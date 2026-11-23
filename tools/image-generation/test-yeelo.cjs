// One paid request through the production adapter. Credentials stay in the local key file.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const out = path.resolve(ROOT, option('--out') || '.refactor-tmp/yeelo-image-generation');
async function run() {
    fs.mkdirSync(out, { recursive: true });
    const apiKey = fs.readFileSync(path.join(ROOT, 'tmp/key.txt'), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)[0];
    if (!apiKey) throw new Error('Local API key is empty');
    const context = vm.createContext({ window: {}, URL, Blob, FormData, Uint8Array, atob, DOMException, AbortController, setTimeout, clearTimeout, fetch });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/image-generation.js'), 'utf8'), context);
    const G = context.window.RPHubImageGeneration;
    const refs = [1, 2, 3].map(n => ({ id: `sqx${n}`, name: `sqx${n}.jpg`, kind: 'character', dataUrl: 'data:image/jpeg;base64,' + fs.readFileSync(path.join(ROOT, `card/suqixue/sqx${n}.jpg`)).toString('base64') }));
    const scenario = process.argv.includes('--scene-selfie');
    const card = scenario ? JSON.parse(fs.readFileSync(path.join(ROOT, 'card/suqixue/苏祈雪v2.json'), 'utf8')) : { name: '苏祈雪', imageReferences: refs };
    const selectedRefs = G.referencesOf(card);
    const scene = scenario ? { location: '三月的大学教学楼走廊，刚下课', time: '傍晚18:10，天已黑，走廊室内灯已亮',
        clothing: '符合清爽简洁衣品的米白针织衫与薄外套，适合三月校园天气，普通小耳饰与自然妆容',
        action: '独自站在走廊自然自拍，轻浅微笑，空闲的一只手在脸旁轻轻比V，借鉴原自拍的轻松手势',
        framing: '手机前置摄像头的上半身自拍，另一只手在画面外持机，可见手臂与取景合理',
        lighting: '柔和走廊灯光，窗外已暗，不使用直射阳光', props: ['手机'], avoid: ['头戴麦克风', '话筒', '舞台设备', '雨伞', '演出服'],
        poseReferenceId: selectedRefs[2].id } : undefined;
    const request = G.characterRequest({ ...G.DEFAULTS, ...G.PRESETS.yeelo, apiKey }, { mode: 'generate', selfPortrait: true,
        ...(scene ? { scene } : {}), prompt: scenario
            ? '生成同一个成年女生刚下课后给恋人发送的校园手机自拍。保持三张参考照中的面部身份；借鉴轻淡精致妆容、自然自拍角度和轻轻比V的习惯，不逐张复制造型。按当前角色的齐肩细软深棕发设定、清爽米白针织衫与薄外套重组画面。她独自在三月傍晚的教学楼走廊里，略带害羞的浅笑，空闲的手在脸旁比V，另一只手在画面外持手机。柔和室内灯，窗外已暗。普通日常校园场景，脸侧、耳部及衣领附近不佩戴任何麦克风，不穿演出服，不撑伞，无舞台设备或多余人物。保留参考自拍的自然亲近感，人体与机位合理。'
            : 'Create a realistic candid smartphone selfie of the same adult woman shown in the three reference photos. Preserve her facial identity and natural proportions. She has just finished a university class, standing in a campus corridor in soft late afternoon light, wearing a modest cream cardigan. Slightly shy, warm smile, natural skin texture, vertical-feeling close portrait, no text.' }, card);
    const started = Date.now();
    try {
        const blob = await G.generate(request.config, request.prompt);
        const file = path.join(out, 'suqixue-selfie' + (blob.type === 'image/jpeg' ? '.jpg' : blob.type === 'image/webp' ? '.webp' : '.png'));
        fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
        fs.writeFileSync(path.join(out, 'live-report.json'), JSON.stringify({ status: 'success', endpoint: G.endpoint(request.config, G.payload(request.config, request.prompt).endpoint),
            model: request.config.model, referenceCount: selectedRefs.length, scene, prompt: request.prompt, mime: blob.type, bytes: blob.size, elapsedMs: Date.now() - started, image: file, paidRequests: 1 }, null, 2));
        console.log(JSON.stringify({ success: true, referenceCount: selectedRefs.length, file, bytes: blob.size }));
    } catch (error) {
        console.error(String(error.message).split(apiKey).join('[redacted]')); process.exitCode = 1;
    }
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
