// 生成微信覆盖层截图（无头 Edge，手机视口）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 18140;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const server = http.createServer((q, s) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); s.end('nf'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(s);
});

const REPLY = JSON.stringify({ messages: [
  { type: 'text', content: '刚看到消息' }, { type: 'text', content: '你也不容易啊' },
  { type: 'sticker', content: '🥺' }, { type: 'text', content: '早点睡' }
] });
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#8ab4d8"/></svg>';

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  await page.addInitScript(() => {
    window.marked = window.marked || { use() { }, parse: t => String(t) };
    window.DOMPurify = window.DOMPurify || { sanitize: t => String(t) };
    let _v;
    Object.defineProperty(window, 'Vue', {
      configurable: true, get() { return _v; },
      set(v) { _v = v; if (v && v.createApp && !v.createApp.__wrapped) { const o = v.createApp; const w = function (...a) { const app = o.apply(this, a); const m = app.mount; app.mount = function (...mm) { const r = m.apply(this, mm); window.__APP_PROXY__ = r; return r; }; return app; }; w.__wrapped = true; v.createApp = w; } }
    });
  });
  await page.route('**/chat/completions', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }] }) }));

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await page.evaluate(() => !!(window.__APP_PROXY__ && Array.isArray(window.__APP_PROXY__.characters)));
    if (!ready) await page.waitForTimeout(250);
  }
  if (!ready) throw new Error('__APP_PROXY__ 未就绪（多为 CDN 网络问题）');
  await page.waitForTimeout(500);

  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.showUserSetupModal = false;
    root.settings.apiUrl = 'https://mock.local/v1';
    root.settings.apiKey = 'k';
    root.settings.model = 'm';
    root.characters.push({
      name: '小A', description: '插画师', personality: '嘴硬心软', first_mes: '……',
      avatar: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#8ab4d8"/></svg>'),
      uuid: 'u1', createdAt: Date.now(), wechatEnabled: true, wechatPeerName: '小A', wechatRelation: '老同学', wechatSpeed: 'fast'
    });
    await root.selectCharacter(0, false, { silent: true });
    root.currentView = 'chat';
    await root.openWechat();
  });
  await page.waitForTimeout(400);
  // 通过真实发送驱动（wechatTimeline 未暴露给模板，只暴露 wechatDisplayItems）
  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.wechatInput = '今天好累';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 300));
    root.wechatInput = '晚安';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 300));
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(__dirname, 'wechat-shot.png') });
  console.log('shot saved');
  await browser.close();
  server.close();
})().catch(e => { console.error('SHOT CRASH:', e); server.close(); process.exit(2); });
