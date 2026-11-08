// 真实 Vue / IndexedDB / Edge：跨渠道清理、刷新、请求内容和菜单布局。
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), PORT = 18137;
const OUTPUT = path.join(ROOT, '.refactor-tmp');
fs.mkdirSync(OUTPUT, { recursive: true });
const server = http.createServer((req, res) => {
  const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
let browser, checks = 0;
const check = (label, value) => { assert.ok(value, label); checks++; console.log('PASS ' + label); };
(async () => {
  await new Promise(done => server.listen(PORT, '127.0.0.1', done));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('roleplay_hub_update_id', '99999');
    let vue;
    Object.defineProperty(window, 'Vue', { configurable: true, get: () => vue, set(value) {
      vue = value;
      if (value?.createApp && !value.createApp.wrapped) {
        const create = value.createApp;
        value.createApp = (...args) => {
          const app = create(...args), mount = app.mount;
          app.mount = (...args) => { const proxy = mount.apply(app, args); window.__APP_PROXY__ = proxy; return proxy; };
          return app;
        };
        value.createApp.wrapped = true;
      }
    } });
  });
  await page.route('**/chat/completions', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    const content = JSON.stringify({ messages: [{ type: 'text', content: '新的微信回复' }] });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }) });
  });
  const ready = () => page.waitForFunction(() => typeof window.__APP_PROXY__?.clearConversationContent === 'function', { timeout: 30000 });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' }); await ready();
  await page.locator('.entry-transition').waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const s = window.__APP_PROXY__;
    s.showUserSetupModal = false; s.user.name = '测试玩家';
    s.characters.push({ uuid: 'clear-fixture', name: '清空测试角色', first_mes: '固定新开场', wechatEnabled: true, wechatSpeed: 'fast' });
    s.settings.apiUrl = 'https://mock.local/v1'; s.settings.apiKey = 'fixture'; s.settings.model = 'mock';
    s.memorySettings.enabled = false;
    await s.selectCharacter(0, false, { silent: true }); await s.openWechat();
    window.seedClearFixture = async (withLastWechat = true) => {
      s.chatHistory = [
        { id: 'opening', role: 'assistant', content: '固定新开场' },
        { id: 'u1', role: 'user', content: 'PREV_RP 玩家旧剧情' }, { id: 'a1', role: 'assistant', content: 'PREV_RP_REPLY 角色旧回应' },
        { id: 'u2', role: 'user', content: 'CURRENT_RP 玩家本段剧情' }, { id: 'a2', role: 'assistant', content: 'CURRENT_RP_REPLY 角色本段回应' }
      ];
      const mirror = i => ({ id: 'r' + i, rpIndex: i, rpMsgId: s.chatHistory[i].id, channel: 'rp', role: s.chatHistory[i].role, type: 'text', content: s.chatHistory[i].content });
      const wx = (id, content) => ({ id, channel: 'wechat', role: 'user', type: 'text', content });
      s.wechatTimeline = [mirror(0), mirror(1), mirror(2), wx('w1', 'PREV_WX 较早微信'), mirror(3), mirror(4)];
      if (withLastWechat) s.wechatTimeline.push(wx('w2', 'CURRENT_WX 本段微信'));
      const turns = window.RPHubContextUtils.buildConversationTurnSnapshot(s.chatHistory).turns;
      s.classicMemories = turns.map(turn => ({ id: 'm' + turn.turn, turn: turn.turn, summary: 'OLD_MEMORY_' + turn.turn }));
      s.storyRecap = { text: 'OLD_RECAP 含全部旧剧情与本段微信', coversThroughTurn: turns.length, coversWechatCount: withLastWechat ? 2 : 1, keepRPTurns: 0, keepWechatCount: 0 };
      await window.RPHubStorage.setScopedStoredValues('clear-fixture', { chat: s.chatHistory, classic_memories: s.classicMemories, wechat_timeline: s.wechatTimeline, story_recap: s.storyRecap });
    };
    await window.seedClearFixture();
    await window.RPHubStorage.setScopedStoredValue('chat', 'other-branch', [{ content: 'OTHER_BRANCH' }]);
  });
  await page.locator('[aria-label="清空微信记录"]').click();
  await page.getByRole('dialog', { name: '清空聊天内容' }).waitFor();
  check('微信垃圾桶打开两个范围选项', await page.getByRole('button', { name: /清空本段微信/ }).count() === 1 && await page.getByRole('button', { name: /清空全部 RP/ }).count() === 1);
  await page.screenshot({ path: path.join(OUTPUT, 'clear-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  check('手机宽度下菜单未溢出', await page.getByRole('dialog', { name: '清空聊天内容' }).evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
  await page.screenshot({ path: path.join(OUTPUT, 'clear-mobile.png') });
  await page.getByRole('button', { name: /清空本段微信/ }).click();
  await page.waitForFunction(() => !window.__APP_PROXY__.showConversationClear);
  const segment = await page.evaluate(() => ({ history: window.__APP_PROXY__.chatHistory, timeline: window.__APP_PROXY__.wechatTimeline, recap: window.__APP_PROXY__.storyRecap }));
  check('微信本段删除 CURRENT_WX，保留上轮 RP 和较早微信', !JSON.stringify(segment.timeline).includes('CURRENT_WX') && JSON.stringify(segment.timeline).includes('CURRENT_RP_REPLY') && JSON.stringify(segment.timeline).includes('PREV_WX'));
  check('涉及删除内容的提要已作废', segment.recap === null);
  await page.evaluate(async () => { const s = window.__APP_PROXY__; s.wechatInput = 'NEW_WX 清理后的新问题'; await s.sendWechatMessage(); });
  check('下次微信请求没有被清除的本段或旧提要', requests.length > 0 && !/CURRENT_WX|OLD_RECAP/.test(JSON.stringify(requests.at(-1))));

  await page.evaluate(async () => { await window.seedClearFixture(false); await window.__APP_PROXY__.closeWechat(); await window.__APP_PROXY__.clearChat(); });
  await page.getByRole('button', { name: /清空本段 RP/ }).click();
  await page.waitForFunction(() => !window.__APP_PROXY__.showConversationClear);
  const rpSegment = await page.evaluate(() => ({ history: window.__APP_PROXY__.chatHistory, memory: window.__APP_PROXY__.classicMemories, timeline: window.__APP_PROXY__.wechatTimeline }));
  check('RP 本段保留较早 RP/微信，移除本段正文和镜像', /PREV_RP/.test(JSON.stringify(rpSegment.history)) && /PREV_WX/.test(JSON.stringify(rpSegment.timeline)) && !/CURRENT_RP/.test(JSON.stringify(rpSegment)));
  check('RP 本段对应的记忆已裁剪', rpSegment.memory.length < 3 && rpSegment.memory.length > 0);

  await page.evaluate(async () => { const s = window.__APP_PROXY__; await s.openWechat(); await window.seedClearFixture();
    await window.RPHubStorage.setScopedStoredValue('wechat_media_tasks', 'clear-fixture', [{ id: 'old-task', scopeId: 'clear-fixture', status: 'failed' }]);
    s.storyRecap = null; await s.clearChat();
  });
  await page.getByRole('button', { name: /清空全部 RP/ }).click();
  await page.waitForFunction(() => !window.__APP_PROXY__.showConversationClear);
  const all = await page.evaluate(async () => {
    const s = window.__APP_PROXY__, S = window.RPHubStorage;
    return { history: s.chatHistory, memory: s.classicMemories, timeline: s.wechatTimeline, recap: s.storyRecap,
      storedRecap: await S.getScopedStoredValue('story_recap', 'clear-fixture'), tasks: await S.getScopedStoredValue('wechat_media_tasks', 'clear-fixture'),
      other: await S.getScopedStoredValue('chat', 'other-branch') };
  });
  check('全部清空回到开场，RP/微信/记忆/磁盘提要/任务一起清空', all.history.length === 1 && all.history[0].content === '固定新开场' && !all.memory.length && !all.timeline.length && all.recap === null && all.storedRecap === null && !all.tasks.length);
  check('其它分支记录保留', all.other[0].content === 'OTHER_BRANCH');
  await page.reload({ waitUntil: 'load' }); await ready();
  await page.waitForFunction(() => window.__APP_PROXY__.currentCharacter?.uuid === 'clear-fixture');
  const beforeReloadRequest = requests.length;
  await page.evaluate(async () => { const s = window.__APP_PROXY__; await s.openWechat(); s.wechatInput = 'AFTER_RELOAD 全新微信问题'; await s.sendWechatMessage(); });
  check('刷新并重开微信后，模型请求没有旧剧情/旧记忆/旧提要', requests.length > beforeReloadRequest && !/PREV_RP|PREV_WX|CURRENT_RP|CURRENT_WX|OLD_MEMORY|OLD_RECAP/.test(JSON.stringify(requests.at(-1))));
  await page.evaluate(async () => { const s = window.__APP_PROXY__; await s.closeWechat(); s.userInput = 'AFTER_CLEAR_RP 全新RP问题'; await s.sendMessage(); });
  check('微信返回 RP 后，请求同样没有旧正文或摘要', !/PREV_RP|PREV_WX|CURRENT_RP|CURRENT_WX|OLD_MEMORY|OLD_RECAP/.test(JSON.stringify(requests.at(-1))));
  check('无 JavaScript 异常', !errors.length);
  console.log(`${checks}/${checks} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); server.close(); });
