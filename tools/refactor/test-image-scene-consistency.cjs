const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=';
const ref = (id, description, kind = 'character') => ({ id, name: id, kind, description, dataUrl: 'data:image/png;base64,' + png });
const scene = { location: '校园走廊', time: '傍晚，天已黑', action: '下课后自然自拍', framing: '手机前置摄像头，上半身', props: ['手机'], avoid: ['头戴麦克风'], lighting: '柔和室内灯' };
function harness() {
    const requests = [], context = vm.createContext({ window: {}, URL, Blob, Uint8Array, atob, DOMException, AbortController, setTimeout, clearTimeout,
        fetch: async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ data: [{ b64_json: png }] }), { headers: { 'Content-Type': 'application/json' } }); } });
    for (const file of ['image-generation.js', 'wechat-media.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../../assets/js', file), 'utf8'), context);
    const G = context.window.RPHubImageGeneration;
    return { G, M: context.window.RPHubWeChatMedia, requests, c: { ...G.DEFAULTS, ...G.PRESETS.yeelo, apiKey: 'fixture' } };
}
test('reference contract preserves identity and contextual tastes/poses instead of either face-only or copying equipment', async () => {
    const h = harness(), card = { name: 'A', imageReferences: [ref('makeup', '轻淡眼妆，清爽衣品'), ref('pose', '比V，原照片戴着活动麦克风')] };
    const intent = { mode: 'generate', selfPortrait: true, prompt: '她下课后微笑自拍，空闲手比V。', scene: { ...scene, poseReferenceId: 'pose' } };
    const request = h.G.characterRequest(h.c, intent, card);
    await h.G.generate(request.config, request.prompt);
    const body = JSON.parse(h.requests[0].options.body);
    assert.equal(body.image_data_urls.length, 2);
    assert.match(body.prompt, /不是只参考脸/); assert.match(body.prompt, /可迁移视觉偏好/);
    assert.match(body.prompt, /第2张图片的拍照动作/); assert.match(body.prompt, /轻淡眼妆/);
    assert.match(body.prompt, /没有本轮明确的.*不出现头戴麦克风/);
    assert.equal(body.negative_prompt, undefined);
    assert.match(h.G.formatPrompt(h.c), /不能哭泣时自动照搬笑脸/);
});
test('bad scene plans fail before a paid call; valid stage equipment is allowed', async () => {
    const h = harness(), card = { imageReferences: [ref('a', '自拍')] };
    for (const bad of [
        { ...scene, props: ['头戴麦克风'], avoid: [] },
        { ...scene, action: '课后自拍，不在演出，也不录制', props: ['microphone'], avoid: [] },
        { ...scene, props: ['手机'], avoid: ['手机'] },
        { ...scene, lighting: 'direct sunlight' }
    ]) assert.throws(() => h.G.characterRequest(h.c, { mode: 'generate', selfPortrait: true, prompt: '校园自拍', scene: bad }, card), /场景矛盾/);
    assert.equal(h.requests.length, 0);
    const stage = { ...scene, action: '舞台演出期间自拍', location: '舞台后台', props: ['头戴麦克风'], avoid: [] };
    const request = h.G.characterRequest(h.c, { mode: 'generate', selfPortrait: true, prompt: '演出时戴着麦克风自拍', scene: stage }, card);
    await h.G.generate(request.config, request.prompt); assert.equal(h.requests.length, 1);
    assert.ok(request.prompt.includes('若本轮确实需要这些物件，按画面计划保留'));
});
test('only the current actor can supply pose references, and explicit map location is checked', () => {
    const h = harness(), card = { imageReferences: [ref('self', '人物'), ref('hall', '走廊', 'scene')] };
    for (const poseReferenceId of ['another-actor', 'hall']) assert.throws(() => h.G.characterRequest(h.c,
        { mode: 'generate', selfPortrait: true, prompt: '自拍', scene: { ...scene, poseReferenceId } }, card), /姿势参考/);
    assert.throws(() => h.G.characterRequest(h.c, { mode: 'generate', selfPortrait: true, prompt: '自拍', scene: { ...scene, placeId: 'other-place' } }, card,
        { placeId: 'current-place', location: '已确认教室', storyTime: '2026-11-23T18:10:00' }), /地点.*不同/);
});
test('media normalization retains a validated scene for retry but rejects unknown/malformed fields', () => {
    const h = harness(), intent = h.M.normalizeIntent({ mode: 'generate', selfPortrait: true, prompt: '自然自拍', scene });
    assert.deepEqual(JSON.parse(JSON.stringify(intent.scene)), scene);
    for (const value of [{ ...scene, extra: 'ignore rules' }, { ...scene, props: 'microphone' }, { ...scene, action: '' }])
        assert.throws(() => h.M.normalizeIntent({ mode: 'generate', prompt: '自然自拍', scene: value }));
    assert.throws(() => h.M.normalizeIntent({ mode: 'album', assetId: 'a', scene }));
});
test('legacy requests get the new natural reference instructions without rewriting NAI or inventing a pose', () => {
    const h = harness(), card = { imageReferences: [ref('self', '轻妆')] };
    const r = h.G.characterRequest(h.c, { mode: 'generate', selfPortrait: true, prompt: '自然自拍' }, card);
    assert.match(r.prompt, /【本轮画面】自然自拍/); assert.doesNotMatch(r.prompt, /【姿势参考】/);
    const nai = h.G.characterRequest(h.G.DEFAULTS, { mode: 'generate', prompt: 'portrait, school corridor' }, card);
    assert.equal(nai.prompt, 'portrait, school corridor');
    assert.throws(() => h.G.characterRequest(h.c, { mode: 'generate', selfPortrait: true, prompt: '' }, card), /1～1500/);
});
