const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { serve, stop, control, readState, removeOwnedState, checkPublicService } = require('../wechat-voice-local.cjs');

function runtime(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rphub-voice-test-'));
  const oldOrigins = process.env.VOICE_ALLOWED_ORIGINS;
  t.after(() => {
    if (oldOrigins === undefined) delete process.env.VOICE_ALLOWED_ORIGINS; else process.env.VOICE_ALLOWED_ORIGINS = oldOrigins;
    // Only this exact, freshly created test directory may be removed.
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { const result = await predicate(); if (result) return result; await delay(50); }
  throw new Error('Timed out waiting for test service');
}
function fakeTunnel() {
  return spawn(process.execPath, ['-e', "console.log('https://fixture-only.trycloudflare.com'); setInterval(() => {}, 1000)"], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function running(t, dir, options = {}) {
  const task = serve({ dir, spawnTunnel: fakeTunnel, verify: async () => {}, ...options });
  t.after(async () => { if (readState(dir)) await stop(dir); await task; });
  return { task, state: await until(() => { const state = readState(dir); return state?.phase === 'ready' && state; }) };
}

test('自动选端口、重复启动复用；停止需本轮身份且回收所有监听与子进程', async t => {
  const dir = runtime(t);
  let child, calls = 0;
  const { task, state } = await running(t, dir, { spawnTunnel() { calls++; child = fakeTunnel(); return child; } });
  assert.ok(state.port > 0); assert.notEqual(state.port, state.controlPort);
  await serve({ dir, spawnTunnel() { calls++; throw new Error('Duplicate tunnel'); } });
  assert.equal(calls, 1);
  await assert.rejects(control({ ...state, token: '0'.repeat(64) }, 'stop'), /身份/);
  const base = `http://127.0.0.1:${state.port}`;
  const health = await fetch(base + '/api/wechat-voice/health', { headers: { Origin: 'https://wangwenxv.github.io' } });
  assert.equal(health.headers.get('access-control-allow-origin'), 'https://wangwenxv.github.io');
  assert.equal((await fetch(base + '/stop', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } })).status, 405);
  assert.equal((await control(state)).phase, 'ready');
  await stop(dir); await task;
  assert.equal(readState(dir), null); assert.equal(fs.existsSync(path.join(dir, 'service-url.txt')), false);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await assert.rejects(fetch(base + '/api/wechat-voice/health'));
  await assert.rejects(control(state));
  await stop(dir);
});

test('cloudflared 启动失败后自动关闭代理与控制端口', async t => {
  const dir = runtime(t); let port, adminPort;
  await serve({ dir, spawnTunnel(proxyPort) {
    port = proxyPort; adminPort = readState(dir).controlPort;
    return spawn(process.execPath, ['-e', 'process.exit(13)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }, verify: async () => { throw new Error('Should not probe'); } });
  assert.equal(readState(dir), null);
  for (const p of [port, adminPort]) await assert.rejects(fetch(`http://127.0.0.1:${p}/`));
});

test('HTTPS 一直不可用时清理子进程；启动过程中也可以停止', async t => {
  const dir = runtime(t); let child;
  await serve({ dir, startupMs: 50, spawnTunnel() { child = fakeTunnel(); return child; }, verify: async () => { throw new Error('Unavailable'); } });
  assert.equal(readState(dir), null); assert.ok(child.exitCode !== null || child.signalCode !== null);
  const task = serve({ dir, spawnTunnel: fakeTunnel, verify: async (_url, signal) => { await delay(10000, undefined, { signal }); } });
  const state = await until(() => { const s = readState(dir); return s?.port && s; });
  await stop(dir); await task;
  assert.equal(readState(dir), null);
  await assert.rejects(fetch(`http://127.0.0.1:${state.port}/api/wechat-voice/health`));
});

test('过期状态不会按保存的 PID 杀进程；错误身份不会删除状态', async t => {
  const dir = runtime(t);
  const other = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { other.close(resolve); other.closeAllConnections(); }));
  const state = { pid: process.pid, controlPort: other.address().port, token: 'a'.repeat(64) };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  removeOwnedState(dir, 'wrong-owner'); assert.deepEqual(readState(dir), state);
  await assert.rejects(stop(dir), /身份/);
  assert.deepEqual(readState(dir), state); assert.equal(other.listening, true);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...state, pid: -1 }));
  await stop(dir); assert.equal(readState(dir), null); assert.equal(other.listening, true);
});

test('启动只探测 health 与 OPTIONS，不带 Key；缺少 Pages CORS 不能报告就绪', async () => {
  const calls = [];
  const origin = 'https://wangwenxv.github.io';
  await checkPublicService('https://fixture.example', AbortSignal.timeout(1000), async (url, options) => {
    calls.push({ url, options });
    return options.method === 'OPTIONS'
      ? new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type, xi-api-key' } })
      : Response.json({ ok: true, service: 'rphub-wechat-voice' }, { headers: { 'Access-Control-Allow-Origin': origin } });
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/health')); assert.equal(calls[1].options.method, 'OPTIONS');
  for (const call of calls) assert.equal(call.options.headers['xi-api-key'], undefined);
  await assert.rejects(checkPublicService('https://fixture.example', AbortSignal.timeout(1000), async () => Response.json({ ok: true, service: 'rphub-wechat-voice' })), /来源许可/);
});
