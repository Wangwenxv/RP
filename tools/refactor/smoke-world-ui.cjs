// Isolated Edge UI checks and old/new save measurements. Never opens the user profile.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), OUT = path.join(ROOT, '.refactor-tmp/world-ui'), SHOTS = path.join(ROOT, '.tmp-review');
const baselineRef = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11);
const oldFiles = new Map(baselineRef ? ['world-model.js', 'world-store.js', 'world-chat.js', 'world-components.js', 'app/35-world-session.js'].map(file => [
    '/assets/js/' + file, execFileSync('git', ['show', baselineRef + ':assets/js/' + file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 4000000 })]) : []);
const cards = ['card/suqixue/苏祈雪v2.json', 'card/linwan/林晚-江大测试.json', 'card/qing/卿.json'].map((file, i) => fs.existsSync(path.join(ROOT, file))
    ? JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
    : { data: { name: ['苏祈雪', '林晚', '卿'][i], personality: '在校学生，独立人物。', first_mes: i === 0 ? '三月的校园里，路灯刚刚亮起。' : '' } });
let checks = 0;
const check = (name, result) => { assert.ok(result, name); checks++; console.log('PASS ' + name); };
const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('?')[0]), file = path.resolve(ROOT, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
});
const ready = page => page.waitForFunction(() => window.__WORLD_SCOPE__?._initComplete && window.__WORLD_SCOPE__.worldUi);
async function open(browser, url, baseline = false) {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 960 } }), page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { localStorage.setItem('roleplay_hub_update_id', '99999'); window.__WORLD_SAVE_WRITES__ = 0; });
    await page.route('**/*', async route => {
        const parsed = new URL(route.request().url()), name = parsed.pathname;
        if (!['127.0.0.1', 'unpkg.com', 'cdn.jsdelivr.net', 'cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(parsed.hostname))
            return route.fulfill({ contentType: 'application/json', body: '{"data":[],"quota":0}' });
        if (parsed.hostname === '127.0.0.1') {
            if (name === '/assets/js/world-images.js') await new Promise(done => setTimeout(done, 1000)); // reproducible cold-resource wait
            let code = baseline ? oldFiles.get(name) : null;
            if (name === '/assets/js/app.js') code = fs.readFileSync(path.join(ROOT, name.slice(1)), 'utf8').replace('const __s = {};', 'const __s = window.__WORLD_SCOPE__ = {};');
            if (name === '/assets/js/data-services.js') code = fs.readFileSync(path.join(ROOT, name.slice(1)), 'utf8').replace('const updateStoredValue = async (name, update) => {', 'const updateStoredValue = async (name, update) => { window.__WORLD_SAVE_WRITES__++;');
            if (code != null) return route.fulfill({ contentType: 'text/javascript', body: code });
        }
        return route.continue();
    });
    await page.goto(url, { waitUntil: 'load', timeout: 45000 }); await ready(page);
    await page.evaluate(cards => {
        const s = window.__WORLD_SCOPE__; s.showUserSetupModal.value = false; s.currentView.value = 'world';
        s.worldNew(); Object.assign(s.worldDraft, { playerName: '测试玩家', playerDescription: '卿的舍友，独立玩家。' });
        s.worldMemoryEnabled.value = false;
        for (let i = 0; i < cards.length; i++) {
            const parsed = window.RPHubCardUtils.parseImportedCharacterCard(cards[i]), a = s.worldDraft.actors[i];
            a.card = { ...parsed, worldInfo: parsed.worldInfoEntries, originalCard: cards[i] }; a.name = parsed.name; a.sourcePath = '现有测试卡';
        }
    }, cards);
    return { context, page, errors };
}
const fits = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('.world-view').getBoundingClientRect().bottom <= window.innerHeight + 1);
(async () => {
    let browser;
    try {
        fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(SHOTS, { recursive: true });
        await new Promise(done => server.listen(0, '127.0.0.1', done));
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const url = `http://127.0.0.1:${server.address().port}/index.html`, timings = {};
        if (baselineRef) {
          const baseline = await open(browser, url, true);
          timings.before = await baseline.page.evaluate(async () => {
            window.__WORLD_SAVE_WRITES__ = 0; const start = performance.now(), s = window.__WORLD_SCOPE__; await s.worldCreate();
            if (s.worldError.value) throw Error(s.worldError.value);
            return { ms: Math.round(performance.now() - start), writes: window.__WORLD_SAVE_WRITES__ };
          });
          await baseline.context.close();
        }
        const { context, page, errors } = await open(browser, url);
        await page.waitForFunction(() => !!window.RPHubWorldImages);
        await page.locator('.entry-transition').waitFor({ state: 'hidden' });
        check('地图在填写世界时提前准备，创建页有固定保存入口', await page.locator('.world-setup-footer').isVisible());
        await page.screenshot({ path: path.join(SHOTS, 'world-setup-redesign.png') });
        timings.after = await page.evaluate(async () => {
            window.__WORLD_SAVE_WRITES__ = 0; const start = performance.now(), s = window.__WORLD_SCOPE__; await s.worldCreate();
            if (s.worldError.value) throw Error(s.worldError.value);
            return { ms: Math.round(performance.now() - start), writes: window.__WORLD_SAVE_WRITES__, bytes: JSON.stringify(s.worldSnapshot.value).length };
        });
        fs.writeFileSync(path.join(OUT, 'timings.json'), JSON.stringify({ ...timings, coldMapDelayMs: 1000, cards: 'existing cards when present; otherwise isolated fixtures' }, null, 2));
        console.log('SAVE ' + JSON.stringify(timings));
        check('现有三张卡与校园地图创建世界仅写入一次', timings.after.writes === 1 && (!timings.before || timings.before.writes === 3));
        check('已有苏祈雪开场白正常展示', (await page.locator('.world-narrative-prose').innerText()).length > 10);
        const originalId = await page.evaluate(() => window.__WORLD_SCOPE__.worldSnapshot.value.sessionId);
        await page.getByRole('button', { name: '世界工具', exact: true }).click();
        const avatarPath = path.join(ROOT, 'assets/images/wechat/cat.jpg');
        await page.locator('.world-person-row').filter({ hasText: '卿' }).locator('input[type=file]').setInputFiles(avatarPath);
        await page.waitForFunction(() => !window.__WORLD_SCOPE__.worldBusy.value && window.__WORLD_SCOPE__.worldAvatar('qing').startsWith('data:image/png'));
        check('人物工具可上传头像并原地保存，不新增世界', await page.evaluate(id => window.__WORLD_SCOPE__.worldSnapshot.value.sessionId === id, originalId));
        await page.getByRole('button', { name: '关闭世界工具', exact: true }).click();
        const qingContact = page.locator('.world-contact').filter({ hasText: '卿' });
        check('会话名册立即显示人物头像', await qingContact.locator('img').count() === 1);
        await qingContact.click();
        check('私聊标题同步显示头像', await page.locator('.world-chat-title img').count() === 1);
        await page.getByRole('checkbox', { name: '连发模式' }).check();
        await page.getByRole('textbox', { name: '世界消息输入' }).fill('测试消息，保留在当前分支。');
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await page.waitForFunction(() => !window.__WORLD_SCOPE__.worldBusy.value);
        await page.evaluate(async () => {
            const s = window.__WORLD_SCOPE__, b = s.worldSnapshot.value;
            s.worldSnapshot.value = await window.RPHubWorldStore.commit({ sessionId: b.sessionId, branchId: b.branchId, expectedRevision: b.revision, idempotencyKey: 'ui-avatar-reply', events: [
                { kind: 'message.sent', actorId: 'qing', conversationId: 'dm-qing', access: { principals: ['player', 'qing'] }, payload: { text: '好，我这边看到了。' } }
            ] });
        });
        check('消息显示真实发送人的头像', await page.locator('.world-message:not(.self) > .world-avatar img').count() === 1);
        const historyIds = await page.evaluate(() => window.__WORLD_SCOPE__.worldSnapshot.value.events.map(e => e.eventId));
        await page.getByRole('button', { name: '编辑世界', exact: true }).click();
        check('已保存世界能回到完整编辑页，保留人物卡与头像', await page.getByRole('button', { name: '保存并继续', exact: true }).isVisible()
            && await page.locator('.world-card-slot').filter({ hasText: '卿' }).locator('.world-avatar img').count() === 1);
        await page.getByLabel('世界名称', { exact: true }).fill('江南大学 · 三月晚风');
        await page.getByLabel('公共世界设定', { exact: true }).fill('三月，江南大学南校区。每个人都有自己的生活。');
        await page.getByRole('button', { name: '保存并继续', exact: true }).click();
        await page.waitForFunction(() => !window.__WORLD_SCOPE__.worldBusy.value && !window.__WORLD_SCOPE__.worldShowSetup.value);
        const revisedId = await page.evaluate(() => { const s = window.__WORLD_SCOPE__; if (s.worldError.value) throw Error(s.worldError.value); return s.worldSnapshot.value.sessionId; });
        check('世界编辑保存为新版本，保留已有剧情与头像', revisedId !== originalId && await page.evaluate(ids => ids.every(id => window.__WORLD_SCOPE__.worldSnapshot.value.events.some(e => e.eventId === id)) && !!window.__WORLD_SCOPE__.worldAvatar('qing'), historyIds));
        check('旧世界原设置与历史仍可打开', await page.evaluate(async id => (await RPHubWorldStore.load(id)).definition.name === '江南大学', originalId));
        await page.reload(); await ready(page);
        await page.locator('.entry-transition').waitFor({ state: 'hidden' });
        await page.evaluate(async id => { const s = window.__WORLD_SCOPE__; s.showUserSetupModal.value = false; s.currentView.value = 'world'; await Vue.nextTick(); await s.worldOpen(id); await s.worldSelectConversation('dm-qing'); }, revisedId);
        await page.waitForFunction(id => window.__WORLD_SCOPE__.worldSnapshot.value?.sessionId === id && document.querySelector('.world-chat-title img'), revisedId);
        check('刷新后人物头像与私聊历史保留', await page.locator('.world-chat-title img').count() === 1 && (await page.locator('.world-transcript').innerText()).includes('保留在当前分支'));
        await page.getByRole('button', { name: '创建群聊', exact: true }).click();
        const group = page.locator('.world-side-form'); await group.getByLabel('群名').fill('测试同学群');
        await group.getByRole('checkbox', { name: '卿', exact: true }).check();
        await group.getByRole('checkbox', { name: '林晚', exact: true }).check();
        await group.getByRole('button', { name: '创建群聊', exact: true }).click();
        await group.waitFor({ state: 'hidden' });
        check('群聊可直接创建并打开', (await page.locator('.world-chat-title').innerText()).includes('测试同学群'));
        await page.evaluate(async () => { const s = window.__WORLD_SCOPE__; await s.worldSelectConversation('rp-main'); });
        await page.screenshot({ path: path.join(SHOTS, 'world-rp-redesign.png') });
        check('桌面布局没有溢出', await fits(page));
        await page.setViewportSize({ width: 390, height: 844 });
        check('手机正文和输入区不被世界工具挤出屏幕', await fits(page) && await page.evaluate(() => document.querySelector('.world-composer').getBoundingClientRect().bottom <= innerHeight + 1));
        await page.screenshot({ path: path.join(SHOTS, 'world-rp-mobile-redesign.png') });
        await page.getByRole('button', { name: '世界工具', exact: true }).click();
        check('手机世界工具以独立抽屉打开，可关闭', await page.locator('.world-inspector').isVisible() && await page.locator('.world-drawer-backdrop').isVisible());
        await page.screenshot({ path: path.join(SHOTS, 'world-tools-mobile-redesign.png') });
        await page.getByRole('button', { name: '关闭世界工具', exact: true }).click();
        await page.getByRole('button', { name: '编辑世界', exact: true }).click();
        check('手机编辑页保存操作保持可见', await fits(page) && await page.locator('.world-setup-footer').isVisible());
        await page.screenshot({ path: path.join(SHOTS, 'world-setup-mobile-redesign.png') });
        await page.getByRole('button', { name: '返回世界', exact: true }).click();
        await page.setViewportSize({ width: 1440, height: 960 });
        await page.evaluate(() => RPHubTheme.set('dark'));
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.world-edit-button')).backgroundColor === 'rgb(28, 40, 46)');
        check('深色按钮与输入区采用世界配色，主题过渡完成后截图', await page.evaluate(() =>
            getComputedStyle(document.querySelector('.world-contact.active')).backgroundColor === 'rgb(28, 40, 46)'
            && getComputedStyle(document.querySelector('.world-composer textarea')).backgroundColor === 'rgba(0, 0, 0, 0)'));
        await page.screenshot({ path: path.join(SHOTS, 'world-rp-dark-redesign.png') });
        check('深色界面与所有操作没有脚本错误', errors.length === 0);
        fs.writeFileSync(path.join(OUT, 'timings.json'), JSON.stringify({ ...timings, coldMapDelayMs: 1000, cards: 'existing cards when present; otherwise isolated fixtures' }, null, 2));
        console.log('SAVE ' + JSON.stringify(timings)); console.log(`${checks}/${checks} passed.`);
        await context.close();
    } finally { if (browser) await browser.close(); await new Promise(done => server.close(done)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
