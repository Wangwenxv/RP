// 冒烟 3（程序化）：建角色 -> 选中 -> 刷新页面验证持久化
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..');
const PORT = 18126;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.md': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push('[pageerror] ' + err.message));
  page.on('console', msg => {
    if (msg.type() === 'error' && !/gstatic|sta1n|favicon|404|ERR_/.test(msg.text())) errors.push('[console.error] ' + msg.text().slice(0, 200));
  });
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('app') && document.getElementById('app')._vnode, { timeout: 30000 });
  await page.waitForTimeout(1500);
  try { await page.click('text=知道了', { timeout: 2000 }); } catch {}

  // 1) 建角色 + 选中
  const flow = await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const s = document.getElementById('app')._vnode.component.setupState;
    const log = [];
    s.createNewCharacter();
    s.editingCharacter.data.name = '小A';
    s.editingCharacter.data.description = '一个测试角色';
    s.saveCharacter();
    log.push('chars=' + s.characters.length);
    await sleep(300);
    await s.selectCharacter(0);
    await sleep(2000);
    log.push('current=' + (s.currentCharacter ? s.currentCharacter.name : 'null'));
    log.push('chatLen=' + s.chatHistory.length);
    log.push('firstMsg=' + (s.chatHistory[0] ? JSON.stringify(s.chatHistory[0].content).slice(0, 40) : 'none'));
    log.push('view=' + s.currentView);
    return log;
  });
  await page.waitForTimeout(1500);

  // 2) 等待自动保存 watcher 落盘，再刷新页面验证持久化加载
  await page.waitForTimeout(4000);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('app') && document.getElementById('app')._vnode, { timeout: 30000 }); await page.waitForTimeout(1500);
  const after = await page.evaluate(() => {
    const s = document.getElementById('app')._vnode.component.setupState;
    return {
      chars: s.characters.length,
      current: s.currentCharacter ? s.currentCharacter.name : null,
      chatLen: s.chatHistory.length,
      user: s.user.name,
    };
  });
  console.log('FLOW:', JSON.stringify(flow, null, 2));
  console.log('AFTER RELOAD:', JSON.stringify(after, null, 2));
  console.log('ERRORS (' + errors.length + '):');
  [...new Set(errors)].slice(0, 10).forEach(e => console.log('  ' + e));
  await page.screenshot({ path: path.join(__dirname, 'smoke3.png') });
  await browser.close();
  server.close();
})().catch(e => { console.error('SMOKE CRASH:', e); server.close(); process.exit(2); });
