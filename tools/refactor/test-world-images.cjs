const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { harness } = require('./world-engine-harness.cjs');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=';
const message = { type: 'image_request', media: { mode: 'generate', selfPortrait: false, prompt: 'yellow braised chicken, rice, clay pot', description: '砂锅黄焖鸡和米饭', usage: 'scene_photo' } };
async function setup(options = {}) {
    const h = await harness(options); let calls = 0;
    const requests = [];
    Object.assign(h.context, { Blob, DOMException });
    for (const file of ['wechat-media.js', 'image-generation.js', 'world-media.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../../assets/js', file), 'utf8'), h.context);
    const M = h.context.window.RPHubWeChatMedia, G = h.context.window.RPHubImageGeneration;
    h.context.window.RPHubWeChatMedia = { ...M, rasterize: async () => ({ blob: new Blob(['fixture']), thumb: new Blob(['thumb']) }), blobToDataURL: async () => png };
    h.context.window.RPHubImageGeneration = { ...G, generate: async (config, prompt, signal) => { M.assertActive(signal); calls++; requests.push({ config, prompt }); return new Blob(['fixture']); } };
    h.context.window.RPHubStorage.setStoredValue = async (key, value) => h.stored.set(key, structuredClone(value));
    const config = { imageConfig: { ...G.DEFAULTS, apiKey: 'fixture-secret' } };
    const run = responder => h.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: '给我拍拍照，看看你吃啥', apiConfig: config }, responder || (() => ({ messages: [{ type: 'text', content: '刚端上来' }, message] })));
    const retry = () => h.Engine.retryTurn({ sessionId: h.snapshot.sessionId, branchId: h.snapshot.branchId, turnId: Object.values(h.snapshot.turns).at(-1).turnId,
        apiConfig: config, modelRunner: () => { throw new Error('saved image proposal must not call actor again'); } });
    return { h, run, retry, config, requests, get calls() { return calls; } };
}

test('world portraits use only the bound actor identity; meals stay unchanged and export retains profiles', async () => {
    const actors = [ { actorId: 'player', name: '玩家', card: null },
        ...['qing', 'suqixue', 'linwan'].map(id => ({ actorId: id, name: id, card: { name: id, personality: 'test personality',
            extensions: { rp_hub_image_identity: { prompt: id === 'qing' ? 'qing oval face, green eyes' : 'suqixue almond eyes, brown hair', negative: id + ' negative' } } },
            knownActorIds: ['player', 'qing', 'suqixue'], bindings: { user: 'player' }, initialState: { phoneAccess: 'available' } })) ];
    const t = await setup({ definition: { actors } });
    for (const id of ['suqixue', 'qing']) {
        await t.h.run({ kind: 'wechat', conversationId: 'dm-player-' + id, text: '自拍给我看看', apiConfig: t.config }, request => {
            const system = request.messages[0].content;
            assert.ok(system.includes(id + (id === 'qing' ? ' oval face, green eyes' : ' almond eyes, brown hair')));
            assert.ok(!system.includes(id === 'qing' ? 'suqixue almond eyes' : 'qing oval face'));
            return { messages: [{ type: 'image_request', media: { mode: 'generate', selfPortrait: true, prompt: 'campus selfie', description: '自拍' } }] };
        });
        const r = t.requests.at(-1);
        assert.ok(r.prompt.startsWith(actors.find(a => a.actorId === id).card.extensions.rp_hub_image_identity.prompt));
        assert.equal(r.config.negativePrompt, id + ' negative');
    }
    await t.run();
    assert.equal(t.requests.at(-1).prompt, message.media.prompt); assert.equal(t.requests.at(-1).config.negativePrompt, undefined);
    const pkg = await t.h.Store.exportSession(t.h.snapshot.sessionId), restored = await t.h.Store.importSession(pkg);
    const C = t.h.context.window.RPHubActorContext;
    assert.equal(C.cardOf(C.actorOf(restored, 'suqixue')).extensions.rp_hub_image_identity.prompt, 'suqixue almond eyes, brown hair');
});

test('world RP exposes the self portrait flag and shared composer', async () => {
    const t = await setup(), G = t.h.context.window.RPHubImageGeneration;
    let prepared = 0;
    t.h.context.window.RPHubImageGeneration = { ...G, characterRequest: (...args) => { prepared++; return G.characterRequest(...args); } };
    await t.h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '发自拍', apiConfig: t.config }, request => {
        if (request.purpose === 'narrator') return { content: '卿发来了自拍。' };
        assert.equal(request.tools.find(tool => tool.function.name === 'tool_wechat').function.parameters.properties.image.properties.selfPortrait.type, 'boolean');
        return { toolCalls: [{ id: 'portrait', function: { name: 'tool_wechat', arguments: JSON.stringify({ image: { ...message.media, selfPortrait: true } }) } }] };
    });
    assert.equal(prepared, 1); assert.equal(t.calls, 1);
});

test('world omitted portrait flag is repaired before image generation', async () => {
    const actors = [{ actorId: 'player', name: '玩家', card: null }, ...['qing', 'suqixue', 'linwan'].map(id => ({ actorId: id,
        name: id, card: { name: id, personality: 'test persona', imageIdentity: { prompt: id + ' fixed face', negative: 'anime' } },
        knownActorIds: ['player', 'qing', 'suqixue', 'linwan'], initialState: { phoneAccess: 'available' } }))];
    const t = await setup({ definition: { actors } }); let modelCalls = 0;
    await t.run(request => {
        modelCalls++;
        if (modelCalls === 1) { const image = { ...message.media }; delete image.selfPortrait; return { messages: [{ type: 'image_request', media: image }] }; }
        assert.match(request.messages.at(-1).content, /selfPortrait/);
        return { messages: [{ type: 'image_request', media: { ...message.media, selfPortrait: true } }] };
    });
    assert.equal(modelCalls, 2); assert.equal(t.calls, 1);
    assert.ok(t.requests[0].prompt.startsWith('qing fixed face'));
});
test('meal photo becomes an actual image event; no key or pixels in actor history, invisible to strangers', async () => {
    const t = await setup(); await t.run();
    assert.equal(t.calls, 1);
    const s = t.h.snapshot, image = s.events.find(e => e.payload.type === 'image');
    assert.ok(image.payload.media.assetId); assert.equal(image.actorId, 'qing'); assert.equal(image.payload.text, undefined);
    const C = t.h.context.window.RPHubActorContext, P = t.h.context.window.RPHubWorldProjections;
    assert.match(C.textOf(image), /黄焖鸡.*像素细节尚未核对/);
    assert.equal(P.hasObserved(s, image.eventId, 'linwan'), false);
    assert.doesNotMatch(JSON.stringify(C.compile({ snapshot: s, actorId: 'qing', conversationId: 'dm-player-qing', kind: 'wechat' })), /fixture-secret|base64,/);
    assert.doesNotMatch(JSON.stringify(s), /fixture-secret|base64,/);
});
test('image failure checkpoints proposal; retry does not regenerate actor and sends one photo', async () => {
    const t = await setup(), original = t.h.context.window.RPHubImageGeneration;
    t.h.context.window.RPHubImageGeneration = { ...original, generate: async () => { throw new Error('HTTP 503 fixture'); } };
    await assert.rejects(t.run(), /HTTP 503/);
    assert.equal(t.h.snapshot.events.filter(e => e.actorId === 'qing' && e.kind === 'message.sent').length, 0);
    assert.ok(Object.values(t.h.snapshot.turns).at(-1).preparedActor);
    t.h.context.window.RPHubImageGeneration = original;
    const s = await t.retry();
    assert.equal(s.events.filter(e => e.payload.type === 'image').length, 1); assert.equal(t.calls, 1);
});
test('failure after pixels saved reuses cached asset on retry without a second paid request', async () => {
    const t = await setup(), storage = t.h.context.window.RPHubStorage, original = storage.updateStoredValue; let failed = false;
    storage.updateStoredValue = (key, updater) => original(key, value => {
        const next = updater(value);
        if (!failed && Object.values(next?.branches || {}).some(b => b.events.some(e => e.payload?.type === 'image'))) { failed = true; throw new Error('disk commit fixture'); }
        return next;
    });
    await assert.rejects(t.run(), /disk commit fixture/); assert.equal(t.calls, 1);
    const s = await t.retry(); assert.equal(t.calls, 1); assert.equal(s.events.filter(e => e.payload.type === 'image').length, 1);
});
test('world export/import carries pixels and remaps assets without overwriting original', async () => {
    const t = await setup(); await t.run();
    const pkg = await t.h.Store.exportSession(t.h.snapshot.sessionId);
    const old = t.h.snapshot.events.find(e => e.payload.type === 'image').payload.media.assetId;
    assert.ok(pkg.media[old].dataUrl);
    const restored = await t.h.Store.importSession(pkg), id = restored.events.find(e => e.payload.type === 'image').payload.media.assetId;
    assert.notEqual(id, old); assert.equal((await t.h.context.window.RPHubWorldMedia.read(id)).dataUrl, png);
    delete pkg.media[old]; await assert.rejects(t.h.Store.importSession(pkg), /缺少有效图片/);
});
test('no key/multiple images/forged sender/offline picture actions fail validation', async () => {
    const t = await setup(), C = t.h.context.window.RPHubActorContext;
    const context = C.compile({ snapshot: t.h.snapshot, actorId: 'qing', conversationId: 'dm-player-qing', kind: 'wechat' });
    const validate = t.h.context.window.RPHubActorRuntime.validateProposal;
    assert.throws(() => validate({ messages: [message] }, context, 'wechat'), /生图尚未配置/);
    context.imageGenerationEnabled = true;
    assert.throws(() => validate({ messages: [message, message] }, context, 'wechat'), /一.*张图片/);
    assert.throws(() => validate({ actorId: 'linwan', messages: [message] }, context, 'wechat'), /身份/);
    assert.throws(() => validate({ decision: 'act', actions: [{ kind: 'tell', channel: 'in_person', targetActorId: 'linwan', image: message.media }] }, context, 'rp'), /线下动作/);
});
test('native RP image tool binds sender and reaches original private chat', async () => {
    const t = await setup();
    await t.h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '卿分享正在吃的饭菜', apiConfig: t.config }, request => {
        if (request.purpose === 'narrator') return { content: '卿拍了一张饭菜照片，发给玩家。' };
        const schema = request.tools.find(tool => tool.function.name === 'tool_wechat').function.parameters;
        assert.ok(schema.properties.image);
        return { toolCalls: [{ id: 'photo', function: { name: 'tool_wechat', arguments: JSON.stringify({ image: message.media }) } }] };
    });
    const image = t.h.snapshot.events.find(e => e.payload.type === 'image');
    assert.equal(image.conversationId, 'dm-player-qing'); assert.equal(image.actorId, 'qing'); assert.equal(t.calls, 1);
});
