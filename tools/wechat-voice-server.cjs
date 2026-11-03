// Optional, dependency-free local host + fixed BreezeBlue proxy. Node 20+.
// Credentials are supplied per request; never retained, logged or embedded in files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const UPSTREAM = 'https://api.breeze.blue';
const MAX_BODY = 16384;

function createVoiceServer({ fetchImpl = fetch } = {}) {
  let generating = false;
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const localOrigin = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); } catch { return false; } };
    const extras = (process.env.VOICE_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const sameHost = (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
    if (origin && !(origin === 'null' || localOrigin(origin) || sameHost || extras.includes(origin))) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"此网页来源未获转发服务许可"}'); return;
    }
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status, body) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); } };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, xi-api-key', 'Access-Control-Max-Age': '600' }); res.end(); return;
    }
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { json(400, { error: '无效地址' }); return; }
    if (url.pathname === '/api/wechat-voice/health' && req.method === 'GET') { json(200, { ok: true, service: 'rphub-wechat-voice' }); return; }
    const listing = url.pathname === '/api/wechat-voice/voices' && req.method === 'GET';
    const synth = url.pathname === '/api/wechat-voice/synthesize' && req.method === 'POST';
    if (listing || synth) {
      const key = String(req.headers['xi-api-key'] || '').trim();
      if (!key || key.length > 256) { json(401, { error: '请在微信设置中填写 BreezeBlue Key' }); return; }
      if (synth && generating) { res.setHeader('Retry-After', '3'); json(429, { error: '已有语音正在合成，请稍后手动重试' }); return; }
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 90000);
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      if (synth) generating = true;
      try {
        let endpoint = '/v1/voices?language_code=zh&voice_type=default&page_size=30';
        let payload;
        if (synth) {
          let data = '';
          for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > MAX_BODY) { json(413, { error: '请求过大' }); return; } }
          let input;
          try { input = JSON.parse(data); } catch { json(400, { error: '请求必须是 JSON' }); return; }
          if (!input || typeof input !== 'object' || !/^voc_[a-zA-Z0-9_-]{1,100}$/.test(input.voiceId || '') || typeof input.text !== 'string' || !input.text.trim() || Array.from(input.text).length > 200 || typeof input.instructions !== 'string' || Array.from(input.instructions).length > 1000) {
            json(400, { error: '音色 ID、语音文字或语气指令无效（单条最多 200 字）' }); return;
          }
          endpoint = `/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=mp3`;
          payload = { text: input.text.trim(), instructions: input.instructions.trim(), model_id: 'breeze-tts-2-multilingual', language_code: 'zh', voice_settings: { guidance_scale: 2 } };
        }
        const upstream = await fetchImpl(UPSTREAM + endpoint, { method: synth ? 'POST' : 'GET', headers: { 'xi-api-key': key, ...(synth ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: abort.signal, redirect: 'error' });
        if (!upstream.ok) {
          // Do not echo untrusted upstream detail (which could contain credentials or scripts).
          const hints = { 401: 'Key 无效或已失效', 402: '额度不足或 Key 预算已用完', 403: '账号无权使用该音色', 404: '音色不存在', 422: '语音参数被服务拒绝', 429: '服务繁忙或达到并发上限，请稍后手动重试' };
          const retry = upstream.headers.get('retry-after'); if (/^\d+$/.test(retry || '')) res.setHeader('Retry-After', retry);
          json(upstream.status, { error: hints[upstream.status] || `BreezeBlue 暂时不可用（HTTP ${upstream.status}）` }); return;
        }
        if (listing) {
          const catalog = await upstream.json();
          json(200, { voices: (catalog.voices || []).slice(0, 30).map(v => ({ voice_id: v.voice_id, name: v.name, gender: v.gender })) }); return;
        }
        const type = upstream.headers.get('content-type') || '';
        if (!/^(audio\/|application\/octet-stream)/i.test(type)) { json(502, { error: '服务未返回音频' }); return; }
        const chunks = []; let bytes = 0;
        for await (const chunk of upstream.body) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw new Error('Audio too large'); chunks.push(Buffer.from(chunk)); }
        if (!bytes) { json(502, { error: '服务返回空音频' }); return; }
        if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(Buffer.concat(chunks)); }
      } catch (error) { json(error.name === 'AbortError' ? 504 : 502, { error: abort.signal.aborted ? '语音请求已中止或超时，请手动重试' : '无法连接 BreezeBlue，请检查本机网络' }); }
      finally { clearTimeout(timeout); if (synth) generating = false; }
      return;
    }
    // Serve only the public app; never expose repository, docs, keys or local test outputs through a tunnel.
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(405, { error: '不支持该请求' }); return; }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { json(400, { error: '无效路径' }); return; }
    const file = path.resolve(ROOT, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!(file === path.join(ROOT, 'index.html') || file.startsWith(path.join(ROOT, 'assets') + path.sep)) || pathname.split('/').some(p => p.startsWith('.'))) { json(404, { error: 'Not found' }); return; }
    try {
      const stat = await fs.promises.stat(file); if (!stat.isFile()) throw new Error('Not a file');
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch { json(404, { error: 'Not found' }); }
  });
}
if (require.main === module) {
  const port = Number(process.env.VOICE_PORT) || 3000;
  const server = createVoiceServer();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，可设置 VOICE_PORT 后重试。` : error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`RP-Hub 微信语音：http://127.0.0.1:${port}（Key 在微信设置填写）`));
}
module.exports = { createVoiceServer };
