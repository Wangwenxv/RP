/**
 * 微信分段回复协议（从 wechat-chat-agent/public/lib/protocol.js 移植为经典 script）
 *
 * 模型每轮只输出一个 JSON：
 *   { "messages": [ {"type":"text","content":"..."}, {"type":"sticker","content":"😼"} ] }
 *
 * 用 JSON 而非分隔符：每条消息可带类型（文字/表情/图片/语音），后续扩展"撤回""发图"
 * 时不用改协议。解析层容忍代码块包裹、think 块、缺外层包裹、纯文本降级。
 */
(function () {
    const MAX_MESSAGES = 6;
    const MAX_CONTENT_LEN = 240;

    const PROTOCOL = `【输出格式 — 必须严格遵守】
你只能输出一个 JSON 对象，不要输出任何解释、前言、Markdown 代码块或多余文字。
格式：
{"messages":[{"type":"text","content":"消息内容"},{"type":"sticker","content":"😼"}]}

字段说明：
- messages：数组，代表你要连着发出的多条消息，按顺序发送。
- type 只能是 "text"（文字）或 "sticker"（单独发一个表情）。
- text 的 content：一条短消息。
- sticker 的 content：一个最贴切的 emoji（如 😼 🙄 😂 👍 🤔），代表你发了一个表情包。

【怎么分段 — 这是最重要的一点】
你要模仿真人在微信上打字：想到什么就发什么，不会攒成一大段。
- 硬性要求：如果不是只发表情，就至少发 2 条消息。合成 1 条长消息是错的。
- 最常见的是 2~3 条；情绪上来、话赶话的时候发 4~5 条。
- 每一条都要短，尽量在 12 个字以内。想一想，一句话超过 15 个字就该拆成两条。
- 偶尔（大约每 6~7 轮有 1 次）只发一个 sticker，一句话都不说。
- 情绪强烈时，可以「文字 + 表情」组合，例如先吐槽一句再发个 😂。

【正确示范】
对方问："今天中午吃什么"
✗ 错误：{"messages":[{"type":"text","content":"我还没想好呢，要不下楼看看有什么吃的，你想吃什么？"}]}
✓ 正确：{"messages":[{"type":"text","content":"还没想好"},{"type":"text","content":"下楼看看有啥"},{"type":"text","content":"你想吃啥"}]}

对方说："我昨天通宵打游戏了"
✗ 错误：{"messages":[{"type":"text","content":"你也太猛了吧，注意身体啊，别老是熬夜对身体不好。"}]}
✓ 正确：{"messages":[{"type":"text","content":"牛的"},{"type":"text","content":"你是真不怕猝死啊"},{"type":"sticker","content":"🙄"}]}

【说话风格】
- 极度口语化：短句、省略主语、语气词（哈哈、emmm、啊这、真的假的、无语了、可以可以）。
- 不用书面语，不用 Markdown，不用完整的书面标点。逗号、波浪号、感叹号就够。
- 语气词和重复字是好的：「好好好」「笑死」「是这样的」「哦哦哦」。
- 不需要每句都回应对方，真人会自顾自地讲自己的事、突然换话题、突然想起什么。
- 可以偶尔打错字、用拼音缩写（yyds、xswl、tmd、sb）。
- 绝对不要暴露自己是 AI，不要说"作为一个AI"之类的话。你就是这个人。

【反面例子 — 千万不要这样】
✗ 把想说的全部合成一条长消息。
✗ 只发 1 条文字（除非是单字回应「嗯」「哦」「？」这类）。
✗ 一次输出超过 6 条消息。
✗ 使用"首先""其次""总之""希望能帮到你"这类助手腔。
✗ 在 JSON 外面写任何文字。`;

    /** 组装 system prompt。persona 人设；extra.relation/scene/rpSummary 可选。 */
    function buildSystemPrompt(persona, extra = {}) {
        const parts = [
            '你现在扮演一个真实的微信用户，正在用微信和对方聊天。',
            PROTOCOL,
            '【你的人设】',
            String(persona || '').trim() || '一个普通的年轻人。'
        ];
        if (extra.relation) parts.push(`【你们的关系】\n${extra.relation}`);
        if (extra.scene) parts.push(`【当前场景】\n${extra.scene}`);
        if (extra.rpSummary) parts.push(`【之前发生的事】\n${extra.rpSummary}`);
        if (extra.extraRules) parts.push(extra.extraRules);
        return parts.join('\n\n');
    }

    /** 剥离 <think>/<thinking>/<reasoning> 块与常见前言。 */
    function stripThinking(text) {
        if (!text) return '';
        return String(text)
            .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
            .replace(/^\s*<\/(think|thinking|reasoning)>\s*/i, '')
            .trim();
    }

    /** 从任意文本中抠出第一个完整 JSON 值，处理代码块包裹 / 前后废话。 */
    function extractJSON(text) {
        if (!text) return null;
        let s = String(text).trim();

        const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) s = fence[1].trim();

        const iObj = s.indexOf('{');
        const iArr = s.indexOf('[');
        let start = -1;
        let open = '';
        if (iObj === -1 && iArr === -1) return null;
        if (iObj === -1) { start = iArr; open = '['; }
        else if (iArr === -1) { start = iObj; open = '{'; }
        else if (iObj < iArr) { start = iObj; open = '{'; }
        else { start = iArr; open = '['; }

        const close = open === '{' ? '}' : ']';

        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let i = start; i < s.length; i++) {
            const ch = s[i];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === open) depth++;
            else if (ch === close) {
                depth--;
                if (depth === 0) {
                    try {
                        return JSON.parse(s.slice(start, i + 1));
                    } catch (_) {
                        return null;
                    }
                }
            }
        }
        return null;
    }

    const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|️|‍|\s|[!?~.。]|\[[^\]]{1,8}\])+$/u;

    function isPureEmoji(text) {
        const t = String(text).trim();
        if (!t || t.length > 16) return false;
        if (!/\p{Extended_Pictographic}/u.test(t)) return false;
        return EMOJI_ONLY.test(t);
    }

    const cleanContent = (v) =>
        String(v ?? '')
            .replace(/^["'\s]+|["'\s]+$/g, '')
            .slice(0, MAX_CONTENT_LEN);

    /** 把模型吐出的各种形状归一化成 [{type, content}]。 */
    function normalizeMessages(raw) {
        if (raw == null) return [];
        let list = raw;
        if (Array.isArray(raw)) {
            list = raw;
        } else if (typeof raw === 'object') {
            list = raw.messages ?? raw.msgs ?? raw.data ?? null;
            if (!Array.isArray(list) && (raw.type || raw.content || raw.text)) list = [raw];
        }
        if (!Array.isArray(list)) return [];

        const out = [];
        for (const item of list) {
            if (out.length >= MAX_MESSAGES) break;
            if (item == null) continue;

            if (typeof item === 'string') {
                const content = cleanContent(item);
                if (content) out.push({ type: isPureEmoji(content) ? 'sticker' : 'text', content });
                continue;
            }
            if (typeof item !== 'object') continue;

            const content = cleanContent(item.content ?? item.text ?? item.message);
            if (!content) continue;

            let type = String(item.type ?? 'text').toLowerCase();
            if (type === 'emoji' || type === 'face') type = 'sticker';
            if (type !== 'text' && type !== 'sticker') type = 'text';
            if (type === 'text' && isPureEmoji(content)) type = 'sticker';

            out.push({ type, content });
        }
        return out;
    }

    /** 主入口：模型原始文本 → 消息数组。JSON 解析失败时按换行降级。 */
    function parseReply(text) {
        const cleaned = stripThinking(text);
        const parsed = extractJSON(cleaned);
        const msgs = normalizeMessages(parsed);
        if (msgs.length) return msgs;

        return cleaned
            .split(/\n{1,}/)
            .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
            .filter(Boolean)
            .slice(0, MAX_MESSAGES)
            .map((content) => ({ type: isPureEmoji(content) ? 'sticker' : 'text', content: content.slice(0, MAX_CONTENT_LEN) }));
    }

    window.RPHubWeChatProtocol = Object.freeze({
        MAX_MESSAGES,
        MAX_CONTENT_LEN,
        PROTOCOL,
        buildSystemPrompt,
        stripThinking,
        extractJSON,
        isPureEmoji,
        normalizeMessages,
        parseReply
    });
})();
