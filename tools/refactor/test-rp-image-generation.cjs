const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=';
const read = file => fs.readFileSync(path.join(ROOT, 'assets/js', file), 'utf8');
function harness(respond = () => new Response(JSON.stringify({ data: [{ b64_json: png }] }), { headers: { 'Content-Type': 'application/json' } })) {
    const requests = [], saved = [], assets = new Map(), writes = [];
    let scope = 'char-a', failSave = false;
    const storage = { getStoredValue: async key => assets.get(key), setStoredValue: async (key, value) => assets.set(key, value), deleteStoredValue: async key => assets.delete(key) };
    const context = vm.createContext({ window: { location: { href: 'http://local/' }, RPHubStorage: storage }, URL, Blob, Uint8Array, atob, btoa, DOMException,
        AbortController, crypto: webcrypto, setTimeout, clearTimeout, console,
        ref: value => ({ value }), computed: get => ({ get value() { return typeof get === 'function' ? get() : get.get(); } }), watch() {}, nextTick() {},
        fetch: async (url, options) => { requests.push({ url, options }); return respond(url, options); }
    });
    for (const file of ['built-in-content.js', 'core-utils.js', 'wechat-media.js', 'image-generation.js', 'branch-chat-utils.js', 'app/07-image-gen-autosave.js']) vm.runInContext(read(file), context);
    context.cardUtils = context.window.RPHubCardUtils;
    context.getImageTagRegex = context.window.RPHubUtils.getImageTagRegex;
    const M = context.window.RPHubWeChatMedia;
    context.window.RPHubWeChatMedia = { ...M, rasterize: async blob => ({ blob, thumb: blob, width: 1, height: 1 }) };
    const library = M.createLibrary(storage);
    const s = { settings: { imageGenKey: 'legacy-key', imageStyle: 'custom', customImageArtists: 'artist:test', wechatImageApi: { ...context.window.RPHubImageGeneration.DEFAULTS, apiKey: 'shared-key', baseUrl: 'https://images.test/v1' } },
        currentCharacter: { value: { uuid: 'char-a' } }, chatHistory: { value: [] }, worldInfo: { value: [] }, chatContainer: { value: null },
        isConversationBusy: { value: false }, conversationRevision: 0, wechatMediaLibrary: library,
        getCurrentStoryBranchScopeId: () => scope,
        saveChatHistoryNow: async target => { writes.push(target); if (failSave) return false; saved.push(structuredClone(s.chatHistory.value)); return true; }
    };
    context.window.RPHubAppSections.imageGenAutosave(s);
    const add = (prompt = 'yellow braised chicken, dining table') => { const message = { role: 'assistant', content: `image###${prompt}###` }; s.chatHistory.value.push(message); return { message, index: 0, prompt }; };
    return { s, context, requests, saved, assets, writes, add, library, setScope: value => { scope = value; }, failSave: value => { failSave = value; } };
}
test('RP uses shared model, credential, NAI protocol and size, persists pixels and pending checkpoint', async () => {
    const h = harness(), binding = h.add();
    h.s.settings.wechatImageApi.size = '1216x832';
    const task = h.s.startGeneratedImageTask('http://local/rp-image', false, binding);
    const result = await task.promise;
    assert.equal(result.status, 'done', result.error);
    const req = h.requests[0], body = JSON.parse(req.options.body);
    assert.equal(req.url, 'https://images.test/v1/chat/completions');
    assert.equal(req.options.headers.Authorization, 'Bearer shared-key');
    assert.equal(body.model, 'nai-diffusion-4-5-full:k_dpmpp_2m');
    assert.match(body.messages[0].content, /画师串:artist:test\n尺寸:横图/);
    assert.doesNotMatch(JSON.stringify(body), /shared-key|legacy-key|image###/);
    assert.equal(h.saved[0][0].generatedImages[0].status, 'pending');
    assert.ok(binding.message.generatedImages[0].assetId);
    assert.ok(await h.library.read(binding.message.generatedImages[0].assetId) instanceof Blob);
    assert.doesNotMatch(JSON.stringify(h.saved), /base64,|shared-key|legacy-key/);
    h.s.cancelGeneratedImageTasks();
});
test('fresh runtime restores saved pixels even when disabled, reroll preserves prompt', async () => {
    const h = harness(), binding = h.add('a cup');
    await h.s.startGeneratedImageTask('http://local/rp-image', false, binding).promise;
    h.s.cancelGeneratedImageTasks(); h.s.settings.wechatImageApi.enabled = false;
    assert.equal((await h.s.startGeneratedImageTask('http://local/rp-image', false, binding).promise).status, 'done');
    assert.equal(h.requests.length, 1);
    h.s.settings.wechatImageApi.enabled = true;
    const oldId = binding.message.generatedImages[0].assetId;
    assert.equal((await h.s.startGeneratedImageTask('http://local/rp-image', true, binding).promise).status, 'done');
    assert.equal(h.requests.length, 2); assert.notEqual(binding.message.generatedImages[0].assetId, oldId);
    assert.equal(binding.message.content, 'image###a cup###');
    h.s.cancelGeneratedImageTasks();
});
test('failure and interrupted checkpoint require manual retry; missing config never uses old key', async () => {
    const h = harness(() => new Response('{}', { status: 503 })), binding = h.add();
    assert.equal((await h.s.startGeneratedImageTask('http://local/rp-image', false, binding).promise).status, 'failed');
    h.s.cancelGeneratedImageTasks();
    await h.s.startGeneratedImageTask('http://local/rp-image', false, binding).promise;
    assert.equal(h.requests.length, 1);
    binding.message.generatedImages[0] = { prompt: binding.prompt, status: 'pending' };
    h.s.cancelGeneratedImageTasks();
    assert.match((await h.s.startGeneratedImageTask('http://local/rp-image', false, binding).promise).error, /手动重试/);
    assert.equal(h.requests.length, 1);
    h.s.settings.wechatImageApi.apiKey = '';
    await h.s.startGeneratedImageTask('http://local/rp-image', true, binding).promise;
    assert.equal(h.requests.length, 1);
});
test('paid pixels survive failed chat persistence; retry does not pay again', async () => {
    const h = harness(), binding = h.add();
    const save = h.s.wechatMediaLibrary.save;
    h.s.wechatMediaLibrary.save = async (...args) => { const asset = await save(...args); h.failSave(true); return asset; };
    assert.equal((await h.s.startGeneratedImageTask('http://local/rp-image', false, binding).promise).status, 'failed');
    assert.ok(binding.message.generatedImages[0].assetId);
    h.failSave(false);
    assert.equal((await h.s.startGeneratedImageTask('http://local/rp-image', true, binding).promise).status, 'done');
    assert.equal(h.requests.length, 1);
    h.s.cancelGeneratedImageTasks();
});
test('cancel/scope change rejects late pixels and cannot write into the new conversation', async () => {
    let release;
    const h = harness(() => new Promise(resolve => { release = resolve; })), binding = h.add();
    const task = h.s.startGeneratedImageTask('http://local/rp-image', false, binding);
    for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(release, 'generation request reached the fixture');
    h.s.cancelGeneratedImageTasks(); h.setScope('char-b'); h.s.chatHistory.value = [];
    release(new Response(JSON.stringify({ data: [{ b64_json: png }] }), { headers: { 'Content-Type': 'application/json' } }));
    assert.equal((await task.promise).status, 'failed');
    assert.equal(h.assets.size, 0); assert.deepEqual(h.writes, ['char-a']);
    assert.equal(h.s.isAutoImageGenerating.value, false);
});
test('RP image resources travel through branch export and import with fresh IDs', async () => {
    const h = harness(), binding = h.add();
    await h.s.startGeneratedImageTask('http://local/rp-image', false, binding).promise;
    const branch = { branchId: 'main', messages: [binding.message], wechatTimeline: [] }, B = h.context.window.RPHubBranchChat;
    const resources = await B.collectResources([branch], 'char-a', h.context.window.RPHubStorage);
    assert.equal(resources.length, 1);
    const parsed = B.parse([branch, ...resources], 2, new Set(['main']));
    const prepared = await B.prepareResources(parsed, 'char-b', h.context.window.RPHubStorage, () => 'new-image-id');
    assert.equal(prepared.chats.get('main').messages[0].generatedImages[0].assetId, 'new-image-id');
    assert.ok(prepared.entries.some(([key, value]) => key === 'wechat_media_blob_new-image-id' && value instanceof Blob));
    h.s.cancelGeneratedImageTasks();
});
test('markup encodes quotes, ampersands, plus signs and never contains credentials', () => {
    const h = harness(), prompt = 'a+b, "quoted", x&y, <tag>';
    const html = h.s.buildGeneratedImageCardMarkup(prompt);
    const request = html.match(/data-image-request="([^"]+)"/)[1];
    assert.equal(new URL(request).searchParams.get('tag'), prompt);
    assert.doesNotMatch(html, /shared-key|legacy-key|token=/);
});
test('missing pixel file fails without paying; explicit retry can replace it', async () => {
    const h = harness(), binding = h.add();
    await h.s.startGeneratedImageTask('http://local/rp-image', false, binding).promise;
    const oldId = binding.message.generatedImages[0].assetId;
    h.assets.delete(`wechat_media_blob_${oldId}`); h.s.cancelGeneratedImageTasks();
    assert.equal((await h.s.startGeneratedImageTask('http://local/rp-image', false, binding).promise).status, 'failed');
    assert.equal(h.requests.length, 1);
    assert.equal((await h.s.startGeneratedImageTask('http://local/rp-image', true, binding).promise).status, 'done');
    assert.equal(h.requests.length, 2); assert.notEqual(binding.message.generatedImages[0].assetId, oldId);
    h.s.cancelGeneratedImageTasks();
});
