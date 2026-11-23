const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=';
const ref = (id, kind = 'character') => ({ id, name: id, kind, description: 'reference', dataUrl: 'data:image/png;base64,' + png });
function harness() {
    const requests = [], context = vm.createContext({ window: {}, URL, Blob, FormData, Uint8Array, Uint32Array, TextEncoder, TextDecoder, atob, DOMException, AbortController, setTimeout, clearTimeout,
        fetch: async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ data: [{ b64_json: png }] }), { headers: { 'Content-Type': 'application/json' } }); } });
    for (const file of ['built-in-content.js', 'core-utils.js', 'image-generation.js', 'wechat-media.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js', file), 'utf8'), context);
    return { context, G: context.window.RPHubImageGeneration, C: context.window.RPHubCardUtils, requests };
}
const plain = value => JSON.parse(JSON.stringify(value));
test('full endpoint and base URL resolve generation, edits and models without duplicated paths', async () => {
    const h = harness();
    for (const baseUrl of ['https://image.test/v1', 'https://image.test/v1/', 'https://image.test/v1/images/generations', 'https://image.test/v1/images/edits']) {
        const c = { ...h.G.DEFAULTS, ...h.G.PRESETS.yeelo, baseUrl, apiKey: 'test-key' };
        await h.G.generate(c, '一碗热饭'); assert.equal(h.requests.at(-1).url, 'https://image.test/v1/images/generations');
        await h.G.models(c); assert.equal(h.requests.at(-1).url, 'https://image.test/v1/models');
    }
    for (const baseUrl of ['https://u:p@image.test/v1', 'https://image.test/v1?key=x']) assert.throws(() => h.G.base(baseUrl));
});
test('portraits select current character refs, scenes only by explicit ID, meals never get faces', async () => {
    const h = harness(), c = { ...h.G.DEFAULTS, ...h.G.PRESETS.yeelo, apiKey: 'test-key' };
    const card = { name: 'A', imageReferences: [ref('a-front'), ref('a-side'), ref('library', 'scene')] };
    const r = h.G.characterRequest(c, { mode: 'generate', selfPortrait: true, prompt: '她在图书馆门前自拍。', referenceIds: ['library'] }, card);
    await h.G.generate(r.config, r.prompt);
    const body = JSON.parse(h.requests[0].options.body);
    assert.equal(h.requests[0].url, 'https://img.yeelo.fun/v1/images/edits');
    assert.equal(body.image_data_urls.length, 3); assert.equal(body.prompt, '她在图书馆门前自拍。');
    assert.equal(body.negative_prompt, undefined); assert.equal(body.response_format, 'b64_json');
    assert.equal(c.referenceImages, undefined);
    const meal = h.G.characterRequest(c, { mode: 'generate', selfPortrait: false, prompt: '一碗热饭' }, card);
    assert.equal(meal.config.referenceImages.length, 0); assert.equal(h.G.payload(meal.config, meal.prompt).endpoint, 'images/generations');
    assert.throws(() => h.G.characterRequest(c, { mode: 'generate', prompt: 'selfie' }, card), /必须填写selfPortrait/);
    assert.throws(() => h.G.characterRequest(c, { mode: 'generate', selfPortrait: true, referenceIds: ['someone-else'], prompt: 'selfie' }, card), /不存在/);
    assert.throws(() => h.G.characterRequest(c, { mode: 'generate', selfPortrait: false, referenceIds: ['a-front'], prompt: 'selfie' }, card), /不存在/);
});
test('natural language never applies legacy positive/negative profile; NAI still uses its own format', () => {
    const { G } = harness(), card = { name: 'A', imageIdentity: { prompt: 'LEGACY_POSITIVE', negative: 'LEGACY_NEGATIVE' }, imageReferences: [ref('portrait')] };
    const c = { ...G.DEFAULTS, ...G.PRESETS.yeelo };
    const r = G.characterRequest(c, { mode: 'generate', selfPortrait: true, prompt: '拍一张课后的自然自拍。' }, card);
    assert.equal(r.prompt, '拍一张课后的自然自拍。'); assert.equal(r.config.negativePrompt, undefined);
    assert.doesNotMatch(G.identityPrompt(card, c), /LEGACY_POSITIVE|LEGACY_NEGATIVE|base64/);
    assert.match(G.formatPrompt(c), /自然语言/); assert.match(G.formatPrompt(G.DEFAULTS), /NAI 标签组/);
    const nai = G.characterRequest(G.DEFAULTS, { mode: 'generate', selfPortrait: true, prompt: 'campus, selfie' }, { imageReferences: [ref('portrait')] });
    assert.equal(nai.config.referenceImages.length, 0); assert.match(G.payload(nai.config, nai.prompt).body.messages[0].content, /负面提示词:/);
    assert.doesNotMatch(G.payload(nai.config, nai.prompt).body.messages[0].content, /base64/);
});
test('multipart edits and chat content carry references in provider-specific formats', async () => {
    const h = harness(), c = { ...h.G.DEFAULTS, ...h.G.PRESETS.openai, apiKey: 'test-key', referenceImages: [ref('front'), ref('side')] };
    await h.G.generate(c, 'A natural phone selfie.');
    const { body, headers } = h.requests[0].options;
    assert.ok(body instanceof FormData); assert.equal(body.getAll('image[]').length, 2);
    assert.equal(body.get('prompt'), 'A natural phone selfie.'); assert.equal(body.get('response_format'), null);
    assert.equal(headers['Content-Type'], undefined); assert.equal(headers.Authorization, 'Bearer test-key');
    const p = h.G.payload({ ...c, protocol: 'chat-image', referenceMode: 'chat-content' }, '自然自拍');
    assert.equal(p.body.messages[0].content[0].text, '自然自拍'); assert.equal(p.body.messages[0].content[1].image_url.url, ref('front').dataUrl);
});
test('reference count, disabled input and corrupt data fail before a paid request', async () => {
    const h = harness(), c = { ...h.G.DEFAULTS, ...h.G.PRESETS.yeelo, apiKey: 'test-key' };
    for (const referenceImages of [Array.from({ length: 17 }, (_, i) => ref('ref' + i)), [{ dataUrl: 'https://unknown.test/face.jpg' }]])
        await assert.rejects(h.G.generate({ ...c, referenceImages }, 'selfie'));
    await assert.rejects(h.G.generate({ ...c, referenceImages: [{ dataUrl: 'data:image/png;base64,' + Buffer.from('this is not a valid png image'.repeat(4)).toString('base64') }] }, 'selfie'), /有效/);
    await assert.rejects(h.G.generate({ ...c, referenceImages: [ref('face')], referenceMode: 'none' }, 'selfie'), /未启用参考图/);
    assert.equal(h.requests.length, 0);
    assert.equal(h.G.payload({ ...c, referenceImages: Array.from({ length: 16 }, (_, i) => ref('ref' + i)) }, 'selfie').body.image_data_urls.length, 16);
});
test('card references survive import/export, explicit clear and original persona stays intact', () => {
    const h = harness(), refs = [ref('face'), ref('campus', 'scene')];
    const raw = { data: { name: 'A', personality: '原本的人设与外貌', extensions: { rp_hub_image_references: refs }, character_book: { entries: [{ comment: '原世界书', content: '原世界观' }] } } };
    const card = h.C.parseImportedCharacterCard(raw), exported = h.C.buildCharacterCardData({ ...card, worldInfo: card.worldInfoEntries });
    assert.deepEqual(plain(exported.data.extensions.rp_hub_image_references), refs);
    assert.equal(exported.data.personality, raw.data.personality); assert.equal(exported.data.character_book.entries[0].content, '原世界观');
    assert.equal(h.C.parseImportedCharacterCard({ ...raw.data, imageReferences: [] }).imageReferences.length, 0);
    assert.throws(() => h.C.normalizeImageReferences([ref('face'), ref('face')]), /重复/);
    const guide = h.G.identityPrompt(card, h.G.PRESETS.yeelo);
    assert.match(guide, /campus/); assert.doesNotMatch(guide, /iVBOR|base64/);
});
test('inline natural image instructions use JSON; malformed flag fails before generation', () => {
    const { G, context } = harness();
    assert.deepEqual(plain(G.inlineIntent('{"prompt":"自然自拍","selfPortrait":true,"referenceIds":[]}')), { prompt: '自然自拍', selfPortrait: true, referenceIds: [], mode: 'generate' });
    assert.equal(G.inlineIntent('portrait, campus').prompt, 'portrait, campus');
    assert.throws(() => G.inlineIntent('{"prompt":"selfie","selfPortrait":"true"}'), /参数无效/);
    const natural = context.window.RPHubBuiltinContent.prompts.buildAutoImageGenPrompt(2, 'openai-images');
    assert.match(natural, /自然语言/); assert.match(natural, /image###{/); assert.doesNotMatch(natural, /所有Tag必须使用英文/);
});
