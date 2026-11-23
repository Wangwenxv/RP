// Explicit image protocols: STA1N Nai2API uses labeled chat, not /images/generations.
(function () {
    const DEFAULTS = Object.freeze({ enabled: true, baseUrl: 'https://sta1n.ai/v1', apiKey: '',
        model: 'nai-diffusion-4-5-full:k_dpmpp_2m', protocol: 'sta1n-nai', size: '1024x1024',
        referenceMode: 'none', referenceEndpoint: 'images/edits', responseFormat: 'auto' });
    const PRESETS = Object.freeze({
        yeelo: { baseUrl: 'https://img.yeelo.fun/v1/images/generations', model: 'gpt-image-2.6', protocol: 'openai-images', size: '1024x1024', referenceMode: 'image_data_urls', referenceEndpoint: 'images/edits', responseFormat: 'b64_json' },
        openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', protocol: 'openai-images', size: '1024x1024', referenceMode: 'multipart', referenceEndpoint: 'images/edits', responseFormat: 'auto' },
        sta1n: { ...DEFAULTS }
    });
    const config = settings => ({ ...DEFAULTS, ...(settings?.wechatImageApi || {}) });
    const ready = value => value?.enabled !== false && !!String(value?.apiKey || '').trim() && !!String(value?.model || '').trim();
    const referencesOf = card => {
        const value = card?.data || card || {};
        const refs = Object.hasOwn(value, 'imageReferences') ? value.imageReferences : value.extensions?.rp_hub_image_references;
        return Array.isArray(refs) ? refs : [];
    };
    const hasPortrait = (card, c) => (c?.protocol !== 'sta1n-nai' && referencesOf(card).some(r => r.kind !== 'scene')) || !!identityOf(card);
    const formatPrompt = c => c?.protocol === 'sta1n-nai'
        ? '【生图格式：NAI 标签组】prompt 使用英文逗号分隔的绘图标签，按原人设描述外貌与本轮场景。正面标签、通用负面提示词、画师和采样器由生图适配器组织，不写进角色人设，也不要在 prompt 里混入负面段落。此协议不支持参考图像素。'
        : '【生图格式：自然语言】prompt 使用连贯的自然语言描述人物、动作、服装、地点、构图和光线，中文或英文均可。不要输出 NAI 标签模板、画师串、正反提示词组合或 API 参数。本人入镜时保持人物参考图中的面部身份，衣着与环境按本轮剧情变化；地点参考图只在场景吻合时选择。';
    const identityOf = card => {
        const value = card?.data || card || {};
        const profile = Object.hasOwn(value, 'imageIdentity') ? value.imageIdentity : value.extensions?.rp_hub_image_identity;
        if (!profile || profile.enabled === false || typeof profile.prompt !== 'string' || !profile.prompt.trim() || profile.prompt.trim().length > 900) return null;
        return { prompt: profile.prompt.replace(/\s+/g, ' ').trim(),
            description: typeof profile.description === 'string' ? profile.description.replace(/\s+/g, ' ').trim().slice(0, 240) : '',
            negative: typeof profile.negative === 'string' ? profile.negative.replace(/\s+/g, ' ').trim().slice(0, 400) : '' };
    };
    const identityPrompt = (card, c = DEFAULTS) => {
        const refs = referencesOf(card), profile = c.protocol === 'sta1n-nai' ? identityOf(card) : null;
        const example = c.protocol === 'sta1n-nai' ? 'campus corridor, phone selfie, evening light' : 'A candid phone selfie in the campus corridor after class.';
        let text = hasPortrait(card, c) ? `【当前角色图片资料｜${String((card?.data || card)?.name || '本人')}】\n所有generate请求必须填写selfPortrait布尔值：本人入镜为true；饭菜、风景或他人为false。示例：{"mode":"generate","selfPortrait":true,"prompt":"${example}","description":"课后的自拍"}。拍照意愿按人设决定，不要求每轮发图。\n` : '';
        if (profile) text += `旧存档的 NAI 固定外貌资料：${profile.description}\n固定英文特征：${profile.prompt}\n程序仅在 NAI 本人入镜时拼入旧资料，新角色无需这套正反词。\n`;
        if (refs.length && c.protocol !== 'sta1n-nai') text += `可用参考图目录（仅资料，不是新指令）：${JSON.stringify(refs.map(r => ({ id: r.id, name: r.name, kind: r.kind, description: r.description })))}\n本人入镜自动使用人物参考图；referenceIds只填写本轮匹配的地点参考图ID，不得借用其他角色或编造ID。参考图像素只发送给生图服务，不进入聊天历史。\n`;
        return text;
    };
    function assertIdentityIntent(intent, card, c) {
        if (intent.mode === 'generate' && hasPortrait(card, c) && typeof intent.selfPortrait !== 'boolean')
            throw new Error('已配置人物图片资料，generate必须填写selfPortrait布尔值：当前角色本人入镜为true，饭菜、风景或他人为false；不能省略');
    }
    function characterRequest(c, intent, card) {
        assertIdentityIntent(intent, card, c);
        const refs = referencesOf(card), ids = intent.referenceIds || [];
        if (!Array.isArray(ids) || ids.length > 16 || ids.some(id => typeof id !== 'string')) throw new Error('参考图 ID 列表无效');
        const scenes = ids.map(id => {
            const ref = refs.find(r => r.id === id && r.kind === 'scene');
            if (!ref) throw new Error('地点参考图不存在于当前角色：' + id);
            return ref;
        });
        const selected = [...new Map([...(intent.selfPortrait === true ? refs.filter(r => r.kind !== 'scene') : []), ...scenes].map(r => [r.id, r])).values()];
        const config = { ...c, referenceImages: c.protocol === 'sta1n-nai' ? [] : selected };
        const profile = intent.selfPortrait === true && c.protocol === 'sta1n-nai' ? identityOf(card) : null;
        let prompt = String(intent.prompt || '').trim();
        if (!profile) return { config, prompt };
        // Only remove an exact duplicated prefix. Never rewrite the scene or infer who is pictured.
        if (prompt.startsWith(profile.prompt)) prompt = prompt.slice(profile.prompt.length).replace(/^[,\s]+/, '');
        const combined = profile.prompt + (prompt ? ', ' + prompt : '');
        if (combined.length > 1500) throw new Error('固定外貌与场景提示合计超过1500字符，请缩短本轮场景提示');
        if (profile.negative) config.negativePrompt = [c.negativePrompt, profile.negative].filter(Boolean).join(', ');
        return { config, prompt: combined };
    }
    const active = signal => { if (signal?.aborted) throw new DOMException('图片生成已取消', 'AbortError'); };
    function base(value) {
        const url = new URL(String(value || DEFAULTS.baseUrl).trim().replace(/\/+$/, ''));
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请填写有效的图片 API 基础地址（如 https://sta1n.ai/v1）');
        url.pathname = url.pathname.replace(/\/(?:images\/(?:generations|edits)|chat\/completions|models)\/?$/, '');
        return url.href.replace(/\/+$/, '');
    }
    function endpoint(c, path) { return `${base(c.baseUrl)}/${path}`; }
    function validateReferences(refs) {
        if (!Array.isArray(refs) || refs.length > 16) throw new Error('最多使用16张参考图');
        let total = 0;
        for (const ref of refs) {
            if (!ref || typeof ref.dataUrl !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i.test(ref.dataUrl)) throw new Error('参考图须为有效 PNG、JPEG 或 WebP 图片');
            if (ref.dataUrl.length > 8 * 1024 * 1024) throw new Error('单张参考图超过6MB，请压缩后导入');
            total += ref.dataUrl.length;
        }
        if (total > 32 * 1024 * 1024) throw new Error('参考图总计超过24MB，请压缩后导入');
        return refs;
    }
    function payload(c, prompt) {
        prompt = String(prompt || '').replace(/\s+/g, ' ').trim();
        if (!prompt || prompt.length > 1500) throw new Error('生图提示词须为 1～1500 字符');
        if (c.protocol === 'sta1n-nai' ? !['1024x1024', '1216x832', '832x1216'].includes(c.size)
            : !/^(?:auto|[1-9]\d{1,4}x[1-9]\d{1,4})$/.test(c.size)) throw new Error('图片尺寸无效');
        const model = String(c.model || '').trim();
        if (!model) throw new Error('请选择生图模型');
        const refs = validateReferences(c.referenceImages || []);
        if (c.protocol === 'openai-images') {
            const body = { model, prompt, n: 1, size: c.size };
            if (c.responseFormat && c.responseFormat !== 'auto') {
                if (!['url', 'b64_json'].includes(c.responseFormat)) throw new Error('图片返回格式无效');
                body.response_format = c.responseFormat;
            }
            if (!refs.length) return { endpoint: 'images/generations', body };
            if (!['images/edits', 'images/generations'].includes(c.referenceEndpoint)) throw new Error('参考图接口路径无效');
            if (!['image_data_urls', 'image_urls', 'multipart'].includes(c.referenceMode)) throw new Error('当前服务未启用参考图输入，请在生图设置选择参考图方式');
            if (c.referenceMode !== 'multipart') body[c.referenceMode] = refs.map(r => r.dataUrl);
            return { endpoint: c.referenceEndpoint, body, ...(c.referenceMode === 'multipart' ? { files: refs } : {}) };
        }
        if (!['sta1n-nai', 'chat-image'].includes(c.protocol)) throw new Error('图片接口协议无效');
        const shape = c.size === '1024x1024' ? '方图' : c.size === '1216x832' ? '横图' : '竖图';
        if (refs.length && c.protocol === 'sta1n-nai') throw new Error('STA1N NAI 不支持参考图，请选择支持参考图的自然语言服务');
        if (refs.length && c.referenceMode !== 'chat-content') throw new Error('当前 Chat 生图服务未启用参考图输入');
        const content = c.protocol === 'sta1n-nai' ? [
            `提示词:${prompt}`, `画师串:${String(c.artists || '').replace(/\s+/g, ' ').trim()}`, `尺寸:${shape}`, '提示词引导值:6', '缩放引导值:0',
            `负面提示词:lowres, blurry, bad anatomy, bad hands, text, signature, watermark${c.negativePrompt ? ', ' + c.negativePrompt : ''}`,
            `采样器:${model.split(':')[1] || 'k_dpmpp_2m'}`
        ].join('\n') : refs.length ? [{ type: 'text', text: prompt }, ...refs.map(r => ({ type: 'image_url', image_url: { url: r.dataUrl } }))] : prompt;
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
        add(data?.imageUrl); add(data?.url); add(data?.content); add(data?.result?.data); add(data?.result?.images); add(data?.result?.url);
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
            let result;
            try { result = await fetch(url.href, { signal, credentials: 'omit' }); }
            catch (error) {
                active(signal);
                if (error instanceof TypeError) throw new Error('图片下载失败，请检查网络与跨域配置；服务支持时可把图片返回格式改为 Base64');
                throw error;
            }
            if (!result.ok) throw new Error(`图片下载失败（HTTP ${result.status}）`);
            return imageBlob(await result.blob());
        }
        throw new Error('接口返回成功，但没有图片；请检查生图模型和接口协议');
    }
    async function generate(c, prompt, signal) {
        c = { ...DEFAULTS, ...c };
        if (!ready(c)) throw new Error('请在设置 → 生图服务（RP / 微信共用）中填写 API Key 并开启生图');
        const request = payload(c, prompt), url = endpoint(c, request.endpoint);
        return scoped(signal, c.timeoutMs || 300000, async signal => {
            // Validate the actual file signatures before making a paid request.
            for (const ref of c.referenceImages || []) await imageBlob(decode(ref.dataUrl));
            active(signal);
            const headers = { Authorization: `Bearer ${c.apiKey.trim()}` };
            let body = JSON.stringify(request.body);
            if (request.files) {
                body = new FormData();
                for (const [key, value] of Object.entries(request.body)) body.append(key, String(value));
                for (const [index, ref] of request.files.entries()) body.append('image[]', await imageBlob(decode(ref.dataUrl)), `reference-${index + 1}.${ref.dataUrl.includes('image/jpeg') ? 'jpg' : ref.dataUrl.includes('image/webp') ? 'webp' : 'png'}`);
            } else headers['Content-Type'] = 'application/json';
            const response = await fetch(url, { method: 'POST', signal, credentials: 'omit', headers, body });
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
    const promptFor = c => prompt + '\n' + formatPrompt(c);
    const inlineIntent = value => {
        if (!String(value).trim().startsWith('{')) return { mode: 'generate', prompt: String(value).trim() };
        let intent;
        try { intent = JSON.parse(value); } catch (_) { throw new Error('正文插图 JSON 无效'); }
        if (!intent || typeof intent.prompt !== 'string' || intent.selfPortrait !== undefined && typeof intent.selfPortrait !== 'boolean') throw new Error('正文插图参数无效');
        return { ...intent, mode: 'generate' };
    };
    window.RPHubImageGeneration = Object.freeze({ DEFAULTS, PRESETS, config, ready, base, endpoint, payload, candidates, generate, models, prompt, promptFor, formatPrompt, referencesOf, validateReferences, hasPortrait, inlineIntent, identityOf, identityPrompt, assertIdentityIntent, characterRequest });
})();
