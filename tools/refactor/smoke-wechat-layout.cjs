// Layout, responsive behavior and drag/drop through the real Vue page.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), OUTPUT = path.join(ROOT, '.refactor-tmp');
const errors = [], requests = [];
const server = http.createServer((req, res) => {
  const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
let checks = 0;
const check = (label, value) => { assert.ok(value, label); checks++; console.log('PASS ' + label); };
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.marked = { use() {}, parse: text => String(text) }; window.DOMPurify = { sanitize: text => String(text) };
      let value;
      Object.defineProperty(window, 'Vue', { configurable: true, get: () => value, set(v) {
        value = v; if (!v?.createApp || v.createApp.__layoutTest) return;
        const mounted = v.onMounted;
        v.onMounted = (hook, ...args) => { const root = !v.getCurrentInstance()?.parent; return mounted(async (...args) => { await hook(...args); if (root) window.__LAYOUT_READY__ = true; }, ...args); };
        const createApp = v.createApp;
        v.createApp = (...args) => { const app = createApp(...args), mount = app.mount; app.mount = (...args) => { const r = mount.apply(app, args); window.__APP_PROXY__ = r; return r; }; return app; }; v.createApp.__layoutTest = true;
      } });
    });
    await page.route('**/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[{"id":"mock"}]}' }));
    await page.route('**/chat/completions', async route => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"messages":[{"type":"text","content":"我先从前几章读起。"},{"type":"text","content":"看到喜欢的地方，再和你说。"}]}' }, finish_reason: 'stop' }] }) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__LAYOUT_READY__, { timeout: 60000 });
    await page.evaluate(async () => {
      const r = window.__APP_PROXY__; r.showUserSetupModal = false; r.user.name = '我';
      r.characters.push({ uuid: 'layout-character', name: '林晚', description: '喜欢小说', first_mes: '你好', wechatEnabled: true, wechatSpeed: 'fast' });
      await r.selectCharacter(r.characters.length - 1, false, { silent: true }); r.settings.apiUrl = 'https://mock.local/v1'; r.settings.apiKey = 'fixture'; r.settings.model = 'mock'; await r.openWechat();
    });
    fs.mkdirSync(OUTPUT, { recursive: true });
    check('空白会话有明确入口与引导', await page.locator('.wx-empty h2').textContent() === '和林晚聊聊吧');
    await page.screenshot({ path: path.join(OUTPUT, 'wechat-layout-desktop-empty.png'), animations: 'disabled' });
    // Keep one real DataTransfer across nested drag events; dragover/drop reuse actual handlers.
    await page.evaluate(() => {
      const dt = new DataTransfer(); dt.items.add(new File(['第一章\n海风吹进窗户。\n'.repeat(600)], '海边的第七封信.txt', { type: 'text/plain' }));
      window.__DRAG_DATA__ = dt;
      document.querySelector('.wx-root').dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    check('拖入真实文件展示接收区域', await page.locator('.wx-drop-zone').isVisible());
    await page.screenshot({ path: path.join(OUTPUT, 'wechat-layout-desktop-drop.png'), animations: 'disabled' });
    await page.evaluate(() => document.querySelector('.wx-root').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__DRAG_DATA__ })));
    await page.waitForFunction(() => window.__APP_PROXY__.wechatPendingDocument && !window.__APP_PROXY__.isWechatDocumentPreparing);
    check('拖入仅准备文件，不自动发送或请求模型', await page.locator('.wx-document-pending').isVisible() && requests.length === 0);
    await page.evaluate(() => {
      const r = window.__APP_PROXY__, ts = Date.now() - 120000;
      r.wechatTimeline.push({ id: 'intro-u', ts, channel: 'wechat', role: 'user', type: 'text', content: '给你本小说。' }, { id: 'intro-a', ts: ts + 30000, channel: 'wechat', role: 'assistant', type: 'text', content: '好，发来我看看。' });
      r.wechatInput = '这是我最近在看的那本。';
    });
    await page.locator('.wx-send').click(); await page.waitForFunction(() => !window.__APP_PROXY__.isWechatGenerating && window.__APP_PROXY__.wechatTimeline.some(item => item.type === 'document'));
    check('拖入附件实际发送并显示文件卡片', await page.locator('.wx-document-card').count() === 1 && (await page.locator('.wx-document-card strong').textContent()).includes('海边'));
    // A raster with no MIME is common when dragging from Windows Explorer.
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
      canvas.getContext('2d').fillRect(0, 0, 8, 8);
      const dt = new DataTransfer(), bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0));
      dt.items.add(new File([bytes], '照片.png'));
      document.querySelector('.wx-root').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await page.waitForFunction(() => !!window.__APP_PROXY__.wechatPendingImage);
    check('MIME 空的拖入图片仍走图片压缩流程', await page.locator('.wx-pending img').isVisible());
    await page.evaluate(() => window.__APP_PROXY__.removeWechatPendingImage());
    for (const width of [320, 375, 430, 768, 1366]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.evaluate(() => {
        const root = document.querySelector('.wx-root'), composer = document.querySelector('.wx-composer'), input = document.querySelector('.wx-input'), send = document.querySelector('.wx-send');
        const ir = input.getBoundingClientRect(), sr = send.getBoundingClientRect();
        return { root: root.scrollWidth, composer: composer.scrollWidth, viewport: window.innerWidth, inputWidth: ir.width, inputHeight: ir.height, sendHeight: sr.height, overlap: ir.right > sr.left && ir.bottom > sr.top && ir.top < sr.bottom,
          cards: [...document.querySelectorAll('.wx-document-card')].every(card => card.scrollWidth <= card.clientWidth + 1) };
      });
      check(`${width}px 没有横向溢出、文件排版完整`, layout.root <= width && layout.composer <= width && layout.cards);
      check(`${width}px 输入框可用且与发送按钮不重叠`, layout.inputWidth >= 100 && !layout.overlap);
      if (width === 430 || width === 1366) await page.screenshot({ path: path.join(OUTPUT, `wechat-layout-${width === 430 ? 'mobile' : 'desktop'}.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width: 375, height: 640 });
    await page.locator('.wx-input').fill('第一行\n第二行\n第三行\n第四行\n第五行');
    check('手机输入框随多行文字增长', await page.locator('.wx-input').evaluate(el => el.clientHeight > 80 && el.clientHeight <= 128));
    await page.locator('.wx-input').fill(''); await page.waitForFunction(() => document.querySelector('.wx-input').clientHeight < 50);
    check('清空文字恢复单行高度', true);
    await page.locator('.wx-document-card').click();
    await page.waitForSelector('.wx-document-text');
    check('文件预览使用页码和阅读进度，隐藏内部块号', !(await page.locator('.wx-document-position').textContent()).includes('块') && await page.locator('.wx-document-preview').evaluate(el => el.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: path.join(OUTPUT, 'wechat-layout-mobile-document.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '关闭文件' }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check('尊重系统减少动态效果设置', await page.locator('.wx-bubble').first().evaluate(el => getComputedStyle(el).animationName === 'none'));
    // Generation lock and multiple files must not silently replace existing attachments.
    await page.evaluate(() => {
      const dt = new DataTransfer(); dt.items.add(new File(['a'], 'a.txt')); dt.items.add(new File(['b'], 'b.txt'));
      document.querySelector('.wx-root').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    check('多个文件拖入明确拒绝，不静默取第一个', await page.evaluate(() => !window.__APP_PROXY__.wechatPendingDocument));
    await page.evaluate(async () => {
      const dt = new DataTransfer(); dt.items.add(new File(['a'], 'a.txt'));
      document.querySelector('.wx-root').dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await window.__APP_PROXY__.closeWechat(); await window.__APP_PROXY__.openWechat();
    });
    check('关闭重开后拖拽提示复位', await page.locator('.wx-drop-zone').count() === 0);
    check('零 JavaScript 错误', errors.length === 0);
    console.log(`WECHAT LAYOUT E2E: PASS (${checks} checks)`);
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
