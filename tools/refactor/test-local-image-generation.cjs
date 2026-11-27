const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=';
const id = 'img_' + 'f'.repeat(32);
const state = (status, extra) => ({ id, status, ...extra });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function harness(reply) {
    const requests = [], context = vm.createContext({ window: {}, URL, Blob, FormData, Uint8Array, atob, DOMException,
        AbortController, setTimeout: (fn, delay) => setTimeout(fn, delay <= 2000 ? 0 : delay), clearTimeout, fetch: async (url, options) => {
            requests.push({ url, options });
            if (reply) return reply(url, options);
            if (url.endsWith('/models')) return json({ data: [{ id: 'qwen-image-2.1-turbo-local' }] });
            if (url.endsWith('/jobs')) return json(state('queued', { phase: 'queued' }), 202);
            if (url.endsWith('/image')) return new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } });
            return json(state('completed'));
        } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../assets/js/image-generation.js'), 'utf8'), context);
    const G = context.window.RPHubImageGeneration;
    return { G, requests, c: { ...G.DEFAULTS, ...G.PRESETS.local, apiKey: '' } };
}
test('local preset generates without credentials and keeps cloud credentials out of requests', async () => {
    const { G, c, requests } = harness();
    assert.equal(G.ready(c), true);
    assert.equal((await G.generate({ ...c, apiKey: 'old-cloud-secret' }, '宿舍浴室')).type, 'image/png');
    assert.equal(requests[0].url, 'http://127.0.0.1:7865/v1/jobs');
    assert.equal(requests[0].options.headers.Authorization, undefined);
    assert.equal(JSON.parse(requests[0].options.body).size, 'auto');
    assert.equal(c.timeoutMs, 1800000);
});
test('local edits upload reference roles in the same order as real image files', async () => {
    const { G, c, requests } = harness();
    c.referenceImages = [{ id: 'face', kind: 'character', dataUrl: 'data:image/png;base64,' + png },
        { id: 'clothes', generationPurpose: 'clothing', dataUrl: 'data:image/png;base64,' + png },
        { id: 'room', kind: 'scene', dataUrl: 'data:image/png;base64,' + png }];
    await G.generate(c, '镜面自拍');
    assert.equal(requests[0].url, 'http://127.0.0.1:7865/v1/jobs');
    const form = requests[0].options.body;
    assert.equal(form.get('reference_roles'), '["identity","clothing","background"]');
    assert.equal(form.getAll('image[]').length, 3);
    assert.equal(requests[0].options.headers.Authorization, undefined);
});

test('local progress includes memory retry and keeps the engine error visible', async () => {
    let polls = 0;
    const { G, c } = harness(url => {
        if (url.endsWith('/jobs')) return json(state('queued', { phase: 'queued' }), 202);
        if (++polls === 1) return json(state('generating', { phase: 'retrying_memory' }));
        return json(state('failed', { error: 'GPU 显存不足，低显存模式已重试一次' }));
    });
    const progress = [];
    await assert.rejects(G.generate(c, '浴室', undefined, update => progress.push(update.label)), /GPU 显存不足/);
    assert.deepEqual(progress, ['排队中', '正在以低显存模式重试']);
});

test('local generation cancels a job accepted during an aborted upload', async () => {
    const controller = new AbortController();
    const { G, c, requests } = harness(url => {
        if (url.endsWith('/jobs')) {
            controller.abort();
            return json(state('queued'), 202);
        }
        assert.ok(url.endsWith(`/${id}/cancel`));
        return json(state('cancelled'));
    });
    await assert.rejects(G.generate(c, '浴室', controller.signal), { name: 'AbortError' });
    assert.deepEqual(requests.map(({ options }) => options.method), ['POST', 'POST']);
});
test('local mode cannot bypass authentication for a remote or malformed address', async () => {
    for (const baseUrl of ['https://example.com/v1', 'http://127.0.0.1.example.com/v1', 'http://user:pass@127.0.0.1/v1', 'file:///tmp']) {
        const { G, c, requests } = harness();
        assert.equal(G.ready({ ...c, baseUrl, apiKey: 'secret' }), false);
        await assert.rejects(G.generate({ ...c, baseUrl }, '浴室'), /本地生图/);
        assert.equal(requests.length, 0);
    }
});
test('local model listing needs no key and cloud presets restore their own mode', async () => {
    const { G, c, requests } = harness();
    assert.deepEqual(Array.from(await G.models(c)), ['qwen-image-2.1-turbo-local']);
    assert.equal(requests[0].options.headers.Authorization, undefined);
    for (const name of ['yeelo', 'openai', 'sta1n']) {
        const switched = { ...c, ...G.PRESETS[name] };
        assert.equal(switched.localService, false);
        assert.equal(G.ready(switched), false);
    }
});

test('SQX local model is scoped to the SQX card when she is in frame', async () => {
    const { G, c, requests } = harness();
    const config = { ...c, model: c.model + '-sqx' };
    const portrait = { mode: 'generate', prompt: '宿舍自拍', selfPortrait: true };
    const card = { name: '苏祈雪' };
    assert.throws(() => G.characterRequest(config, { ...portrait, selfPortrait: undefined }, card), /selfPortrait/);
    const request = G.characterRequest(config, portrait, card);
    await G.generate(request.config, request.prompt);
    assert.equal(JSON.parse(requests[0].options.body).model, config.model);
    assert.equal(G.characterRequest(config, { ...portrait, selfPortrait: false }, card).config.model, c.model);
    assert.equal(G.characterRequest(config, portrait, { name: '其他角色' }).config.model, c.model);
});
