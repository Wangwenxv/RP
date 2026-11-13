const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=';
function harness(respond) {
    const requests = [], context = vm.createContext({ window: {}, URL, Blob, Uint8Array, atob, DOMException,
        AbortController, setTimeout, clearTimeout, fetch: async (url, options) => { requests.push({ url, options }); return respond(url, options, requests.length); } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../assets/js/image-generation.js'), 'utf8'), context);
    const G = context.window.RPHubImageGeneration;
    return { G, requests, c: { ...G.DEFAULTS, apiKey: 'fixture-secret' } };
}
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const identity = { version: 1, enabled: true, prompt: 'slim oval face, dark brown almond eyes', description: '苏祈雪的固定外貌', negative: 'anime, oversized eyes' };

test('only explicit self portraits compose the bound card identity and NAI negatives', async () => {
    const h = harness(() => json({ data: [{ b64_json: png }] }));
    const card = { data: { name: '苏祈雪', extensions: { rp_hub_image_identity: identity } } };
    const scene = 'campus corridor, phone selfie, evening light';
    const r = h.G.characterRequest(h.c, { prompt: scene, selfPortrait: true }, card);
    assert.equal(r.prompt, identity.prompt + ', ' + scene);
    assert.equal(r.config.negativePrompt, identity.negative);
    assert.equal(h.c.negativePrompt, undefined, 'shared config must not be mutated');
    await h.G.generate(r.config, r.prompt);
    const text = JSON.parse(h.requests[0].options.body).messages[0].content;
    assert.ok(text.includes('提示词:' + identity.prompt + ', ' + scene));
    assert.ok(text.includes('watermark, ' + identity.negative));
    for (const flag of [false]) {
        const meal = h.G.characterRequest(h.c, { prompt: 'clay pot chicken', selfPortrait: flag }, card);
        assert.equal(meal.prompt, 'clay pot chicken'); assert.equal(meal.config.negativePrompt, undefined);
    }
    assert.match(h.G.identityPrompt(card), /苏祈雪.*】/);
    assert.match(h.G.identityPrompt(card), /"selfPortrait":true/);
    assert.throws(() => h.G.characterRequest(h.c, { mode: 'generate', prompt: 'clay pot chicken' }, card), /必须填写selfPortrait/);
});

test('disabled/cleared identities stay cleared; deduplication and length checks happen before paying', () => {
    const h = harness(() => { throw new Error('must not pay'); });
    const r = h.G.characterRequest(h.c, { selfPortrait: true, prompt: identity.prompt + ', phone selfie' }, { imageIdentity: identity });
    assert.equal(r.prompt, identity.prompt + ', phone selfie');
    assert.throws(() => h.G.characterRequest(h.c, { selfPortrait: true, prompt: 'x'.repeat(1480) }, { imageIdentity: identity }), /超过1500/);
    for (const value of [null, { ...identity, enabled: false }, { prompt: 'x'.repeat(901) }]) {
        const card = { imageIdentity: value, extensions: { rp_hub_image_identity: identity } };
        assert.equal(h.G.identityPrompt(card), '');
        assert.equal(h.G.characterRequest(h.c, { selfPortrait: true, prompt: 'phone selfie' }, card).prompt, 'phone selfie');
    }
    assert.equal(h.requests.length, 0);
});
test('STA1N uses exact sampler model and labeled chat payload, no images endpoint or RP tags', async () => {
    const h = harness(() => json({ choices: [{ message: { content: `![meal](data:image/png;base64,${png})` } }] }));
    const blob = await h.G.generate(h.c, 'yellow braised chicken, rice');
    assert.equal(blob.type, 'image/png');
    const r = h.requests[0], body = JSON.parse(r.options.body);
    assert.equal(r.url, 'https://sta1n.ai/v1/chat/completions');
    assert.equal(body.model, 'nai-diffusion-4-5-full:k_dpmpp_2m');
    assert.equal(body.stream, false);
    assert.match(body.messages[0].content, /^提示词:yellow braised chicken, rice\n画师串:\n尺寸:方图\n提示词引导值:6\n缩放引导值:0\n负面提示词:.+\n采样器:k_dpmpp_2m$/);
    assert.doesNotMatch(JSON.stringify(body), /fixture-secret|image###/);
    assert.equal(r.options.headers.Authorization, 'Bearer fixture-secret');
});
test('response variants: content parts, images, b64_json and direct image', async () => {
    for (const data of [{ choices: [{ message: { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } }] } }] },
        { choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + png } }] } }] }, { data: [{ b64_json: png }] }, null]) {
        const h = harness(() => data ? json(data) : new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } }));
        assert.ok((await h.G.generate(h.c, 'chicken')).size > 0);
    }
});
test('download result URL without API key, reject nonimage response', async () => {
    const h = harness((url, opts, n) => n === 1 ? json({ choices: [{ message: { content: '![meal](https://cdn.test/meal.png)' } }] })
        : new Response(Buffer.from(png, 'base64')));
    await h.G.generate(h.c, 'food');
    assert.equal(h.requests[1].url, 'https://cdn.test/meal.png');
    assert.equal(h.requests[1].options.headers, undefined);
    const bad = harness(() => new Response('<html>oops</html>', { headers: { 'Content-Type': 'image/png' } }));
    await assert.rejects(bad.G.generate(bad.c, 'food'), /未返回有效/);
});
test('protocol is explicit and user model/size honored; model list retrieval does not generate', async () => {
    const h = harness(() => json({ data: [{ id: 'custom-image' }, { id: 'custom-image' }] }));
    assert.deepEqual(Array.from(await h.G.models(h.c)), ['custom-image']);
    assert.equal(h.requests[0].url, 'https://sta1n.ai/v1/models');
    let p = h.G.payload({ ...h.c, protocol: 'openai-images', model: 'custom-image', size: '832x1216' }, 'food');
    assert.equal(p.endpoint, 'images/generations'); assert.equal(p.body.model, 'custom-image'); assert.equal(p.body.size, '832x1216');
    p = h.G.payload({ ...h.c, protocol: 'chat-image' }, 'food'); assert.equal(p.body.messages[0].content, 'food');
    assert.throws(() => h.G.payload({ ...h.c, protocol: 'unknown' }, 'food'), /协议无效/);
});
test('no credential, disabled, HTTP errors, empty success, timeout and cancel never fake an image', async () => {
    const h = harness(() => new Response('', { status: 401 }));
    await assert.rejects(h.G.generate({ ...h.c, apiKey: '' }, 'food'), /填写 API Key/);
    await assert.rejects(h.G.generate({ ...h.c, enabled: false }, 'food'), /填写 API Key/);
    assert.equal(h.requests.length, 0);
    await assert.rejects(h.G.generate(h.c, 'food'), /HTTP 401/);
    assert.equal(h.requests.length, 1);
    const empty = harness(() => json({ choices: [{ message: { content: 'done' } }] }));
    await assert.rejects(empty.G.generate(empty.c, 'food'), /没有图片/);
    const delayed = harness((url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')))));
    await assert.rejects(delayed.G.generate({ ...delayed.c, timeoutMs: 5 }, 'food'), /超时/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(delayed.G.generate(delayed.c, 'food', controller.signal), { name: 'AbortError' });
    assert.equal(delayed.requests.length, 1);
});
