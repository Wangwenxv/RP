// 单次真实调用 qwen-image-2.1-turbo，验证工程 naturalScenePrompt 的长提示能否被承接。
// Key 只从 tmp/key.txt 第一行读取，不写入代码、卡片或报告。每次运行计费 1 张。
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const out = path.resolve(ROOT, option('--out', '.refactor-tmp/qwen-image/probe'));
const cardPath = path.resolve(ROOT, option('--card', 'card/suqixue/苏祈雪v2.json'));
const refCount = Math.max(1, Math.min(10, Number(option('--refs', '1'))));
const size = option('--size', '1024*1024');
const seed = option('--seed', '');
const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

async function run() {
    fs.mkdirSync(out, { recursive: true });
    const keyFile = path.join(ROOT, 'tmp/key.txt');
    const apiKey = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)[0] : '';
    const dry = process.argv.includes('--dry');
    if (!apiKey && !dry) throw new Error('tmp/key.txt 为空：请先写入 DASHSCOPE_API_KEY');

    // 用生产适配器拼提示词，确保测的是工程真实输出而不是手写样例。
    const context = vm.createContext({ window: {}, URL, Blob, Uint8Array, atob, DOMException, AbortController, setTimeout, clearTimeout, fetch });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/image-generation.js'), 'utf8'), context);
    const G = context.window.RPHubImageGeneration;
    const raw = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    const card = { ...(raw.data || raw), name: (raw.data || raw).name };
    // 参考图在卡里可能只有相对路径 src，没有内嵌 dataUrl；这里就地读盘补成 data URL。
    const inline = ref => {
        if (ref.dataUrl) return ref;
        if (!ref.src || /^https?:/i.test(ref.src)) return null;
        const file = path.resolve(ROOT, ref.src.replace(/^\.?\//, ''));
        if (!fs.existsSync(file)) return null;
        const ext = path.extname(file).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        return { ...ref, dataUrl: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` };
    };
    const portraits = G.referencesOf(card).filter(r => r.kind !== 'scene').map(inline).filter(Boolean);
    if (!portraits.length) throw new Error('卡片内没有可读到像素的人物参考图');
    const picked = portraits.slice(0, refCount);

    // 本轮场景：与 docs 中的宿舍浴室自拍一致，避免与参考图的街景、演出设备互相污染。
    const intent = {
        mode: 'generate', selfPortrait: true,
        prompt: '宿舍浴室的害羞手机自拍，齐肩柔软头发别在耳后，白色长袖睡衣上衣带小红心印花，配套短裤，站在镜子前，单手举手机，微微脸红，害羞的浅笑。',
        scene: {
            location: '大学宿舍浴室，镜子前', time: '夜间，室内', clothing: '白色长袖睡衣上衣，小红心印花，配套短裤',
            action: '站在镜前单手举手机自拍，另一只手自然垂下', framing: '手机前置摄像头的上半身自拍',
            lighting: '暖白室内荧光灯', props: ['手机'], avoid: ['头戴麦克风', '话筒', '舞台设备', '雨伞', '多余人物']
        }
    };
    // 必须显式选自然语言协议：DEFAULTS 是 sta1n-nai，会跳过 naturalScenePrompt 直接返回短句。
    const request = G.characterRequest({
        ...G.DEFAULTS, protocol: 'chat-image', referenceMode: 'chat-content',
        apiKey, model: 'qwen-image-2.1-turbo', size: '1024x1024'
    }, intent, card);
    const prompt = request.prompt;

    const body = {
        model: 'qwen-image-2.1-turbo',
        input: { messages: [{ role: 'user', content: [...picked.map(r => ({ image: r.dataUrl })), { text: prompt }] }] },
        parameters: { size, n: 1, prompt_extend: false, watermark: false, ...(seed ? { seed: Number(seed) } : {}) }
    };
    const started = Date.now();
    if (process.argv.includes('--dry')) {
        // 只验证提示词组装与参考图读取，不联网、不计费。
        console.log(JSON.stringify({
            dryRun: true, refs: picked.length, promptChars: prompt.length,
            referenceBytes: picked.reduce((n, r) => n + r.dataUrl.length, 0), prompt
        }, null, 2));
        return;
    }
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status} 非 JSON 响应：${text.slice(0, 300)}`); }
    if (!response.ok) throw new Error(`HTTP ${response.status} ${data.code || ''} ${data.message || text.slice(0, 300)}`);

    const urls = (data.output?.choices?.[0]?.message?.content || []).map(item => item.image).filter(Boolean);
    if (!urls.length) throw new Error('响应中没有 image 字段：' + JSON.stringify(data).slice(0, 400));

    // 同时记录图片 CDN 的 CORS 头，验证网页端能否直接 fetch 转 Blob。
    const head = await fetch(urls[0], { method: 'GET' });
    const cors = head.headers.get('access-control-allow-origin');
    const bytes = Buffer.from(await head.arrayBuffer());
    const file = path.join(out, `qwen-refs${refCount}.png`);
    fs.writeFileSync(file, bytes);

    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({
        status: 'success', endpoint: ENDPOINT, model: 'qwen-image-2.1-turbo', referenceCount: picked.length,
        size, promptExtend: false, promptChars: prompt.length, prompt, seed: seed || null,
        imageUrl: urls[0], imageHostCors: cors, bytes: bytes.length, elapsedMs: Date.now() - started,
        usage: data.usage || null, file, paidRequests: 1
    }, null, 2));
    console.log(JSON.stringify({ success: true, refs: picked.length, file, bytes: bytes.length, imageHostCors: cors, elapsedMs: Date.now() - started }));
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
