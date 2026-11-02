/**
 * 微信分段回复协议（从 wechat-chat-agent/public/lib/protocol.js 移植为经典 script）
 *
 * 模型每轮只输出一个 JSON：
 *   { "messages": [ {"type":"text","content":"..."}, {"type":"sticker","content":"😼"} ] }
 *   { "messages": [] } 表示角色主动选择不回复，与 API 空内容/协议错误不同。
 *
 * 用 JSON 而非分隔符：每条消息可带类型（文字/表情/图片/语音），后续扩展"撤回""发图"
 * 时不用改协议。解析层容忍代码块包裹、think 块、缺外层包裹、纯文本降级。
 *
 * sticker 的 content 是「库里的名字」（如「伤心猫」），不再是 emoji 字符——但协议层
 * 不校验、不解释 content，只保证 type 为 "sticker"。名字是否命中库、渲染成图还是回退
 * 文本，都归 25-wechat.js / 前端管（见 docs/ARCHITECTURE.md §9）。
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
- messages：数组，代表你要连着发出的多条消息，按顺序发送。决定不回复时输出 {"messages":[]}。
- type 只能是 "text"（文字）或 "sticker"（单独发一个表情）。
- text 的 content：一条短消息。
- sticker 的 content：默认是一个最贴切的 emoji（如 😼 🙄 😂 👍 🤔）；若下方出现了【表情包库】目录，则只能从目录里挑一个名字，原样照抄，其余情况一律用 emoji。

【怎么分段 — 先决定是否回复，再决定发几条】
你要模仿真人在微信上打字：想到什么就发什么，不会攒成一大段。
- 话题已经自然结束、没有需要回应的内容时，可以一条也不发。空回不是发送空字符串、空白气泡或「不回复」三个字，而是 {"messages":[]}。
- 需要回复时，通常发 1~3 条短消息，每条尽量在 12 个字以内；较长的话可以按语意拆开，不要拆碎一个简单答案。
- 一条完整的回答、确认、道别或情绪反应，可以只发 1 条文字或 1 个表情，不要为凑条数加话。
- 情绪上来、话赶话的时候发 4~5 条。
- 例外——偶尔会写小作文：对方问的事需要认真回应，或者你在解释、交代、翻旧账、情绪上来的时候，可以发一条很长的消息（几十到几百字）。按真实需要决定是否还有其他消息，不要滥用。
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
✗ 话已经说完，还为了凑消息补一句、反问或强行引申话题。
✗ 一次输出超过 6 条消息。
✗ 使用"首先""其次""总之""希望能帮到你"这类助手腔。
✗ 在 JSON 外面写任何文字。`;

    // 放在人设/自选规则之后：避免「必须接话」「至少两条」一类旧规则覆盖收尾能力。
    const REPLY_DECISION_RULE = `【是否回复 — 先按人物和完整局势判断，优先于分段、表情频率和要求继续聊天的规则】
你有选择不回复的能力。每轮先结合完整聊天上下文、你的人物性格、与对方的关系、当前场景和情绪，判断这时的你是否真有话想说，再输出 JSON。判断过程不要输出。
- 问题已答完、事情已交代清楚，对方只是表示收到、感谢或结束话题，而且没有新的问题、请求、需要接住的情绪或未完成的约定时，可以让对话自然停下，输出 {"messages":[]}。
- 不要为了每条消息都得到回复而加「还有什么问题」「可以继续问我」「那你呢」之类的客服式续话；不要在结束后凭空找新话题。
- 不要只凭「好的」「嗯」「谢谢」「晚安」这些词决定沉默。内敛的人可能不回，亲近、热情或在意对方的人可能用一句简短的话或一个合适的表情收尾。若你确有想继续说的事，也可以自然接话；不必每轮沉默，也不必每轮道别。
- 对方仍在提问、提出明确请求、等待关键确认，或表达需要回应的情绪（如受委屈、担心、生气、求助），不要把它误判成话题结束。按人物性格接住它，不要用空回逃避尚未解决的事。
- 真正不回复时只输出 {"messages":[]}，不要输出省略号、空字符串、「已读不回」、动作描写、原因或解释，也不要用一个表情占位。

【局势示例 — 不是关键词触发器】
对方：1+1=几？ → 你：{"messages":[{"type":"text","content":"2"}]}
接着对方：好的 → 问题已解决，你没有别的话想说：{"messages":[]}
接着对方：好的，明天几点见？ → 还有新问题，按已知约定回答，未知则确认时间，不能空回。
对方：好吧，其实我有点难过 → 需要接住情绪，按你的人设回应，不能因为「好吧」就空回。`;

    /**
     * 组装 system prompt。
     * RP 相关的上下文（长期记忆、近况摘要）一律排在最后：越靠近生成位置，模型越当回事，
     * 而协议/人设/世界设定这些静态前提放在前面。
     * @param {string} persona 人设文本（通常是完整角色卡）
     * @param {{characterName?:string, presetRules?:string, worldInfo?:string, userInfo?:string, relation?:string, scene?:string, memory?:string, rpSummary?:string, stickerRule?:string, stickerCatalog?:string, extraRules?:string}} [extra]
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
        // 表情包库目录紧跟在频率策略之后：PROTOCOL 里说的「下方【表情包库】」指的就是它。
        if (extra.stickerCatalog) parts.push(String(extra.stickerCatalog).trim());
        parts.push('【你的人设】', String(persona || '').trim() || '一个普通的年轻人。');
        // 世界书设定：与 RP 侧同源的 [条目名] + 正文，让微信侧的称呼/设定和 RP 对齐。
        if (extra.worldInfo) parts.push(`【世界设定】\n${String(extra.worldInfo).trim()}`);
        // 对方（用户）是谁，与 RP 侧一致，避免模型对聊天对象一无所知。
        if (extra.userInfo) parts.push(`【对方信息】\n${extra.userInfo}`);
        if (extra.relation) parts.push(`【你们的关系】\n${extra.relation}`);
        if (extra.scene) parts.push(`【当前场景】\n${extra.scene}`);
        if (extra.extraRules) parts.push(extra.extraRules);
        parts.push(REPLY_DECISION_RULE);
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

    /**
     * 纯 emoji 判定：模型把表情当成 text 发时，据此升级成 sticker 气泡。
     * 表情包库的「名字」是中文（Han 不属于 Extended_Pictographic），不会被误升级。
     */
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

    /**
     * 模型原始文本 → { messages, silent }。
     * 只有明确的 messages: [] 才算主动空回；API 空内容、无效/截断 JSON 不能冒充沉默。
     * 纯文本保留历史降级能力，但已解析出的 JSON 绝不作为聊天正文展示。
     */
    function parseReplyResult(text) {
        const cleaned = stripThinking(text);
        const parsed = extractJSON(cleaned);
        if (parsed !== null) {
            const silent = !Array.isArray(parsed) && typeof parsed === 'object'
                && Array.isArray(parsed.messages) && parsed.messages.length === 0;
            return { messages: silent ? [] : normalizeMessages(parsed), silent };
        }

        const unfenced = cleaned.replace(/^```(?:json)?\s*/i, '').trim();
        if (/^[{\[]/.test(unfenced)
            || /[\{\[]\s*"(?:messages|msgs|data|type|content|text)"\s*:/.test(unfenced)) {
            return { messages: [], silent: false };
        }

        const messages = cleaned
            .split(/\n{1,}/)
            .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
            .filter(Boolean)
            .slice(0, MAX_MESSAGES)
            .map((content) => ({ type: isPureEmoji(content) ? 'sticker' : 'text', content: content.slice(0, MAX_CONTENT_LEN) }));
        return { messages, silent: false };
    }

    /** 兼容既有调用方（包括 RP 主动微信工具）：仍然只返回消息数组。 */
    function parseReply(text) {
        return parseReplyResult(text).messages;
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
        off: '【表情包策略 — 决定回复时适用】这轮聊天不要发表情包，不要输出 type 为 "sticker" 的消息，只用文字；决定不回复时仍输出 {"messages":[]}。',
        low: '【表情包策略 — 决定回复时适用】表情包要克制：绝大多数回复只发文字，大约每 4~5 轮才带一个 sticker；确实适合用表情收尾时也可以只发一个。不要为了频率凑消息。',
        normal: '【表情包策略 — 决定回复时适用】表情包按需使用：大约每 2~3 轮在文字后面跟一个 sticker，偶尔可以整条只发一个表情；决定不回复时不要用表情占位。',
        high: '【表情包策略 — 决定回复时适用】表情包可以多用：情绪到位就带一个 sticker，也可以整条只发一个表情；决定不回复时不要用表情占位。'
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
        REPLY_DECISION_RULE,
        DEFAULT_STICKER_TIER,
        STICKER_TIERS,
        buildSystemPrompt,
        stripThinking,
        extractJSON,
        normalizeMessages,
        parseReply,
        parseReplyResult,
        normalizeStickerTier,
        stickerRuleFor,
        applyStickerPolicy
    });
})();
