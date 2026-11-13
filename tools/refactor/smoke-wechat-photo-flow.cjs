// Original single-card WeChat: scenario 2.txt, real UI/IndexedDB. Default APIs are fixtures.
// --live --config <local JSON>: { chat:{baseUrl,apiKey,model}, image:{apiKey,...} }
// --card <card JSON> optionally supplies the user's character; keys/replies are never printed.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..');
const option = name => process.argv[process.argv.indexOf(name) + 1];
const OUT = process.argv.includes('--out') ? path.resolve(option('--out')) : path.join(ROOT, '.refactor-tmp/wechat-photo-flow');
const live = process.argv.includes('--live');
assert.ok(!live || process.argv.includes('--config'), '--live requires --config <local JSON>');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const config = live ? readJSON(option('--config')) : { chat: { baseUrl: 'https://chat-fixture.local/v1', apiKey: 'fixture-chat', model: 'fixture' }, image: { apiKey: 'fixture-image' } };
assert.ok(config.chat?.apiKey && config.image?.apiKey, 'Chat and image keys are required');
const supplied = process.argv.includes('--card') ? readJSON(option('--card')) : null;
const card = supplied?.data || supplied || { name: '苏祈雪', personality: '18岁大学生，齐肩细软头发别在耳后。与玩家恋爱七个月，愿意分享生活。', first_mes: '三月的校园，教学楼下课，傍晚路灯亮起。',
    extensions: { rp_hub_image_identity: require('../character-cards/patch-suqixue-image-identity.cjs').profile } };
const identity = card.extensions?.rp_hub_image_identity || card.imageIdentity;
let chats = 0, images = 0, checks = 0;
const errors = [], decisions = [], providerResponses = [], imageDownloads = new Set();
const imagePrompts = [];
const redact = value => String(value).split(config.chat.apiKey).join('[redacted]').split(config.image.apiKey).join('[redacted]');
const check = (name, value) => { assert.ok(value, name); checks++; console.log('PASS ' + name); };
const server = http.createServer((req, res) => {
    const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
});
(async () => {
    let browser;
    fs.mkdirSync(OUT, { recursive: true });
    try {
        await new Promise(done => server.listen(0, '127.0.0.1', done));
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
        page.setDefaultTimeout(15000);
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            window.marked = { use() {}, parse: String }; window.DOMPurify = { sanitize: String };
            localStorage.setItem('roleplay_hub_update_id', '99999');
        });
        await page.route('**/assets/js/app.js?*', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8').replace('const __s = {};', 'const __s = window.__PHOTO_SCOPE__ = {};') }));
        const chatBase = config.chat.baseUrl.replace(/\/+$/, ''), imageBase = (config.image.baseUrl || 'https://sta1n.ai/v1').replace(/\/+$/, '');
        await page.route('**/*', async route => {
            const req = route.request(), url = req.url(), host = new URL(url).hostname;
            if (url === chatBase + '/chat/completions') {
                chats++; assert.ok(chats <= 8, 'Chat request limit');
                const body = req.postDataJSON();
                assert.ok(!JSON.stringify(body).includes(config.image.apiKey), 'Image key stays out of chat context');
                if (live) return route.continue();
                const correction = body.messages.some(m => m.role === 'system' && m.content.includes('刚才的回复尚未发送'));
                const messages = chats === 1 ? [{ type: 'text', content: '在呢' }, { type: 'text', content: '刚下课' }] : [
                    { type: 'text', content: '给你看看' }, { type: 'image_request', media: correction
                        ? { mode: 'generate', selfPortrait: true, prompt: 'campus corridor, phone selfie, evening light', description: '校园走廊里齐肩头发女生的自拍' }
                        : process.argv.includes('--missing-portrait-flag')
                            ? { mode: 'generate', prompt: 'phone selfie, campus corridor', description: '校园走廊里齐肩头发女生的自拍' }
                            : { mode: 'describe', description: '校园走廊里齐肩头发女生的自拍' } }
                ];
                decisions.push(correction ? 'corrected-generate' : chats === 1 ? 'text' : 'describe');
                return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ messages }) }, finish_reason: 'stop' }] }) });
            }
            if (url === imageBase + '/chat/completions' || url === imageBase + '/images/generations') {
                images++; assert.ok(images <= 2, 'Paid image request limit');
                const body = req.postDataJSON(), prompt = body.messages?.[0]?.content || body.prompt;
                imagePrompts.push({ prompt: redact(prompt), fixedAppearanceApplied: !!identity?.prompt && prompt.includes(identity.prompt),
                    negativeApplied: !!identity?.negative && prompt.includes(identity.negative) });
                if (live) {
                    const response = await route.fetch({ timeout: 300000 });
                    const bytes = await response.body();
                    providerResponses.push({ status: response.status(), contentType: response.headers()['content-type'], bytes: bytes.length,
                        preview: redact(bytes.toString('utf8').slice(0, 2500)) });
                    for (const url of bytes.toString('utf8').match(/https?:\/\/[^\s)\]"'<>]+/g) || []) imageDownloads.add(url.replace(/\\\//g, '/'));
                    return route.fulfill({ response });
                }
                assert.equal(req.postDataJSON().stream, false);
                return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: `![fixture](http://127.0.0.1:${server.address().port}/assets/images/wechat/cat.jpg)` } }] }) });
            }
            if (['127.0.0.1', 'unpkg.com', 'cdn.jsdelivr.net', 'cdn.tailwindcss.com'].includes(host) || /\/assets\/js\/app\.js\?/.test(url)) return route.fallback();
            // Permit live provider image downloads; unrelated background integrations stay fixtures.
            if (live && imageDownloads.has(url) && req.method() === 'GET') return route.continue();
            return route.fulfill({ contentType: 'application/json', body: '{"data":[],"quota":0}' });
        });
        page.on('response', async response => {
            const req = response.request();
            if (!live || req.method() !== 'GET' || req.resourceType() !== 'fetch' || !images || new URL(req.url()).hostname === '127.0.0.1') return;
            try { const bytes = await response.body(); providerResponses.push({ download: true, url: redact(req.url()), status: response.status(),
                contentType: response.headers()['content-type'], bytes: bytes.length, magic: bytes.subarray(0, 12).toString('hex'),
                ...(bytes.subarray(0, 1).toString() === '<' ? { preview: bytes.toString('utf8').slice(0, 200) } : {}) }); } catch (_) {}
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
        await page.waitForFunction(() => window.__PHOTO_SCOPE__?._initComplete);
        await page.evaluate(async ({ card, config }) => {
            const s = window.__PHOTO_SCOPE__;
            s.showUserSetupModal.value = false; s.user.name = '陆清淮';
            const imported = await s.importCharacterData(card, null, { activate: false, askImageGeneration: false });
            Object.assign(imported, { wechatEnabled: true, wechatSpeed: 'fast', wechatStickerRate: 'off', wechatImageGenerationEnabled: true,
                wechatWorldInfoComments: card.wechatWorldInfoComments || [], wechatPresetNames: card.wechatPresetNames || [] });
            await s.selectCharacter(s.characters.value.length - 1, false, { silent: true });
            Object.assign(s.settings, { apiUrl: config.chat.baseUrl, apiKey: config.chat.apiKey, model: config.chat.model });
            Object.assign(s.settings.wechatImageApi, config.image);
            s.currentView.value = 'chat'; await s.openWechat();
            s.wechatBurstMode.value = true;
        }, { card, config });
        if (identity?.prompt) {
            await page.getByRole('button', { name: '微信设置', exact: true }).click();
            const fields = page.locator('.wx-image-identity-settings');
            check('角色卡固定外貌显示在原生设置中', await fields.getByRole('textbox', { name: '固定英文提示词', exact: true }).inputValue() === identity.prompt);
            await fields.getByRole('textbox', { name: '外貌说明', exact: true }).fill(identity.description || '固定外貌');
            await page.locator('.wx-drawer').getByRole('button', { name: '保存', exact: true }).click();
            await page.getByRole('button', { name: '微信设置', exact: true }).click();
            check('外貌设置保存后重新打开仍在', await fields.getByRole('textbox', { name: '固定英文提示词', exact: true }).inputValue() === identity.prompt);
            await page.locator('.wx-drawer').getByRole('button', { name: '保存', exact: true }).click();
            check('通过角色导出契约保留外貌', await page.evaluate(expected => RPHubCardUtils.buildCharacterCardData(window.__PHOTO_SCOPE__.currentCharacter.value).data.extensions.rp_hub_image_identity.prompt === expected, identity.prompt));
        }
        const send = async (text, time) => {
            await page.evaluate(time => { const s = window.__PHOTO_SCOPE__; s.wechatSendAt.value = time; }, time);
            await page.getByRole('textbox', { name: '微信消息', exact: true }).fill(text);
            await page.getByRole('textbox', { name: '微信消息', exact: true }).press('Enter');
        };
        const reply = async count => {
            await page.getByRole('button', { name: `让对方回复（攒了 ${count} 条）`, exact: true }).click();
            await page.waitForFunction(() => !window.__PHOTO_SCOPE__.isWechatGenerating.value, null, { timeout: 360000 });
            const failure = await page.evaluate(() => window.__PHOTO_SCOPE__.wechatMediaTasks.value.find(t => t.status === 'failed')?.error || '');
            if (failure) throw new Error(failure);
        };
        await send('老！婆！', '2025-03-11T18:00:00'); await send('喂喂喂，老婆人呢？', '2025-03-11T18:05:00'); await send('苏!祈!雪!', '2025-03-11T18:10:00');
        await reply(3); check('第一轮三条连发不产生图片请求', images === 0);
        check('连发消息保留18:00、18:05、18:10的剧情时间', await page.evaluate(() => {
            const times = window.__PHOTO_SCOPE__.wechatTimeline.value.filter(i => i.role === 'user').map(i => RPHubWeChatTime.format(i.storyAt));
            return times.length === 3 && times[0].includes('18:00') && times[1].includes('18:05') && times[2].includes('18:10');
        }));
        await send('我不信', '2025-03-11T18:10:00'); await send('现在立刻拍张照给我!', '2025-03-11T18:10:00'); await reply(2);
        const inspectReply = () => page.evaluate(() => {
            const s = window.__PHOTO_SCOPE__, replies = s.wechatTimeline.value.filter(i => i.role === 'assistant');
            return { types: replies.map(i => i.type), image: replies.find(i => i.type === 'image')?.media, unanswered: s.wechatUnansweredCount.value,
                texts: replies.filter(i => i.type === 'text').map(i => i.content) };
        });
        let result = await inspectReply();
        const requestedPhoto = { sentImage: !!result.image, texts: result.texts, unanswered: result.unanswered };
        if (!result.image && live && process.argv.includes('--scene-followup') && result.unanswered === 0) {
            await send('那你不用拍自己，拍一张你现在眼前的景色给我看看吧', '2025-03-11T18:10:00');
            await reply(1); result = await inspectReply();
        }
        check('模型决策成功，待回复消息未因错误被丢失', result.unanswered === 0);
        // A live character may refuse. Report its actual decision; never force a paid image.
        if (!result.image && live) {
            await page.screenshot({ path: path.join(OUT, 'live-character-decision.png') });
            fs.writeFileSync(path.join(OUT, 'live-report.json'), JSON.stringify({ live, checks, chats, images, requestedPhoto, result, errors, status: 'character-did-not-send-image' }, null, 2));
            console.log('LIVE: character did not send an image; see local report.'); return;
        }
        check('新图片为实际生成资源，未落成描述卡片', result.image?.source === 'generate' && result.image?.assetId && !result.image?.descriptionOnly);
        check('一张图片只调用一次生图服务', images === 1);
        if (identity?.prompt && (!live || process.argv.includes('--expect-self-portrait'))) check('本人照片请求带固定特征与负面提示词', imagePrompts[0]?.fixedAppearanceApplied && imagePrompts[0]?.negativeApplied);
        if (!live) check(process.argv.includes('--missing-portrait-flag') ? '本人标记遗漏在付费前通过一次聊天纠正' : '描述误用通过一次聊天纠正完成', chats === 3 && decisions.at(-1) === 'corrected-generate');
        await page.waitForFunction(() => [...document.querySelectorAll('.wx-photo-button img')].some(img => img.complete && img.naturalWidth > 0));
        await page.screenshot({ path: path.join(OUT, live ? 'live-chat.png' : 'fixture-chat.png') });
        const saved = await page.evaluate(async () => {
            const s = window.__PHOTO_SCOPE__, image = s.wechatTimeline.value.find(i => i.media?.source === 'generate');
            const blob = await RPHubStorage.getStoredValue(`wechat_media_blob_${image.media.assetId}`);
            window.__PHOTO_IMAGE_BYTES__ = await blob.arrayBuffer();
            await s.saveData(); await s.saveWechatTimelineNow(); return { bytes: blob.size, mime: blob.type, scope: s.getCurrentStoryBranchScopeId() };
        });
        const imageBytes = await page.evaluate(() => Array.from(new Uint8Array(window.__PHOTO_IMAGE_BYTES__)));
        const imageFile = (live ? 'live-image' : 'fixture-image') + ({ 'image/webp': '.webp', 'image/jpeg': '.jpg' }[saved.mime] || '.png');
        fs.writeFileSync(path.join(OUT, imageFile), Buffer.from(imageBytes));
        await page.reload(); await page.waitForFunction(() => window.__PHOTO_SCOPE__?._initComplete);
        await page.evaluate(async () => { const s = window.__PHOTO_SCOPE__; s.showUserSetupModal.value = false; s.currentView.value = 'chat'; await s.selectCharacter(0, false, { silent: true }); await s.openWechat(); });
        await page.waitForFunction(() => document.querySelector('.wx-photo-button img')?.naturalWidth > 0);
        check('刷新后图片仍可读取，未重新调用生图', images === 1 && saved.bytes > 1000);
        if (identity?.prompt) check('刷新后固定外貌仍保存', await page.evaluate(expected => window.__PHOTO_SCOPE__.currentCharacter.value.imageIdentity?.prompt === expected, identity.prompt));
        check('无页面脚本错误', errors.length === 0);
        fs.writeFileSync(path.join(OUT, live ? 'live-report.json' : 'fixture-report.json'), JSON.stringify({ live, checks, chats, images,
            worldbooks: card.wechatWorldInfoComments?.length || 0, presets: card.wechatPresetNames?.length || 0,
            requestedPhoto, imageBytes: saved.bytes, imageFile, imagePrompts, errors }, null, 2));
        console.log(`${checks}/${checks} passed; ${live ? 'real chat and image APIs' : 'fixture APIs'}.`);
    } finally {
        if (browser) await browser.close(); await new Promise(done => server.close(done));
        if (live) fs.writeFileSync(path.join(OUT, 'live-provider-responses.json'), JSON.stringify(providerResponses, null, 2));
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
