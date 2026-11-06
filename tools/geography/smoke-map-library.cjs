// Actual Vue UI, native file input/download, image decoding and IndexedDB persistence.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const atlasWorld = JSON.parse(fs.readFileSync(path.join(root, 'worlds/jiangnan-south-campus.json'), 'utf8'));
const { chromium } = require(require.resolve('playwright-core', { paths: [path.join(root, 'tools/refactor')] }));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rphub-maps-')), errors = [], warnings = [];
const requests = []; let channel = 'rp';
let closing = false;
// This repository's Playwright version can reject an uncommitted iframe initialization
// during Chromium disposal on Node 25. Only ignore that exact teardown rejection.
process.on('unhandledRejection', e => { if (closing && e?.name === 'TargetClosedError') return; console.error(e); process.exitCode = 1; });
const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.jpeg': 'image/jpeg' }[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
const check = (label, ok) => { assert.ok(ok, label); console.log('PASS ' + label); };
(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
        await context.addInitScript(() => {
            window.marked = { use() {}, parse: text => String(text) }; window.DOMPurify = { sanitize: text => String(text) };
            let value;
            Object.defineProperty(window, 'Vue', { configurable: true, get: () => value, set(v) {
                value = v; if (!v?.createApp || v.createApp.__mapTest) return;
                const mounted = v.onMounted;
                v.onMounted = (hook, ...args) => { const root = !v.getCurrentInstance()?.parent; return mounted(async (...hookArgs) => { await hook(...hookArgs); if (root) window.__MAP_BOOTED__ = true; }, ...args); };
                const createApp = v.createApp; v.createApp = (...args) => { const app = createApp(...args), mount = app.mount; app.mount = (...args) => { const result = mount.apply(app, args); window.__APP_PROXY__ = result; return result; }; return app; }; v.createApp.__mapTest = true;
            } });
        });
        await context.route('**/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' }));
        await context.route('**/chat/completions', route => {
            const body = route.request().postDataJSON(); requests.push({ channel, body });
            const completed = body.messages.some(m => m.role === 'tool');
            const message = completed ? { role: 'assistant', content: channel === 'wechat' ? JSON.stringify({ messages: [{ type: 'text', content: '走过去大概2分钟。' }] }) : '走过去大概2分钟。' }
                : { role: 'assistant', content: '', tool_calls: [{ id: 'custom-map-context', type: 'function', function: { name: 'tool_geo', arguments: JSON.stringify({ operation: 'context', from: '测试食堂', to: '测试宿舍' }) } }] };
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message, finish_reason: completed ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) });
        });
        const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('console', msg => { if (msg.type() === 'warning' && /Vue warn/.test(msg.text())) warnings.push(msg.text()); });
        page.on('dialog', dialog => dialog.accept());
        const boot = async () => {
            await page.waitForFunction(() => window.__MAP_BOOTED__ && window.__APP_PROXY__?.mapRecords, { timeout: 60000 });
            await page.evaluate(() => { const r = window.__APP_PROXY__; r.showUserSetupModal = false; r.user.name = '测试玩家'; r.currentView = 'maps'; });
        };
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' }); await boot();
        await page.getByRole('button', { name: '查看 / 编辑', exact: true }).waitFor();
        check('地理环境管理入口可显示内置江大地图', await page.locator('.map-view article').count() === 1);
        await page.getByRole('button', { name: '浏览地点', exact: true }).click();
        const atlas = page.getByTestId('map-atlas'); await atlas.waitFor();
        check('地点浏览默认展示全部场景地点', await atlas.locator('.atlas-place-button').count() === atlasWorld.places.filter(p => p.kind !== 'junction').length);
        await page.getByLabel('浏览地点目录').selectOption('library');
        check('浏览器完整展示图书馆介绍，不使用工具的180字截断', await page.getByTestId('atlas-local-scene').textContent() === atlasWorld.places.find(p => p.id === 'library').scene);
        await atlas.locator('summary').filter({ hasText: '所属片区完整背景' }).click();
        check('完整片区背景可展开查看', await page.getByTestId('atlas-district-scene').textContent() === atlasWorld.districts.library.scene);
        await page.getByLabel('浏览搜索地点').fill('声控灯');
        check('地点介绍可搜索，找到B栋', await atlas.locator('.atlas-place-button').count() === 1 && (await atlas.locator('.atlas-place-button').textContent()).includes('B栋'));
        await page.getByLabel('浏览搜索地点').fill(''); await atlas.getByLabel('显示路网节点').check();
        check('可显示全部地点和路网节点', await atlas.locator('.atlas-place-button').count() === atlasWorld.places.length);
        await page.screenshot({ path: path.join(tmp, 'atlas-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(tmp, 'atlas-mobile.png'), fullPage: true });
        check('手机地点浏览无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.getByRole('button', { name: '返回列表', exact: true }).click();
        const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: '导出地图包', exact: true }).click();
        const download = await downloaded, output = path.join(tmp, 'pilot.rpmap.json'); await download.saveAs(output);
        const pack = JSON.parse(fs.readFileSync(output, 'utf8'));
        check('浏览器导出原图片字节与地点道路文化，自包含且无本地路径', Buffer.compare(Buffer.from(pack.image.dataUrl.split(',')[1], 'base64'), fs.readFileSync(path.join(root, 'card/江大南校区.jpeg'))) === 0 && pack.world.places.length === atlasWorld.places.length && !pack.world.image);
        check('浏览器导出保留生活需求、服务和使用惯例', JSON.stringify(pack.world.everyday) === JSON.stringify(atlasWorld.everyday) && pack.world.places.find(p => p.id === 'youkang').usage === atlasWorld.places.find(p => p.id === 'youkang').usage);
        await page.getByTestId('map-import').setInputFiles(output); await page.waitForFunction(() => window.__APP_PROXY__.mapRecords.length === 2);
        check('同ID导入为副本，内置世界保持原ID', await page.evaluate(() => { const r = window.__APP_PROXY__.mapRecords; return r[0].world.id === 'jiangnan-south-campus' && r[1].world.id.includes('-import-'); }));
        await page.locator('.map-view article').last().getByRole('button', { name: '查看 / 编辑' }).click();
        await page.getByRole('button', { name: '文化 / 标定', exact: true }).click();
        await page.getByLabel('路程起点').selectOption('dorm-13'); await page.getByLabel('路程终点').selectOption('lab-A'); await page.getByRole('button', { name: '计算步行 / 骑车', exact: true }).click();
        check('实际编辑器路程检查仍为35分钟', (await page.locator('.map-form pre').textContent()).includes('"typicalMinutes": 35'));
        await page.getByRole('button', { name: '地点', exact: true }).click(); await page.getByLabel('选择地点道路').selectOption('canteen-3');
        await page.getByLabel('用途 / 功能', { exact: true }).fill('测试食堂用途');
        await page.getByRole('button', { name: '在图上定位', exact: true }).click();
        await page.getByTestId('map-canvas').evaluate(svg => { const pt = svg.createSVGPoint(); pt.x = 100; pt.y = 100; const screen = pt.matrixTransform(svg.getScreenCTM()); svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: screen.x, clientY: screen.y })); });
        const coords = [+(await page.getByLabel('X', { exact: true }).inputValue()), +(await page.getByLabel('Y', { exact: true }).inputValue())];
        check('图上定位按归一坐标计算，编辑用途可见（屏幕取整误差≤2）', coords.every(n => Math.abs(n - 100) <= 2));
        await page.getByRole('button', { name: '保存地图', exact: true }).click(); await page.waitForFunction(() => window.__APP_PROXY__.mapRecords[1].world.places.find(p => p.id === 'canteen-3').function === '测试食堂用途');
        await page.getByRole('button', { name: '返回列表', exact: true }).click();
        await page.getByRole('button', { name: '新建地图', exact: true }).click();
        await page.getByTestId('map-image').setInputFiles(path.join(root, 'card/江大南校区.jpeg'));
        await page.getByTestId('map-canvas').waitFor(); await page.getByLabel('地图名称').fill('两点测试世界');
        await page.getByRole('button', { name: '添加地点', exact: true }).click(); await page.getByLabel('地点名称', { exact: true }).fill('测试宿舍');
        await page.getByLabel('X', { exact: true }).fill('100'); await page.getByLabel('Y', { exact: true }).fill('100');
        await page.getByRole('button', { name: '添加地点', exact: true }).click(); await page.getByLabel('地点名称', { exact: true }).fill('测试食堂');
        await page.getByLabel('用途 / 功能', { exact: true }).fill('供应夜宵'); await page.getByLabel('X', { exact: true }).fill('200'); await page.getByLabel('Y', { exact: true }).fill('100');
        await page.getByRole('button', { name: '道路', exact: true }).click(); await page.getByRole('button', { name: '添加道路', exact: true }).click();
        await page.getByLabel('道路长度', { exact: false }).fill('150'); await page.getByLabel('长度来源').selectOption('measured');
        await page.getByRole('button', { name: '图上添加折点', exact: true }).click();
        await page.getByTestId('map-canvas').evaluate(svg => { const pt = svg.createSVGPoint(); pt.x = 150; pt.y = 120; const screen = pt.matrixTransform(svg.getScreenCTM()); svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: screen.x, clientY: screen.y })); });
        await page.getByRole('button', { name: '保存地图', exact: true }).click(); await page.waitForFunction(() => window.__APP_PROXY__.mapRecords.length === 3);
        const id = await page.evaluate(() => window.__APP_PROXY__.mapRecords.at(-1).world.id);
        check('玩家可上传原图、新建地点和有折线的道路并保存', await page.evaluate(() => { const w = window.__APP_PROXY__.mapRecords.at(-1).world; return w.places.length === 2 && w.edges[0].points.length === 1 && window.RPHubGeography.route(w, '测试宿舍', '测试食堂').duration.typicalMinutes === 2; }));
        await page.screenshot({ path: path.join(tmp, 'map-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(tmp, 'map-mobile.png'), fullPage: true });
        check('手机地图编辑器无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => { const r = window.__APP_PROXY__; r.currentView = 'characters'; r.characters.push({ name: '测试角色', uuid: 'map-character', avatar: '', description: '', first_mes: '', personality: '', worldInfo: [], regexScripts: [], uiTemplates: [], wechatEnabled: true }); r.editCharacter(r.characters.length - 1); r.editorTab = 'geography'; r.editingCharacter.data.description = '待保存角色草稿'; });
        await page.getByRole('button', { name: '打开地图管理', exact: true }).click();
        await page.getByRole('button', { name: '返回角色编辑', exact: true }).click();
        check('往返地图管理保留角色编辑草稿', await page.evaluate(() => window.__APP_PROXY__.showCharacterEditor && window.__APP_PROXY__.editingCharacter.data.description === '待保存角色草稿'));
        await page.getByLabel('角色绑定地图').selectOption(id); const ids = await page.evaluate(() => window.__APP_PROXY__.mapRecords.at(-1).world.places.map(p => p.id));
        await page.getByLabel('玩家住址', { exact: true }).selectOption(ids[0]); await page.getByLabel('角色住址', { exact: true }).selectOption(ids[1]);
        await page.evaluate(() => {
            window.__MAP_TEST_PUT__ = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function(value, key) { if (String(key).endsWith('characters')) throw new DOMException('fixture storage failure', 'QuotaExceededError'); return window.__MAP_TEST_PUT__.apply(this, arguments); };
        });
        await page.getByRole('button', { name: '保存角色', exact: true }).click();
        await page.waitForFunction(() => document.body.textContent.includes('fixture storage failure'));
        check('角色落盘失败保留编辑页与绑定草稿，回滚未保存角色', await page.evaluate(() => { const r = window.__APP_PROXY__; return r.showCharacterEditor && r.characters.length === 1 && !r.characters[0].geography && r.editingCharacter.data.geography.worldId; }));
        await page.evaluate(() => { IDBObjectStore.prototype.put = window.__MAP_TEST_PUT__; delete window.__MAP_TEST_PUT__; });
        await page.getByRole('button', { name: '保存角色', exact: true }).click();
        await page.waitForFunction(() => !window.__APP_PROXY__.showCharacterEditor);
        await page.waitForFunction(id => window.__APP_PROXY__.characters.at(-1).geography?.worldId === id, id);
        await page.evaluate(async () => { const r = window.__APP_PROXY__; await r.selectCharacter(r.characters.length - 1, false, { silent: true }); });
        await page.reload({ waitUntil: 'domcontentloaded' }); await boot();
        check('刷新后原图、编辑用途、道路、角色绑定都从IndexedDB恢复', await page.evaluate(id => { const r = window.__APP_PROXY__, record = r.mapRecords.find(m => m.world.id === id); return r.mapRecords.length === 3 && record.imageData.startsWith('data:image/jpeg') && record.world.edges[0].points.length === 1 && r.characters.at(-1).geography.worldId === id && r.mapRecords[1].world.places.find(p => p.id === 'canteen-3').function === '测试食堂用途'; }, id));
        check('编辑保存与刷新载入后仍保留生活需求和服务检索', await page.evaluate(() => { const w = window.__APP_PROXY__.mapRecords[1].world, G = window.RPHubGeography; return G.needs(w, '洗衣液用完了')[0].id === 'daily-supplies' && G.execute(w, {}, { operation: 'search', query: '洗衣液' }).results[0].id === 'youkang' && w.places.find(p => p.id === 'turf').usage.includes('日常跑步'); }));
        check('自建图的局部查询不含图片和完整世界数据', await page.evaluate(id => { const record = window.__APP_PROXY__.mapRecords.find(m => m.world.id === id); const text = JSON.stringify(window.RPHubGeography.execute(record.world, {}, { operation: 'place', query: '测试食堂' })); return text.includes('供应夜宵') && !/base64|edges|metersPerUnit/.test(text); }, id));
        await page.evaluate(async () => {
            const r = window.__APP_PROXY__; await r.selectCharacter(r.characters.length - 1, false, { silent: true });
            r.settings.apiUrl = 'https://mock.local/v1'; r.settings.apiKey = 'fixture'; r.settings.model = 'mock'; r.settings.cotEnabled = false; r.settings.autoImageGen = false; r.settings.uiTemplateEnabled = false; r.memorySettings.enabled = false; r.activeTools.forEach(t => t.enabled = false);
            r.chatHistory.push({ id: 'custom-char-location', role: 'user', content: '/geo character 测试食堂' }); r.userInput = '我在测试宿舍，你过来多久？'; await r.sendMessage();
        });
        check('RP实际调用绑定的自建地图，续写拿到2分钟及地点用途', requests.length === 2 && requests[1].body.messages.some(m => m.role === 'tool' && m.content.includes('供应夜宵') && /"typicalMinutes"\s*:\s*2\D/.test(m.content)));
        channel = 'wechat';
        await page.evaluate(async () => { const r = window.__APP_PROXY__; await r.openWechat(); r.wechatInput = '我在测试宿舍，你过来多久？'; r.wechatBurstMode = false; r.wechatFastMode = true; await r.sendWechatMessage(); });
        const wx = requests.filter(r => r.channel === 'wechat');
        check('微信实际调用同一自建地图和相同路程引擎', wx.length === 2 && wx[1].body.messages.some(m => m.role === 'tool' && m.content.includes('供应夜宵') && /"typicalMinutes"\s*:\s*2\D/.test(m.content)));
        check('两条实际模型管线不发送原图或完整路网', requests.every(r => !/base64|imageSize|metersPerUnit|road-[a-z0-9]{8}/.test(JSON.stringify(r.body))));
        await page.evaluate(() => window.__APP_PROXY__.closeWechat());
        await page.getByTestId('map-import').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'rp-hub-map', version: 1, world: pack.world, image: { dataUrl: 'data:image/png;base64,ZmFrZQ==' } })) });
        await page.waitForFunction(() => !window.__APP_PROXY__.mapLibraryBusy); check('损坏图片导入不写入存储', await page.locator('.map-view article').count() === 3);
        check('管理页和角色绑定无Vue解析/组件错误', errors.length === 0 && warnings.length === 0);
        // file:// original image export: no fetch/CORS dependency.
        const filePage = await context.newPage(); await filePage.goto('file:///' + path.join(root, 'index.html').replaceAll('\\', '/'), { waitUntil: 'domcontentloaded' });
        await filePage.waitForFunction(() => window.__MAP_BOOTED__ && window.__APP_PROXY__?.mapRecords, { timeout: 60000 });
        check('file协议也可取得内置原图并构建自包含包', await filePage.evaluate(async () => { const r = window.__APP_PROXY__; const data = await r.getMapImage('jiangnan-south-campus'); return window.RPHubMapPackages.encode(r.mapRecords[0].world, data).image.dataUrl.length > 100000; }));
        console.log('Screenshots: ' + tmp); console.log('MAP LIBRARY E2E PASS');
    } catch (e) { console.error(e); console.error({ errors, warnings }); process.exitCode = 1; }
    finally { closing = true; if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})();
