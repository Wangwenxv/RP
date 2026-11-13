// Explicit image protocols: STA1N Nai2API uses labeled chat, not /images/generations.
(function () {
    const DEFAULTS = Object.freeze({ enabled: true, baseUrl: 'https://sta1n.ai/v1', apiKey: '',
        model: 'nai-diffusion-4-5-full:k_dpmpp_2m', protocol: 'sta1n-nai', size: '1024x1024' });
    const config = settings => ({ ...DEFAULTS, ...(settings?.wechatImageApi || {}) });
    const ready = value => value?.enabled !== false && !!String(value?.apiKey || '').trim() && !!String(value?.model || '').trim();
    const active = signal => { if (signal?.aborted) throw new DOMException('图片生成已取消', 'AbortError'); };
    function base(value) {
        const url = new URL(String(value || DEFAULTS.baseUrl).trim().replace(/\/+$/, ''));
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请填写有效的图片 API 基础地址（如 https://sta1n.ai/v1）');
        return url.href.replace(/\/+$/, '');
    }
    function payload(c, prompt) {
        prompt = String(prompt || '').replace(/\s+/g, ' ').trim();
        if (!prompt || prompt.length > 1500) throw new Error('生图提示词须为 1～1500 字符');
        if (!['1024x1024', '1216x832', '832x1216'].includes(c.size)) throw new Error('图片尺寸无效');
        const model = String(c.model || '').trim();
        if (!model) throw new Error('请选择生图模型');
        if (c.protocol === 'openai-images') return { endpoint: 'images/generations', body: { model, prompt, n: 1, size: c.size, response_format: 'b64_json' } };
        if (!['sta1n-nai', 'chat-image'].includes(c.protocol)) throw new Error('图片接口协议无效');
        const shape = c.size === '1024x1024' ? '方图' : c.size === '1216x832' ? '横图' : '竖图';
        const content = c.protocol === 'sta1n-nai' ? [
            `提示词:${prompt}`, '画师串:', `尺寸:${shape}`, '提示词引导值:6', '缩放引导值:0',
            '负面提示词:lowres, blurry, bad anatomy, bad hands, text, signature, watermark',
            `采样器:${model.split(':')[1] || 'k_dpmpp_2m'}`
        ].join('\n') : prompt;
        return { endpoint: 'chat/completions', body: { model, stream: false, messages: [{ role: 'user', content }] } };
    }
    function candidates(data) {
        const out = [];
        const add = value => {
            if (typeof value === 'string') out.push(value);
            else if (Array.isArray(value)) value.forEach(add);
            else if (value && typeof value === 'object') for (const key of ['text', 'url', 'image_url', 'b64_json', 'base64', 'b64']) add(value[key]);
        };
        add(data?.choices?.[0]?.message?.content); add(data?.choices?.[0]?.message?.images);
        add(data?.choices?.[0]?.text); add(data?.data);
        add(data?.imageUrl); add(data?.url); add(data?.content);
        return out;
    }
    const maxBytes = 12 * 1024 * 1024;
    async function imageBlob(blob) {
        if (!blob.size || blob.size > maxBytes) throw new Error('图片为空或超过 12MB');
        const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
        const mime = b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 ? 'image/png'
            : b[0] === 255 && b[1] === 216 && b[2] === 255 ? 'image/jpeg'
            : String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8)) === 'WEBP' ? 'image/webp' : '';
        if (!mime) throw new Error('接口未返回有效的 PNG、JPEG 或 WebP 图片');
        return new Blob([blob], { type: mime });
    }
    function decode(text) {
        const match = text.match(/data:image\/(?:png|jpe?g|webp);base64,([a-z0-9+/=\r\n]+)/i);
        const encoded = match?.[1] || (/^[a-z0-9+/=\r\n]+$/i.test(text.trim()) && text.trim().length >= 64 ? text.trim() : '');
        if (!encoded) return null;
        if (encoded.length > maxBytes * 1.4) throw new Error('图片超过 12MB');
        try { return new Blob([Uint8Array.from(atob(encoded.replace(/\s/g, '')), c => c.charCodeAt(0))]); }
        catch (_) { throw new Error('接口返回的图片 Base64 无效'); }
    }
    async function scoped(signal, timeoutMs, operation) {
        active(signal);
        const controller = new AbortController(); let timedOut = false;
        const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
        try { return await operation(controller.signal); }
        catch (error) { active(signal); if (timedOut) throw new Error('生图等待超时，可手动重试；服务端可能仍已计费'); throw error; }
        finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    async function extract(response, c, signal) {
        if (!response.ok) throw new Error(`图片接口请求失败（HTTP ${response.status}）${response.status === 401 || response.status === 403 ? '，请检查 API Key、模型权限和余额' : ''}`);
        if ((response.headers.get('content-type') || '').startsWith('image/')) return imageBlob(await response.blob());
        const data = await response.json();
        for (const text of candidates(data)) { const blob = decode(text); if (blob) return imageBlob(blob); }
        for (const text of candidates(data)) {
            const value = text.match(/!\[[^\]]*\]\(([^\s)]+)\)/)?.[1]
                || text.match(/https?:\/\/[^\s)\]"'<>]+/)?.[0]
                || (/^\/[^\s]+$/.test(text.trim()) ? text.trim() : '');
            if (!value) continue;
            const url = new URL(value, base(c.baseUrl) + '/');
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('图片地址无效');
            // Never send the API credential to image/CDN hosts or in a query string.
            const result = await fetch(url.href, { signal, credentials: 'omit' });
            if (!result.ok) throw new Error(`图片下载失败（HTTP ${result.status}）`);
            return imageBlob(await result.blob());
        }
        throw new Error('接口返回成功，但没有图片；请检查生图模型和接口协议');
    }
    async function generate(c, prompt, signal) {
        c = { ...DEFAULTS, ...c };
        if (!ready(c)) throw new Error('请在设置 → 微信生图中填写 API Key 并开启生图');
        const request = payload(c, prompt), url = `${base(c.baseUrl)}/${request.endpoint}`;
        return scoped(signal, c.timeoutMs || 300000, async signal => {
            const response = await fetch(url, { method: 'POST', signal, credentials: 'omit', headers: {
                'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey.trim()}` }, body: JSON.stringify(request.body) });
            const blob = await extract(response, c, signal); active(signal); return blob;
        });
    }
    async function models(c, signal) {
        return scoped(signal, 30000, async signal => {
            const response = await fetch(`${base(c.baseUrl)}/models`, { signal, credentials: 'omit', headers: { Authorization: `Bearer ${String(c.apiKey || '').trim()}` } });
            if (!response.ok) throw new Error(`读取模型失败（HTTP ${response.status}）`);
            const data = await response.json();
            return [...new Set((data.data || []).map(m => m.id).filter(id => typeof id === 'string'))].sort();
        });
    }
    const prompt = '需要拍照、自拍、分享饭菜或场景时，按当前对话、人设与已确定的地点/动作设计画面，优先使用生图。不要为了匹配图库更改正在吃的饭菜，不把文字“[图片]”当作发图。'
        + '返回 {"type":"image_request","media":{"mode":"generate","prompt":"具体画面英文描述或Tag，包含主体、环境、视角、光线；不含API字段","description":"中文简短画面说明","usage":"scene_photo"}}，放在messages原位置；每次决策最多一张，也可与文字混排。'
        + '例如正在吃黄焖鸡而对方说“给我拍拍照，看看你吃啥”，可生成 yellow braised chicken with potatoes and green peppers in a clay pot, bowl of rice, dining table, close-up, warm indoor light。自拍结合本人已知外貌，不凭空借用其他人照片。'
        + '这是图片内容说明，不是角色配文；生成提示不等于识图结果，后续不能据此断言未经核对的细节。可以按人设拒绝拍照，也不要求每轮发图。';
    window.RPHubImageGeneration = Object.freeze({ DEFAULTS, config, ready, payload, candidates, generate, models, prompt });
})();
