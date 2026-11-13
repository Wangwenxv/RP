# STA1N 生图接口实测与调用经验

更新：2026-11-13。来自 `tmp` 中两次实测及正式微信适配器，不能把旧 RP 自动插图服务的协议与此接口混用。

## 已验证的模型与格式

- Base URL：`https://sta1n.ai/v1`
- 模型：`nai-diffusion-4-5-full:k_dpmpp_2m`，保留冒号后的采样器；模型列表中是这个完整 ID。
- 鉴权：`Authorization: Bearer <用户的 API Key>`。
- 获取模型：`GET /v1/models`；列出模型不等于已验证生图，列表可能同时包含聊天模型。
- **生成：`POST /v1/chat/completions`，`stream: false`，使用 NAI 标签文本。**

```json
{
  "model": "nai-diffusion-4-5-full:k_dpmpp_2m",
  "stream": false,
  "messages": [{
    "role": "user",
    "content": "提示词:yellow braised chicken with potatoes and green peppers in a clay pot, bowl of rice, dining table, close-up, warm indoor light\n画师串:\n尺寸:方图\n提示词引导值:6\n缩放引导值:0\n负面提示词:lowres, blurry, bad anatomy, bad hands, text, signature, watermark\n采样器:k_dpmpp_2m"
  }]
}
```

`尺寸` 使用“方图 / 横图 / 竖图”。设置页的 `1024x1024 / 1216x832 / 832x1216` 会映射到这三个值；最终像素尺寸以服务返回为准。画师串可以为空，不能把标签名省成一段普通聊天文字。提示词可以描述画面主体、环境、视角和光线；人物图应补已知外貌与服装，单写角色名字不能保证身份一致。这个默认 NAI 模型偏插画，不能保证输出写实照片。

## 实例中的成功与失败

| 时间（北京时间） | 调用 | 结果 |
| --- | --- | --- |
| 2026-11-13 17:12 | `/v1/images/generations` | HTTP 400，`not found.`；这条路不适用于上述 NAI 模型 |
| 2026-11-13 17:32 | 带标签的 `/v1/chat/completions` | HTTP 200，约 9.971 秒；取得图片 URL 并下载 1,044,111 字节 PNG |

原始成功报告是 `tmp/nai_image_test_20261113_173211.json`，图片是 `tmp/nai_test_20261113_173211.png`。这些本地实例继续保留；Key 没有写入文档、代码或报告正文。

读取 HTTP 200 不算成功：还要从响应中提取图片并确认图片文件可解码。正式适配器兼容 `choices[0].message.content` 的 Markdown 图片、内容数组、`message.images`、`data[].b64_json/url`、Data URL 和直接图片响应。下载后验证 PNG/JPEG/WebP 字节特征，再交给浏览器栅格化与持久化。只返回文字的“成功”应报错。

生成请求携带 Key，返回的图片/CDN URL 下载不携带 Key；Key 不写进查询字符串、模型提示词或图片元数据。生成超时为五分钟，不自动重试付费请求；超时/网络中断时服务端是否已经计费无法由前端保证，交给用户手动重试。

## 可复用验证

```powershell
py -3 tools/image-generation/test-sta1n.py --key-file tmp/key.txt --prompt "yellow braised chicken, clay pot, bowl of rice, dining table"
node --test tools/refactor/test-image-generation.cjs
node tools/refactor/smoke-wechat-image-generation.cjs
```

Python 工具会实际调用服务并可能计费，默认输出到忽略目录 `.refactor-tmp/sta1n/`；它用于接口排查，不证明浏览器 CORS。浏览器专项默认使用隔离存储和 fixture API；加 `--live` 才会读取 `tmp/key.txt` 并允许**一次真实 STA1N 生图**，角色聊天回复仍是固定测试数据。不能把 fixture 图片当成黄焖鸡的视觉效果验收。

## 清理与后续维护

临时下载的 `new-api-source`、`bestnai-reference`、`nai-proxy-reference` 三个参考仓库和 `__pycache__` 在确认工作树干净后删除。保留脚本的正式副本在 `tools/image-generation/test-sta1n.py`，运行不再依赖这些参考目录。

不要给所有可选生图模型盲目套 NAI 标签。设置页明确区分 `sta1n-nai`（本次默认且已验证）、`chat-image`（普通聊天生图）与 `openai-images`（Images API）。后两者提供格式适配，具体模型能力、尺寸和返回格式仍以供应商为准，不自动猜协议、切换供应商或重复发送。

微信功能与数据交接见 [微信按需生图](./wechat-image-generation.md)。
