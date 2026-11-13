// Isolated Vue + IndexedDB smoke. --live uses tmp/key.txt for ONE real STA1N image.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), OUT = path.join(ROOT, '.refactor-tmp/wechat-image-generation');
const live = process.argv.includes('--live');
let imageRequests = 0, chatRequests = 0, mode = 'meal', imageFailure = false, checks = 0;
const errors = [], check = (name, value) => { assert.ok(value, name); checks++; console.log('PASS ' + name); };
const server = http.createServer((req, res) => {
    const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
});
const ready = page => page.waitForFunction(() => window.__IMAGE_SCOPE__?._initComplete && window.__IMAGE_SCOPE__.worldUi);
(async () => {
    let browser;
    try {
        fs.mkdirSync(OUT, { recursive: true }); await new Promise(done => server.listen(0, '127.0.0.1', done));
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const context = await browser.newContext({ viewport: { width: 1280, height: 960 } }), page = await context.newPage();
        page.on('pageerror', e => errors.push(e.message));
        await page.addInitScript(() => { window.marked = { use() {}, parse: String }; window.DOMPurify = { sanitize: String }; localStorage.setItem('roleplay_hub_update_id', '99999'); });
        await page.route('**/*', route => {
            const host = new URL(route.request().url()).hostname;
            if (['127.0.0.1', 'unpkg.com', 'cdn.jsdelivr.net', 'cdn.tailwindcss.com'].includes(host)) return route.continue();
            // Live image download URLs may use a CDN. No app credential is attached there.
            if (live && !['nai.sta1n.cn', 'image-fixture.local', 'chat-fixture.local'].includes(host)) return route.continue();
            return route.fulfill({ contentType: 'application/json', body: '{"data":[],"quota":0}' });
        });
        await page.route('**/assets/js/app.js?*', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8').replace('const __s = {};', 'const __s = window.__IMAGE_SCOPE__ = {};') }));
        await page.route('https://chat-fixture.local/**', route => {
            const body = route.request().postDataJSON();
            if (!body?.messages) return route.fulfill({ contentType: 'application/json', body: '{"data":[]}' });
            chatRequests++;
            assert.ok(!JSON.stringify(body).includes('fixture-image-key'));
            const content = mode === 'meal' ? { messages: [{ type: 'text', content: '吃饭，黄焖鸡刚端上来' }] }
                : { messages: [{ type: 'text', content: '给你看看' }, { type: 'image_request', media: { mode: 'generate',
                    prompt: 'yellow braised chicken with potatoes and green peppers in a clay pot, bowl of white rice, dining table, close-up food photography, warm indoor lighting, no people, no text',
                    description: '桌上的砂锅黄焖鸡，旁边是一碗米饭', usage: 'scene_photo' } }] };
            if (mode !== 'meal') assert.match(body.messages[0].content, /需要拍照.*生图/);
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }] }) });
        });
        await page.route('https://image-fixture.local/v1/models', route => route.fulfill({ contentType: 'application/json', body: '{"data":[{"id":"nai-diffusion-4-5-full:k_dpmpp_2m"},{"id":"custom-image-model"}]}' }));
        await page.route('https://image-fixture.local/v1/chat/completions', route => {
            imageRequests++; const body = route.request().postDataJSON();
            assert.equal(body.stream, false); assert.match(body.messages[0].content, /^提示词:yellow braised chicken/);
            return imageFailure ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.fulfill({ contentType: 'application/json',
                body: JSON.stringify({ choices: [{ message: { content: `![image](http://127.0.0.1:${server.address().port}/assets/images/wechat/salad.jpg)` } }] }) });
        });
        if (live) await page.route('https://sta1n.ai/v1/chat/completions', route => { imageRequests++; if (imageRequests > 1) throw new Error('Live smoke permits only one paid image request'); return route.continue(); });
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 }); await ready(page);
        await page.evaluate(() => { const s = window.__IMAGE_SCOPE__; s.showUserSetupModal.value = false; s.currentView.value = 'settings'; });
        check('微信生图设置默认 STA1N 模型', await page.evaluate(() => window.__IMAGE_SCOPE__.settings.wechatImageApi.model === 'nai-diffusion-4-5-full:k_dpmpp_2m'));
        await page.locator('#wechat-image-settings').scrollIntoViewIfNeeded();
        await page.locator('#wechat-image-settings input[type=password]').fill('fixture-image-key');
        await page.evaluate(() => { window.__IMAGE_SCOPE__.settings.wechatImageApi.baseUrl = 'https://image-fixture.local/v1'; });
        await page.getByRole('button', { name: '读取可用模型', exact: true }).click();
        await page.waitForFunction(() => window.__IMAGE_SCOPE__.wechatImageModels.value.length === 2);
        check('模型列表可读取且没有生图请求', imageRequests === 0);
        await page.screenshot({ path: path.join(OUT, 'settings-desktop.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#wechat-image-settings').scrollIntoViewIfNeeded();
        check('手机设置没有横向溢出', await page.locator('#wechat-image-settings').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        await page.screenshot({ path: path.join(OUT, 'settings-mobile.png') });
        if (live) {
            const apiKey = fs.readFileSync(path.join(ROOT, 'tmp/key.txt'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0].trim();
            await page.evaluate(apiKey => { const c = window.__IMAGE_SCOPE__.settings.wechatImageApi; c.apiKey = apiKey; c.baseUrl = 'https://sta1n.ai/v1'; }, apiKey);
        }
        await page.evaluate(async () => {
            const s = window.__IMAGE_SCOPE__; s.currentView.value = 'world'; s.worldMemoryEnabled.value = false;
            Object.assign(s.settings, { apiUrl: 'https://chat-fixture.local/v1', apiKey: 'fixture-chat-key', model: 'chat-fixture', stream: false });
            Object.assign(s.worldDraft, { playerName: '玩家', playerDescription: '学生', storyTime: '2026-11-13T18:00', mapId: '' });
            for (const a of s.worldDraft.actors) a.card = { name: a.name, personality: '喜欢分享生活，今天晚饭吃黄焖鸡。' };
            await s.worldCreate(); await s.worldSelectConversation('dm-qing');
            s.worldInput.value = '你在干嘛'; await s.worldSend(); if (s.worldError.value) throw new Error(s.worldError.value);
        });
        check('普通吃饭问答不触发生图', imageRequests === 0);
        mode = 'photo';
        await page.evaluate(async () => { const s = window.__IMAGE_SCOPE__; s.worldInput.value = '给我拍拍照，看看你吃啥'; await s.worldSend(); if (s.worldError.value) throw new Error(s.worldError.value); });
        await page.locator('.world-image-thumb img').waitFor();
        check('请求照片后出现真实图片气泡', imageRequests === 1 && await page.locator('.world-image-thumb img').evaluate(img => img.complete && img.naturalWidth > 0));
        await page.screenshot({ path: path.join(OUT, live ? 'meal-live-mobile.png' : 'meal-fixture-mobile.png') });
        await page.locator('.world-image-thumb').click();
        check('可以放大查看原图', await page.locator('.world-image-preview img').evaluate(img => img.complete && img.naturalWidth > 0));
        await page.screenshot({ path: path.join(OUT, live ? 'meal-live-preview.png' : 'meal-fixture-preview.png') });
        await page.getByRole('button', { name: '关闭图片', exact: true }).click();
        const stored = await page.evaluate(async () => {
            const s = window.__IMAGE_SCOPE__, event = s.worldSnapshot.value.events.find(e => e.payload.type === 'image');
            const asset = await RPHubWorldMedia.read(event.payload.media.assetId);
            const pkg = await RPHubWorldStore.exportSession(s.worldSnapshot.value.sessionId);
            await s.saveData({ saveChat: false, saveMemories: false });
            return { sessionId: s.worldSnapshot.value.sessionId, assetId: event.payload.media.assetId, bytes: asset.dataUrl.length, dataUrl: asset.dataUrl,
                portable: !!pkg.media[event.payload.media.assetId], clean: !JSON.stringify(pkg.session).includes('base64,') };
        });
        check('世界包携带图片，事件不内嵌像素', stored.portable && stored.clean);
        if (live) fs.writeFileSync(path.join(OUT, 'meal-live.webp'), Buffer.from(stored.dataUrl.split(',')[1], 'base64'));
        await page.reload(); await ready(page);
        await page.evaluate(async sessionId => { const s = window.__IMAGE_SCOPE__; s.showUserSetupModal.value = false; s.currentView.value = 'world';
            await s.worldOpen(sessionId); await s.worldSelectConversation('dm-qing'); }, stored.sessionId);
        await page.locator('.world-image-thumb img').waitFor();
        check('刷新恢复原图和设置，不重复生图', imageRequests === 1 && await page.evaluate(async () => window.__IMAGE_SCOPE__.settings.wechatImageApi.model === 'nai-diffusion-4-5-full:k_dpmpp_2m'));
        if (!live) {
            imageFailure = true;
            await page.evaluate(async () => { const s = window.__IMAGE_SCOPE__; s.worldInput.value = '再拍张饭菜'; await s.worldSend(); });
            check('接口失败不发伪图片，显示继续回合', await page.locator('.world-image-thumb').count() === 1 && await page.getByRole('button', { name: '继续未完成回合', exact: true }).isVisible());
            imageFailure = false; const before = chatRequests;
            await page.getByRole('button', { name: '继续未完成回合', exact: true }).click();
            await page.waitForFunction(() => window.__IMAGE_SCOPE__.worldMessages.value.filter(e => e.payload.type === 'image').length === 2);
            check('重试沿用角色计划，不重复聊天调用', chatRequests === before);
        }
        check('无页面脚本错误', errors.length === 0);
        fs.writeFileSync(path.join(OUT, live ? 'live-report.json' : 'fixture-report.json'), JSON.stringify({ live, checks, imageRequests, chatRequests,
            imageBytes: stored.bytes, model: 'nai-diffusion-4-5-full:k_dpmpp_2m', date: new Date().toISOString(), errors }, null, 2));
        console.log(`${checks}/${checks} passed. ${live ? 'Real STA1N image; fixture chat decisions.' : 'Fixture APIs.'}`);
    } finally { if (browser) await browser.close(); await new Promise(done => server.close(done)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
