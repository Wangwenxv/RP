// Isolated Edge + real Vue/IndexedDB + fixture HTTP model responses. No user profile or live API.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), OUT = path.join(ROOT, '.refactor-tmp/world-chat');
const requests = [], errors = []; let stage = 'dm', failLin = false, checks = 0;
let lateResolve;
let closing = false;
process.on('unhandledRejection', error => {
    if (closing && /Target page, context or browser has been closed/.test(error?.message || '') && /FrameSession\.dispose/.test(error?.stack || '')) return;
    throw error;
});
const check = (name, value) => { assert.ok(value, name); checks++; console.log('PASS ' + name); };
const server = http.createServer((req, res) => {
    const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
});
const ready = page => page.waitForFunction(() => window.__WORLD_SCOPE__?._initComplete && window.__WORLD_SCOPE__.worldUi);
const proposal = (decision, actions = [], ids = []) => JSON.stringify({ decision, actions, referencedEvidenceIds: ids, needsPlayerResponse: false });
(async () => {
    let browser;
    try {
        fs.mkdirSync(OUT, { recursive: true }); await new Promise(done => server.listen(0, '127.0.0.1', done));
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 950 } }), page = await context.newPage();
        page.on('pageerror', e => errors.push(e.message));
        await page.addInitScript(() => { window.marked = { use() {}, parse: String }; window.DOMPurify = { sanitize: String }; localStorage.setItem('roleplay_hub_update_id', '99999'); });
        await page.route('**/*', route => ['127.0.0.1', 'unpkg.com', 'cdn.jsdelivr.net', 'cdn.tailwindcss.com'].includes(new URL(route.request().url()).hostname)
            ? route.continue() : route.fulfill({ contentType: 'application/json', body: '{"data":[],"quota":0}' }));
        await page.route('**/assets/js/app.js?*', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8')
            .replace('const __s = {};', 'const __s = window.__WORLD_SCOPE__ = {};') }));
        await page.route('https://world-fixture.local/**', async route => {
            const body = route.request().postDataJSON();
            if (!body?.messages) return route.fulfill({ contentType: 'application/json', body: '{"data":[]}' });
            if (body.messages[0]?.content.includes('本次只整理')) {
                const sources = JSON.parse(body.messages.at(-1).content);
                return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: {
                    role: 'assistant', content: sources.map(e => e.name + '：' + e.text).join('；') }, finish_reason: 'stop' }] }) });
            }
            const packet = body.messages.map(m => { try { return JSON.parse(m.content); } catch (_) { return null; } }).find(p => p?.actorId || p?.acceptedEvents);
            const actorId = packet?.actorId, record = { stage, actorId: actorId || 'narrator', body, packet }; requests.push(record);
            if (stage === 'late') { lateResolve?.(); await new Promise(done => setTimeout(done, 400)); }
            if (stage === 'group-retry' && actorId === 'linwan' && failLin) { failLin = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"fixture timeout"}}' }); }
            let content;
            if (!actorId) content = stage === 'tell' ? '【NPC镜头】林晚把 TRANSFERRED_ONLY 告诉苏祈雪。苏祈雪决定暂时装作不知道。玩家的回应留待本人决定。'
                : '同一时段，卿改变了晚上的安排；苏祈雪仍依据自己读过的私聊理解玩家去打球，没有得知惊喜。';
            else if (stage === 'tell' && actorId === 'linwan') content = proposal('act', [{ kind: 'tell', targetActorId: 'suqixue', channel: 'dm', text: 'TRANSFERRED_ONLY：玩家在准备生日惊喜，请装作不知道。' }]);
            else if (stage === 'tell' && actorId === 'suqixue') content = proposal('act', [{ kind: 'remember', text: '读到林晚的转告后，决定暂时装作不知道。' }]);
            else if (stage === 'rp') content = proposal('act', [{ kind: 'act', text: actorId === 'qing' ? '收到取消打球的私聊后，卿改为自己训练。' : '苏祈雪仍以为玩家去打球，继续自己的安排。' }]);
            else if (stage.startsWith('group')) content = proposal('reply', [{ kind: 'reply', text: actorId === 'qing' ? '咋了' : '对啊，咋了，卿也不知道' }]);
            else content = proposal('reply', [{ kind: 'reply', text: actorId === 'qing' ? 'ok，取消打球，我会保密' : '好，早点回来' }]);
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } }) });
        });
        const url = `http://127.0.0.1:${server.address().port}/index.html`;
        await page.goto(url, { waitUntil: 'load', timeout: 45000 }); await ready(page);
        await page.evaluate(async () => {
            const s = window.__WORLD_SCOPE__; s.showUserSetupModal.value = false; s.currentView.value = 'world';
            s.worldMemoryEnabled.value = false;
            Object.assign(s.settings, { apiUrl: 'https://world-fixture.local/v1', apiKey: 'fixture-only', model: 'world-fixture', temperature: 0.7, stream: false });
            Object.assign(s.worldDraft, { playerName: '独立玩家', playerDescription: '学生，另一个独立人物', storyTime: '2026-05-12T17:00', mapId: '' });
            const words = { suqixue: 'SU_CARD：在校学生。', linwan: 'LIN_CARD：恋人是{{user}}。', qing: 'QING_CARD：独立 NPC。' };
            for (const a of s.worldDraft.actors) a.card = { name: a.name, personality: words[a.actorId], first_mes: a.actorId === 'suqixue' ? '三月六点半，语心湖边的路灯亮起来。' : '', worldInfo: [{ id: 'self-' + a.actorId, comment: '个人参考', content: a.actorId === 'suqixue' ? 'SU_PRIVATE_CARD_ONLY' : a.actorId + '自己的参考', constant: true }] };
            await s.worldCreate();
            if (s.worldError.value) throw new Error(s.worldError.value);
        });
        check('世界入口真实渲染，有 RP 和三条独立私聊', await page.locator('.world-contact').count() === 4);
        check('创建世界自动展示苏祈雪开场白', await page.locator('.world-message.narration').innerText().then(text => text.includes('语心湖')));
        const sid = await page.evaluate(() => window.__WORLD_SCOPE__.worldSnapshot.value.sessionId);
        await page.evaluate(async () => { const s = window.__WORLD_SCOPE__; await s.worldSelectConversation('dm-suqixue'); s.worldInput.value = '今晚去和卿打球，下课不用等我'; await s.worldSend(); if (s.worldError.value) throw new Error(s.worldError.value); });
        await page.evaluate(async () => { const s = window.__WORLD_SCOPE__; await s.worldSelectConversation('dm-qing'); s.worldInput.value = 'SECRET_QING_ONLY：今晚取消打球，准备祈雪生日惊喜，请保密'; await s.worldSend(); if (s.worldError.value) throw new Error(s.worldError.value); });
        const qing = requests.find(r => r.actorId === 'qing'), su = requests.find(r => r.actorId === 'suqixue');
        check('卿私聊请求收到取消证据，苏祈雪请求不包含秘密', JSON.stringify(qing.body.messages).includes('SECRET_QING_ONLY') && !JSON.stringify(su.body.messages).includes('SECRET_QING_ONLY'));
        check('每个演员只收到自己卡，林晚恋人占位符绑定卿', !JSON.stringify(qing.body.messages).includes('SU_PRIVATE_CARD_ONLY') && await page.evaluate(() => {
            const s = window.__WORLD_SCOPE__, ctx = window.RPHubActorContext.compile({ snapshot: s.worldSnapshot.value, actorId: 'linwan', conversationId: 'rp-main', kind: 'rp' }); return ctx.packet.person.includes('恋人是卿');
        }));
        check('未授权秘密检索返回零，直接读 ID 也不可访问', await page.evaluate(() => {
            const s = window.__WORLD_SCOPE__.worldSnapshot.value, C = window.RPHubActorContext, secret = s.events.find(e => e.kind === 'message.sent' && e.payload.text.includes('SECRET_QING_ONLY'));
            return C.searchMemory(s, 'suqixue', 'SECRET_QING_ONLY').count === 0 && C.readEvidence(s, 'suqixue', secret.eventId).status === 'unavailable' && C.searchMemory(s, 'qing', 'SECRET_QING_ONLY').count > 0;
        }));
        await page.evaluate(async () => {
            const s = window.__WORLD_SCOPE__, b = s.worldSnapshot.value;
            s.worldSnapshot.value = await window.RPHubWorldStore.commit({ sessionId: b.sessionId, branchId: b.branchId, expectedRevision: b.revision, idempotencyKey: 'fixture-availability', events: [], patch: { actorStates: {
                suqixue: { phoneAccess: 'blocked', activity: '正在上课且手机收起', replyOrder: 2 }, qing: { phoneAccess: 'available', replyOrder: 0 }, linwan: { phoneAccess: 'available', replyOrder: 1 }
            } } });
            s.worldGroupMembers.value = ['suqixue', 'qing', 'linwan']; s.worldGroupName.value = '四人群'; await s.worldCreateGroup();
        });
        stage = 'group'; const groupStart = requests.length;
        await page.evaluate(async () => { const s = window.__WORLD_SCOPE__; s.worldInput.value = '哈喽'; await s.worldSend(); if (s.worldError.value) throw new Error(s.worldError.value); });
        const groupRequests = requests.slice(groupStart);
        check('群聊依次生成卿、林晚，明确手机收起的苏祈雪没有调用', groupRequests.map(r => r.actorId).join(',') === 'qing,linwan');
        check('林晚取得卿已提交群回复后才生成', groupRequests[1].packet.observations.some(e => e.actorId === 'qing' && e.text === '咋了'));
        check('群气泡保留真实发送者，苏祈雪尚未读到群问候', await page.evaluate(() => {
            const s = window.__WORLD_SCOPE__, b = s.worldSnapshot.value, msgs = s.worldMessages.value, P = window.RPHubWorldProjections;
            return msgs.map(e => e.actorId).join(',') === 'player,qing,linwan' && !P.hasObserved(b, msgs[0].eventId, 'suqixue');
        }));
        stage = 'group-retry'; failLin = true; const failedStart = requests.length;
        await page.evaluate(async () => { const s = window.__WORLD_SCOPE__; s.worldInput.value = '再问一次'; await s.worldSend(); });
        check('部分失败保留卿的成功回复，界面显示恢复按钮', await page.locator('.world-recovery button').filter({ hasText: '继续未完成回合' }).count() === 1 && await page.evaluate(() => window.__WORLD_SCOPE__.worldMessages.value.filter(e => e.actorId === 'qing').length) === 2);
        await page.evaluate(async () => { const s = window.__WORLD_SCOPE__, turn = s.worldRetryable.value[0]; await s.worldRetry(turn.turnId); if (s.worldError.value) throw new Error(s.worldError.value); });
        check('恢复只重试林晚，没有重复卿的气泡', requests.slice(failedStart).map(r => r.actorId).join(',') === 'qing,linwan,linwan' && await page.evaluate(() => window.__WORLD_SCOPE__.worldMessages.value.filter(e => e.actorId === 'qing').length) === 2);
        stage = 'rp'; const rpStart = requests.length;
        await page.evaluate(async () => { const s = window.__WORLD_SCOPE__; await s.worldSelectConversation('rp-main'); s.worldActorSelection.value = ['suqixue', 'qing']; s.worldInput.value = '同一时段，继续他们各自的安排，不替我决定'; await s.worldSend(); if (s.worldError.value) throw new Error(s.worldError.value); });
        const rp = requests.slice(rpStart);
        check('RP 按角色独立观察决策，随后叙述；取消约定无需玩家重述', rp.filter(r => r.actorId !== 'narrator').length === 2 && rp.at(-1).actorId === 'narrator'
            && JSON.stringify(rp.find(r => r.actorId === 'qing').body.messages).includes('SECRET_QING_ONLY') && !JSON.stringify(rp.find(r => r.actorId === 'suqixue').body.messages).includes('SECRET_QING_ONLY'));
        await page.evaluate(async () => { const s = window.__WORLD_SCOPE__, b = s.worldSnapshot.value; s.worldSnapshot.value = await window.RPHubWorldStore.commit({ sessionId: b.sessionId, branchId: b.branchId, expectedRevision: b.revision, idempotencyKey: 'fixture-phone-released', events: [], patch: { actorStates: { suqixue: { phoneAccess: 'available' } } } }); });
        stage = 'tell'; const tellStart = requests.length;
        await page.evaluate(async () => { const s = window.__WORLD_SCOPE__; s.worldActorSelection.value = ['linwan']; s.worldInput.value = '求林晚不要告诉苏祈雪我在准备生日礼物'; await s.worldSend(); if (s.worldError.value) throw new Error(s.worldError.value); });
        const tell = requests.slice(tellStart);
        check('实际告知并阅读之后，苏祈雪才取得转述并作出自己的决定', tell.map(r => r.actorId).join(',') === 'linwan,suqixue,narrator' && JSON.stringify(tell[1].body.messages).includes('TRANSFERRED_ONLY'));
        check('NPC 镜头可见，但玩家角色不自动获得幕后通信知识', await page.evaluate(() => {
            const b = window.__WORLD_SCOPE__.worldSnapshot.value, P = window.RPHubWorldProjections, event = b.events.find(e => e.kind === 'message.sent' && e.payload.text.includes('TRANSFERRED_ONLY'));
            return !!b.events.find(e => e.kind === 'narration.published' && e.payload.text.includes('TRANSFERRED_ONLY')) && P.hasObserved(b, event.eventId, 'suqixue') && !P.hasObserved(b, event.eventId, 'player');
        }));
        const countBeforeReload = requests.length;
        await page.reload(); await ready(page); await page.evaluate(async sid => { const s = window.__WORLD_SCOPE__; s.showUserSetupModal.value = false; s.currentView.value = 'world'; await s.worldOpen(sid, 'main'); }, sid);
        check('刷新/打开存档保留记忆，不产生后台模型调用', requests.length === countBeforeReload && await page.evaluate(() => window.RPHubActorContext.searchMemory(window.__WORLD_SCOPE__.worldSnapshot.value, 'qing', 'SECRET_QING_ONLY').count > 0));
        const dlPromise = page.waitForEvent('download'); await page.evaluate(() => window.__WORLD_SCOPE__.worldExport()); const dl = await dlPromise, file = path.join(OUT, dl.suggestedFilename()); await dl.saveAs(file);
        const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
        check('世界包真实下载，含卡快照、观察、回合与会话', exported.format === 'rphub-world' && exported.session.branches.main.events.some(e => e.kind === 'message.read') && exported.session.definition.actors.every(a => a.cardHash));
        const boundary = exported.session.branches.main.events.find(e => e.kind === 'player.input' && e.payload.text.includes('SECRET_QING_ONLY')).seq - 1;
        await page.evaluate(async boundary => { const s = window.__WORLD_SCOPE__; s.worldCheckpointSeq.value = boundary; s.worldBranchName.value = '取消之前'; await s.worldFork(); if (s.worldError.value) throw new Error(s.worldError.value); }, boundary);
        check('世界回档恢复所有人物，不继承被取消的未来私聊', await page.evaluate(() => { const b = window.__WORLD_SCOPE__.worldSnapshot.value; return b.branchId !== 'main' && !b.events.some(e => String(e.payload.text).includes('SECRET_QING_ONLY')); }));
        await page.evaluate(async pkg => {
            const s = window.__WORLD_SCOPE__; await s.worldImport({ target: { files: [new File([JSON.stringify(pkg)], 'world.rpworld.json')], value: 'x' } }); await s.worldConfirmImport(); if (s.worldError.value) throw new Error(s.worldError.value);
        }, exported);
        check('世界包作为独立存档导入，角色认知与私密来源完整往返', await page.evaluate(sid => { const b = window.__WORLD_SCOPE__.worldSnapshot.value, C = window.RPHubActorContext; return b.sessionId !== sid && C.searchMemory(b, 'qing', 'SECRET_QING_ONLY').count > 0 && C.searchMemory(b, 'suqixue', 'SECRET_QING_ONLY').count === 0; }, sid));
        const disabledSource = await page.evaluate(async () => {
            const s = window.__WORLD_SCOPE__, definition = JSON.parse(JSON.stringify(s.worldSnapshot.value.definition));
            definition.actors.find(a => a.actorId === 'qing').enabled = false;
            const disabled = await window.RPHubWorldStore.reviseDefinition({ sessionId: s.worldSnapshot.value.sessionId, definition });
            await s.worldOpen(disabled.sessionId, disabled.branchId); return { sessionId: disabled.sessionId, events: disabled.events.length, oldHash: disabled.definition.actors.find(a => a.actorId === 'qing').cardHash };
        });
        await page.evaluate(async () => {
            const s = window.__WORLD_SCOPE__; s.worldUpdateActor.value = 'qing';
            await s.worldReadReplacement({ target: { files: [new File([JSON.stringify({ name: '卿', personality: 'QING_UPDATED：适配后的独立 NPC。' })], '卿适配.json')], value: 'x' } });
            await s.worldApplyReplacement(); if (s.worldError.value) throw new Error(s.worldError.value);
        });
        check('补入适配卡在新世界副本启用卿，原卡与旧世界剧情保留', await page.evaluate(async source => {
            const b = window.__WORLD_SCOPE__.worldSnapshot.value, old = await window.RPHubWorldStore.load(source.sessionId), updated = b.definition.actors.find(a => a.actorId === 'qing');
            return b.sessionId !== source.sessionId && updated.enabled && updated.cardHash !== source.oldHash && b.events.length >= source.events
                && old.definition.actors.find(a => a.actorId === 'qing').enabled === false && old.definition.actors.find(a => a.actorId === 'qing').cardHash === source.oldHash;
        }, disabledSource));
        stage = 'late'; const pending = new Promise(resolve => lateResolve = resolve);
        await page.evaluate(async () => {
            const s = window.__WORLD_SCOPE__; Object.assign(s.settings, { apiUrl: 'https://world-fixture.local/v1', apiKey: 'fixture-only', model: 'world-fixture' });
            await s.worldSelectConversation('dm-qing'); s.worldInput.value = '切会话时的晚到探针'; window.__LATE_SEND__ = s.worldSend();
        });
        await pending;
        await page.evaluate(async () => { const s = window.__WORLD_SCOPE__; await s.worldSelectConversation('rp-main'); await window.__LATE_SEND__; });
        check('生成时切会话保持原会话，完成后的回复正常保存', await page.evaluate(() => {
            const s = window.__WORLD_SCOPE__, b = s.worldSnapshot.value, t = Object.values(b.turns).find(t => t.text === '切会话时的晚到探针');
            return s.worldConversationId.value === 'dm-qing' && t && b.events.some(e => e.turnId === t.turnId && e.kind === 'message.sent' && e.actorId === 'qing');
        }));
        stage = 'burst'; const burstStart = requests.length;
        await page.getByRole('checkbox', { name: '连发模式' }).check();
        for (const text of ['先发第一条', '再发第二条']) {
            await page.getByRole('textbox', { name: '世界消息输入' }).fill(text);
            await page.getByRole('button', { name: '发送', exact: true }).click();
            await page.waitForFunction(() => !window.__WORLD_SCOPE__.worldBusy.value);
        }
        check('连发只保存两个气泡，未请求模型且显示待回应2条', requests.length === burstStart && await page.getByText('待回应 2 条').isVisible());
        await page.evaluate(() => { window.__WORLD_SCOPE__.worldMemoryEnabled.value = true; });
        await page.getByRole('button', { name: '让对方回复', exact: true }).click();
        await page.waitForFunction(() => !window.__WORLD_SCOPE__.worldBusy.value);
        check('让对方回复只生成一批，没有重复玩家气泡，并保存该人物总结', await page.evaluate(() => {
            const s = window.__WORLD_SCOPE__, b = s.worldSnapshot.value;
            return s.worldUnansweredCount.value === 0 && b.events.filter(e => e.kind === 'message.sent' && e.payload.text === '先发第一条').length === 1
                && window.RPHubWorldMemory.records(b, 'qing').length > 0 && !s.worldError.value;
        }));
        const review = path.join(ROOT, '.tmp-review'); fs.mkdirSync(review, { recursive: true });
        await page.locator('.entry-transition').waitFor({ state: 'hidden' });
        await page.locator('.world-view').waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.querySelectorAll('.toast-item').length === 0);
        await page.setViewportSize({ width: 1360, height: 950 }); await page.screenshot({ path: path.join(review, 'world-desktop.png'), fullPage: false });
        await page.setViewportSize({ width: 390, height: 844 });
        check('390 像素世界界面没有横向溢出，输入和发送按钮位于屏幕内', await page.evaluate(() => {
            const composer = document.querySelector('.world-composer'), rect = composer.getBoundingClientRect();
            return document.documentElement.scrollWidth <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight + 1;
        }));
        await page.screenshot({ path: path.join(review, 'world-mobile.png'), fullPage: false });
        await page.setViewportSize({ width: 1360, height: 950 }); await page.evaluate(() => window.RPHubTheme.set('dark')); await page.screenshot({ path: path.join(review, 'world-dark.png'), fullPage: false });
        check('桌面与手机截图已保存，页面没有 JavaScript 异常', errors.length === 0);
        const localContext = await browser.newContext(), localPage = await localContext.newPage(), localErrors = [];
        localPage.on('pageerror', e => localErrors.push(e.message));
        await localPage.addInitScript(() => { window.marked = { use() {}, parse: String }; window.DOMPurify = { sanitize: String }; localStorage.setItem('roleplay_hub_update_id', '99999'); });
        await localPage.route('**/*', route => route.request().url().startsWith('file:') || ['unpkg.com', 'cdn.jsdelivr.net', 'cdn.tailwindcss.com'].includes(new URL(route.request().url()).hostname)
            ? route.continue() : route.fulfill({ contentType: 'application/json', body: '{"data":[],"quota":0}' }));
        await localPage.route('**/assets/js/app.js?*', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8').replace('const __s = {};', 'const __s = window.__WORLD_SCOPE__ = {};') }));
        await localPage.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'load', timeout: 45000 }); await ready(localPage);
        await localPage.evaluate(() => { const s = window.__WORLD_SCOPE__; s.showUserSetupModal.value = false; s.currentView.value = 'world'; });
        await localPage.locator('.world-setup h2').first().waitFor();
        await localPage.locator('.entry-transition').waitFor({ state: 'hidden' });
        check('双击 file:// 页面可加载世界入口，没有白屏或脚本异常', localErrors.length === 0 && await localPage.locator('.world-view').isVisible());
        await localContext.close();
        fs.writeFileSync(path.join(OUT, 'requests.json'), JSON.stringify(requests, null, 2));
        console.log(`${checks}/${checks} passed (fixture API; semantic personality fidelity is not evaluated).`);
    } finally { closing = true; if (browser) await browser.close(); await new Promise(done => server.close(done)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
