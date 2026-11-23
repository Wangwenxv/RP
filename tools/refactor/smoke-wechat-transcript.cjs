// 真实 Vue 页面、系统剪贴板与桌面/手机顶栏验证；不请求模型和媒体服务。
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), OUTPUT = path.join(ROOT, '.refactor-tmp');
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.resolve(ROOT, '.' + (url === '/' ? '/index.html' : url));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
let checks = 0;
const check = (name, ok) => { assert.ok(ok, name); checks++; console.log('PASS ' + name); };
(async () => {
  let browser;
  const errors = [], requests = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const Renderer = function () {};
      Renderer.prototype.link = (href, title, text) => String(text || '');
      Renderer.prototype.html = token => String(typeof token === 'string' ? token : token?.text || '');
      window.marked = { use() {}, parse: text => String(text), Renderer };
      window.DOMPurify = { sanitize: text => String(text) };
      let value;
      Object.defineProperty(window, 'Vue', { configurable: true, get: () => value, set(v) {
        value = v; if (!v?.createApp || v.createApp.__transcriptTest) return;
        const mounted = v.onMounted;
        v.onMounted = (hook, ...args) => { const root = !v.getCurrentInstance()?.parent;
          return mounted(async (...args) => { await hook(...args); if (root) window.__TRANSCRIPT_READY__ = true; }, ...args); };
        const createApp = v.createApp;
        v.createApp = (...args) => { const app = createApp(...args), mount = app.mount;
          app.mount = (...args) => { const r = mount.apply(app, args); window.__APP_PROXY__ = r; return r; }; return app; };
        v.createApp.__transcriptTest = true;
      } });
    });
    await page.route('**/chat/completions', route => { requests.push(route.request().url()); return route.abort(); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__TRANSCRIPT_READY__, { timeout: 60000 });
    await page.evaluate(async () => {
      const r = window.__APP_PROXY__; r.showUserSetupModal = false; r.user.name = '王文叙';
      r.characters.push({ uuid: 'transcript-character', name: '杨德兵', description: '测试角色', first_mes: '你好', wechatEnabled: true });
      await r.selectCharacter(r.characters.length - 1, false, { silent: true }); await r.openWechat();
    });
    const copy = page.getByRole('button', { name: '复制聊天记录', exact: true });
    check('空会话显示复制按钮并禁用', await copy.isVisible() && await copy.isDisabled());
    await page.evaluate(() => {
      const r = window.__APP_PROXY__, T = window.RPHubWeChatTime;
      const msg = (id, role, type, content, time, extra = {}) => ({ id, role, type, content, channel: 'wechat', storyAt: T.parse(time), ...extra });
      r.wechatTimeline.push(msg('text-a', 'user', 'text', '再试最后一次看看', '2026-11-20 17:43:50'),
        msg('rp', 'user', 'text', '剧情背景不能复制', '2026-11-20 17:44:00', { channel: 'rp' }),
        msg('text-b', 'user', 'text', '真的，感觉就是这个问题了', '2026-11-20 17:44:01'),
        msg('image-a', 'assistant', 'image', '', '2026-11-20 17:45:28', { media: { descriptionOnly: true, caption: '桌面上的门户配置截图' } }),
        msg('voice-a', 'assistant', 'voice', '语音正文不能复制', '2026-11-23 11:55:15', { voice: { duration: 12.1 } }),
        msg('text-c', 'user', 'text', '第一行\n第二行', '2026-11-23 12:01:22'),
        msg('system-a', 'system', 'text', '系统提示不能复制', '2026-11-23 12:01:22'));
      // 可见消息仅两条，复制仍包含窗口外历史。
      r.wechatDisplayLimit = 2;
    });
    check('有记录后按钮可点', await copy.isEnabled());
    await copy.click();
    await page.waitForFunction(() => !window.__APP_PROXY__.isWechatCopying);
    const expected = '王文叙 11/20 下午5:43:50\n再试最后一次看看\n\n'
      + '王文叙 11/20 下午5:44:01\n真的，感觉就是这个问题了\n\n'
      + '杨德兵 11/20 下午5:45:28\n【image：桌面上的门户配置截图】\n\n'
      + '杨德兵 11/23 上午11:55:15\n【语音 13秒】\n\n'
      + '王文叙 11/23 下午12:01:22\n第一行\n第二行';
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(clipboard.replace(/\r\n/g, '\n'), expected);
    check('实际点击写入系统剪贴板，逐字匹配格式且包括窗口外历史', true);
    check('排除 RP、系统提示、语音正文和资源链接', !/剧情背景不能复制|系统提示不能复制|语音正文不能复制|data:|blob:/.test(clipboard));
    check('未触发模型请求', requests.length === 0);
    // 展示全部少量测试消息，用于截图和单条复制回归。
    await page.evaluate(() => { window.__APP_PROXY__.wechatDisplayLimit = 80; });
    fs.mkdirSync(OUTPUT, { recursive: true });
    await page.screenshot({ path: path.join(OUTPUT, 'wechat-transcript-desktop.png'), animations: 'disabled' });
    const inBounds = () => page.evaluate(() => {
      const root = document.querySelector('.wx-root'), bar = root.querySelector('.wx-bar'), button = bar.querySelector('.wx-copy-records');
      const buttons = [...bar.querySelectorAll('button')].map(el => el.getBoundingClientRect());
      const b = button.getBoundingClientRect(), left = bar.querySelector('.wx-bar-left').getBoundingClientRect();
      return b.width >= 30 && b.height >= 36 && buttons.every(r => r.left >= 0 && r.right <= innerWidth)
        && left.right <= b.left && bar.scrollWidth <= bar.clientWidth && root.scrollWidth <= innerWidth;
    });
    check('桌面顶栏按钮和姓名区域不重叠', await inBounds());
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => { window.__APP_PROXY__.currentCharacter.wechatPeerName = '杨德兵（很长的微信备注）'; });
      check(`${width}px 手机顶栏无溢出和重叠，复制按钮可见`, await copy.isVisible() && await inBounds());
      if (width === 390) await page.screenshot({ path: path.join(OUTPUT, 'wechat-transcript-mobile.png'), animations: 'disabled' });
    }
    await page.evaluate(() => { window.__APP_PROXY__.currentCharacter.wechatPeerName = '杨德兵'; });
    await copy.click();
    await page.waitForFunction(() => !window.__APP_PROXY__.isWechatCopying);
    check('手机点击同样写入完整记录', (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n') === expected);
    const row = page.locator('.wx-row').filter({ hasText: '再试最后一次看看' });
    await row.locator('.wx-tool-btn').click();
    await page.locator('.wx-msg-menu').getByRole('button', { name: '复制', exact: true }).click();
    check('单条复制仍只复制正文', await page.evaluate(() => navigator.clipboard.readText()) === '再试最后一次看看');
    // 真实浏览器降级并核对输入框焦点、光标和临时节点清理。
    await page.locator('.wx-composer textarea').fill('草稿');
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      window.__FALLBACK_COPIES__ = [];
      const original = document.execCommand.bind(document);
      document.execCommand = command => { if (command === 'copy') window.__FALLBACK_COPIES__.push(document.activeElement.value); return original(command); };
      const input = document.querySelector('.wx-composer textarea'); input.focus(); input.setSelectionRange(1, 2);
    });
    const fallback = await page.evaluate(async () => {
      const before = document.querySelectorAll('textarea').length;
      await window.__APP_PROXY__.copyWechatTranscript();
      return { text: window.__FALLBACK_COPIES__.at(-1), cleaned: document.querySelectorAll('textarea').length === before,
        focused: document.activeElement.matches('.wx-composer textarea'), start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd };
    });
    assert.deepEqual(fallback, { text: expected, cleaned: true, focused: true, start: 1, end: 2 });
    check('降级复制逐字完整，移除临时节点并恢复草稿光标', true);
    check('页面无 JavaScript 错误', errors.length === 0);
    console.log(`ALL PASS (${checks} checks); screenshots: ${OUTPUT}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})();
