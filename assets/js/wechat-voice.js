/** BreezeBlue contract, bounded voice intents and independent audio storage. */
(function () {
    const MAX_VOICES = 2;
    const MAX_TEXT = 200;
    const MAX_TOTAL_TEXT = 300;
    const assertActive = signal => { if (signal?.aborted) throw new DOMException('语音请求已中止', 'AbortError'); };
    function normalizeIntent(item) {
        if (item?.type !== 'voice_request' || typeof item.content !== 'string' || !item.content.trim()) throw new Error('语音必须包含要说的文字');
        const content = item.content.trim();
        const instructions = typeof item.instructions === 'string' ? item.instructions.trim() : '';
        if (Array.from(content).length > MAX_TEXT) throw new Error('单条语音最多 200 字，请缩短后重试');
        if (Array.from(instructions).length > 500) throw new Error('语音语气指令过长');
        if (/<\/?(?:think|script|audio)|data:audio|https?:\/\//i.test(content)) throw new Error('语音内容必须是口语正文，不能是链接或源码');
        return { type: 'voice_request', content, instructions };
    }
    function validateBatch(messages) {
        const voices = messages.filter(item => item.type === 'voice_request');
        if (voices.length > MAX_VOICES || voices.reduce((sum, item) => sum + Array.from(item.content).length, 0) > MAX_TOTAL_TEXT) throw new Error('每轮最多 2 条语音，合计最多 300 字');
        return messages;
    }
    const recordText = item => `[语音] ${String(item.content || '').trim()}`;
    function buildPrompt(enabled) {
        if (!enabled) return '【语音】本轮没有可用的语音服务，只能使用已提供的文字、表情或图片能力，不能输出 voice_request，也不要声称已发语音。';
        return `【语音消息｜可选表达方式】
先判断能否、愿否、是否需要回复，再决定媒介；亲密关系不等于每轮都发语音，语音也不用于强行收尾。
结合角色性格、你们的关系、最新 RP 场景和微信原文，在安慰、打趣、认真解释、想让对方听见语气或对方主动想听声音时，可自然穿插语音。对方不方便听、明确要文字、身边不能出声、熟睡或无法安全操作手机时不要发；不能用语音绕过通信和沉默约束，也不能捏造正在开车、哭泣或喘气等状态。
在 messages 数组原位置输出 {"type":"voice_request","content":"真正说出口的话","instructions":"符合当下情境的简短语气指令"}，可与文字、表情、图片混排。每轮最多 2 条语音，单条最多 200 字、合计最多 300 字；通常一条就够，不为凑条数重复同一句话。
content 只放自然口语，不写动作括号、舞台说明、音频标签、链接或音色 ID。不要在旁边再发一条相同文字作为字幕。
instructions 使用与正文相同的语言，挑两三项有依据的表达：意图、情绪强度、语速、停顿或轻重音。例如“像给熟悉的人留微信语音，轻声安慰，语速稍慢，语气克制”。不要描述新的身份或编造剧情，不承诺精确时长。音色由用户设置，instructions 不会发送给对方。
保持同一人物的声音身份，按每条当下内容调整表达。当前合成语言为中文。语音是异步留言，不是电话或实时通话。`;
    }
    function serviceBase(value) {
        const input = String(value || '').trim();
        if (!input) return window.location.protocol === 'file:' ? 'http://127.0.0.1:3000' : window.location.origin;
        const url = new URL(input);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('语音服务地址请填写完整来源，如 http://127.0.0.1:3000');
        return url.origin;
    }
    async function request(base, key, route, body, signal) {
        if (!String(key || '').trim()) throw new Error('请在微信设置填写 BreezeBlue Key');
        assertActive(signal);
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, 95000);
        try {
            const response = await fetch(`${serviceBase(base)}/api/wechat-voice/${route}`, { method: body ? 'POST' : 'GET', headers: { 'xi-api-key': key.trim(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, credentials: 'omit', redirect: 'error' });
            if (!response.ok) {
                let error; try { error = await response.json(); } catch (_) {}
                throw new Error(error?.error || `语音服务返回 HTTP ${response.status}`);
            }
            if (!body) return await response.json();
            if (!/^audio\//i.test(response.headers.get('content-type') || '')) throw new Error('语音服务没有返回音频，请检查服务地址');
            const blob = await response.blob();
            if (!blob.size || blob.size > 8 * 1024 * 1024) throw new Error('语音文件为空或过大');
            assertActive(signal); return blob;
        } catch (error) {
            assertActive(signal);
            if (controller.signal.aborted) throw new Error('语音生成超时，可手动重试');
            if (error instanceof TypeError) throw new Error('无法连接语音服务，请启动本机服务并检查微信设置中的服务地址');
            throw error;
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    async function durationOf(blob) {
        const context = new (window.AudioContext || window.webkitAudioContext)();
        try {
            const decoded = await context.decodeAudioData(await blob.arrayBuffer());
            if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error('音频时长无效');
            return decoded.duration;
        } finally { await context.close(); }
    }
    function createLibrary(storage) {
        let writes = Promise.resolve();
        const serial = fn => { const p = writes.then(fn); writes = p.catch(() => {}); return p; };
        const index = async () => (await storage.getStoredValue('wechat_voice_index')) || [];
        const read = async (id, scopeId) => {
            const found = (await index()).find(item => item.id === id && item.scopeId === scopeId);
            if (!found) throw new Error('当前会话没有这条语音资源');
            const blob = await storage.getStoredValue(`wechat_voice_blob_${id}`);
            if (!(blob instanceof Blob) || !blob.size) throw new Error('语音文件已丢失');
            return blob;
        };
        const save = (blob, info, signal) => serial(async () => {
            assertActive(signal);
            const item = { ...info, id: `voice-${crypto.randomUUID()}`, bytes: blob.size, createdAt: Date.now() };
            try {
                await storage.setStoredValue(`wechat_voice_blob_${item.id}`, blob, { clone: false });
                assertActive(signal);
                await storage.setStoredValue('wechat_voice_index', [...await index(), item]);
                return item;
            } catch (error) { await storage.deleteStoredValue(`wechat_voice_blob_${item.id}`).catch(() => {}); throw error; }
        });
        const purgeOwner = ownerId => serial(async () => {
            const items = await index();
            for (const item of items.filter(item => item.ownerId === ownerId)) await storage.deleteStoredValue(`wechat_voice_blob_${item.id}`);
            await storage.setStoredValue('wechat_voice_index', items.filter(item => item.ownerId !== ownerId));
        });
        return { read, save, purgeOwner };
    }
    window.RPHubWeChatVoice = Object.freeze({ normalizeIntent, validateBatch, recordText, buildPrompt, serviceBase, request, durationOf, createLibrary });
})();
