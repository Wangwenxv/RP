// 深度冒烟：交互 + setupState 探针 + 跨模块纯函数调用
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 18124;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.md': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push('[console.error] ' + msg.text().slice(0, 300)); });
  page.on('pageerror', err => errors.push('[pageerror] ' + err.message));
  const netFail = (url) => url.includes('gstatic') || url.includes('sta1n') || url.includes('favicon') || url.startsWith('https://');
  page.on('requestfailed', req => { if (!netFail(req.url())) errors.push('[requestfailed] ' + req.url()); });

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(5000);

  // 1) 关闭网站公告
  try { await page.click('text=知道了', { timeout: 3000 }); } catch {}
  await page.waitForTimeout(500);

  // 2) 填写用户称呼并保存（锻炼 lateHelpers -> presets/persistence 跨模块链路）
  const setupResult = await page.evaluate(async () => {
    try {
      const modal = [...document.querySelectorAll('div')].find(d => d.innerText && d.innerText.includes('您的称呼'));
      if (!modal) return 'modal-not-found';
      const input = modal.querySelector('input[type="text"], input:not([type])');
      if (!input) return 'input-not-found';
      input.value = '测试用户';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      const btn = [...modal.querySelectorAll('button')].find(b => /保存|确定|完成|开始/.test(b.innerText));
      if (!btn) return 'button-not-found';
      btn.click();
      return 'clicked:' + btn.innerText;
    } catch (e) { return 'ex:' + e.message; }
  });
  await page.waitForTimeout(1500);

  // 3) setupState 探针（根实例 = #app._vnode.component）
  const probe = await page.evaluate(() => {
    const el = document.getElementById('app');
    const inst = el._vnode && el._vnode.component;
    const state = inst && inst.setupState;
    if (!state) return { ok: false, reason: 'no setupState' };
    const keys = Object.keys(state);
    const types = {};
    for (const k of keys) types[typeof state[k]] = (types[typeof state[k]] || 0) + 1;
    window.__probeState = state; // 供后续调用
    return { ok: true, keyCount: keys.length, types };
  });

  // 4) 调用一批跨模块纯函数 / 安全函数
  const calls = await page.evaluate(() => {
    const state = window.__probeState;
    if (!state) return ['no probe state'];
    const run = (name, fn) => { try { return name + '=' + JSON.stringify(fn()).slice(0, 80); } catch (e) { return name + ' THREW: ' + e.message; } };
    return [
      run('formatTokenCount', () => state.formatTokenCount(123456)),
      run('formatStorageSize', () => state.formatStorageSize(1234567)),
      run('parseCot', () => state.parseCot('hello world').main),
      run('renderMarkdown', () => state.renderMarkdown('**加粗**测试').slice(0, 60)),
      run('getPresetRoleLabel', () => state.getPresetRoleLabel('system')),
      run('getSortableItemKey', () => state.getSortableItemKey({ uuid: 'u1', name: 'n' })),
      run('conversationBodyLength', () => state.conversationBodyLength),
      run('canDeleteMessage', () => state.canDeleteMessage(0)),
      run('getCharacterWICount', () => state.getCharacterWICount({})),
      run('memoryStats', () => state.memoryStats),
      run('isSecondPerson', () => state.isSecondPerson),
      run('processMainContent', () => state.processMainContent('正文测试', false).text),
    ];
  });

  // 5) 当前界面文本（确认保存称呼后的状态）
  const after = await page.evaluate(() => document.body.innerText.slice(0, 200));

  console.log('SETUP FLOW:', setupResult);
  console.log('PROBE:', JSON.stringify(probe));
  console.log('CALLS:');
  calls.forEach(c => console.log('  ' + c));
  console.log('AFTER TEXT:', JSON.stringify(after));
  console.log('\nERRORS (' + errors.length + '):');
  [...new Set(errors)].slice(0, 20).forEach(e => console.log('  ' + e));
  await page.screenshot({ path: path.join(__dirname, 'smoke2.png') });
  await browser.close();
  server.close();
})().catch(e => { console.error('SMOKE CRASH:', e); server.close(); process.exit(2); });
