/**
 * 微信分段回复协议（从 wechat-chat-agent/public/lib/protocol.js 移植为经典 script）
 *
 * 模型每轮只输出一个 JSON：
 *   { "messages": [ {"type":"text","content":"..."}, {"type":"sticker","content":"😼"} ] }
 *
 * 用 JSON 而非分隔符：每条消息可带类型（文字/表情/图片/语音），后续扩展"撤回""发图"
 * 时不用改协议。解析层容忍代码块包裹、think 块、缺外层包裹、纯文本降级。
 *
 * 表情包频率不靠模型自觉：档位同时作用于提示词（stickerRuleFor）和生成后的硬裁剪
 * （applyStickerPolicy），两者共用同一组 STICKER_TIERS。
 */
(function () {
    const MAX_MESSAGES = 6;
    // 单条上限要留得下「小作文」：真人偶尔会一口气发一大段，
    // 截得太短会把长消息拦腰砍断，比不发还假。
    const MAX_CONTENT_LEN = 400;

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
- 默认是短消息：一轮 2~3 条，每条尽量在 12 个字以内；一句话超过 15 个字就该拆成两条。
- 硬性要求：如果不是只发表情，就至少发 2 条消息。把想说的合成 1 条长消息是错的。
- 情绪上来、话赶话的时候发 4~5 条。
- 例外——偶尔会写小作文：对方问的事需要认真回应，或者你在解释、交代、翻旧账、情绪上来的时候，可以发一条很长的消息（几十到几百字）。这种时候长消息一般是连发几条里夹着的一条，不是孤零零甩出去一段。十几轮里大概才一次，不要滥用。
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

    /**
     * 组装 system prompt。
     * RP 相关的上下文（长期记忆、近况摘要）一律排在最后：越靠近生成位置，模型越当回事，
     * 而协议/人设/世界设定这些静态前提放在前面。
     * @param {string} persona 人设文本（通常是完整角色卡）
     * @param {{characterName?:string, presetRules?:string, worldInfo?:string, userInfo?:string, relation?:string, scene?:string, memory?:string, rpSummary?:string, stickerRule?:string, extraRules?:string}} [extra]
     */
    function buildSystemPrompt(persona, extra = {}) {
        const who = String(extra.characterName || '').trim();
        const parts = [
            who
                ? `你现在扮演一个真实的微信用户「${who}」，正在用微信和对方聊天。`
                : '你现在扮演一个真实的微信用户，正在用微信和对方聊天。'
        ];
        // 预设规则（破限、人格内核…）排在最前：它们是"你是什么状态"的前提，先于格式契约。
        if (extra.presetRules) parts.push(`【预设规则】\n${String(extra.presetRules).trim()}`);
        parts.push(PROTOCOL);
        if (extra.stickerRule) parts.push(String(extra.stickerRule).trim());
        parts.push('【你的人设】', String(persona || '').trim() || '一个普通的年轻人。');
        // 世界书设定：与 RP 侧同源的 [条目名] + 正文，让微信侧的称呼/设定和 RP 对齐。
        if (extra.worldInfo) parts.push(`【世界设定】\n${String(extra.worldInfo).trim()}`);
        // 对方（用户）是谁，与 RP 侧一致，避免模型对聊天对象一无所知。
        if (extra.userInfo) parts.push(`【对方信息】\n${extra.userInfo}`);
        if (extra.relation) parts.push(`【你们的关系】\n${extra.relation}`);
        if (extra.scene) parts.push(`【当前场景】\n${extra.scene}`);
        if (extra.extraRules) parts.push(extra.extraRules);
        // 前情提要：用户手动压缩出的旧剧情概要，覆盖范围比逐轮记忆更早。
        if (extra.storyRecap) parts.push(`【前情提要】\n${String(extra.storyRecap).trim()}`);
        // 长期记忆：RP 侧压缩出来的历轮总结，补上「摘要只覆盖最近几轮」之外的旧账。
        if (extra.memory) parts.push(`【长期记忆】\n${String(extra.memory).trim()}`);
        if (extra.rpSummary) parts.push(`【之前发生的事】\n${extra.rpSummary}`);
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

    /**
     * 表情包档位：keep = 单个 sticker 的保留概率，max = 每轮最多留下几个。
     * keep 与 max 一起用，模型偶尔无视提示词刷表情时仍能被硬裁掉。
     */
    const DEFAULT_STICKER_TIER = 'low';
    const STICKER_TIERS = Object.freeze({
        off: Object.freeze({ keep: 0, max: 0 }),
        low: Object.freeze({ keep: 0.35, max: 1 }),
        normal: Object.freeze({ keep: 0.7, max: 2 }),
        high: Object.freeze({ keep: 1, max: 3 })
    });

    function normalizeStickerTier(tier) {
        return Object.prototype.hasOwnProperty.call(STICKER_TIERS, tier) ? tier : DEFAULT_STICKER_TIER;
    }

    /** 档位对应的提示词片段，措辞上明确压过 PROTOCOL 里的默认频率描述。 */
    const STICKER_RULES = Object.freeze({
        off: '【表情包策略 — 优先级高于上文】这轮聊天不要发表情包，不要输出 type 为 "sticker" 的消息，只用文字。',
        low: '【表情包策略 — 优先级高于上文】表情包要克制：绝大多数轮次只发文字，大约每 4~5 轮才在文字后面跟一个 sticker，不要整条只发一个表情。',
        normal: '【表情包策略 — 优先级高于上文】表情包按需使用：大约每 2~3 轮在文字后面跟一个 sticker，偶尔可以整条只发一个表情。',
        high: '【表情包策略 — 优先级高于上文】表情包可以多用：情绪到位就带一个 sticker，也可以整条只发一个表情。'
    });

    function stickerRuleFor(tier) {
        return STICKER_RULES[normalizeStickerTier(tier)];
    }

    /**
     * 按档位裁剪 sticker：先逐条按保留概率抽掉，再套每轮上限。
     * 整轮被裁空时保留第一条 sticker —— 宁可偶尔多发一个表情，也不要让这轮回复变成空白。
     * @param {Array<{type:string, content:string}>} messages parseReply 的输出
     * @param {string} tier
     * @param {{random?:() => number}} [options]
     */
    function applyStickerPolicy(messages, tier, options = {}) {
        const list = Array.isArray(messages) ? messages : [];
        const random = typeof options.random === 'function' ? options.random : Math.random;
        const { keep, max } = STICKER_TIERS[normalizeStickerTier(tier)];
        const out = [];
        let kept = 0;
        for (const message of list) {
            if (message?.type !== 'sticker') {
                out.push(message);
                continue;
            }
            if (kept >= max) continue;
            if (keep <= 0) continue;
            if (keep < 1 && random() >= keep) continue;
            kept++;
            out.push(message);
        }
        if (out.length === 0 && list.some((message) => message?.type === 'sticker')) {
            return [list.find((message) => message?.type === 'sticker')];
        }
        return out;
    }

    window.RPHubWeChatProtocol = Object.freeze({
        MAX_MESSAGES,
        MAX_CONTENT_LEN,
        PROTOCOL,
        DEFAULT_STICKER_TIER,
        STICKER_TIERS,
        buildSystemPrompt,
        stripThinking,
        extractJSON,
        isPureEmoji,
        normalizeMessages,
        parseReply,
        normalizeStickerTier,
        stickerRuleFor,
        applyStickerPolicy
    });
})();
