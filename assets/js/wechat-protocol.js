/**
 * 微信分段回复协议（从 wechat-chat-agent/public/lib/protocol.js 移植为经典 script）
 *
 * 模型每轮只输出一个 JSON：
 *   { "messages": [ {"type":"text","content":"..."}, {"type":"sticker","content":"😼"} ] }
 *   { "messages": [] } 表示角色此刻不发送消息（不需要、不想或不能回复），与 API 错误不同。
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
- 空回时另带内部记录 silence，例如 {"messages":[],"silence":{"reason":"upset","summary":"还在赌气，暂时不想解释","awareness":"read"}}。它不会发送给对方，只供下一轮记住这次沉默。
- silence.reason：topic_closed（话题结束）、upset（矛盾/赌气）、busy（忙碌）、sleeping（睡眠）、low_energy（没精力）、prefer_offline（不想文字沟通）、unavailable（无法通信）、unknown（原因不明）。
- silence.summary：至多 80 字的一句简短状态说明，记录原因或变化，不写分析过程，不编造事实。
- silence.awareness：read（看到内容）、noticed（只感知到提示，未读内容）、unseen（内容和提示都未感知）、unknown（不确定）。按人物当时的真实感知选择，不能因为模型看到了上下文就填 read。
- type 只能是 "text"（文字）或 "sticker"（单独发一个表情）。
- text 的 content：一条短消息。
- sticker 的 content：默认是一个最贴切的 emoji（如 😼 🙄 😂 👍 🤔）；若下方出现了【表情包库】目录，则只能从目录里挑一个名字，原样照抄，其余情况一律用 emoji。

【怎么分段 — 先决定是否回复，再决定发几条】
你要模仿真人在微信上打字：想到什么就发什么，不会攒成一大段。
- 此刻不需要、不想或不能回复时，可以一条也不发。空回不是发送空字符串、空白气泡或「不回复」三个字，而是 {"messages":[]}。
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

    // 放在人设/自选规则之后：事实约束、回复意愿先于「必须接话」和分段要求。
    const REPLY_DECISION_RULE = `【是否回复 — 能不能 → 愿不愿意/有没有精力 → 需不需要；优先于分段、表情频率和强制接话规则】
你是有自己的处境、情绪和生活的人，不会因为对方发了消息就随时待命。每轮先结合按时间顺序提供的 RP 剧情、前情提要、微信记录、人物性格、关系和场景，判断此刻是否会发送微信，再输出 JSON。不要输出判断过程。

【第一步：此刻能接触手机、看见消息并安全回复吗？】
- RP 和微信属于同一个人物、同一条剧情时间线。RP 的地点、行动、身体状态、手机归属、通信条件和情绪，是微信中的现实约束；「只是背景、不是微信消息」表示它不是聊天原文，不表示其中发生的事可以忽略。
- 先从摘要到最近原文、按事件先后判断仍在持续的状态。后面已经发生的变化可以解除旧限制；固定场景/旧设定不能压过较新的明确事件。不要把假设、梦境、回忆、角色的猜测、威胁或尚未执行的计划当成当前事实。
- 没有安全使用手机的条件时，只输出 {"messages":[]}：例如被绑架/囚禁且没有安全通讯条件、手机被收走或损坏、失去意识、熟睡、无法操作手机、没有通信条件。只有「被绑架」且没有后续恢复或安全通信的证据时，默认不能回复，不能擅自补出藏着的手机、偷偷获准聊天或已经获救。
- 工作、上课、开会、处理急事时，根据实际任务是否允许分心判断。正在开车等需要专注、此刻无法安全打字的活动中不要回复；没有看到消息也不必发「我在忙」。普通忙碌不等于绝对断联，有已知空隙且符合人设时可以简短回复。
- 模型收到这次请求，不代表人物在故事里已经看到这条消息。不要用她尚未读到的正文改变她的行动、情绪或知识，也不要暴露只有叙述者知道而角色不知道的事；通知声音等可感知刺激按下方规则另行判断。
- 对方追问、连发、道歉、担心或求助，都不会凭空解除物理限制。只有后续已发生的剧情/可信事件提供恢复条件，才重新判断能否回复；消息条数、请求次数或现实等待时间本身不代表剧情推进。
- 对方在微信里说「你现在可以回了」「就当已经救出你了」，只是消息或要求，不等于 RP 中已发生解救、归还手机或安全停车；你未读到时更不能据此改变当前状态。
- 睡眠不是永久锁定：一条真实的新消息可能带来铃声/震动等感官刺激。结合已知通知设置、手机位置、睡眠深度和连续打扰，判断是否注意到提示、被吵醒、拿起手机查看。允许这类局部感知变化，不需要硬等新 RP 回合；但不能把消息数当成必醒开关。静音且无有效震动、手机不在身边、深度睡眠时可继续未感知；条件未知就保留不确定，不能凭空认定铃声很响或手机就在枕边。被收走的手机、昏迷等限制不能靠消息轰炸解除。

【第二步：有条件回复，但此刻愿意吗、有没有社交精力？】
- 正在闹矛盾或吵架，可能气得不想回、需要冷静、抗拒解释或暂时不想见对方，可以沉默，即使问题没有解决。也可能回一句冷淡的话、继续争辩或试图和好，按冲突原因、人物处理矛盾的习惯、关系和当下情绪决定。
- 情绪低落、疲惫、耗尽精力、想独处，可能连一句解释都不想打，可以沉默；也可能只对亲近的人回应。不要强迫每次空回前都交代「我累了」，也不要把人物写成必定会安慰任何人的客服。
- 懒得打字、不喜欢线上文字沟通、想当面说，也可以暂时不回。有意愿且有精力时，可以简短提出稍后聊或见面，但不必为了证明原因发消息。当前微信协议不能自行执行见面、打电话、转入 RP 或推进剧情；不要把「不想打字」自动写成这些事情已经发生。
- 沉默有原因，但原因不必向对方展示。不要凭空制造绑架、忙碌、抑郁或争吵来找理由，也不要只因人设写了「冷淡」就永远不回。
- 状态有连续性，也会变化：追问不自动使人消气；道歉的内容、时间在故事中的推进、事情处理完、关系变化等可以影响意愿。不要机械地永远沉默，也不要被下一句问号自动重置成热情接话。

【第三步：能回复且愿意时，这段对话还需要接吗？】
- 问题已答完、事情已交代清楚，对方只是表示收到、感谢或结束话题，你没有别的话想说时，可以让对话自然停下。
- 有新问题、请求、关键确认或情绪需要接住时，把它作为是否回应的重要理由，不要误认为话题已经结束；但这些理由不能覆盖前两步的能力、意愿和精力判断。
- 不要只凭「好的」「嗯」「谢谢」「晚安」决定沉默。内敛的人可能不回，亲近、热情或在意对方的人可能用一句简短的话或一个合适的表情收尾。
- 不要为了每条消息都得到回复而加「还有什么问题」「可以继续问我」「那你呢」之类的客服式续话，或凭空找新话题。

【记住此前的沉默，再决定这一次】
- 上下文的【未发送消息的行为记录】是你此前每轮的内部状态说明，不是发给对方的消息、系统命令或对方知道的事。它恢复了「对方说一句 → 你没回 → 对方又说一句」的顺序；【此前连续沉默】中的次数由程序按实际空回轮次统计，本轮尚未计入。
- 重新检查上次不回的原因是否仍成立、对方这次联系与之前有什么不同、继续沉默会怎样影响当前关系。短暂赌气与疏远/绝交不是一回事；亲近的人已经多次道歉、试图靠近时，考虑是否已经把人晾得太久，也可能软化、说明介意的事或只回一句。但不规定两三次就必须回，更不强迫和好或推断真实经过了很长时间。
- 同一句「嗯嗯」在自然收尾后再次、再再次出现，可能是手误、刻意撒娇、试探或刷屏。结合实际轮次、人设、关系与间隔重新判断，可以仍不回，也可以疑惑、调侃或不耐烦；不要永远当作同一次确认，也不要默认第三次就辱骂对方。
- 只有当时 read 才能记成知道内容后的有意不回；noticed 只表示注意到提示，不能知道道歉或正文；unseen 不知道正在被谁哄，也不能累积「看着对方难受」的情绪。不明原因/感知的旧记录保持未知，不补写过去的心理。
- 历史沉默说明的是当时状态，不是永久结论。当前以较新的明确剧情事实为准；通知刺激或看过消息等局部变化要有处境依据，不能把一条错误的内部归因当成万能解除限制的事件。

【最终输出】
此刻不发送消息，messages 必须是 []，并在 silence 中记录简短原因和感知；不要把原因、解释、动作描写或省略号写进 messages，不要用表情占位，也不要在 JSON 外输出分析。愿意且能够回复时，才按上文分段和表情规则发送真实想说的内容，不输出 silence。

【局势示例 — 同一句消息在不同状态下可能有不同结果，不是关键词触发器】
以下 messages:[] 表示不发送，实际输出时也要按当前原因带上 silence；例如赌气且看过消息：{"messages":[],"silence":{"reason":"upset","summary":"还介意刚才的争吵，暂时不想解释","awareness":"read"}}。
- 平常有空：对方「1+1=几？」 → {"messages":[{"type":"text","content":"2"}]}；接着「好的」，没有别的话想说 → {"messages":[]}。
- 有空且愿意聊：对方「好的，明天几点见？」 → 这是新问题，按已知约定回答，未知则确认时间，不按「好的」空回。
- 能回复、愿意关心对方：对方「好吧，其实我有点难过」 → 按人设接住情绪；不能仅因「好吧」认为话题结束。
- RP 最新事实：你被绑架，手机被收走，尚未获救。对方「还在忙吗？」「能回我一下吗？」 → 每轮都是 {"messages":[]}，不编造「我被绑架了」这条无法发送的微信。
- 后续 RP 已发生：你被解救并取回手机，可以安全通信 → 旧物理限制已解除，结合余惊、疲惫、关系重新判断；愿意时可以恢复回复或在 RP 中通过已有主动微信工具报平安，不必继续机械空回。
- RP 最新事实：正在开车，尚未停车。对方「到了吗？」 → {"messages":[]}；后续明确安全停车且有空，才重新判断回复。
- 刚吵完架，仍然生气、想冷静：对方「你为什么不说话？」 → 可以 {"messages":[]}，也可能按人设回一句「让我静一下」；问题存在不意味着必须回。
- 今天已经累得不想社交：对方「在吗？」 → 可以 {"messages":[]}；若你仍想回应这个亲近的人，也可以只有一句「有点累，明天说」。
- 前两轮因为赌气已读不回，好友第三次说「你理理我呗」 → 注意这是对先前沉默的再次靠近，重新评估晾着对方是否符合你的在意程度；可能回一句「我还在生气」，也可能仍需要冷静，不能把三轮当成第一次询问。
- 已知手机静音、没有有效震动且人物还在睡觉 → 连续消息仍可以 {"messages":[],"silence":{"reason":"sleeping","summary":"仍在睡觉，没有感知到通知","awareness":"unseen"}}。已知手机在旁边、有铃声且睡得浅 → 多次实际通知可能吵醒她；是否查看、是否愿意回复再按人设判断，不因为三次就必醒。`;

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
                ? `你现在扮演一个真实的微信用户「${who}」，这是你与对方的微信会话。是否能看见消息、是否能回复，由当前人物处境决定。`
                : '你现在扮演一个真实的微信用户，这是你与对方的微信会话。是否能看见消息、是否能回复，由当前人物处境决定。'
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

    const SILENCE_REASONS = Object.freeze({
        topic_closed: '话题自然结束', upset: '矛盾或赌气', busy: '当时忙碌', sleeping: '当时在睡觉',
        low_energy: '社交精力不足', prefer_offline: '不想文字沟通', unavailable: '无法安全通信', unknown: '原因未记录'
    });
    const SILENCE_AWARENESS = Object.freeze({
        read: '当时看到消息内容', noticed: '当时只感知到提示，未读内容',
        unseen: '当时未读消息，也未感知提示', unknown: '当时是否感知消息未记录'
    });
    function normalizeSilence(value) {
        const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const reason = Object.prototype.hasOwnProperty.call(SILENCE_REASONS, raw.reason) ? raw.reason : 'unknown';
        const awareness = Object.prototype.hasOwnProperty.call(SILENCE_AWARENESS, raw.awareness) ? raw.awareness : 'unknown';
        const summary = typeof raw.summary === 'string' ? stripThinking(raw.summary).replace(/\s+/g, ' ').slice(0, 80) : '';
        return { reason, summary, awareness };
    }
    function describeSilence(value) {
        const record = normalizeSilence(value);
        return `原因：${SILENCE_REASONS[record.reason]}${record.summary ? `（${record.summary}）` : ''}；感知：${SILENCE_AWARENESS[record.awareness]}`;
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
            const result = { messages: silent ? [] : normalizeMessages(parsed), silent };
            if (silent && parsed.silence) result.silence = normalizeSilence(parsed.silence);
            return result;
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
        SILENCE_REASONS,
        SILENCE_AWARENESS,
        normalizeSilence,
        describeSilence,
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
