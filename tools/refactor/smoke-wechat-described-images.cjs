// Real Vue / IndexedDB / Edge. Model replies are fixtures; no image provider is used.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), OUTPUT = path.join(ROOT, '.refactor-tmp');
const DESCRIPTION = '北苑宿舍楼下，一盏路灯照亮潮湿的台阶，树影落在墙上。';
const requests = [], errors = [], providers = [];
let fixture = 'active', browser, page, checks = 0;
const check = (label, value) => { assert.ok(value, label); checks++; console.log('PASS ' + label); };
const server = http.createServer((req, res) => {
  const name = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.resolve(ROOT, '.' + decodeURIComponent(name));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  // Keep startup model/quota probes inside the fixture too; CDN scripts remain ordinary page assets.
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    return url.hostname !== '127.0.0.1' && ['fetch', 'xhr'].includes(request.resourceType())
      ? route.fulfill({ contentType: 'application/json', body: '{"data":[],"quota":0}' }) : route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem('roleplay_hub_update_id', '99999');
  });
  await page.route('**/assets/js/app.js?*', route => route.fulfill({ contentType: 'text/javascript',
    body: fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8')
      .replace('const __s = {};', 'const __s = window.__DESCRIBED_SCOPE__ = {};')
      .replace("app.mount('#app');", "window.__APP_PROXY__ = app.mount('#app');") }));
  await page.route('**/chat/completions', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    let message = { role: 'assistant', content: '{"messages":[]}' }, finishReason = 'stop';
    if (fixture === 'active') {
      message = { role: 'assistant', content: '她站在宿舍楼下，拿起手机，将眼前的路灯拍下来发给你。',
        tool_calls: [{ id: 'active-photo', type: 'function', function: { name: 'tool_wechat', arguments: JSON.stringify({ image: { mode: 'describe', description: DESCRIPTION }, sendAt: '2025-03-11 22:50', reason: '分享此刻看到的景色' }) } }] };
      finishReason = 'tool_calls';
    }
    if (fixture === 'album') message.content = JSON.stringify({ messages: [{ type: 'image_request', media: { mode: 'album', assetId: 'builtin-salad', description: '沙拉' } }] });
    if (fixture === 'missing') message.content = JSON.stringify({ messages: [{ type: 'image_request', media: { mode: 'album', assetId: 'missing-photo', description: '窗边的木桌上放着一杯热茶。' } }] });
    if (fixture === 'rp') message.content = '她收起手机，继续走向宿舍。';
    if (fixture === 'recap') message.content = '角色发来一张北苑宿舍路灯的描述型图片，之后又分享了一杯热茶的画面。';
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message, finish_reason: finishReason }] }) });
  });
  await page.route(/https:\/\/(?:commons\.wikimedia\.org\/w\/api\.php|nai\.sta1n\.cn\/api\/jobs(?:[/?]|$))/, route => { providers.push(route.request().url()); return route.abort(); });
  const ready = () => page.waitForFunction(() => window.__DESCRIBED_SCOPE__?._initComplete && typeof window.__APP_PROXY__?.openWechat === 'function', null, { timeout: 60000 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' }); await ready();
  await page.locator('.entry-transition').waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const s = window.__APP_PROXY__;
    s.showUserSetupModal = false; s.user.name = '测试玩家';
    s.characters.push({ uuid: 'described-fixture', name: '苏祈雪', first_mes: '固定开场', description: '大学生', wechatEnabled: true, wechatSpeed: 'fast', wechatStickerRate: 'off' });
    await s.selectCharacter(s.characters.length - 1, false, { silent: true });
    s.settings.apiUrl = 'https://mock.local/v1'; s.settings.apiKey = 'fixture'; s.settings.model = 'mock';
    s.memorySettings.enabled = false; s.memorySettings.classicModel = 'mock-summary'; s.activeTools.find(tool => tool.id === 'tool_wechat').enabled = true;
    s.userInput = '描述图片测试：你在宿舍楼下看见路灯，想把眼前的景色发给我。'; await s.sendMessage();
  });
  await page.waitForFunction(() => window.__APP_PROXY__.showWechatPanel && !window.__APP_PROXY__.isWechatGenerating && window.__APP_PROXY__.wechatTimeline.some(item => item.media?.descriptionOnly));
  check('原生工具 schema 包含 image 和离线描述模式', requests[0].tools.find(tool => tool.function.name === 'tool_wechat').function.parameters.properties.image.properties.mode.enum.includes('describe'));
  check('主动图片只请求一次 RP，发送后等待玩家', requests.length === 1 && !requests[0].messages.some(message => message.role === 'tool'));
  check('主动 RP 提示提供本地目录和描述说明', JSON.stringify(requests[0].messages).includes('builtin-salad') && JSON.stringify(requests[0].messages).includes('不补造过去未记录的联系'));
  check('角色图片独立落盘，剧情时间和 RP 正文都保留', await page.evaluate(description => {
    const s = window.__APP_PROXY__, images = s.wechatTimeline.filter(item => item.channel === 'wechat' && item.type === 'image');
    return images.length === 1 && images[0].role === 'assistant' && images[0].content === '' && !images[0].media.assetId && images[0].media.caption === description
      && window.RPHubWeChatTime.format(images[0].storyAt) === '2025-03-11 22:50' && s.chatHistory.at(-1).content.includes('拿起手机')
      && s.chatHistory.at(-1).toolCalls.some(call => call.toolId === 'tool_wechat');
  }, DESCRIPTION));
  const card = page.getByRole('button', { name: '查看图片画面描述' });
  check('描述卡片显示画面，无加载中提示或文字配文气泡', await card.count() === 1 && (await card.textContent()).includes(DESCRIPTION) && await page.locator('.wx-photo-button').count() === 0);
  await page.screenshot({ path: path.join(OUTPUT, 'wechat-described-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  check('手机卡片无横向溢出', await card.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
  await page.screenshot({ path: path.join(OUTPUT, 'wechat-described-mobile.png'), animations: 'disabled' });
  await card.click();
  check('点开全文说明，预览不使用 img 或伪造像素', await page.locator('.wx-description-preview').isVisible() && await page.locator('.wx-media-preview img').count() === 0);
  await page.screenshot({ path: path.join(OUTPUT, 'wechat-described-preview.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '关闭图片', exact: true }).click();
  await page.evaluate(async () => { const s = window.__DESCRIBED_SCOPE__; await s.saveData({ throwOnError: true }); await s.saveWechatTimelineNow(); });
  await page.waitForFunction(async () => {
    const S = window.RPHubStorage, saved = await S.getScopedStoredValue('wechat_timeline', 'described-fixture');
    return saved?.some(item => item.media?.descriptionOnly) && (await S.getStoredValue('settings'))?.model === 'mock'
      && (await S.getStoredValue('characters'))?.some(char => char.uuid === 'described-fixture');
  });
  await page.reload({ waitUntil: 'load' }); await ready();
  await page.waitForFunction(() => window.__APP_PROXY__.currentCharacter?.uuid === 'described-fixture');
  fixture = 'silence';
  await page.evaluate(async () => { const s = window.__APP_PROXY__; s.showUserSetupModal = false; await s.openWechat(); s.wechatInput = '灯下有人吗？'; await s.sendWechatMessage(); });
  check('刷新后卡片恢复，后续微信只带画面说明并保留未知细节边界', await card.count() === 1 && JSON.stringify(requests.at(-1).messages).includes(DESCRIPTION) && JSON.stringify(requests.at(-1).messages).includes('未描述的细节仍未知'));
  check('描述型图片不提供识图工具或视觉附件', !requests.at(-1).tools?.some(tool => tool.function.name === 'tool_view_image') && !/image_url|data:image\//.test(JSON.stringify(requests.at(-1).messages)));
  fixture = 'missing';
  await page.evaluate(async () => { const s = window.__APP_PROXY__; s.wechatInput = '给我看看另一张照片'; await s.sendWechatMessage(); });
  check('无匹配资源的被动图片直接描述兜底，无失败任务和额外请求', await page.evaluate(() => window.__APP_PROXY__.wechatTimeline.at(-1).media?.descriptionOnly && window.__APP_PROXY__.wechatMediaTasks.length === 0) && await card.count() === 2);
  fixture = 'rp';
  await page.evaluate(async () => { const s = window.__APP_PROXY__; await s.closeWechat(); s.userInput = '我看过照片后，继续刚刚的剧情。'; await s.sendMessage(); });
  check('微信回 RP 保留描述型图片和配文边界，无视觉字节', /画面描述.*北苑.*不是发送者的文字配文/.test(JSON.stringify(requests.at(-1).messages)) && !/image_url|data:image\//.test(JSON.stringify(requests.at(-1).messages)));
  fixture = 'recap';
  await page.evaluate(async () => { await window.__APP_PROXY__.runStoryRecap(); });
  check('压缩素材同样保留描述而不把它变成配文', /画面描述.*北苑.*不是发送者的文字配文/.test(JSON.stringify(requests.at(-1).messages)) && await page.evaluate(() => !!window.__APP_PROXY__.storyRecap?.text));
  await page.evaluate(async () => { const s = window.__APP_PROXY__; await s.openWechat(); await s.clearWechatTimeline(); });
  await page.getByRole('button', { name: /清空全部 RP/ }).click();
  await page.waitForFunction(() => !window.__APP_PROXY__.showConversationClear);
  check('全部清空同步移除描述图片、任务和含图总结', await card.count() === 0 && await page.evaluate(async () => {
    const s = window.__APP_PROXY__, S = window.RPHubStorage;
    return s.wechatTimeline.length === 0 && s.wechatMediaTasks.length === 0 && s.storyRecap === null
      && (await S.getScopedStoredValue('wechat_timeline', 'described-fixture')).length === 0 && await S.getScopedStoredValue('story_recap', 'described-fixture') === null;
  }));
  fixture = 'album';
  await page.evaluate(async () => { const s = window.__APP_PROXY__; s.wechatInput = '给我看看沙拉照片'; await s.sendWechatMessage(); });
  await page.waitForFunction(() => document.querySelector('.wx-photo-button img')?.naturalWidth > 0);
  check('有真实匹配资源时仍显示真实照片', await page.locator('.wx-photo-button img').count() === 1 && await card.count() === 0);
  check('没有调用搜索或生图服务，0 页面异常', providers.length === 0 && errors.length === 0);
  console.log(`${checks}/${checks} passed`);
})().catch(async error => {
  console.error(error); console.error({ errors, requests: requests.length, providers });
  if (page) { console.error(await page.evaluate(async () => ({ booted: window.__DESCRIBED_SCOPE__?._initComplete, proxy: !!window.__APP_PROXY__, url: location.href,
    characters: window.__APP_PROXY__?.characters.map(char => char.uuid), storedCharacters: (await window.RPHubStorage.getStoredValue('characters'))?.map(char => char.uuid),
    active: await window.RPHubStorage.getStoredValue('last_active_char'), body: document.body.innerText.slice(0, 1000) }))); await page.screenshot({ path: path.join(OUTPUT, 'wechat-described-failure.png') }); }
  process.exitCode = 1;
}).finally(async () => { await browser?.close(); server.close(); });
