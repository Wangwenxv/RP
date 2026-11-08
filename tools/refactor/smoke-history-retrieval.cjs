// Real Vue / Edge / IndexedDB, fixture API only: compressed history, request logs, search/read and clearing.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), OUT = path.join(ROOT, '.refactor-tmp/history-retrieval');
const requests = [], logs = [], logJobs = [], errors = []; let browser, page, stage = 'rp', checks = 0;
const check = (label, value) => { assert.ok(value, label); checks++; console.log('PASS ' + label); };
const server = http.createServer((req, res) => {
  const name = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0], file = path.resolve(ROOT, '.' + decodeURIComponent(name));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res);
});
(async () => {
  fs.mkdirSync(OUT, { recursive: true }); await new Promise(done => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ channel: 'msedge', headless: true }); page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'info' && message.text().startsWith('[模型请求]')) logJobs.push(message.args()[1].jsonValue().then(value => logs.push(value))); });
  await page.addInitScript(() => localStorage.setItem('roleplay_hub_update_id', '99999'));
  await page.route('**/*', route => ['fetch', 'xhr'].includes(route.request().resourceType()) && new URL(route.request().url()).hostname !== '127.0.0.1'
    ? route.fulfill({ contentType: 'application/json', body: '{"data":[],"quota":0}' }) : route.continue());
  await page.route('**/assets/js/app.js?*', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8')
    .replace('const __s = {};', 'const __s = window.__HISTORY_SCOPE__ = {};').replace("app.mount('#app');", "window.__APP_PROXY__ = app.mount('#app');") }));
  await page.route('https://mock.local/**', async route => {
    const body = route.request().postDataJSON(); if (!body) return route.fulfill({ contentType: 'application/json', body: '{"data":[]}' });
    requests.push(body);
    if (route.request().url().endsWith('/embeddings')) throw new Error('本地关键词检索不应请求向量');
    const toolResults = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    const unpack = result => Array.isArray(result.results) && result.results[0]?.status ? result.results[0] : result;
    const values = toolResults.map(unpack), found = values.find(result => Array.isArray(result.results) && result.results.some(hit => hit.recordId));
    const read = values.find(result => typeof result.text === 'string' && result.recordId);
    let message = { role: 'assistant', content: '继续此刻的剧情。' };
    const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id: `history-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    if (body.model === 'summary-test') message.content = '钥匙与雨伞借用事件的概要。';
    else if (['rp', 'wechat'].includes(stage)) {
      if (!found) message = call('tool_search_history', { query: stage === 'rp' ? '钥匙' : '雨伞', channel: stage === 'rp' ? 'rp' : 'wechat' });
      else if (!read) {
        const hit = found.results.find(hit => stage === 'rp' ? hit.recordId === 'rp:a1' : hit.role === 'user');
        assert.ok(hit, '真实原文命中'); message = call('tool_read_history', { recordId: hit.recordId, startChar: hit.startChar, length: 1800 });
      } else message.content = stage === 'rp' ? '她核对了借用记录，钥匙编号是 K731。' : '{"messages":[{"type":"text","content":"只是借伞，我记得。"}]}';
    } else if (stage === 'wechat-clear') message.content = '{"messages":[{"type":"text","content":"新的对话。"}]}';
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__HISTORY_SCOPE__?._initComplete && window.__APP_PROXY__);
  await page.locator('.entry-transition').waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const s = window.__HISTORY_SCOPE__, app = window.__APP_PROXY__;
    app.showUserSetupModal = false; s.user.name = '陈璃';
    s.characters.value.push({ uuid: 'history-fixture', name: '苏祈雪', first_mes: '开场', wechatEnabled: true, wechatSpeed: 'fast' });
    await app.selectCharacter(0, false, { silent: true });
    await s.ensureStoryRecapLoaded(); await s.ensureRecapKeepSettingsLoaded();
    await s.setRecapKeepSettings({ rpTurns: 0, wechatCount: 0 });
    Object.assign(s.settings, { apiUrl: 'https://mock.local/v1', apiKey: 'fixture-secret', model: 'rp-test', stream: false, uiTemplateEnabled: false });
    Object.assign(s.memorySettings, { enabled: true, mode: 'classic', classicModel: 'summary-test', summaryKeepFloors: 4 });
    s.presets.value = []; s.worldInfo.value = []; s.activeTools.value.forEach(tool => { tool.enabled = false; });
    s.startAutomaticMemoryPatrol = async () => {};
    s.chatHistory.value = [{ id: 'u1', role: 'user', content: '钥匙只是借用，我没有答应留宿。' }, { id: 'a1', role: 'assistant', content: '蓝色钥匙的编号是 K731，原约定周五晚上归还。' },
      { id: 'u2', role: 'user', content: '我去做别的事。' }, { id: 'a2', role: 'assistant', content: '她留在宿舍。' }];
    s.classicMemories.value = [{ id: 'm1', turn: 1, classicMemory: true, summary: 'MEMORY_SHORT 发生钥匙借用', sourceUserIds: ['u1'], sourceAssistantIds: ['a1'] }];
    s.replaceWechatTimeline([{ channel: 'rp', rpIndex: 0, rpMsgId: 'u1' }, { channel: 'rp', rpIndex: 1, rpMsgId: 'a1' },
      { id: 'w1', channel: 'wechat', role: 'assistant', type: 'text', content: '雨伞可以借我吗，周日还给你。' },
      { id: 'w2', channel: 'wechat', role: 'user', type: 'text', content: '只是借雨伞，我没有答应去你家。' },
      { channel: 'rp', rpIndex: 2, rpMsgId: 'u2' }, { channel: 'rp', rpIndex: 3, rpMsgId: 'a2' }]);
    s.replaceStoryRecap({ text: 'RECAP_SHORT 钥匙和雨伞的借用概要，细节未保留。', coversThroughTurn: 2, coversWechatCount: 2, keepRPTurns: 0, keepWechatCount: 0 });
    await s.saveWechatTimelineNow(); await s.saveStoryRecapNow();
    app.userInput = '那把钥匙的具体编号是什么？'; await app.sendMessage();
  });
  check('主模型首请求只带提要，未偷偷全量回灌被压缩细节', JSON.stringify(requests[0].messages).includes('RECAP_SHORT') && !JSON.stringify(requests[0].messages).includes('K731'));
  check('RP提要是无玩家姓名的程序资料，最新玩家输入仍具名', requests[0].messages.some(message => message.content.includes('【前情提要｜') && !Object.hasOwn(message, 'name') && message.content.includes('非玩家本轮发言'))
    && requests[0].messages.findLast(message => message.role === 'user').name === '陈璃');
  check('未开普通主动工具也有按需搜索/读取能力，未强迫模型调用', requests[0].tools.some(tool => tool.function.name === 'tool_search_history') && requests[0].tool_choice !== 'required');
  check('RP完整调用链：搜索→读回原文→回复，原生调用签名成对保留', requests.length === 3 && requests[2].messages.some(message => message.role === 'tool' && message.content.includes('K731')));
  check('玩家否定以原输入来源返回，不被摘要变成答应', JSON.stringify(requests[1].messages).includes('没有答应留宿') && JSON.stringify(requests[1].messages).includes('玩家原输入'));
  await Promise.all(logJobs); check('每个实际请求均有Console固定快照，messages与HTTP请求一致且无请求密钥', logs.length === requests.length && logs.every((log, index) => JSON.stringify(log.messages) === JSON.stringify(requests[index].messages)) && !JSON.stringify(logs).includes('fixture-secret'));
  stage = 'plain';
  await page.evaluate(async () => { const app = window.__APP_PROXY__; app.userInput = '继续当前的事情'; await app.sendMessage(); });
  check('新RP回合不重放上轮检索结果', !requests.at(-1).messages.some(message => message.role === 'tool'));
  await page.evaluate(async () => {
    const s = window.__HISTORY_SCOPE__, app = window.__APP_PROXY__, load = s.ensureStoryRecapLoaded;
    s.replaceStoryRecap(null, 'pending-fixture');
    s.ensureStoryRecapLoaded = async (...args) => { await new Promise(done => setTimeout(done, 80)); return load(...args); };
    try { app.userInput = '刚切回剧情，继续当前事情'; await app.sendMessage(); }
    finally { s.ensureStoryRecapLoaded = load; }
  });
  check('提要读取尚未结束时RP先等待，再组装压缩覆盖范围', JSON.stringify(requests.at(-1).messages).includes('RECAP_SHORT') && !JSON.stringify(requests.at(-1).messages).includes('原约定周五晚上归还'));
  const beforeCancelled = requests.length;
  await page.evaluate(async () => {
    const s = window.__HISTORY_SCOPE__, app = window.__APP_PROXY__, load = s.ensureStoryRecapLoaded;
    s.ensureStoryRecapLoaded = async () => { app.stopGeneration(); await new Promise(done => setTimeout(done, 30)); };
    try { app.userInput = '载入途中停止的输入'; await app.sendMessage(); }
    finally { s.ensureStoryRecapLoaded = load; }
  });
  check('载入提要途中停止不会发送请求，生成状态与计时器清理', requests.length === beforeCancelled && await page.evaluate(() => !window.__APP_PROXY__.isGenerating && !window.__HISTORY_SCOPE__.waitTimer));
  stage = 'wechat'; const beforeWechat = requests.length;
  await page.evaluate(async () => {
    const app = window.__APP_PROXY__, s = window.__HISTORY_SCOPE__, load = s.ensureStoryRecapLoaded;
    await app.openWechat(); s.replaceStoryRecap(null, 'pending-wechat-fixture');
    s.ensureStoryRecapLoaded = async (...args) => { await new Promise(done => setTimeout(done, 80)); return load(...args); };
    try { app.wechatInput = '之前借雨伞时，我有没有答应去你家？'; await app.sendWechatMessage(); }
    finally { s.ensureStoryRecapLoaded = load; }
  });
  check('微信也先等提要载入，再剔除已压缩原文并组装请求', JSON.stringify(requests[beforeWechat].messages).includes('RECAP_SHORT') && !JSON.stringify(requests[beforeWechat].messages).includes('雨伞可以借我吗，周日还给你'));
  check('微信提要不冠玩家姓名，也不发送内部来源标记', requests[beforeWechat].messages.some(message => message.content.includes('【前情提要｜') && !Object.hasOwn(message, 'name')
    && !Object.hasOwn(message, '_contextOrigin') && !Object.hasOwn(message, '_preventContextMerge')));
  check('微信也可从压缩前原文核对，三个请求完成后正常发气泡', requests.length === beforeWechat + 3 && requests.at(-1).messages.some(message => message.role === 'tool' && message.content.includes('没有答应去你家')) && await page.evaluate(() => window.__APP_PROXY__.wechatTimeline.at(-1).content === '只是借伞，我记得。'));
  await page.evaluate(async () => { await window.__APP_PROXY__.closeWechat(); await window.__APP_PROXY__.runStoryRecap(); });
  const summary = requests.at(-1); check('开记忆后提要仍使用完整原文，含编号与否定条件，未使用MEMORY_SHORT替代', summary.model === 'summary-test' && JSON.stringify(summary.messages).includes('K731') && JSON.stringify(summary.messages).includes('没有答应留宿') && !JSON.stringify(summary.messages).includes('MEMORY_SHORT'));
  await Promise.all(logJobs); check('前情提要请求也有相同messages调试快照', JSON.stringify(logs.at(-1).messages) === JSON.stringify(summary.messages));
  await page.evaluate(() => { const app = window.__APP_PROXY__; app.currentView = 'chat'; app.showChatModelSelector = true; });
  const debugToggle = page.getByRole('checkbox', { name: '模型请求调试' });
  await debugToggle.locator('..').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'debug-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 }); await debugToggle.locator('..').scrollIntoViewIfNeeded();
  check('请求调试开关沿用原快捷面板，在手机视口内', await debugToggle.locator('..').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
  await page.screenshot({ path: path.join(OUT, 'debug-mobile.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { window.__APP_PROXY__.showChatModelSelector = false; });
  await page.evaluate(() => { const app = window.__APP_PROXY__; app.currentView = 'memory'; app.showMemorySettings = true; });
  const toggle = page.getByRole('checkbox', { name: '压缩后原文检索' }); await toggle.waitFor({ state: 'attached' });
  await toggle.locator('..').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(OUT, 'desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 }); await toggle.locator('..').scrollIntoViewIfNeeded();
  check('原记忆设置里的开关在手机视口内', await toggle.locator('..').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
  await page.screenshot({ path: path.join(OUT, 'mobile.png'), animations: 'disabled' });
  stage = 'plain'; const beforeLogs = logs.length;
  await page.evaluate(async () => { const s = window.__HISTORY_SCOPE__, app = window.__APP_PROXY__; s.settings.debugModelRequests = false; s.settings.historyRetrievalEnabled = false; app.currentView = 'chat'; app.userInput = '关闭调试后的新请求'; await app.sendMessage(); });
  await Promise.all(logJobs); check('关闭两个开关后不记录请求、也不下发原文检索工具', logs.length === beforeLogs && !requests.at(-1).tools?.some(tool => tool.function.name.includes('_history')));
  await page.evaluate(async () => { const s = window.__HISTORY_SCOPE__, app = window.__APP_PROXY__; s.settings.historyRetrievalEnabled = true; await app.clearChat(); });
  await page.getByRole('button', { name: /清空全部 RP/ }).click(); await page.waitForFunction(() => !window.__APP_PROXY__.showConversationClear);
  stage = 'wechat-clear';
  await page.evaluate(async () => { const app = window.__APP_PROXY__; await app.openWechat(); app.wechatInput = '清空后的新话题'; await app.sendWechatMessage(); });
  check('清空后无旧原文/摘要，也不再下发无历史的检索工具', !/K731|RECAP_SHORT|没有答应留宿|MEMORY_SHORT/.test(JSON.stringify(requests.at(-1))) && !requests.at(-1).tools?.some(tool => tool.function.name.includes('_history')));
  check('0 JavaScript异常', errors.length === 0); console.log(`${checks}/${checks} passed`);
})().catch(async error => { console.error(error); console.error({ errors, requestCount: requests.length }); fs.writeFileSync(path.join(OUT, 'requests.json'), JSON.stringify(requests, null, 2)); if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') }); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); server.close(); });
