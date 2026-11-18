// Real Vue/IndexedDB/Edge UI, with deterministic model responses and a fresh browser profile.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.refactor-tmp/chat-map');
const { chromium } = require(require.resolve('playwright-core', { paths: [path.join(root, 'tools/refactor')] }));
const requests = [], errors = []; let fixture = 'rp';
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.jpeg': 'image/jpeg' }[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
});
const check = (label, condition) => { assert.ok(condition, label); console.log('PASS ' + label); };
(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            window.marked = { use() {}, parse: text => String(text) }; window.DOMPurify = { sanitize: text => String(text) };
            let value;
            Object.defineProperty(window, 'Vue', { configurable: true, get: () => value, set(v) {
                value = v; if (!v?.createApp || v.createApp.__chatMapTest) return;
                const mounted = v.onMounted;
                v.onMounted = (hook, ...args) => { const root = !v.getCurrentInstance()?.parent; return mounted(async (...hookArgs) => { await hook(...hookArgs); if (root) window.__CHAT_MAP_BOOTED__ = true; }, ...args); };
                const createApp = v.createApp;
                v.createApp = (...args) => { const app = createApp(...args), mount = app.mount; app.mount = (...args) => { const result = mount.apply(app, args); window.__APP_PROXY__ = result; return result; }; return app; };
                v.createApp.__chatMapTest = true;
            } });
        });
        await page.route('**/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[{"id":"mock","object":"model"}]}' }));
        await page.route('**/chat/completions', route => {
            const body = route.request().postDataJSON(); requests.push(body);
            const done = body.messages.some(m => m.role === 'tool');
            const tool = (id, args) => ({ id, type: 'function', function: { name: 'tool_geo', arguments: JSON.stringify(args) } });
            const content = fixture === 'spoken' ? '{"messages":[{"type":"text","content":"刚回北苑"},{"type":"text","content":"吃过了"}],"position":{"action":"present","placeId":"dorm-4","detail":"一楼门口台阶"}}' : fixture === 'wechat' ? '{"messages":[{"type":"text","content":"到啦。"}],"position":{"action":"present","placeId":"library","detail":"四楼靠窗书桌"}}' : '到啦，先等你。';
            const message = done || fixture === 'spoken' ? { role: 'assistant', content } : { role: 'assistant', content: fixture === 'rp' ? '她走进了图书馆。' : '', tool_calls: [
                tool('map-update', fixture === 'rp' ? { operation: 'update_location', locationStatus: 'last_confirmed', query: 'library', sourceMessageId: 'current', evidence: '她走进了图书馆。' } : { operation: 'context', query: 'library' }),
                tool('map-status', { operation: 'status' })
            ] };
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message, finish_reason: done ? 'stop' : 'tool_calls' }] }) });
        });
        const url = `http://127.0.0.1:${server.address().port}/`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__CHAT_MAP_BOOTED__ && window.__APP_PROXY__?.characters, { timeout: 60000 });
        await page.evaluate(async () => {
            const r = window.__APP_PROXY__;
            const avatar = (letter, fill) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="40" fill="${fill}"/><text x="40" y="52" text-anchor="middle" font-size="36" fill="white">${letter}</text></svg>`);
            r.showUserSetupModal = false; r.user.name = '玩家'; r.user.avatar = avatar('我', 'steelblue');
            r.characters.push({ uuid: 'chat-map-test', name: '苏祈雪', avatar: avatar('雪', 'slateblue'), description: '地理地图测试角色', first_mes: '', wechatEnabled: true, wechatSpeed: 'fast', wechatStickerRate: 'off',
                geography: { enabled: true, worldId: 'jiangnan-south-campus', bindings: { character: { home: 'dorm-3' }, user: { home: 'dorm-13' } } } });
            await r.selectCharacter(r.characters.length - 1, false, { silent: true });
            r.settings.apiUrl = 'https://mock.local/v1'; r.settings.apiKey = 'fixture'; r.settings.model = 'mock';
            r.settings.cotEnabled = false; r.settings.autoImageGen = false; r.settings.uiTemplateEnabled = false; r.memorySettings.enabled = false;
            r.settings.useCharacterBackground = false;
            r.activeTools.forEach(t => t.enabled = false);
        });
        await page.getByRole('button', { name: '打开导航', exact: true }).first().click();
        await page.getByRole('button', { name: '地理地图', exact: true }).click();
        const drawer = page.getByTestId('chat-map');
        await drawer.waitFor();
        await page.waitForFunction(() => Math.abs(document.querySelector('.geo-drawer').getBoundingClientRect().right - innerWidth) < 1);
        check('导航地图入口打开右侧固定抽屉，聊天区保留可用空间', await page.evaluate(() => {
            const map = document.querySelector('.geo-drawer').getBoundingClientRect(), chat = document.querySelector('.app-main').getBoundingClientRect();
            return Math.abs(map.right - innerWidth) < 1 && chat.right <= map.left + 1;
        }));
        check('住址不当当前位置，未知人物不落地图标记', await drawer.locator('.geo-marker').count() === 0 && (await drawer.textContent()).includes('位置未知'));
        await drawer.getByLabel('选择地图地点').selectOption('dorm-13');
        await drawer.getByRole('button', { name: '把我的位置设在这里' }).click();
        await page.waitForFunction(() => window.__APP_PROXY__.chatMapLocations?.user.placeId === 'dorm-13' && !window.__APP_PROXY__.chatMapSaving);
        check('玩家选择自己的位置直接保存，不触发模型请求', requests.length === 0 && await drawer.getByTestId('map-marker-user').count() === 1);
        check('聊天显示可读位置设定', await page.getByText('📍 我的位置：南苑13栋', { exact: true }).count() === 1);
        await page.evaluate(async () => { const r = window.__APP_PROXY__; r.userInput = '你到图书馆了吗？'; await r.sendMessage(); });
        await page.waitForFunction(() => window.__APP_PROXY__.chatMapLocations?.character.placeId === 'library');
        const toolResult = requests.at(-1).messages.find(m => m.role === 'tool' && m.tool_call_id === 'map-status');
        check('RP原生工具更新角色并续写，同响应状态查询看见已保存的位置', requests.length === 2 && toolResult.content.includes('library') && toolResult.content.includes('last_confirmed'));
        check('地图画出双方头像与真实路网路线', await drawer.locator('.geo-marker').count() === 2 && await drawer.locator('.geo-route').count() === 1);
        const routeText = await drawer.locator('.geo-route-summary').textContent();
        await drawer.getByLabel('地图交通方式').selectOption('bike');
        check('可切换骑行路线和耗时', (await drawer.locator('.geo-route-summary').textContent()) !== routeText);
        await drawer.getByRole('button', { name: '双方', exact: true }).click();
        await page.waitForFunction(() => !!document.querySelector('.geo-map-image image')?.getAttribute('href'));
        await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
        await page.evaluate(() => { const r = window.__APP_PROXY__; const source = r.chatHistory.find(m => m.geographyUpdates); source.content = '她打算去图书馆。'; });
        await page.waitForFunction(() => window.__APP_PROXY__.chatMapLocations.character.status === 'unknown');
        check('编辑依据后角色标记立即失效', await drawer.getByTestId('map-marker-character').count() === 0);
        await page.evaluate(async () => {
            const r = window.__APP_PROXY__, S = window.RPHubStorage;
            await S.setScopedStoredValue('chat', r.currentCharacter.uuid, JSON.parse(JSON.stringify(r.chatHistory)));
            await S.setStoredValue('characters', JSON.parse(JSON.stringify(r.characters)));
            await S.setStoredValue('settings', JSON.parse(JSON.stringify(r.settings)));
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__CHAT_MAP_BOOTED__ && window.__APP_PROXY__?.currentCharacter?.uuid === 'chat-map-test', { timeout: 60000 });
        await page.getByRole('button', { name: '打开地理地图', exact: true }).click();
        await drawer.waitFor();
        check('刷新恢复本分支玩家位置，失效的角色证据不恢复成旧坐标', await page.evaluate(() => { const r = window.__APP_PROXY__; return r.chatMapLocations.user.placeId === 'dorm-13' && r.chatMapLocations.character.status === 'unknown'; }));
        await drawer.getByRole('button', { name: '清除我的位置', exact: true }).click();
        await page.waitForFunction(() => window.__APP_PROXY__.chatMapLocations.user.status === 'unknown');
        check('玩家可清除位置，地图不继续显示旧标记', await drawer.getByTestId('map-marker-user').count() === 0);
        await drawer.getByLabel('地图搜索地点').fill('图书馆');
        await drawer.getByLabel('选择地图地点').selectOption('library');
        await drawer.getByRole('button', { name: '把我的位置设在这里' }).click();
        await page.waitForFunction(() => !window.__APP_PROXY__.chatMapSaving);
        fixture = 'wechat';
        await page.evaluate(async () => {
            const r = window.__APP_PROXY__; await r.openWechat(); r.wechatBurstMode = true;
            r.wechatTimeline.push({ id: 'wx-location', channel: 'wechat', role: 'assistant', type: 'text', content: '她走进了图书馆。', at: Date.now() });
            r.wechatInput = '到了吗'; await r.sendWechatMessage(); await r.requestWechatReplyNow();
        });
        await page.waitForFunction(() => window.__APP_PROXY__.chatMapLocations.character.placeId === 'library');
        check('微信查询后最终JSON提交自身场景，双方同址头像分别显示', await drawer.locator('.geo-marker').count() === 2 && await drawer.locator('.geo-route-summary').textContent().then(text => text.includes('同址')));
        check('微信仅提供查询schema，未广告旧位置写入工具', !requests.at(-1).tools.find(t => t.function.name === 'tool_geo').function.parameters.properties.operation.enum.includes('update_location'));
        check('微信固定地图时聊天层避开右侧抽屉', await page.evaluate(() => document.querySelector('.wx-root').getBoundingClientRect().right <= document.querySelector('.geo-drawer').getBoundingClientRect().left + 1));
        check('同址头像横向分开展示，指针仍指向同一坐标', await drawer.locator('.geo-marker-bubble').evaluateAll(elements => elements[0].style.transform !== elements[1].style.transform));
        await drawer.getByRole('button', { name: '双方', exact: true }).click();
        await page.screenshot({ path: path.join(output, 'same-place.png'), fullPage: true });
        await page.evaluate(() => window.RPHubTheme.set('dark'));
        await page.screenshot({ path: path.join(output, 'dark.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForFunction(() => {
            const map = document.querySelector('.geo-map-viewport').getBoundingClientRect();
            return [...document.querySelectorAll('.geo-marker')].every(el => { const r = el.getBoundingClientRect(); return r.left < map.right && r.right > map.left && r.top < map.bottom && r.bottom > map.top; });
        });
        check('窗口缩到手机宽度后同址人物仍在可见地图内，并使用对话框语义', await drawer.getAttribute('role') === 'dialog' && await drawer.getAttribute('aria-modal') === 'true');
        await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
        check('手机右抽屉覆盖显示，无页面横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.geo-drawer').getBoundingClientRect().width <= innerWidth));
        await drawer.getByRole('button', { name: '关闭地理地图', exact: true }).click();
        await drawer.waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: '微信地理地图', exact: true }).click();
        await drawer.waitFor();
        await drawer.getByRole('button', { name: '关闭地理地图', exact: true }).focus(); await page.keyboard.press('Escape');
        await drawer.waitFor({ state: 'hidden' });
        check('微信可随时打开地图，Escape关闭并恢复入口焦点', await page.evaluate(() => document.activeElement.getAttribute('aria-label') === '微信地理地图'));
        await page.getByRole('button', { name: '微信地理地图', exact: true }).click();
        fixture = 'spoken';
        await page.evaluate(async () => { const r = window.__APP_PROXY__; r.wechatTimeline = []; r.wechatBurstMode = true;
            r.wechatInput = '北苑哪一栋？你已经到楼里了吗，还是在路上？'; await r.sendWechatMessage(); await r.requestWechatReplyNow(); });
        await page.waitForFunction(() => window.__APP_PROXY__.chatMapLocations.character.placeId === 'dorm-4');
        check('只说刚回北苑，内部自主选择4栋和门口台阶，不按住址3栋代填', await drawer.getByTestId('map-marker-character').count() === 1 && (await drawer.textContent()).includes('一楼门口台阶'));
        await page.waitForFunction(async () => {
            const r = window.__APP_PROXY__;
            if (r.isWechatGenerating) return false;
            const scope = window.RPHubStoryBranches.getStoryBranchScopeId(r.currentCharacter.uuid, r.activeStoryBranchId);
            const saved = await window.RPHubStorage.getScopedStoredValue('wechat_timeline', scope);
            return saved?.some(m => m.geographyPosition?.decision.placeId === 'dorm-4');
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__CHAT_MAP_BOOTED__ && window.__APP_PROXY__?.currentCharacter?.uuid === 'chat-map-test', { timeout: 60000 });
        await page.getByRole('button', { name: '打开地理地图', exact: true }).click();
        await page.waitForFunction(() => window.__APP_PROXY__.chatMapLocations.character.placeId === 'dorm-4');
        check('刷新重放内部自身场景，对外模糊措辞不抹掉模型决定的位置', await drawer.getByTestId('map-marker-character').count() === 1);
        await page.evaluate(() => { const r = window.__APP_PROXY__; r.closeWechat(); r.currentCharacter.geography.enabled = false; r.openChatMap(); });
        await drawer.waitFor();
        check('未绑定地图有明确设置入口', (await drawer.textContent()).includes('尚未绑定可用地图') && await drawer.getByRole('button', { name: '设置角色地理环境' }).count() === 1);
        await page.evaluate(async () => {
            const r = window.__APP_PROXY__, h = r.worldUi;
            r.showChatMap = false; r.currentView = 'world'; h.worldNew();
            h.worldDraft.playerName = '地图玩家'; h.worldDraft.openingMode = 'none'; h.worldDraft.mapId = 'jiangnan-south-campus';
            for (const a of h.worldDraft.actors) a.card = { name: a.name, personality: '在校学生', first_mes: '', worldInfo: [] };
            await h.worldCreate(); if (h.worldError) throw new Error(h.worldError);
            const s = h.worldSnapshot;
            h.worldSnapshot = await window.RPHubWorldStore.commit({ sessionId: s.sessionId, branchId: s.branchId, expectedRevision: s.revision, idempotencyKey: 'map-fixture-cast', events: [],
                patch: { actorStates: { suqixue: { position: { status: 'confirmed', placeId: 'library' } }, linwan: { position: 'dorm-3' }, qing: { position: { status: 'travelling', placeId: 'dorm-13', to: 'library' } } } } });
        });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.getByRole('button', { name: '世界地理地图', exact: true }).click();
        await drawer.waitFor();
        check('多角色世界共用右抽屉，展示全部人物且在途不冒充到达', await drawer.locator('.geo-actor-card').count() === 4 && await drawer.locator('.geo-marker').count() === 2);
        await drawer.getByLabel('选择地图地点').selectOption('dorm-13');
        const beforeWorldRequests = requests.length;
        const beforePhone = await page.evaluate(() => window.__APP_PROXY__.worldUi.worldSnapshot.actorStates.player?.phoneAccess);
        await drawer.getByRole('button', { name: '把我的位置设在这里' }).click();
        await page.waitForFunction(() => !window.__APP_PROXY__.chatMapSaving && window.__APP_PROXY__.worldUi.worldSnapshot.actorStates.player?.position?.placeId === 'dorm-13');
        check('世界玩家设置位置只提交本分支状态事件，保留手机状态且不调用模型', requests.length === beforeWorldRequests && await page.evaluate(phone => window.__APP_PROXY__.worldUi.worldSnapshot.actorStates.player.phoneAccess === phone, beforePhone));
        await drawer.getByLabel('地图关注人物').selectOption('linwan');
        check('选择关注人物后路程切换为对应NPC', (await drawer.locator('.geo-route-summary').textContent()).includes('林晚'));
        await drawer.getByRole('button', { name: '双方', exact: true }).click();
        await page.screenshot({ path: path.join(output, 'world.png'), fullPage: true });
        await page.evaluate(async () => {
            const h = window.__APP_PROXY__.worldUi, s = h.worldSnapshot;
            h.worldCheckpointSeq = s.events.find(e => e.kind === 'actor.state_changed' && e.actorId === 'player' && e.payload.state.position?.placeId === 'dorm-13').seq - 1;
            h.worldBranchName = '地图回档测试'; await h.worldFork(); if (h.worldError) throw new Error(h.worldError);
        });
        await page.waitForFunction(() => window.__APP_PROXY__.chatMapLocations.user.status === 'unknown');
        check('世界回档重放位置事件，后续玩家定位不泄漏到新分支', await drawer.getByTestId('map-marker-user').count() === 0);
        check('浏览器无运行错误', errors.length === 0);
        console.log('Screenshots: ' + output);
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
