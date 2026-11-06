// Browser integration: real Vue + IndexedDB, model fixtures only, temporary browser profile.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const { chromium } = require(require.resolve('playwright-core', { paths: [path.join(root, 'tools/refactor')] }));
const card = JSON.parse(fs.readFileSync(path.join(root, 'card/suqixue/苏祈雪.json'), 'utf8'));
const requests = [], errors = [];
let channel = 'rp', fixture = 'route';
const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
});
const check = (label, condition) => { assert.ok(condition, label); console.log('PASS ' + label); };
(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const page = await browser.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            window.marked = { use() {}, parse: text => String(text) }; window.DOMPurify = { sanitize: text => String(text) };
            let value;
            Object.defineProperty(window, 'Vue', { configurable: true, get: () => value, set(v) {
                value = v; if (!v?.createApp || v.createApp.__geoTest) return;
                const mounted = v.onMounted;
                v.onMounted = (hook, ...args) => { const root = !v.getCurrentInstance()?.parent; return mounted(async (...hookArgs) => { await hook(...hookArgs); if (root) window.__GEO_BOOTED__ = true; }, ...args); };
                const createApp = v.createApp;
                v.createApp = (...args) => { const app = createApp(...args), mount = app.mount; app.mount = (...args) => { const result = mount.apply(app, args); window.__APP_PROXY__ = result; return result; }; return app; };
                v.createApp.__geoTest = true;
            } });
        });
        await page.route('**/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[{"id":"mock","object":"model"}]}' }));
        await page.route('**/chat/completions', route => {
            const body = route.request().postDataJSON(); requests.push({ channel, fixture, body });
            const geoResult = body.messages.some(m => m.role === 'tool');
            const say = text => ({ role: 'assistant', content: channel === 'wechat' ? JSON.stringify({ messages: [{ type: 'text', content: text }] }) : text });
            const tool = (id, args) => ({ id, type: 'function', function: { name: 'tool_geo', arguments: JSON.stringify(args) } });
            let message;
            if (fixture === 'burst-rooms') message = say('你先在B栋401上课，别着凉。');
            else if (fixture === 'prefetch') message = say('我还在实验楼A区。风采园是南苑食堂，我看下路程再决定。');
            else if (fixture === 'clean') message = say('好呀。');
            else if (geoResult) message = say('走过去大概35分钟，我先找辆车，你等我。');
            else message = { role: 'assistant', content: '', tool_calls: fixture === 'parallel'
                ? [tool('geo-place', { operation: 'place', query: '风采园' }), tool('geo-status', { operation: 'status' }), tool('geo-route', { operation: 'route', from: '实验楼A区', to: '13栋', mode: 'walk' })]
                : fixture === 'combined'
                ? [tool('geo-context', { operation: 'context', query: '风采园' })]
                : [tool('geo-route', { operation: 'route', from: '实验楼A区', to: '13栋', mode: 'walk' })] };
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) });
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__GEO_BOOTED__ && window.__APP_PROXY__?.characters, { timeout: 60000 });
        await page.evaluate(async card => {
            const r = window.__APP_PROXY__, U = window.RPHubCardUtils, c = U.parseImportedCharacterCard(card);
            r.showUserSetupModal = false; r.user.name = '玩家';
            r.characters.push({ ...c, uuid: 'geo-character', worldInfo: c.worldInfoEntries, first_mes: '我在实验楼A区', wechatEnabled: true, wechatSpeed: 'fast', wechatStickerRate: 'off' });
            await r.selectCharacter(r.characters.length - 1, false, { silent: true });
            r.settings.apiUrl = 'https://mock.local/v1'; r.settings.apiKey = 'fixture'; r.settings.model = 'mock';
            r.settings.cotEnabled = false; r.settings.autoImageGen = false; r.settings.uiTemplateEnabled = false; r.memorySettings.enabled = false;
            r.activeTools.forEach(t => t.enabled = false);
            r.userInput = '我在13栋，你能来吗？'; await r.sendMessage();
        }, card);
        check('RP首轮提供tool_geo，局部状态带35分钟约束', requests[0].body.tools.some(t => t.function.name === 'tool_geo') && JSON.stringify(requests[0].body.messages).includes('typicalMinutes\\":35'));
        const rp = requests.filter(r => r.channel === 'rp');
        check('RP真实工具续写保留调用ID，计算结果为35分钟', rp.length === 2 && rp[1].body.messages.some(m => m.role === 'tool' && m.tool_call_id === 'geo-route' && JSON.parse(m.content).results[0].duration.typicalMinutes === 35));
        check('RP正文展示续写，完整地图不进入模型请求', await page.evaluate(() => window.__APP_PROXY__.chatHistory.at(-1).content.includes('35分钟')) && !JSON.stringify(rp[0]).includes('metersPerUnit'));
        channel = 'wechat';
        await page.evaluate(async () => { const r = window.__APP_PROXY__; await r.openWechat(); r.wechatInput = '我在13栋，你还在实验楼A区吗？'; r.wechatBurstMode = false; await r.sendWechatMessage(); });
        const wx = requests.filter(r => r.channel === 'wechat');
        check('微信提供相同地理工具，并返回局部结果续写', wx.length === 2 && wx[0].body.tools.some(t => t.function.name === 'tool_geo') && wx[1].body.messages.some(m => m.role === 'tool' && JSON.parse(m.content).duration?.typicalMinutes === 35));
        check('微信地理工具结果不落气泡/时间线', await page.evaluate(() => { const t = window.__APP_PROXY__.wechatTimeline; return t.some(m => m.channel === 'wechat' && m.role === 'assistant' && m.content.includes('35分钟')) && !t.some(m => m.content.includes('estimatedMeters')); }));
        for (const target of ['rp', 'wechat']) {
            channel = target;
            await page.evaluate(async target => { const r = window.__APP_PROXY__; if (target === 'rp') r.closeWechat(); else await r.openWechat(); }, target);
            for (const scenario of ['parallel', 'combined', 'prefetch', 'clean']) {
                fixture = scenario; const start = requests.length;
                await page.evaluate(async ({ target, scenario }) => {
                    const r = window.__APP_PROXY__, input = scenario === 'clean' ? '谢谢啦' : '我在风采园，你在哪里？';
                    if (target === 'rp') { r.userInput = input; await r.sendMessage(); }
                    else { r.wechatInput = input; r.wechatBurstMode = false; await r.sendWechatMessage(); }
                }, { target, scenario });
                const turn = requests.slice(start).map(r => r.body);
                check(target + '业务工具请求启用同响应多调用', turn[0].parallel_tool_calls === true);
                if (scenario === 'parallel') {
                    const results = turn[1]?.messages.filter(m => m.role === 'tool') || [];
                    check(target + '三调用只发生一次续写，结果ID全部配对', turn.length === 2 && results.length === 3 && ['geo-place', 'geo-status', 'geo-route'].every(id => results.some(m => m.tool_call_id === id)));
                } else if (scenario === 'combined') {
                    const result = JSON.parse(turn[1].messages.find(m => m.role === 'tool').content);
                    const context = target === 'rp' ? result.results[0] : result;
                    check(target + '一组合调用返回食堂功能和双交通耗时', turn.length === 2 && context.places.to.id === 'canteen-3' && context.routes.walk.duration && context.routes.bike.duration);
                } else if (scenario === 'prefetch') {
                    check(target + '本轮速查包含风采园功能，不需要额外模型请求', turn.length === 1 && turn[0].messages.some(m => m.role === 'system' && m.content.includes('本轮地理速查') && m.content.includes('南苑西南')));
                } else {
                    check(target + '下一轮普通聊天不重放工具结果/速查', turn.length === 1 && !turn[0].messages.some(m => m.role === 'tool' || (m.role === 'system' && m.content.includes('本轮地理速查'))));
                }
            }
        }
        channel = 'wechat'; fixture = 'burst-rooms'; const burstStart = requests.length;
        await page.evaluate(async () => {
            const r = window.__APP_PROXY__; await r.openWechat(); r.wechatBurstMode = true;
            for (const text of ['8点左右', '多穿衣服了没', '你在图书馆吗？', '我在B栋401']) { r.wechatInput = text; await r.sendWechatMessage(); }
            await r.requestWechatReplyNow();
        });
        const burst = requests.slice(burstStart).map(r => r.body);
        const burstPrompt = burst[0].messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
        check('微信连发自动预取B栋和图书馆简介，只需一次模型请求', burst.length === 1 && burstPrompt.includes('mentionedPlaces') && burstPrompt.includes('中文系教室与办公室') && burstPrompt.includes('借阅与自习'));
        check('微信实际提示确认玩家在B栋401，询问图书馆不改角色位置', burstPrompt.includes('"user":{"status":"last_confirmed","placeId":"teaching-B"') && burstPrompt.includes('"room":"401"') && !burstPrompt.includes('"character":{"status":"last_confirmed","placeId":"library"'));
        check('浏览器无运行错误', errors.length === 0);
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
