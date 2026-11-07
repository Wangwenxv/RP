// 隔离浏览器 + 假 API，验证真实 RP 生成降级和原 UI 的桌面/移动端表现。
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), OUTPUT = path.join(ROOT, '.refactor-tmp/memory-recall');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': `${mime[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
  fs.createReadStream(file).pipe(res);
});
(async () => {
  let browser;
  const errors = [], requests = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.mkdirSync(OUTPUT, { recursive: true });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.marked = { use() {}, parse(text) { return String(text); } };
      window.DOMPurify = { sanitize(text) { return String(text); } };
    });
    await page.route('**/assets/js/app.js?*', route => route.fulfill({ contentType: 'text/javascript',
      body: fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8')
        .replace('const __s = {};', 'const __s = window.__MEMORY_SCOPE__ = {};')
        .replace("app.mount('#app');", "window.__APP_PROXY__ = app.mount('#app');") }));
    await page.route('https://mock.local/**', async route => {
      const req = route.request(), body = req.postDataJSON();
      if (body) requests.push({ url: req.url(), body });
      if (req.url().endsWith('/embeddings')) return route.fulfill({ status: 400, contentType: 'application/json',
        body: JSON.stringify({ error: { message: '所选向量模型不可用（模拟接口故障）' } }) });
      if (!body) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        choices: [{ message: { role: 'assistant', content: body.model === 'summary-test' ? '最新一轮的简短总结' : '总结保留，继续聊天。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load', timeout: 45000 });
    await page.waitForFunction(() => window.__APP_PROXY__ && window.__MEMORY_SCOPE__._initComplete, { timeout: 20000 });
    await page.evaluate(async () => {
      const s = window.__MEMORY_SCOPE__, app = window.__APP_PROXY__;
      app.showUserSetupModal = false;
      s.characters.value.push({ uuid: 'memory-smoke', name: '记忆验证角色', description: '记忆验证', first_mes: '', avatar: '' });
      await app.selectCharacter(s.characters.value.length - 1, false, { silent: true });
      Object.assign(s.settings, { apiUrl: 'https://mock.local/v1', apiKey: 'fixture', model: 'main-test', stream: false,
        uiTemplateEnabled: false, activeToolsEnabled: false });
      Object.assign(s.memorySettings, { enabled: true, mode: 'enhanced', embeddingModel: 'vector-test', classicModel: 'summary-test', summaryKeepFloors: 20 });
      s.presets.value = []; s.worldInfo.value = [];
      s.chatHistory.value = []; s.classicMemories.value = [];
      for (let turn = 1; turn <= 14; turn++) {
        s.chatHistory.value.push({ id: `u-${turn}`, role: 'user', content: `用户${turn}` },
          { id: `a-${turn}`, role: 'assistant', content: `OLD_AI_TEXT_${turn}` });
        s.classicMemories.value.push({ id: `m-${turn}`, turn, summary: `OLD_MEM_SUMMARY_${turn}`, classicMemory: true, enabled: true,
          sourceUserIds: [`u-${turn}`], sourceAssistantIds: [`a-${turn}`], sourceUserText: `用户${turn}`,
          ...window.RPHubMemoryUtils.quantizeEmbeddingForStorage([1, 0]), embeddingModel: 'vector-test', embeddingApiUrl: s.settings.apiUrl });
      }
      s.chatHistory.value.push({ id: 'latest', role: 'user', content: '记得之前发生的事情吗？' });
      await Vue.nextTick(); await s.generateResponse();
    });
    await page.waitForFunction(() => !window.__MEMORY_SCOPE__.isClassicBatchExtracting.value);
    const main = requests.find(req => req.body.model === 'main-test');
    assert.ok(main, '向量接口失败后仍请求主聊天模型');
    assert.ok(main.body.messages.some(message => String(message.content).includes('OLD_MEM_SUMMARY_1')));
    assert.ok(!main.body.messages.some(message => String(message.content).includes('OLD_AI_TEXT_1\n') || message.content === 'OLD_AI_TEXT_1'));
    assert.equal(requests.filter(req => req.url.endsWith('/embeddings')).length, 1);
    assert.equal(await page.evaluate(() => window.__MEMORY_SCOPE__.chatHistory.value.at(-1).content), '总结保留，继续聊天。');
    console.log('PASS 向量故障后主请求正常发送，旧AI原文由总结替换，聊天原文仍保留');
    await page.evaluate(async () => {
      const s = window.__MEMORY_SCOPE__;
      s.chatHistory.value.push({ id: 'latest-2', role: 'user', content: '继续' }); await s.generateResponse();
      window.__APP_PROXY__.currentView = 'memory'; window.__APP_PROXY__.showMemorySettings = true;
    });
    await page.waitForFunction(() => !window.__MEMORY_SCOPE__.isClassicBatchExtracting.value);
    assert.equal(requests.filter(req => req.url.endsWith('/embeddings')).length, 1);
    const status = page.locator('[role="status"]').filter({ hasText: '向量增强暂不可用，总结仍可使用' });
    await status.waitFor({ state: 'visible' }); assert.match(await status.innerText(), /模拟接口故障/);
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.entry-transition')).opacity) === 0);
    await status.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(OUTPUT, 'desktop.png') });
    console.log('PASS 冷却期间继续聊天不重复调用向量；设置页显示具体故障原因');
    await page.setViewportSize({ width: 390, height: 844 }); await status.scrollIntoViewIfNeeded();
    const box = await status.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 391);
    await page.screenshot({ path: path.join(OUTPUT, 'mobile.png') });
    await page.getByRole('button', { name: '下次请求重试', exact: true }).click();
    await status.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '切换到基础模式', exact: true }).click();
    await page.evaluate(async () => {
      const s = window.__MEMORY_SCOPE__; s.chatHistory.value.push({ id: 'latest-3', role: 'user', content: '基础模式继续' });
      await s.generateResponse();
    });
    assert.equal(requests.filter(req => req.url.endsWith('/embeddings')).length, 1);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS 移动端提示在视口内、重试按钮有效、基础模式无向量请求、无JS运行时错误');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
