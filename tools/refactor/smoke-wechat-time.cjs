// Story time through the real Vue page: picker, grouping, model delays, persistence and mobile layout.
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
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"messages":[{"type":"text","content":"刚才在忙","delayMinutes":60},{"type":"text","content":"现在有空了"}]}' }, finish_reason: 'stop' }] }) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__LAYOUT_READY__, { timeout: 60000 });
    await page.evaluate(async () => {
      const r = window.__APP_PROXY__; r.showUserSetupModal = false; r.user.name = '我';
      r.characters.push({ uuid: 'layout-character', name: '林晚', description: '喜欢小说', first_mes: '你好', wechatEnabled: true, wechatSpeed: 'fast' });
      await r.selectCharacter(r.characters.length - 1, false, { silent: true }); r.settings.apiUrl = 'https://mock.local/v1'; r.settings.apiKey = 'fixture'; r.settings.model = 'mock'; await r.openWechat();
    });

    const wx = page.locator('.wx-root');
    fs.mkdirSync(OUTPUT, { recursive: true });
    await wx.getByRole('button', { name: '选择发送时间', exact: true }).click();
    check('发送时间选择沿用原有弹窗', await wx.getByRole('dialog', { name: '选择发送时间' }).isVisible());
    check('初始剧情时间使用固定默认日期', await page.evaluate(() => window.__APP_PROXY__.wechatClockLabel === '2025-03-11 18:30'));
    await wx.getByRole('button', { name: '＋ 添加标签', exact: true }).click();
    await wx.getByLabel('快捷标签分钟数').fill('15');
    await wx.getByRole('button', { name: '保存标签', exact: true }).click();
    check('添加分钟数自动生成快捷标签名称', await wx.getByRole('button', { name: '15 分钟后', exact: true }).isVisible());
    await wx.getByRole('button', { name: '编辑标签 15 分钟后', exact: true }).click();
    await wx.getByLabel('快捷标签分钟数').fill('60');
    await wx.getByLabel('快捷标签名称').fill('等一小时');
    await wx.getByRole('button', { name: '保存标签', exact: true }).click();
    check('编辑标签更新名称和实际分钟数', await wx.getByRole('button', { name: '等一小时', exact: true }).isVisible() && await page.evaluate(() => window.__APP_PROXY__.wechatTimeTags.at(-1).minutes === 60));
    await wx.getByRole('button', { name: '删除标签 5 分钟后', exact: true }).click();
    check('默认快捷标签也可删除', await wx.getByRole('button', { name: '5 分钟后', exact: true }).count() === 0);
    await wx.getByRole('button', { name: '完成管理', exact: true }).click();
    await wx.getByLabel('剧情发送日期时间').fill('2023-08-01T18:00');
    await wx.getByRole('button', { name: '使用这个时间', exact: true }).click();
    check('选时间不提前推进剧情钟', await page.evaluate(() => window.__APP_PROXY__.wechatSendAt === '2023-08-01T18:00:00' && !window.__APP_PROXY__.wechatClock.established));
    await page.evaluate(() => { window.__APP_PROXY__.wechatBurstMode = true; });
    for (const text of ['你在忙吗', '我想和你说点事']) {
      await wx.getByRole('textbox', { name: '微信消息', exact: true }).fill(text);
      await wx.getByRole('button', { name: '发送', exact: true }).click();
    }
    check('连发沿用同一时间并只有一个分隔', await page.locator('.wx-day').count() === 1 && await page.evaluate(() => !window.__APP_PROXY__.wechatSendAt));
    await wx.getByRole('button', { name: '选择发送时间', exact: true }).click();
    await wx.getByRole('button', { name: '等一小时', exact: true }).click();
    await wx.getByRole('textbox', { name: '微信消息', exact: true }).fill('现在呢');
    await wx.getByRole('button', { name: '发送', exact: true }).click();
    check('一小时后形成新的分隔', await page.locator('.wx-day').count() === 2 && await page.evaluate(() => window.__APP_PROXY__.wechatClockLabel === '2023-08-01 19:00'));
    await wx.getByRole('button', { name: /让对方回复/ }).click();
    await page.waitForFunction(() => !window.__APP_PROXY__.isWechatGenerating && window.__APP_PROXY__.wechatTimeline.some(item => item.role === 'assistant' && item.channel === 'wechat'));
    const history = requests[0].messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('你在忙吗'));
    check('真实 API 请求仍合并连发，变化处才有时间标记', history.length === 1 && (history[0].content.match(/【发送时间：/g) || []).length === 2 && history[0].content.includes('距上一条 1小时'));
    check('模型延迟一小时后连发，实际播放只等打字动画', await page.evaluate(() => window.__APP_PROXY__.wechatClockLabel === '2023-08-01 20:00') && await page.locator('.wx-day').count() === 3);
    await page.screenshot({ path: path.join(OUTPUT, 'wechat-time-desktop.png'), animations: 'disabled' });
    await wx.getByRole('button', { name: '选择发送时间', exact: true }).click();
    await wx.getByLabel('剧情发送日期时间').fill('2023-08-01T17:00');
    await wx.getByRole('button', { name: '使用这个时间', exact: true }).click();
    check('倒退时间在弹窗提示并保留选择', await wx.getByRole('alert').filter({ hasText: '不能早于' }).isVisible());
    await wx.getByRole('button', { name: '沿用当前时间', exact: true }).click();
    await page.evaluate(async () => { const r = window.__APP_PROXY__; await r.closeWechat(); await r.openWechat(); });
    check('关闭重开恢复已保存剧情钟和所有消息', await page.evaluate(() => window.__APP_PROXY__.wechatClockLabel === '2023-08-01 20:00' && window.__APP_PROXY__.wechatTimeline.filter(m => m.channel === 'wechat').length === 5));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__LAYOUT_READY__, { timeout: 60000 });
    await page.evaluate(async () => {
      const r = window.__APP_PROXY__; r.showUserSetupModal = false;
      if (!r.currentCharacter) { r.characters.push({ uuid: 'time-tags-reload', name: '林晚', first_mes: '你好', wechatEnabled: true }); await r.selectCharacter(r.characters.length - 1, false, { silent: true }); }
      await r.openWechat();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await wx.getByRole('button', { name: '选择发送时间', exact: true }).click();
    await page.waitForFunction(() => window.__APP_PROXY__.wechatTimeTagsLoaded);
    check('刷新页面恢复自定义标签与删除结果', await wx.getByRole('button', { name: '等一小时', exact: true }).isVisible() && await wx.getByRole('button', { name: '5 分钟后', exact: true }).count() === 0);
    await wx.getByRole('button', { name: '＋ 添加标签', exact: true }).click();
    check('手机标签编辑器没有横向溢出', await page.evaluate(() => { const e = document.querySelector('.wx-time-tag-editor'); return e.scrollWidth <= e.clientWidth + 1; }));
    await wx.getByLabel('快捷标签分钟数').fill('90');
    await page.screenshot({ path: path.join(OUTPUT, 'wechat-time-mobile-tags.png'), animations: 'disabled' });
    await wx.getByRole('button', { name: '取消编辑', exact: true }).click();
    check('手机时间选择没有横向溢出', await page.evaluate(() => { const e = document.querySelector('.wx-time-modal'), r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && e.scrollWidth <= e.clientWidth + 1; }));
    await page.screenshot({ path: path.join(OUTPUT, 'wechat-time-mobile-picker.png'), animations: 'disabled' });
    await wx.getByRole('button', { name: '关闭时间选择', exact: true }).click();
    await page.screenshot({ path: path.join(OUTPUT, 'wechat-time-mobile.png'), animations: 'disabled' });
    check('手机输入区和时间按钮均可操作', await wx.getByRole('textbox', { name: '微信消息', exact: true }).isVisible() && await wx.getByRole('button', { name: '选择发送时间', exact: true }).isVisible());
    check('Vue 页面无运行时异常', errors.length === 0);
    console.log(`${checks} browser checks passed`);
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
