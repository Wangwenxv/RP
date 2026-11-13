// Real Vue/Canvas/IndexedDB/Edge; all model, search and generation responses are fixtures.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..');
const requests = [];
const errors = [];
const providerRequests = [];
let fixture = 'album', delayReply;
const server = http.createServer((req, res) => {
  const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg' };
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
const check = (label, value) => { assert.ok(value, label); console.log('PASS ' + label); };
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.marked = { use() {}, parse: text => String(text) };
      window.DOMPurify = { sanitize: text => String(text) };
      let value;
      Object.defineProperty(window, 'Vue', { configurable: true, get: () => value, set(v) {
        value = v;
        if (!v?.createApp || v.createApp.__mediaTest) return;
        const onMounted = v.onMounted;
        v.onMounted = (hook, ...args) => {
          const root = !v.getCurrentInstance()?.parent;
          return onMounted(async (...hookArgs) => { await hook(...hookArgs); if (root) window.__MEDIA_TEST_BOOTED__ = true; }, ...args);
        };
        const createApp = v.createApp;
        v.createApp = function (...args) { const app = createApp(...args); const mount = app.mount; app.mount = function (...args) { const root = mount.apply(this, args); window.__APP_PROXY__ = root; return root; }; return app; };
        v.createApp.__mediaTest = true;
      } });
    });
    await page.route('**/chat/completions', async route => {
      const body = route.request().postDataJSON(); requests.push(body);
      const contentText = JSON.stringify(body.messages);
      const freshIds = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text.match(/本轮新图 #([^｜]+)/)?.[1]).filter(Boolean) : []);
      let message = { role: 'assistant', content: '{"messages":[]}' }, finishReason = 'stop';
      if (fixture === 'album') message.content = '{"messages":[{"type":"text","content":"给你看看"},{"type":"image_request","media":{"mode":"album","assetId":"builtin-salad","usage":"scene_photo"}}]}';
      if (fixture === 'lazy') {
        if (body.messages.some(item => item.role === 'tool' && item.content.includes('【可选相册图片】'))) message.content = '{"messages":[{"type":"image_request","media":{"mode":"album","assetId":"builtin-cat","usage":"scene_photo"}}]}';
        else {
          message = { role: 'assistant', content: '', tool_calls: [{ id: 'load-sending', type: 'function', function: { name: 'tool_load_image_sending', arguments: '{}' } }] };
          finishReason = 'tool_calls';
        }
      }
      if (fixture === 'draw') message.content = '{"messages":[{"type":"image_request","media":{"mode":"draw","template":"note","text":"今天也要好好吃饭","decorations":["heart"]}}]}';
      if (fixture === 'upload') message.content = JSON.stringify({ messages: [{ type: 'text', content: '这个沙拉颜色好多' }], image_descriptions: freshIds.map(messageId => ({ messageId, caption: '木桌上的一碗蔬菜沙拉，有番茄、牛油果和紫甘蓝。' })) });
      if (fixture === 'view') {
        if (body.messages.some(item => item.role === 'tool')) message.content = '{"messages":[{"type":"text","content":"纸条写着今天也要好好吃饭"}]}';
        else {
          const id = await page.evaluate(() => window.__APP_PROXY__.wechatTimeline.find(item => item.media?.source === 'draw')?.id);
          message = { role: 'assistant', content: '', tool_calls: [{ id: 'view-call', type: 'function', function: { name: 'tool_view_image', arguments: JSON.stringify({ messageId: id, question: '上面写着什么字' }) } }] }; finishReason = 'tool_calls';
        }
      }
      if (fixture === 'vision') message.content = body.model === 'mock-vision' ? '纸条上写着今天也要好好吃饭。' : '{"messages":[]}';
      if (fixture === 'missing') message.content = '{"messages":[{"type":"text","content":"给你看"},{"type":"image_request","media":{"mode":"album","assetId":"missing-photo"}}]}';
      if (fixture === 'search') message.content = '{"messages":[{"type":"image_request","media":{"mode":"search","query":"黑白猫","usage":"reference"}}]}';
      if (fixture === 'generate') message.content = '{"messages":[{"type":"image_request","media":{"mode":"generate","prompt":"cat at a wooden desk","usage":"scene_photo"}}]}';
      if (fixture === 'late') { await new Promise(resolve => { delayReply = resolve; }); message.content = '{"messages":[{"type":"image_request","media":{"mode":"album","assetId":"builtin-cat"}}]}'; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message, finish_reason: finishReason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) });
    });
    // Optional provider fixtures: no external search/generation calls leave this test.
    await page.route('https://commons.wikimedia.org/**', route => {
      providerRequests.push({ provider: 'search', url: route.request().url() });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ query: { pages: { 1: { title: 'Cat', imageinfo: [{ thumburl: `http://127.0.0.1:${server.address().port}/assets/images/wechat/cat.jpg`, descriptionurl: 'https://commons.wikimedia.org/wiki/File:fixture', extmetadata: { LicenseShortName: { value: 'CC0' }, ImageDescription: { value: '黑白猫' } } }] } } } }) });
    });
    await page.route('https://nai.sta1n.cn/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.route('https://sta1n.ai/v1/chat/completions', route => {
      providerRequests.push({ provider: 'generate', body: route.request().postDataJSON(), authorization: route.request().headers().authorization });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: `![image](http://127.0.0.1:${server.address().port}/assets/images/wechat/cat.jpg)` } }] }) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__MEDIA_TEST_BOOTED__ && window.__APP_PROXY__?.characters, { timeout: 60000 });
    await page.evaluate(async () => {
      const r = window.__APP_PROXY__;
      r.user.name = '玩家'; r.showUserSetupModal = false;
      r.characters.push({ uuid: 'media-e2e-character', name: '林晚', description: '在窗边吃沙拉', personality: '喜欢随手分享', first_mes: '你好', wechatEnabled: true, wechatSpeed: 'fast', wechatStickerRate: 'off' });
      await r.selectCharacter(0, false, { silent: true });
      r.settings.apiUrl = 'https://mock.local/v1'; r.settings.apiKey = 'fixture'; r.settings.model = 'mock';
      await r.openWechat();
    });
    const send = text => page.evaluate(async text => { const r = window.__APP_PROXY__; r.wechatInput = text; await r.sendWechatMessage(); }, text);
    fixture = 'silence'; await send('先忙吧');
    check('普通聊天不携带完整发图说明和素材目录', !requests[0].messages[0].content.includes('【可选相册图片】') && !requests[0].messages[0].content.includes('image_descriptions'));
    fixture = 'album';
    await send('拍个照');
    check('拍照关键词通过世界书匹配器按需注入目录', requests.at(-1).messages[0].content.includes('【可选相册图片】') && !requests.at(-1).tools?.some(tool => tool.function.name === 'tool_load_image_sending'));
    check('相册图片与前置文字发出，记录不包含图片字节', await page.evaluate(() => { const items = window.__APP_PROXY__.wechatTimeline.filter(item => item.channel === 'wechat' && item.role === 'assistant'); return items.length === 2 && items[1].media.assetId === 'builtin-salad' && !items[1].content; }));
    await page.waitForFunction(() => document.querySelector('.wx-photo-button img')?.naturalWidth > 0);
    check('相册照片真实显示', await page.locator('.wx-photo-button img').count() === 1);
    await page.evaluate(async () => { const r = window.__APP_PROXY__; await r.viewWechatImage(r.wechatTimeline.find(item => item.type === 'image')); });
    await page.waitForFunction(() => document.querySelector('.wx-media-preview img')?.naturalWidth > 0);
    check('点击查看完整图', await page.locator('.wx-media-preview').count() === 1);
    await page.evaluate(() => { window.__APP_PROXY__.wechatImagePreview = null; });
    fixture = 'draw'; await send('画张纸条');
    check('Canvas 真正生成图片且 Blob 落盘', await page.evaluate(async () => { const item = window.__APP_PROXY__.wechatTimeline.find(item => item.media?.source === 'draw'); const blob = await window.RPHubStorage.getStoredValue(`wechat_media_blob_${item.media.assetId}`); return blob instanceof Blob && blob.size > 1000 && item.media.caption.includes('今天也要好好吃饭'); }));
    await page.evaluate(async () => { const r = window.__APP_PROXY__; await r.viewWechatImage(r.wechatTimeline.find(item => item.media?.source === 'draw')); });
    await page.waitForFunction(() => document.querySelector('.wx-media-preview img')?.naturalWidth > 0);
    fs.mkdirSync(path.join(ROOT, '.refactor-tmp'), { recursive: true });
    await page.evaluate(() => { window.__APP_PROXY__.showUserSetupModal = false; });
    await page.screenshot({ path: path.join(ROOT, '.refactor-tmp/wechat-drawing.png') });
    await page.evaluate(() => { window.__APP_PROXY__.wechatImagePreview = null; });
    fixture = 'view'; const beforeView = requests.length; await send('刚刚纸条上写什么');
    check('查看工具续写使用真实历史图片像素', requests.slice(beforeView).some(body => body.messages.some(message => message.role === 'tool') && JSON.stringify(body.messages).includes('data:image/')));
    fixture = 'upload';
    await page.locator('.wx-composer input[type=file]').first().setInputFiles(path.join(ROOT, 'assets/images/wechat/salad.jpg'));
    await page.waitForFunction(() => !!window.__APP_PROXY__.wechatPendingImage);
    const uploadStart = requests.length; await send('吃饭');
    const uploadRequest = requests[uploadStart];
    check('本轮新图完整进入视觉输入', uploadRequest.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' && part.image_url.detail === 'high')));
    check('用户图片记录独立存储且短描述持久化', await page.evaluate(() => { const image = window.__APP_PROXY__.wechatTimeline.find(item => item.role === 'user' && item.type === 'image'); return image.content === '' && image.media.caption.includes('沙拉'); }));
    fixture = 'silence'; const oldStart = requests.length; await send('好的');
    check('下一轮旧图只用描述，不重复发送像素', !JSON.stringify(requests[oldStart].messages).includes('data:image/'));
    check('旧图存在时普通确认仍不带发图目录，保留轻量查看工具', !requests[oldStart].messages[0].content.includes('【可选相册图片】') && requests[oldStart].tools.some(tool => tool.function.name === 'tool_view_image'));
    check('空回继续正常工作', await page.evaluate(() => window.__APP_PROXY__.wechatTimeline.at(-1).replyDecision === 'silent'));
    await page.evaluate(async () => { const r = window.__APP_PROXY__; await r.closeWechat(); await r.openWechat(); });
    await page.waitForFunction(() => [...document.querySelectorAll('.wx-photo-button img')].every(img => img.naturalWidth > 0));
    check('关闭重开恢复三张图片', await page.locator('.wx-photo-button').count() === 3);
    await page.evaluate(() => window.__APP_PROXY__.openWechatMediaGallery());
    await page.waitForSelector('.wx-media-card img');
    check('相册界面没有横向溢出', await page.evaluate(() => document.querySelector('.wx-media-gallery').scrollWidth <= document.querySelector('.wx-media-gallery').clientWidth));
    await page.evaluate(() => { window.__APP_PROXY__.showUserSetupModal = false; });
    await page.screenshot({ path: path.join(ROOT, '.refactor-tmp/wechat-album.png') });
    await page.evaluate(() => { window.__APP_PROXY__.showWechatMediaGallery = false; });
    fixture = 'lazy'; const lazyStart = requests.length; await send('在干嘛');
    check('没有关键词也能加载说明后自主分享，目录仅存在于本轮工具结果', requests.length === lazyStart + 2
      && !requests[lazyStart].messages[0].content.includes('【可选相册图片】')
      && requests[lazyStart + 1].messages.some(item => item.role === 'tool' && item.content.includes('【可选相册图片】'))
      && await page.evaluate(() => window.__APP_PROXY__.wechatTimeline.at(-1).media?.assetId === 'builtin-cat'));
    fixture = 'silence'; await send('ok');
    check('工具加载后的下轮收尾不重放目录，空回无额外气泡', !JSON.stringify(requests.at(-1).messages).includes('【可选相册图片】')
      && await page.evaluate(() => window.__APP_PROXY__.wechatTimeline.at(-1).replyDecision === 'silent'));
    fixture = 'missing'; const countBeforeFailure = await page.evaluate(() => window.__APP_PROXY__.wechatTimeline.length); await send('给我看另一张');
    check('资源失败没有发出依赖文字或假图片', await page.evaluate(before => window.__APP_PROXY__.wechatTimeline.length === before + 1 && window.__APP_PROXY__.wechatMediaTasks.some(task => task.status === 'failed'), countBeforeFailure));
    check('真实界面有图片重试入口', (await page.locator('.wx-media-task').textContent()).includes('重试图片'));
    await page.evaluate(async () => {
      const r = window.__APP_PROXY__; const task = r.wechatMediaTasks.find(task => task.status === 'failed');
      task.messages[1].media.assetId = 'builtin-cat'; await r.retryWechatMediaTask(task);
    });
    check('重试成功只补图片批次', await page.evaluate(() => window.__APP_PROXY__.wechatTimeline.at(-1).media?.assetId === 'builtin-cat'));
    check('默认来源没有触发联网搜索或生图', providerRequests.length === 0);
    await page.evaluate(() => { const r = window.__APP_PROXY__; r.currentCharacter.wechatImageSearchEnabled = true; r.currentCharacter.wechatImageGenerationEnabled = true; r.settings.wechatImageApi.apiKey = 'fixture-key'; });
    fixture = 'search'; await send('找张猫的参考图');
    check('可选搜索通过适配器保存真实图片与来源信息', await page.evaluate(async () => {
      const item = window.__APP_PROXY__.wechatTimeline.at(-1);
      const index = await window.RPHubStorage.getStoredValue('wechat_media_index');
      return item.media?.source === 'search' && index.find(asset => asset.id === item.media.assetId)?.license === 'CC0';
    }));
    fixture = 'generate'; await send('按需生成一张图');
    check('微信 STA1N 生图使用标签格式提交并保存图片', await page.evaluate(() => window.__APP_PROXY__.wechatTimeline.at(-1).media?.source === 'generate')
      && providerRequests.some(request => request.provider === 'generate' && request.authorization === 'Bearer fixture-key' && request.body.model === 'nai-diffusion-4-5-full:k_dpmpp_2m' && request.body.messages[0].content.startsWith('提示词:cat at a wooden desk')));
    fixture = 'late';
    const late = send('晚到图片');
    while (!delayReply) await new Promise(resolve => setTimeout(resolve, 50));
    await page.evaluate(async () => { const r = window.__APP_PROXY__; r.stopWechatGeneration(); await r.closeWechat(); await r.openWechat(); });
    const lateCount = await page.evaluate(() => window.__APP_PROXY__.wechatTimeline.length);
    delayReply(); await late;
    check('关闭重开后过期请求不追加图片', await page.evaluate(n => window.__APP_PROXY__.wechatTimeline.length === n, lateCount));
    check('0 JavaScript 错误', errors.length === 0);
    const filePage = await browser.newPage();
    await filePage.goto('file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/'), { waitUntil: 'domcontentloaded' });
    await filePage.waitForFunction(() => !!window.RPHubWeChatMedia);
    check('file:// 内置照片能够读取像素，无 Canvas 污染', await filePage.evaluate(async () => {
      const lib = window.RPHubWeChatMedia.createLibrary({ getStoredValue: async () => [] });
      return (await lib.read('builtin-salad')).size > 1000;
    }));
    await filePage.close();
    console.log('WECHAT MEDIA E2E: PASS');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
