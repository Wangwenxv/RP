// Isolated browser storage and fixture image API; never reads keys or user conversations.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), OUT = path.join(ROOT, '.refactor-tmp/rp-image-generation');
let imageRequests = 0, failing = false, checks = 0;
const errors = [], check = (name, value) => { assert.ok(value, name); checks++; console.log('PASS ' + name); };
const server = http.createServer((req, res) => {
    const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
});
const ready = page => page.waitForFunction(() => window.__RP_IMAGE_SCOPE__?._initComplete);
(async () => {
    let browser, page;
    try {
        fs.mkdirSync(OUT, { recursive: true }); await new Promise(done => server.listen(0, '127.0.0.1', done));
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
        page.on('pageerror', e => errors.push(e.message));
        await page.addInitScript(() => { window.marked = { use() {}, parse: String }; window.DOMPurify = { sanitize: String }; localStorage.setItem('roleplay_hub_update_id', '99999'); });
        await page.route('**/*', route => {
            const host = new URL(route.request().url()).hostname;
            if (['127.0.0.1', 'unpkg.com', 'cdn.jsdelivr.net', 'cdn.tailwindcss.com'].includes(host)) return route.continue();
            return route.fulfill({ contentType: 'application/json', body: '{"data":[]}' });
        });
        await page.route('**/assets/js/app.js?*', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8').replace('const __s = {};', 'const __s = window.__RP_IMAGE_SCOPE__ = {};') }));
        await page.route('https://image-fixture.local/v1/chat/completions', route => {
            imageRequests++;
            const body = route.request().postDataJSON();
            assert.equal(route.request().headers().authorization, 'Bearer fixture-image-key');
            assert.equal(body.model, 'nai-diffusion-4-5-full:k_dpmpp_2m');
            assert.match(body.messages[0].content, /^提示词:a cup of tea|^提示词:a\+b/);
            assert.doesNotMatch(JSON.stringify(body), /fixture-image-key|legacy-key|image###/);
            return failing ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.fulfill({ contentType: 'application/json',
                body: JSON.stringify({ choices: [{ message: { content: `![image](http://127.0.0.1:${server.address().port}/assets/images/wechat/desk.jpg)` } }] }) });
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 }); await ready(page);
        await page.evaluate(async () => {
            const s = window.__RP_IMAGE_SCOPE__;
            s.showUserSetupModal.value = false;
            s.characters.value = [{ uuid: 'rp-image-test', name: '插图测试', description: '测试角色', personality: '', first_mes: '', avatar: '', wechatEnabled: true }];
            await s.selectCharacter(0, false, { silent: true });
            Object.assign(s.settings.wechatImageApi, { apiKey: 'fixture-image-key', baseUrl: 'https://image-fixture.local/v1' });
            s.settings.imageGenKey = 'legacy-key';
            s.setAutoImageGenEnabled(true);
            s.isGenerating.value = true;
            s.chatHistory.value = [{ role: 'assistant', content: '她把茶放在桌上。\n\nimage###a cup of tea, table###', shouldAnimate: false }];
            s.currentView.value = 'chat';
        });
        await page.locator('.generated-image-card').waitFor();
        check('流式未完成时只等待，不请求生图', imageRequests === 0 && await page.locator('.generated-image-progress-label').innerText() === '等待正文完成…');
        await page.evaluate(() => { const s = window.__RP_IMAGE_SCOPE__; s.chatHistory.value[0].content = '她把茶放在桌上。\n\nimage###a cup of tea, table###'; s.isGenerating.value = false; });
        await page.waitForFunction(() => document.querySelector('.generated-image-card img')?.naturalWidth > 0);
        check('正文图片通过共用接口生成并显示', imageRequests === 1);
        check('DOM 不含旧密钥或旧请求地址', !await page.locator('.generated-image-card').evaluate(el => /legacy-key|fixture-image-key|nai.sta1n|token=/.test(el.outerHTML)));
        await page.screenshot({ path: path.join(OUT, 'rp-generated-desktop.png') });
        const original = await page.evaluate(() => window.__RP_IMAGE_SCOPE__.chatHistory.value[0].content);
        await page.locator('.generated-image-reroll').click();
        await page.waitForFunction(() => !window.__RP_IMAGE_SCOPE__.isAutoImageGenerating.value);
        check('重新生成只请求一次且保留原提示', imageRequests === 2 && await page.evaluate(() => window.__RP_IMAGE_SCOPE__.chatHistory.value[0].content) === original);
        await page.evaluate(async () => { const s = window.__RP_IMAGE_SCOPE__; await s.saveCharactersNow(); await s.saveData(); });
        await page.reload(); await ready(page);
        await page.evaluate(() => { const s = window.__RP_IMAGE_SCOPE__; s.showUserSetupModal.value = false; s.currentView.value = 'chat'; });
        await page.waitForFunction(() => document.querySelector('.generated-image-card img')?.naturalWidth > 0);
        check('刷新恢复图片且不重复生图', imageRequests === 2);
        failing = true;
        await page.evaluate(() => { window.__RP_IMAGE_SCOPE__.chatHistory.value.push({ role: 'assistant', content: 'image###a+b, "quoted", x&y###', shouldAnimate: false }); });
        await page.locator('.is-generation-error').waitFor();
        check('生图失败显示错误且不假装成功', imageRequests === 3 && /HTTP 503/.test(await page.locator('.is-generation-error').innerText()));
        failing = false;
        await page.locator('.is-generation-error .generated-image-reroll').click();
        await page.waitForFunction(() => !window.__RP_IMAGE_SCOPE__.isAutoImageGenerating.value);
        check('手动重试恢复图片，特殊提示字符保持原样', imageRequests === 4 && await page.locator('.generated-image-card').last().evaluate(el => el.querySelector('img').naturalWidth > 0));
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('.entry-transition').waitFor({ state: 'hidden' });
        await page.screenshot({ path: path.join(OUT, 'rp-generated-mobile.png') });
        await page.evaluate(() => { window.__RP_IMAGE_SCOPE__.currentView.value = 'settings'; });
        await page.locator('#wechat-image-settings').scrollIntoViewIfNeeded();
        check('共用生图设置手机端没有横向溢出', await page.locator('#wechat-image-settings').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        check('移除了 RP 旧密钥输入', await page.locator('input[placeholder="原自动插图服务密钥"]').count() === 0);
        check('没有页面脚本错误', errors.length === 0);
        console.log(`${checks}/${checks} passed. Fixture APIs.`);
    } catch (error) {
        console.error(error, errors);
        if (page) {
            console.error(await page.evaluate(() => { const s = window.__RP_IMAGE_SCOPE__; return { character: s?.currentCharacter.value?.uuid,
                history: s?.chatHistory.value, busy: s?.isConversationBusy.value, applying: s?._isApplyingCharacterScopedData,
                regex: s?.regexScripts.value.filter(r => r.name === 'NAI画图正则'), tasks: [...(s?.generatedImageTasks.values() || [])].map(t => t.job),
                cards: [...document.querySelectorAll('.generated-image-card')].map(c => c.outerHTML) }; }));
            await page.screenshot({ path: path.join(OUT, 'failure.png') });
        }
        process.exitCode = 1;
    }
    finally { await browser?.close(); server.close(); }
})();
