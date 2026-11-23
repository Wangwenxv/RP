// One paid request through the production adapter. Credentials stay in the local key file.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const out = path.join(ROOT, '.refactor-tmp/yeelo-image-generation');
async function run() {
    fs.mkdirSync(out, { recursive: true });
    const apiKey = fs.readFileSync(path.join(ROOT, 'tmp/key.txt'), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)[0];
    if (!apiKey) throw new Error('Local API key is empty');
    const context = vm.createContext({ window: {}, URL, Blob, FormData, Uint8Array, atob, DOMException, AbortController, setTimeout, clearTimeout, fetch });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/image-generation.js'), 'utf8'), context);
    const G = context.window.RPHubImageGeneration;
    const refs = [1, 2, 3].map(n => ({ id: `sqx${n}`, name: `sqx${n}.jpg`, kind: 'character', dataUrl: 'data:image/jpeg;base64,' + fs.readFileSync(path.join(ROOT, `card/suqixue/sqx${n}.jpg`)).toString('base64') }));
    const card = { name: '苏祈雪', imageReferences: refs };
    const request = G.characterRequest({ ...G.DEFAULTS, ...G.PRESETS.yeelo, apiKey }, { mode: 'generate', selfPortrait: true,
        prompt: 'Create a realistic candid smartphone selfie of the same adult woman shown in the three reference photos. Preserve her facial identity and natural proportions. She has just finished a university class, standing in a campus corridor in soft late afternoon light, wearing a modest cream cardigan. Slightly shy, warm smile, natural skin texture, vertical-feeling close portrait, no text.' }, card);
    const started = Date.now();
    try {
        const blob = await G.generate(request.config, request.prompt);
        const file = path.join(out, 'suqixue-selfie' + (blob.type === 'image/jpeg' ? '.jpg' : blob.type === 'image/webp' ? '.webp' : '.png'));
        fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
        fs.writeFileSync(path.join(out, 'live-report.json'), JSON.stringify({ status: 'success', endpoint: G.endpoint(request.config, G.payload(request.config, request.prompt).endpoint),
            model: request.config.model, referenceCount: refs.length, mime: blob.type, bytes: blob.size, elapsedMs: Date.now() - started, image: file }, null, 2));
        console.log(JSON.stringify({ success: true, referenceCount: refs.length, file, bytes: blob.size }));
    } catch (error) {
        console.error(String(error.message).split(apiKey).join('[redacted]')); process.exitCode = 1;
    }
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
