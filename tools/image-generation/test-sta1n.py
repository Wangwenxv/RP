#!/usr/bin/env python3
"""Test an OpenAI-compatible image generation model without exposing the API key."""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "https://sta1n.ai/v1"
DEFAULT_MODEL = "nai-diffusion-4-5-full:k_dpmpp_2m"
DEFAULT_PROMPT = (
    "masterpiece, best quality, anime style, a small white cat sitting beside "
    "a window, warm morning sunlight, clean background"
)


def parse_args() -> argparse.Namespace:
    script_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--key-file", type=Path, required=True, help="Local file containing the API key; never commit this file")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--size", default="1024x1024")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--output-dir", type=Path, default=script_dir.parent.parent / ".refactor-tmp" / "sta1n")
    return parser.parse_args()


def read_key(path: Path) -> str:
    with path.open("r", encoding="utf-8-sig") as handle:
        key = handle.readline().strip()
    if not key:
        raise ValueError(f"API key file has an empty first line: {path}")
    return key


def redact(text: str, api_key: str) -> str:
    return text.replace(api_key, "[REDACTED]") if api_key else text


def request(
    url: str,
    api_key: str | None,
    timeout: int,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> tuple[int, str, bytes]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json, image/*", "User-Agent": "RP-Hub-image-model-test/1.0"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, response.headers.get("Content-Type", ""), response.read()
    except urllib.error.HTTPError as exc:
        response_body = exc.read()
        return exc.code, exc.headers.get("Content-Type", ""), response_body


def json_or_none(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def choose_extension(content_type: str, raw: bytes) -> str:
    media_type = content_type.split(";", 1)[0].strip().lower()
    guessed = mimetypes.guess_extension(media_type) if media_type else None
    if guessed == ".jpe":
        guessed = ".jpg"
    if guessed:
        return guessed
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if raw.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if raw.startswith((b"RIFF",)) and raw[8:12] == b"WEBP":
        return ".webp"
    return ".bin"


def save_image(raw: bytes, content_type: str, output_dir: Path, stem: str) -> Path:
    extension = choose_extension(content_type, raw)
    path = output_dir / f"{stem}{extension}"
    path.write_bytes(raw)
    return path


def response_text_candidates(response_json: Any) -> list[str]:
    candidates: list[str] = []
    if not isinstance(response_json, dict):
        return candidates
    choices = response_json.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        choice = choices[0]
        message = choice.get("message")
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str):
                candidates.append(content)
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, str):
                        candidates.append(part)
                    elif isinstance(part, dict):
                        for key in ("text", "image_url", "url", "b64_json"):
                            value = part.get(key)
                            if isinstance(value, str):
                                candidates.append(value)
                            elif isinstance(value, dict) and isinstance(value.get("url"), str):
                                candidates.append(value["url"])
            images = message.get("images")
            if isinstance(images, list):
                for image in images:
                    if isinstance(image, str):
                        candidates.append(image)
                    elif isinstance(image, dict):
                        for key in ("url", "image_url", "b64_json", "base64"):
                            value = image.get(key)
                            if isinstance(value, str):
                                candidates.append(value)
                            elif isinstance(value, dict) and isinstance(value.get("url"), str):
                                candidates.append(value["url"])
        if isinstance(choice.get("text"), str):
            candidates.append(choice["text"])
    data = response_json.get("data")
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                for key in ("url", "b64_json", "b64", "base64"):
                    value = item.get(key)
                    if isinstance(value, str):
                        candidates.append(value)
    for key in ("message", "content", "imageUrl", "url"):
        if isinstance(response_json.get(key), str):
            candidates.append(response_json[key])
    return candidates


def decode_image_from_text(text: str) -> tuple[bytes, str] | None:
    data_url = re.search(
        r"data:(image/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=\s]+)", text, re.I
    )
    if data_url:
        encoded = re.sub(r"\s+", "", data_url.group(2))
        try:
            return base64.b64decode(encoded, validate=True), data_url.group(1)
        except ValueError:
            return None
    compact = text.strip()
    if len(compact) >= 200 and re.fullmatch(r"[A-Za-z0-9+/=\s]+", compact):
        try:
            raw = base64.b64decode(re.sub(r"\s+", "", compact), validate=True)
        except ValueError:
            return None
        if choose_extension("", raw) != ".bin":
            return raw, "image/png"
    return None


def find_image_url(text: str) -> str:
    markdown = re.search(r"!\[[^\]]*\]\(([^)\s]+)\)", text)
    if markdown:
        return markdown.group(1)
    url = re.search(r"https?://[^\s)\]\"']+", text)
    if url:
        return url.group(0)
    relative = re.search(r"(?:^|\s)(/[^\s)\]\"']+\.(?:png|jpe?g|webp)(?:\?[^\s)\]\"']*)?)", text, re.I)
    return relative.group(1) if relative else ""


def extract_image(
    response_json: Any,
    api_key: str,
    timeout: int,
    output_dir: Path,
    stem: str,
    base_url: str,
) -> tuple[Path | None, str]:
    candidates = response_text_candidates(response_json)
    for candidate in candidates:
        decoded = decode_image_from_text(candidate)
        if decoded:
            raw, content_type = decoded
            return save_image(raw, content_type, output_dir, stem), "base64"

    for candidate in candidates:
        image_url = find_image_url(candidate)
        if not image_url:
            continue
        image_url = urllib.parse.urljoin(base_url.rstrip("/") + "/", image_url)
        base_host = urllib.parse.urlparse(base_url).netloc.lower()
        image_host = urllib.parse.urlparse(image_url).netloc.lower()
        download_key = api_key if image_host == base_host else None
        status, content_type, raw = request(image_url, download_key, timeout)
        if 200 <= status < 300 and (
            content_type.lower().startswith("image/") or choose_extension(content_type, raw) != ".bin"
        ):
            return save_image(raw, content_type, output_dir, stem), "url"
        return None, f"image URL download failed with HTTP {status}"
    return None, "response contained neither image base64 nor an image URL"


def image_shape_label(size: str) -> str:
    match = re.fullmatch(r"\s*(\d+)\s*[xX*×]\s*(\d+)\s*", size)
    if not match:
        return "方图"
    width, height = int(match.group(1)), int(match.group(2))
    return "横图" if width > height else "竖图" if width < height else "方图"


def error_summary(raw: bytes, api_key: str, limit: int = 4000) -> str:
    text = raw.decode("utf-8", errors="replace")
    return redact(text, api_key)[:limit]


def main() -> int:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    api_key = read_key(args.key_file)
    base_url = args.base_url.rstrip("/")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_path = args.output_dir / f"nai_image_test_{timestamp}.json"
    report: dict[str, Any] = {
        "tested_at_utc": datetime.now(timezone.utc).isoformat(),
        "base_url": base_url,
        "model": args.model,
        "size": args.size,
        "key_file": str(args.key_file.resolve()),
        "key_was_logged": False,
    }

    models_started = time.perf_counter()
    models_status, models_type, models_raw = request(
        f"{base_url}/models", api_key, min(args.timeout, 60)
    )
    models_json = json_or_none(models_raw)
    model_ids: list[str] = []
    if isinstance(models_json, dict) and isinstance(models_json.get("data"), list):
        model_ids = [
            str(item.get("id"))
            for item in models_json["data"]
            if isinstance(item, dict) and item.get("id") is not None
        ]
    report["models_check"] = {
        "http_status": models_status,
        "content_type": models_type,
        "latency_seconds": round(time.perf_counter() - models_started, 3),
        "target_listed_exactly": args.model in model_ids,
        "target_base_model_listed": args.model.split(":", 1)[0] in model_ids,
        "model_count": len(model_ids),
    }
    if not 200 <= models_status < 300:
        report["models_check"]["error_body"] = error_summary(models_raw, api_key)

    sampler = args.model.split(":", 1)[1] if ":" in args.model else "k_dpmpp_2m"
    negative_prompt = "lowres, blurry, bad anatomy, bad hands, text, signature, watermark"
    chat_content = "\n".join(
        [
            f"提示词:{args.prompt}",
            "画师串:",
            f"尺寸:{image_shape_label(args.size)}",
            "提示词引导值:6",
            "缩放引导值:0",
            f"负面提示词:{negative_prompt}",
            f"采样器:{sampler}",
        ]
    )
    payload = {
        "model": args.model,
        "stream": False,
        "messages": [{"role": "user", "content": chat_content}],
    }
    generation_started = time.perf_counter()
    status, content_type, raw = request(
        f"{base_url}/chat/completions",
        api_key,
        args.timeout,
        method="POST",
        payload=payload,
    )
    report["generation"] = {
        "endpoint": f"{base_url}/chat/completions",
        "request_format": "STA1N Nai2API labeled chat payload",
        "http_status": status,
        "content_type": content_type,
        "latency_seconds": round(time.perf_counter() - generation_started, 3),
    }

    image_path: Path | None = None
    if 200 <= status < 300 and content_type.lower().startswith("image/"):
        image_path = save_image(raw, content_type, args.output_dir, f"nai_test_{timestamp}")
        report["generation"]["response_mode"] = "direct-image"
    elif 200 <= status < 300:
        image_path, mode = extract_image(
            json_or_none(raw),
            api_key,
            args.timeout,
            args.output_dir,
            f"nai_test_{timestamp}",
            base_url,
        )
        report["generation"]["response_mode"] = mode
    else:
        report["generation"]["error_body"] = error_summary(raw, api_key)

    available = image_path is not None and image_path.stat().st_size > 0
    report["available"] = available
    if image_path is not None:
        report["image_path"] = str(image_path.resolve())
        report["image_bytes"] = image_path.stat().st_size

    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Model available: {available}")
    print(f"HTTP status: {status}")
    print(f"Report: {report_path.resolve()}")
    if image_path is not None:
        print(f"Image: {image_path.resolve()}")
    else:
        print("No image was saved. See the redacted report for details.")
    return 0 if available else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Test failed before completion: {exc}", file=sys.stderr)
        raise SystemExit(2)
