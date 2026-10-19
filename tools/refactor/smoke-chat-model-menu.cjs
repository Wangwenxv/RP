// 冒烟测试：聊天输入框左侧的模型下拉菜单（搜索 / 分类 / 直接切换模型）
// 断言：
//   1. 快捷面板里不再有「槽位」列表
//   2. 模型下拉可打开、可搜索、可分类过滤
//   3. 点击模型后 settings.model 变化、菜单收起、按钮文案更新
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 18155;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const MODELS = [
  'gpt-5.2', 'gpt-5.2-mini', 'claude-sonnet-4.5', 'claude-opus-4.1',
  'gemini-3.0-pro', 'gemini-3.0-flash', 'deepseek-v4.1', 'qwen3.7-plus',
  'glm-5.3-max', 'gpt-6.1-sol', 'kimi-k3', 'o4-mini'
];

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
};

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) errors.push('[console] ' + m.text()); });

  await page.addInitScript(() => {
    // CDN 偶发拉不到时兜底，避免 marked 未定义打断 app 启动
    window.marked = window.marked || { use() { }, parse(t) { return String(t); } };
    window.DOMPurify = window.DOMPurify || { sanitize(t) { return String(t); } };
    let _v;
    Object.defineProperty(window, 'Vue', {
      configurable: true, get() { return _v; },
      set(v) {
        _v = v;
        if (v && v.createApp && !v.createApp.__wrapped) {
          const o = v.createApp;
          const w = function (...a) {
            const app = o.apply(this, a);
            const m = app.mount;
            app.mount = function (...mm) { const r = m.apply(this, mm); window.__APP_PROXY__ = r; return r; };
            return app;
          };
          w.__wrapped = true; v.createApp = w;
        }
      }
    });
  });

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 30000 });
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    ready = await page.evaluate(() => !!(window.__APP_PROXY__ && Array.isArray(window.__APP_PROXY__.characters)));
    if (!ready) await page.waitForTimeout(250);
  }
  if (!ready) throw new Error('APP PROXY 未就绪 :: ' + errors.join(' | '));

  await page.evaluate(async (models) => {
    const root = window.__APP_PROXY__;
    root.showUserSetupModal = false;
    root.settings.apiUrl = 'https://mock.local/v1';
    root.settings.apiKey = 'k';
    root.settings.model = 'gpt-5.2';
    root.availableModels = models.map(id => ({ id, object: 'model' }));
    root.characters.push({
      name: '测试角色', description: '用于冒烟', personality: '安静', first_mes: '你好',
      avatar: '', uuid: 'menu-test-1', createdAt: Date.now()
    });
    await root.selectCharacter(root.characters.length - 1, false, { silent: true });
    root.currentView = 'chat';
  }, MODELS);
  await page.waitForTimeout(600);

  // 1) 工具栏：模型按钮存在且显示当前模型
  const trigger = page.locator('[aria-label="当前聊天模型"]');
  check('工具栏出现模型下拉按钮', await trigger.count() === 1);
  check('按钮显示当前模型', (await trigger.innerText()).includes('gpt-5.2'), await trigger.innerText());

  await page.screenshot({ path: path.join(__dirname, 'chat-model-menu-closed.png') });

  // 2) 打开下拉
  await trigger.click();
  await page.waitForTimeout(350);
  const menu = page.locator('#chat-model-menu');
  check('下拉菜单打开', await menu.count() === 1);
  const modelItems = menu.locator('button[title][aria-pressed]');
  const itemCount = await modelItems.count();
  check('列出拉取到的模型', itemCount === MODELS.length, `count=${itemCount}`);
  await page.screenshot({ path: path.join(__dirname, 'chat-model-menu-open.png') });

  // 3) 搜索
  await menu.locator('input[aria-label="搜索模型"]').fill('gemini');
  await page.waitForTimeout(200);
  const searched = await modelItems.count();
  check('搜索 gemini 过滤生效', searched === 2, `count=${searched}`);

  // 4) 分类标签（chips）
  await menu.locator('input[aria-label="搜索模型"]').fill('');
  await page.waitForTimeout(150);
  const chipGemini = menu.locator('button', { hasText: 'GEMINI' }).first();
  await chipGemini.click();
  await page.waitForTimeout(200);
  const tagged = await modelItems.count();
  check('GEMINI 分类过滤生效', tagged === 2, `count=${tagged}`);

  // 5) 选择模型
  await menu.locator('button[title="gemini-3.0-flash"][aria-pressed]').click();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    model: window.__APP_PROXY__.settings.model,
    quality: window.__APP_PROXY__.settings.qualityModel,
    menuOpen: window.__APP_PROXY__.showChatModelMenu
  }));
  check('点击后 settings.model 切换', after.model === 'gemini-3.0-flash', after.model);
  check('qualityModel 跟随同步', after.quality === 'gemini-3.0-flash', after.quality);
  check('选择后菜单收起', after.menuOpen === false);
  check('按钮文案更新', (await trigger.innerText()).includes('gemini-3.0-flash'), await trigger.innerText());

  // 6) 快捷面板不再有槽位
  await page.locator('[aria-controls="chat-quick-panel"]').click();
  await page.waitForTimeout(300);
  const panelText = await page.locator('#chat-quick-panel').innerText();
  check('快捷面板已移除槽位列表', !panelText.includes('槽位'), panelText.split('\n').slice(0, 6).join(' / '));
  check('快捷面板保留其它开关', panelText.includes('推理强度') && panelText.includes('压缩上下文'));
  await page.screenshot({ path: path.join(__dirname, 'chat-quick-panel-after.png') });

  // 7) 点空白处关闭模型菜单
  await page.locator('[aria-controls="chat-quick-panel"]').click();
  await page.waitForTimeout(200);
  await trigger.click();
  await page.waitForTimeout(250);
  await page.mouse.click(200, 300);
  await page.waitForTimeout(250);
  const closedByOutside = await page.evaluate(() => window.__APP_PROXY__.showChatModelMenu);
  check('点击外部关闭模型菜单', closedByOutside === false);

  // 7.5) Esc 关闭；与快捷面板互斥
  await trigger.click();
  await page.waitForTimeout(250);
  await menu.locator('input[aria-label="搜索模型"]').press('Escape');
  await page.waitForTimeout(200);
  check('Esc 关闭模型菜单', (await page.evaluate(() => window.__APP_PROXY__.showChatModelMenu)) === false);

  await trigger.click();
  await page.waitForTimeout(250);
  await page.locator('[aria-controls="chat-quick-panel"]').click();
  await page.waitForTimeout(250);
  const mutual = await page.evaluate(() => ({ menu: window.__APP_PROXY__.showChatModelMenu, panel: window.__APP_PROXY__.showChatModelSelector }));
  check('打开快捷面板时收起模型菜单', mutual.menu === false && mutual.panel === true, JSON.stringify(mutual));

  // 8) 移动端：菜单不出屏、工具栏不溢出
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  await trigger.click();
  await page.waitForTimeout(300);
  const box = await menu.boundingBox();
  check('移动端菜单在视口内', !!box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  const gearBox = await page.locator('[aria-controls="chat-quick-panel"]').boundingBox();
  check('移动端工具栏未溢出', !!gearBox && gearBox.x + gearBox.width <= 390);
  await page.screenshot({ path: path.join(__dirname, 'chat-model-menu-mobile.png') });

  check('无 JS 运行时错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  server.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('SMOKE CRASH:', e); server.close(); process.exit(2); });
