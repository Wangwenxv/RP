// On-demand local voice proxy + Cloudflare quick tunnel. No API key is needed here.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createVoiceServer } = require('./wechat-voice-server.cjs');

const RUNTIME = path.resolve(__dirname, '../.refactor-tmp/wechat-voice-local');
const PAGES_ORIGIN = 'https://wangwenxv.github.io';
const files = dir => ({ state: path.join(dir, 'state.json'), log: path.join(dir, 'service.log'), url: path.join(dir, 'service-url.txt') });
function readState(dir) {
  try { return JSON.parse(fs.readFileSync(files(dir).state, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('无法读取语音运行状态，请查看 .refactor-tmp/wechat-voice-local。'); }
}
function pidExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function removeOwnedState(dir, token) {
  if (readState(dir)?.token !== token) return;
  fs.rmSync(files(dir).url, { force: true });
  fs.rmSync(files(dir).state, { force: true });
}
async function control(state, action = 'status') {
  if (!Number.isInteger(state?.controlPort) || state.controlPort < 1 || state.controlPort > 65535 || !/^[a-f0-9]{64}$/.test(state.token || '')) throw new Error('语音服务仍在启动，或运行状态不完整。');
  const response = await fetch(`http://127.0.0.1:${state.controlPort}/${action}`, {
    method: action === 'stop' ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${state.token}` }, redirect: 'error', signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error('无法确认语音服务身份；没有停止任何其他进程。');
  const result = await response.json();
  if (result.service !== 'rphub-wechat-voice-local' || result.pid !== state.pid) throw new Error('语音服务身份不匹配。');
  return result;
}
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
});
const close = server => new Promise(resolve => {
  if (!server?.listening) return resolve();
  server.close(resolve); server.closeAllConnections();
});

async function checkPublicService(url, signal, fetchImpl = fetch) {
  const options = { headers: { Origin: PAGES_ORIGIN }, redirect: 'error', signal };
  const health = await fetchImpl(url + '/api/wechat-voice/health', options);
  const info = await health.json();
  if (!health.ok || info?.ok !== true || info.service !== 'rphub-wechat-voice' || health.headers.get('access-control-allow-origin') !== PAGES_ORIGIN) throw new Error('HTTPS 服务或 Pages 来源许可尚未就绪。');
  const preflight = await fetchImpl(url + '/api/wechat-voice/synthesize', {
    ...options, method: 'OPTIONS', headers: { ...options.headers, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'xi-api-key,content-type' },
  });
  if (preflight.status !== 204 || preflight.headers.get('access-control-allow-origin') !== PAGES_ORIGIN || !/xi-api-key/i.test(preflight.headers.get('access-control-allow-headers') || '')) throw new Error('Pages 跨域预检尚未就绪。');
}

// The stop channel is a separate loopback-only server, never forwarded through the tunnel.
// It authenticates with a random per-run token, rather than trusting/terminating saved PIDs.
async function serve({ dir = RUNTIME, spawnTunnel = (port) => spawn(process.env.CLOUDFLARED_PATH || 'cloudflared', [
  'tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate',
], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), verify = checkPublicService, startupMs = 90000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const f = files(dir);
  const state = { pid: process.pid, token: randomBytes(32).toString('hex'), phase: 'starting', startedAt: new Date().toISOString() };
  // Exclusive file creation prevents concurrent double-clicks from starting two tunnels.
  try { fs.writeFileSync(f.state, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  fs.writeFileSync(f.log, 'Starting RP-Hub local voice service. No API key required.\n');
  const log = message => fs.appendFileSync(f.log, String(message));
  const save = () => {
    fs.writeFileSync(f.state + '.tmp', JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(f.state + '.tmp', f.state);
  };
  let proxy, admin, tunnel, tunnelExited, shutdownPromise, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const abort = new AbortController();
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      abort.abort();
      // Close connections first so active synthesis propagates cancellation upstream.
      await close(proxy);
      if (tunnel?.pid && tunnel.exitCode === null && tunnel.signalCode === null) {
        if (!tunnel.kill()) throw new Error('无法停止本轮 cloudflared，请检查 service.log 后重试停止。');
        await Promise.race([tunnelExited, delay(5000, undefined, { ref: false }).then(() => { throw new Error('cloudflared 尚未退出，请重试停止。'); })]);
      }
      await close(admin);
      removeOwnedState(dir, state.token);
      finish();
    })().catch(error => {
      log(`Stop failed: ${error.message}\n`); state.phase = 'error'; save(); shutdownPromise = null;
      throw error;
    });
    return shutdownPromise;
  };
  const requestShutdown = () => { shutdown().catch(() => {}); };
  process.once('SIGINT', requestShutdown); process.once('SIGTERM', requestShutdown);
  try {
    admin = http.createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.headers.origin || req.headers.authorization !== `Bearer ${state.token}`) { res.writeHead(403); res.end(); return; }
      const stopping = req.method === 'POST' && req.url === '/stop';
      if (!stopping && !(req.method === 'GET' && req.url === '/status')) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ service: 'rphub-wechat-voice-local', pid: state.pid, phase: state.phase, url: state.url, port: state.port }));
      if (stopping) setImmediate(requestShutdown);
    });
    state.controlPort = await listen(admin);
    if (abort.signal.aborted) { await close(admin); await shutdown(); return; }
    save();
    process.env.VOICE_ALLOWED_ORIGINS = [...new Set([PAGES_ORIGIN, ...(process.env.VOICE_ALLOWED_ORIGINS || '').split(',').filter(Boolean)])].join(',');
    proxy = createVoiceServer(); state.port = await listen(proxy);
    if (abort.signal.aborted) { await close(proxy); await shutdown(); return; }
    save();
    tunnel = spawnTunnel(state.port);
    let tunnelError, received = '';
    tunnelExited = new Promise(resolve => {
      tunnel.once('error', error => { tunnelError = error; resolve(); });
      tunnel.once('exit', (code, signal) => {
        tunnelError = new Error(`cloudflared exited (${code ?? signal}).`); resolve();
        if (state.phase === 'ready' && !abort.signal.aborted) { log(tunnelError.message + '\n'); requestShutdown(); }
      });
    });
    const consume = chunk => {
      log(chunk); received = (received + chunk.toString()).slice(-16384);
      const match = received.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
      if (match) state.url = match[0];
    };
    tunnel.stdout.on('data', consume); tunnel.stderr.on('data', consume);
    const deadline = Date.now() + startupMs;
    let ready = false;
    while (!abort.signal.aborted && Date.now() < deadline) {
      if (tunnelError) throw tunnelError;
      if (state.url) {
        try {
          await verify(state.url, AbortSignal.any([abort.signal, AbortSignal.timeout(6000)]));
          ready = true; break;
        } catch (_) { /* Retry no-key health checks only; never generate audio during startup. */ }
      }
      await delay(1000, undefined, { signal: abort.signal }).catch(() => {});
    }
    if (abort.signal.aborted) { await shutdown(); return; }
    if (tunnelError) throw tunnelError;
    if (!ready) throw new Error('临时 HTTPS 地址未能在 90 秒内连通，请检查网络或 Cloudflare 日志。');
    state.phase = 'ready'; save();
    fs.writeFileSync(f.url, state.url + '\n');
    log(`Ready: ${state.url}\nLocal port: ${state.port}\n`);
    await done;
  } catch (error) {
    log(`Startup failed: ${error.message}\n`);
    await shutdown();
  } finally {
    process.off('SIGINT', requestShutdown); process.off('SIGTERM', requestShutdown);
  }
}

async function stop(dir = RUNTIME) {
  let state = readState(dir);
  if (!state) { console.log('语音服务已停止。'); return; }
  // Give a just-started owner time to publish its authenticated control port.
  for (let n = 0; !state.controlPort && pidExists(state.pid) && n < 20; n++) { await delay(100); state = readState(dir); if (!state) return; }
  if (!pidExists(state.pid)) { removeOwnedState(dir, state.token); console.log('已清理上次退出的运行状态。'); return; }
  await control(state, 'stop');
  for (let n = 0; n < 80; n++) {
    if (readState(dir)?.token !== state.token) { console.log('本轮语音服务与 Cloudflare 已停止，本机端口已释放。'); return; }
    await delay(100);
  }
  throw new Error('停止尚未完成，请检查 service.log 后重新运行停止脚本；未按 PID 强制结束其他进程。');
}

async function start(dir = RUNTIME) {
  fs.mkdirSync(dir, { recursive: true });
  let state = readState(dir);
  if (state && !pidExists(state.pid)) { removeOwnedState(dir, state.token); state = null; }
  if (!state) {
    // No shell, no API key arguments; background helpers remain hidden on Windows.
    const child = spawn(process.execPath, [__filename, 'serve'], { detached: true, windowsHide: true, stdio: 'ignore', cwd: path.resolve(__dirname, '..') });
    child.on('error', error => console.error(`无法启动 Node：${error.message}`));
    child.unref();
  }
  console.log('正在连接本机语音服务和 Cloudflare（最多约 90 秒）…');
  const deadline = Date.now() + 105000;
  let observedOwner = !!state;
  while (Date.now() < deadline) {
    state = readState(dir);
    if (state) {
      observedOwner = true;
      if (!pidExists(state.pid)) break;
      try {
        const status = await control(state);
        if (status.phase === 'ready') {
          console.log(`\n语音服务已就绪（本机端口 ${status.port}）。\n\n${status.url}\n\n继续打开 https://wangwenxv.github.io/RP/\n把上面地址填入微信设置的“语音转发服务地址”，读取音色并保存。\n每次重新启动，HTTPS 地址可能变化，需要重新填写。\n用完双击 stop-wechat-voice.cmd；关闭此窗口不会停止后台服务。\n地址也保存在：${files(dir).url}`);
          return status;
        }
        if (status.phase === 'error') break;
      } catch (_) { /* Owner may still be publishing its control port. */ }
    } else if (observedOwner) break;
    await delay(500);
  }
  // Stop through the authenticated channel, never by a process-name or port-wide kill.
  await stop(dir);
  throw new Error(`启动失败，服务已停止。请确认 node 与 cloudflared 已安装并可联网。\n日志：${files(dir).log}`);
}

if (require.main === module) {
  const command = process.argv[2];
  const action = { start, stop, serve }[command];
  if (Number(process.versions.node.split('.')[0]) < 20) { console.error('需要 Node.js 20 或更新版本。'); process.exitCode = 1; }
  else if (!action) { console.error('用法：node tools/wechat-voice-local.cjs start|stop'); process.exitCode = 1; }
  else action().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { serve, stop, control, checkPublicService, readState, removeOwnedState };
