const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createVoiceServer } = require('../wechat-voice-server.cjs');
const root = path.resolve(__dirname, '../..');
const sandbox = vm.createContext({ window: {}, console, URL });
for (const file of ['wechat-voice.js', 'wechat-protocol.js']) vm.runInContext(fs.readFileSync(path.join(root, 'assets/js', file), 'utf8'), sandbox);
const V = sandbox.window.RPHubWeChatVoice, P = sandbox.window.RPHubWeChatProtocol;
const voice = (content = '我在呢') => ({ type: 'voice_request', content, instructions: '轻声，语气放松' });
test('语音按原位置解析，原文和语气分离；非法意图不冒充文字或空回', () => {
  const parsed = P.parseReplyResult(JSON.stringify({ messages: [{ type: 'text', content: '嗯' }, voice(), voice('慢慢说')] }));
  assert.equal(parsed.messages[1].instructions, '轻声，语气放松');
  assert.equal(parsed.messages[2].content, '慢慢说');
  for (const item of [{ ...voice(), content: '' }, { ...voice(), type: 'voice' }, voice('a'.repeat(201)), voice('https://example.com/voice.mp3')]) assert.throws(() => P.normalizeMessages([item]));
  assert.throws(() => P.normalizeMessages([voice(), voice(), voice()]));
  assert.throws(() => P.normalizeMessages([voice('a'.repeat(151)), voice('b'.repeat(151))]));
  assert.equal(V.recordText({ content: '我在呢', voice: { instructions: 'SECRET', assetId: 'asset' } }), '[语音] 我在呢');
});
test('语音可用能力位于最终收尾判断之前，未配置时明确禁用', () => {
  const prompt = P.buildSystemPrompt('朋友', { voicePrompt: V.buildPrompt(true) });
  assert.ok(prompt.indexOf('【语音消息') < prompt.indexOf(P.REPLY_DECISION_RULE));
  assert.ok(prompt.endsWith(P.REPLY_DECISION_REMINDER));
  assert.ok(V.buildPrompt(false).includes('不能输出 voice_request'));
});
async function serverTest(t, fetchImpl) {
  const server = createVoiceServer({ fetchImpl });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const request = (body = {}) => ({ method: 'POST', headers: { 'xi-api-key': 'test-not-a-real-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ voiceId: 'voc_test', text: '我在呢', instructions: '放松，轻声', ...body }) });
test('本机预检支持 file 和 localhost；拒绝陌生来源、无 Key、超长脚本及仓库文件', async t => {
  let calls = 0;
  const base = await serverTest(t, async () => { calls++; throw new Error('Unexpected upstream'); });
  const pre = await fetch(base + '/api/wechat-voice/synthesize', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'xi-api-key,content-type' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), 'null');
  assert.match(pre.headers.get('access-control-allow-headers'), /xi-api-key/);
  assert.equal((await fetch(base + '/api/wechat-voice/voices', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/wechat-voice/voices')).status, 401);
  assert.equal((await fetch(base + '/api/wechat-voice/synthesize', request({ text: 'a'.repeat(201) }))).status, 400);
  for (const file of ['/.git/config', '/docs/wechat-and-RP.md', '/.refactor-tmp/secret', '/tools/wechat-voice-server.cjs', '/assets/%2e%2e%2f.git/config']) assert.equal((await fetch(base + file)).status, 404);
  assert.equal(calls, 0);
});
test('代理严格按官方契约请求 MP3，多余输入无法更改上游或模型', async t => {
  let captured;
  const base = await serverTest(t, async (url, options) => { captured = { url, options }; return new Response('audio', { headers: { 'Content-Type': 'audio/mpeg' } }); });
  const response = await fetch(base + '/api/wechat-voice/synthesize', request({ url: 'https://untrusted.example', model_id: 'wrong' }));
  assert.equal(response.status, 200); assert.equal(await response.text(), 'audio');
  assert.equal(captured.url, 'https://api.breeze.blue/v1/text-to-speech/voc_test?output_format=mp3');
  assert.deepEqual(JSON.parse(captured.options.body), { text: '我在呢', instructions: '放松，轻声', model_id: 'breeze-tts-2-multilingual', language_code: 'zh', voice_settings: { guidance_scale: 2 } });
  assert.equal(captured.options.redirect, 'error');
});
test('额度错误不自动重试、不泄露服务响应；保留 Retry-After', async t => {
  let calls = 0;
  const base = await serverTest(t, async () => { calls++; return new Response('{"error":"test-not-a-real-key"}', { status: 402, headers: { 'Retry-After': '8' } }); });
  const response = await fetch(base + '/api/wechat-voice/synthesize', request());
  assert.equal(response.status, 402); assert.equal(response.headers.get('retry-after'), '8');
  assert.ok(!(await response.text()).includes('test-not-a-real-key')); assert.equal(calls, 1);
});
test('并发限制与客户端中止会传递到上游', async t => {
  let started, release;
  const ready = new Promise(resolve => { started = resolve; });
  const cancelled = new Promise(resolve => { release = resolve; });
  const base = await serverTest(t, async (_url, options) => {
    started(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { release(); reject(new DOMException('cancelled', 'AbortError')); }, { once: true }));
  });
  const controller = new AbortController();
  const first = fetch(base + '/api/wechat-voice/synthesize', { ...request(), signal: controller.signal }).catch(() => {});
  await ready;
  assert.equal((await fetch(base + '/api/wechat-voice/synthesize', request())).status, 429);
  controller.abort(); await cancelled; await first;
});
