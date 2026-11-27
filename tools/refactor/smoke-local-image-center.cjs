// Isolated browser storage and fixture character; image generation calls the real local model service.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), OUT = path.join(ROOT, '.refactor-tmp/local-image-center');
const errors = [], imageRequests = []; let checks = 0;
const check = (name, value) => { assert.ok(value, name); checks++; console.log('PASS ' + name); };
const server = http.createServer((req, res) => {
    const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
});
(async () => {
    let browser, page;
    try {
        fs.mkdirSync(OUT, { recursive: true }); await new Promise(done => server.listen(0, '127.0.0.1', done));
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
        page.setDefaultTimeout(15000);
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
            if (request.method() === 'POST' && request.url() === 'http://127.0.0.1:7865/v1/jobs') {
                imageRequests.push({ url: request.url(), authorization: request.headers().authorization || null, body: request.postDataJSON() });
            }
        });
        await page.addInitScript(() => { window.marked = { use() {}, parse: String }; window.DOMPurify = { sanitize: String }; localStorage.setItem('roleplay_hub_update_id', '99999'); });
        await page.route('**/*', route => {
            const host = new URL(route.request().url()).hostname;
            if (['127.0.0.1', 'unpkg.com', 'cdn.jsdelivr.net', 'cdn.tailwindcss.com'].includes(host)) return route.continue();
            return route.fulfill({ contentType: 'application/json', body: '{"data":[]}' });
        });
        await page.route('**/assets/js/app.js?*', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8').replace('const __s = {};', 'const __s = window.__LOCAL_IMAGE_SCOPE__ = {};') }));
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const ready = () => page.waitForFunction(() => window.__LOCAL_IMAGE_SCOPE__?._initComplete);
        await ready();
        await page.evaluate(async () => {
            const s = window.__LOCAL_IMAGE_SCOPE__;
            s.showUserSetupModal.value = false;
            s.characters.value = [{ uuid: 'local-image-test', name: '本地验收', description: '隔离测试角色', personality: '', first_mes: '', avatar: '', wechatEnabled: true }];
            await s.selectCharacter(0, false, { silent: true });
            Object.assign(s.settings.wechatImageApi, { baseUrl: 'https://image-fixture.local/v1', apiKey: 'fixture-cloud-key' });
            s.currentView.value = 'settings';
        });
        await page.getByRole('button', { name: /本机 Qwen 2\.1 Turbo/ }).click();
        check('本地预设清空密钥并可直接使用', await page.evaluate(() => {
            const c = window.RPHubImageGeneration.config(window.__LOCAL_IMAGE_SCOPE__.settings);
            return c.localService && !c.apiKey && window.RPHubImageGeneration.ready(c);
        }));
        check('本地模式隐藏图片 Key 输入', await page.locator('input[placeholder="填写当前生图服务的 API Key"]').count() === 0);
        await page.getByRole('button', { name: '读取可用模型', exact: true }).click();
        await page.waitForFunction(() => window.__LOCAL_IMAGE_SCOPE__.wechatImageModels.value.some(item => item.value === 'qwen-image-2.1-turbo-local') && !window.__LOCAL_IMAGE_SCOPE__.wechatImageModelsLoading.value);
        check('实际本机模型列表跨域读取成功', imageRequests.length === 0);
        await page.evaluate(() => {
            const s = window.__LOCAL_IMAGE_SCOPE__;
            s.settings.wechatImageApi.size = '256x256';
            s.setAutoImageGenEnabled(true);
            s.isGenerating.value = true;
            s.chatHistory.value = [{ role: 'assistant', content: '这是现在的浴室。\n\nimage###{"prompt":"A natural phone photo of an empty university dorm bathroom, a white ceramic sink and rectangular wall mirror, warm fluorescent light, no people.","selfPortrait":false}###', shouldAnimate: false }];
            s.currentView.value = 'chat';
        });
        await page.locator('.generated-image-card').waitFor();
        check('流式未完成时没有调用模型', imageRequests.length === 0);
        const started = Date.now();
        await page.evaluate(() => { window.__LOCAL_IMAGE_SCOPE__.isGenerating.value = false; });
        console.log('Waiting for real native image generation through the RP adapter...');
        await page.waitForFunction(() => document.querySelector('.generated-image-card img')?.naturalWidth > 0, null, { timeout: 1800000 });
        check('RP 正文实际生成并展示本机模型图片', imageRequests.length === 1);
        check('请求未携带云 Key', imageRequests[0].authorization === null);
        check('本地自然语言请求提交异步任务', imageRequests[0].url.endsWith('/jobs') && imageRequests[0].body.model === 'qwen-image-2.1-turbo-local');
        const metadata = await page.evaluate(() => window.__LOCAL_IMAGE_SCOPE__.chatHistory.value[0].generatedImages);
        check('生成像素进入原媒体库', !!metadata?.[0]?.assetId && metadata[0].status === 'done');
        await page.screenshot({ path: path.join(OUT, 'local-rp-generated.png') });
        await page.evaluate(async () => { const s = window.__LOCAL_IMAGE_SCOPE__; await s.saveCharactersNow(); await s.saveData(); });
        await page.reload(); await ready();
        await page.evaluate(() => { const s = window.__LOCAL_IMAGE_SCOPE__; s.showUserSetupModal.value = false; s.currentView.value = 'chat'; });
        await page.waitForFunction(() => document.querySelector('.generated-image-card img')?.naturalWidth > 0);
        check('刷新恢复图片且不重新推理', imageRequests.length === 1);
        check('页面无脚本异常', errors.length === 0);
        fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ checks, imageRequests, metadata, elapsedMs: Date.now()-started,
            scope: 'isolated browser and fixture character; real local image inference, CORS, RP media storage and reload' }, null, 2));
        console.log(`${checks}/${checks} passed. Real local image API.`);
    } catch (error) {
        console.error(error, errors);
        if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') });
        process.exitCode = 1;
    } finally { await browser?.close(); server.close(); }
})();
