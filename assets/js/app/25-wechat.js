/**
 * RP-Hub 应用模块 25 · 微信聊天子系统
 *
 * 目标：角色扮演（RP）↔ 拟真微信 双场景互通，共享角色记忆，按统一时间线无缝衔接。
 *
 * 核心设计（见 docs/ARCHITECTURE.md §7）：
 * - 统一时间线：每条消息写 { id, ts, channel: 'rp' | 'wechat', role, type, content }，
 *   存在角色作用域键 'wechat_timeline'（粒度跟随剧情分支，与 chat 一致）。
 * - 进微信：system prompt = 角色卡人设 + 世界书/预设 + RP 长期记忆；
 *   模型消息严格按时间线顺序还原——微信消息原样发，途中每段连续 RP 合并成一条
 *   「剧情背景」块插在原位，于是「RP → 微信 → RP → 微信」的时间顺序不会丢。
 * - 回 RP：把"最后一次 RP 之后"的微信段改写成第三人称剧情片段，附到最新用户消息末尾。
 * - 微信侧生成复用 requestTrackedChatCompletion（RP 当前模型）+ 微信 agent 的 JSON 分段协议
 *   与打字节奏；世界书与预设都按用户勾选的条目注入，RP 长期记忆一并带上，
 *   但不走 RP 的关键词扫描/正则/记忆抽取管线，避免互相污染。
 */
(function () {
    window.RPHubAppSections = window.RPHubAppSections || {};
    window.RPHubAppSections.wechat = function (__s) {
        const wxProtocol = window.RPHubWeChatProtocol;

        // ---- 打字速度档位（停顿 = 基线 + 字数×每字耗时 + 抖动，偶尔走神多停）----
        const WECHAT_SPEEDS = {
            fast: { read: [260, 520], base: 260, perChar: 40, cap: 1600 },
            normal: { read: [600, 1300], base: 520, perChar: 85, cap: 2600 },
            slow: { read: [1100, 2200], base: 900, perChar: 140, cap: 4200 }
        };
        const WECHAT_HISTORY_LIMIT = 30;
        // 最近多少条消息不参与合并：生成点附近得留着正确的「短气泡」样本，
        // 否则模型看到的历史全是合并后的多行一条，会跟着模仿成长段。
        const WECHAT_RECENT_VERBATIM = 8;
        // RP 段回放预算：一段 roleplay 最多回放进微信上下文多少条消息、每条截多少字。
        // 段数不单独限——最终统一按 WECHAT_HISTORY_LIMIT 裁消息条数。
        const WECHAT_RP_SEGMENT_MESSAGES = 16;
        const WECHAT_RP_SEGMENT_CHARS = 200;
        const WECHAT_MEMORY_LIMIT = 10;
        const WECHAT_TIMELINE_KEY = 'wechat_timeline';

        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const rand = (a, b) => a + Math.random() * (b - a);
        /** 微信侧的「按名字勾选」字段（世界书条目名 / 预设名）统一去空去重。 */
        const normalizeTrimmedList = (value) => [...new Set(
            (Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean)
        )];

        // ---- 状态 ----
        const showWechatPanel = ref(false);
        __s.showWechatPanel = showWechatPanel;
        const showWechatSettings = ref(false);
        __s.showWechatSettings = showWechatSettings;
        const wechatTimeline = ref([]);
        __s.wechatTimeline = wechatTimeline;
        const wechatInput = ref('');
        __s.wechatInput = wechatInput;
        const wechatPendingImage = ref(null);
        __s.wechatPendingImage = wechatPendingImage;
        const isWechatGenerating = ref(false);
        __s.isWechatGenerating = isWechatGenerating;
        const wechatTyping = ref(false);
        __s.wechatTyping = wechatTyping;
        const wechatStatusText = ref('');
        __s.wechatStatusText = wechatStatusText;
        const wechatSettingsDraft = reactive({
            peerName: '',
            relation: '',
            scene: '',
            persona: '',
            speed: 'normal',
            worldInfoComments: [],
            presetNames: [],
            stickerRate: wxProtocol.DEFAULT_STICKER_TIER
        });
        __s.wechatSettingsDraft = wechatSettingsDraft;
        __s.wechatAbortController = null;
        __s.wechatStatusTimer = null;

        const wechatPeerName = computed(() => {
            const char = __s.currentCharacter.value;
            if (!char) return '微信';
            return String(char.wechatPeerName || '').trim() || char.name || '微信';
        });
        __s.wechatPeerName = wechatPeerName;
        const wechatAvatar = computed(() => __s.currentCharacter.value?.avatar || '');
        __s.wechatAvatar = wechatAvatar;

        const wechatScopeId = () => __s.getCurrentStoryBranchScopeId();
        const wechatSpeedKey = () => {
            const speed = __s.currentCharacter.value?.wechatSpeed;
            return WECHAT_SPEEDS[speed] ? speed : 'normal';
        };
        const wechatSpeedConfig = () => WECHAT_SPEEDS[wechatSpeedKey()] || WECHAT_SPEEDS.normal;

        // ---- 持久化（角色作用域 / 剧情分支）----
        const saveWechatTimelineNow = async (scopeId = wechatScopeId(), timeline = wechatTimeline.value) => {
            if (!scopeId) return false;
            if (!getMainDb()) await initDB();
            await setScopedStoredValue(WECHAT_TIMELINE_KEY, scopeId, cloneForStorage(timeline), { clone: false });
            return true;
        };
        __s.saveWechatTimelineNow = saveWechatTimelineNow;

        const loadWechatTimeline = async (scopeId = wechatScopeId()) => {
            if (!scopeId) return [];
            try {
                const saved = await getScopedStoredValue(WECHAT_TIMELINE_KEY, scopeId);
                return Array.isArray(saved) ? saved.filter(item => item && typeof item === 'object') : [];
            } catch (error) {
                console.error('读取微信时间线失败:', error);
                return [];
            }
        };
        __s.loadWechatTimeline = loadWechatTimeline;

        let wechatSaveTimer = null;
        const scheduleWechatSave = () => {
            clearTimeout(wechatSaveTimer);
            wechatSaveTimer = setTimeout(() => {
                wechatSaveTimer = null;
                saveWechatTimelineNow().catch((error) => console.error('保存微信时间线失败:', error));
            }, 300);
        };
        __s.scheduleWechatSave = scheduleWechatSave;

        // ---- 时间线写入 ----
        const pushWechatItem = (item) => {
            wechatTimeline.value.push({
                id: generateUUID(),
                ts: Date.now(),
                ...item
            });
        };
        __s.pushWechatItem = pushWechatItem;

        let recordedRpCount = 0;
        let loadedWechatScopeId = null;
        const resetRpRecordCursor = () => {
            recordedRpCount = 0;
            wechatTimeline.value.forEach((item) => {
                if (item.channel === 'rp' && Number.isFinite(item.rpIndex)) {
                    recordedRpCount = Math.max(recordedRpCount, item.rpIndex + 1);
                }
            });
        };
        __s.resetRpRecordCursor = resetRpRecordCursor;

        /** 确保内存里的时间线对应当前角色/分支；切换后首次调用会从 DB 重新载入。 */
        const ensureWechatTimelineLoaded = async (force = false) => {
            const scope = wechatScopeId();
            if (!force && loadedWechatScopeId === scope) return;
            wechatTimeline.value = await loadWechatTimeline(scope);
            loadedWechatScopeId = scope;
            resetRpRecordCursor();
        };
        __s.ensureWechatTimelineLoaded = ensureWechatTimelineLoaded;

        /**
         * 把 RP 侧新产生的消息镜像进统一时间线（channel='rp'）。
         * 在 RP 生成结束时调用；只追加 rpIndex >= 上次记录位的新消息，保证时间顺序。
         * 历史回退/分支切换导致游标越界时自动重建，避免漏记。
         */
        const recordRpMessages = async () => {
            const char = __s.currentCharacter.value;
            if (!char?.wechatEnabled) return;
            await ensureWechatTimelineLoaded();
            const history = __s.chatHistory.value;
            if (recordedRpCount > history.length) resetRpRecordCursor();
            for (let index = recordedRpCount; index < history.length; index++) {
                const message = history[index];
                if (!message || !['user', 'assistant'].includes(message.role)) continue;
                const content = String(message.content || '').trim();
                if (!content) continue;
                wechatTimeline.value.push({
                    id: generateUUID(),
                    ts: Date.now() + index,
                    channel: 'rp',
                    rpIndex: index,
                    role: message.role === 'user' ? 'user' : 'assistant',
                    type: 'text',
                    content
                });
            }
            if (history.length > recordedRpCount) {
                recordedRpCount = history.length;
                scheduleWechatSave();
            }
        };
        __s.recordRpMessages = recordRpMessages;

        /**
         * 一段连续的 RP 时间线 → 一条「剧情背景」消息。
         * 用 user 角色 + 明显标题，与项目里中途插世界书的既有做法一致
         * （injectContextMessages 也是 user + [标题] 的前缀形式）。
         *
         * 正文先走一遍 RP 的 processRegex（与 15-generate.js 生成时同参）：它会
         * replaceUserNamePlaceholder 把 {{user}} 等占位符解析掉，再跑用户自定义正则
         * （如遗留的「Auto Replace {{user}}」）。必须在截断之前做——否则 200 字边界
         * 落在 {{user}} 中间会切出半截「{」，而微信块不走 RP 管线，残渣会原样发给模型。
         * 最后顺手用 stripThinking 去掉 <thinking> 块：RP 正文里常见，带进微信是噪音。
         */
        const clipRpText = (raw, role) => {
            const processed = __s.processRegex(raw, { isPrompt: true, role }) || '';
            const oneLine = wxProtocol.stripThinking(processed).replace(/\s+/g, ' ').trim();
            const codePoints = Array.from(oneLine);
            if (codePoints.length <= WECHAT_RP_SEGMENT_CHARS) return oneLine;
            // 按码点切（不劈开 emoji 代理对），末尾兜底摘掉任何残缺的 {{...}} / 花括号
            return codePoints.slice(0, WECHAT_RP_SEGMENT_CHARS).join('')
                .replace(/\{\{[^{}]*$/, '').replace(/\{[^{}]*$/, '').trim();
        };

        const buildWechatRpBlock = (items) => {
            const char = __s.currentCharacter.value || {};
            const who = String(char.name || '').trim() || '你';
            const lines = [];
            for (const item of items) {
                if (item.role !== 'user' && item.role !== 'assistant') continue;
                const text = clipRpText(item.content, item.role);
                if (!text) continue;
                lines.push(`${item.role === 'user' ? '对方' : `你（${who}）`}：${text}`);
            }
            if (!lines.length) return '';
            const kept = lines.slice(-WECHAT_RP_SEGMENT_MESSAGES);
            const omitted = lines.length - kept.length;
            return [
                '【roleplay 剧情｜以下是你和对方在 roleplay 里发生的事，只作为背景，不是微信消息】',
                omitted > 0 ? `（这段更早的 ${omitted} 条已省略）` : '',
                ...kept
            ].filter(Boolean).join('\n');
        };

        /**
         * 组装「完整角色卡」文本，与 RP 侧一致地作为人设前提注入。
         * RP 侧角色卡 = [Character] + Name + Personality + mes_example；这里对齐，
         * 并优先使用角色编辑器里的「微信人设」覆盖（若填了）。
         */
        const buildWechatCharacterCard = () => {
            const char = __s.currentCharacter.value || {};
            const override = String(char.wechatPersona || '').trim();
            if (override) return override;
            const parts = [];
            if (char.name) parts.push(`Name: ${char.name}`);
            if (String(char.description || '').trim()) parts.push(`Description: ${String(char.description).trim()}`);
            if (String(char.personality || '').trim()) parts.push(`Personality: ${String(char.personality).trim()}`);
            if (String(char.mes_example || '').trim()) parts.push(`示例对话:\n${String(char.mes_example).trim()}`);
            return parts.join('\n');
        };
        __s.buildWechatCharacterCard = buildWechatCharacterCard;

        /**
         * 微信侧世界书：只认「手动选中」的条目，选中即全量注入。
         * 不像 RP 那样扫关键词触发 —— 微信是短对话，没有足够正文去扫，且用户要的是
         * 「我挑哪几条设定，微信就按哪几条理解」。
         * 条目没有稳定 id（normalizeWorldInfoEntry 不生成），所以按 comment 认领，
         * 与项目里按 comment 找「自动生图」条目的既有做法一致。
         */
        const WECHAT_WORLD_INFO_PREVIEW_LEN = 60;
        const wechatWorldInfoOptions = computed(() => __s.worldInfo.value.map((entry, index) => {
            const comment = String(entry?.comment || '').trim();
            return {
                index,
                comment,
                preview: String(entry?.content || '').trim().replace(/\s+/g, ' ').slice(0, WECHAT_WORLD_INFO_PREVIEW_LEN),
                enabled: entry?.enabled !== false,
                constant: entry?.constant === true,
                // 没名字的条目无从认领，抽屉里只展示不可选。
                selectable: !!comment
            };
        }));
        __s.wechatWorldInfoOptions = wechatWorldInfoOptions;

        const selectedWechatWorldInfoComments = () => {
            const raw = __s.currentCharacter.value?.wechatWorldInfoComments;
            return new Set((Array.isArray(raw) ? raw : [])
                .map(comment => String(comment || '').trim())
                .filter(Boolean));
        };

        /** 格式与 RP 侧 joinContent 一致：`[条目名]\n正文`，按 order 升序（同 RP 组内排序）。 */
        const buildWechatWorldInfo = () => {
            const selected = selectedWechatWorldInfoComments();
            if (!selected.size) return '';
            return __s.worldInfo.value
                .filter(entry => entry?.enabled !== false
                    && String(entry?.content || '').trim()
                    && selected.has(String(entry?.comment || '').trim()))
                .slice()
                .sort((a, b) => (a.order || 0) - (b.order || 0))
                .map(entry => `[${String(entry.comment).trim()}]\n${String(entry.content).trim()}`)
                .join('\n\n');
        };

        const wechatStickerTier = () => wxProtocol.normalizeStickerTier(
            __s.currentCharacter.value?.wechatStickerRate
        );

        /**
         * 微信侧预设：只列「带微信版文案」的预设，注入时也用 wechatContent 而非 content。
         * 同一个预设因此有两套写法：RP 用正文版，微信短气泡用微信版。
         * - 纯 RP 正文规则（破限/时间戳/剧情面板/文风…）没有微信版，抽屉里不展示，省得误点。
         * - 勾选只看微信这一侧，不跟随预设的启用开关：否则想用微信版就得把 RP 版一起打开，
         *   反而污染 RP。
         */
        const WECHAT_PRESET_PREVIEW_LEN = 60;
        const wechatPresetOptions = computed(() => __s.presets.value
            .map(__s.normalizePreset)
            .map((preset, index) => ({
                index,
                name: String(preset.name || '').trim(),
                preview: preset.wechatContent.trim().replace(/\s+/g, ' ').slice(0, WECHAT_PRESET_PREVIEW_LEN)
            }))
            .filter(option => option.name && option.preview));
        __s.wechatPresetOptions = wechatPresetOptions;

        const selectedWechatPresetNames = () => {
            const raw = __s.currentCharacter.value?.wechatPresetNames;
            return new Set((Array.isArray(raw) ? raw : [])
                .map(name => String(name || '').trim())
                .filter(Boolean));
        };

        const selectedWechatPresets = () => {
            const selected = selectedWechatPresetNames();
            if (!selected.size) return [];
            return __s.presets.value
                .map(__s.normalizePreset)
                .filter(preset => preset.wechatContent.trim()
                    && selected.has(String(preset.name || '').trim()));
        };

        /** system 角色的预设（破限、人格内核、防神化…）合成一段，进 system prompt。 */
        const buildWechatPresetRules = () => selectedWechatPresets()
            .filter(preset => preset.role === 'system')
            .map(preset => preset.wechatContent.trim())
            .join('\n\n---\n\n');

        /**
         * user / assistant 角色的预设是「预注入轮次」（破限预注入那几条）：
         * 它们靠伪造一轮问答给模型定调，必须作为真实消息插在 system 和聊天记录之间。
         * 混进 system 提示词里就失去这个作用了。
         */
        const buildWechatPresetMessages = () => selectedWechatPresets()
            .filter(preset => preset.role !== 'system')
            .map(preset => ({ role: preset.role, content: preset.wechatContent.trim() }));

        /**
         * RP 长期记忆（classicMemories）：RP 侧用它替换掉被压缩的旧轮次。
         * 微信侧只拿得到最近若干轮的近况摘要，更早的剧情就靠这段兜底。
         */
        const buildWechatMemory = () => {
            if (!__s.memorySettings?.enabled) return '';
            const memories = (__s.classicMemories?.value || [])
                .filter(memory => memory?.enabled !== false && String(memory?.summary || '').trim());
            if (!memories.length) return '';
            return memories.slice(-WECHAT_MEMORY_LIMIT).map((memory) => {
                const start = Number(memory.turnStart ?? memory.turn);
                const end = Number(memory.turnEnd ?? memory.turn);
                const label = Number.isFinite(start) && Number.isFinite(end) && end > start
                    ? `第 ${start}–${end} 轮`
                    : (Number.isFinite(start) ? `第 ${start} 轮` : '');
                const summary = String(memory.summary).trim();
                return label ? `【${label}】${summary}` : summary;
            }).join('\n');
        };

        const buildWechatSystemPrompt = () => {
            const char = __s.currentCharacter.value || {};
            return wxProtocol.buildSystemPrompt(buildWechatCharacterCard(), {
                characterName: String(char.wechatPeerName || '').trim() || char.name || '',
                presetRules: buildWechatPresetRules(),
                worldInfo: buildWechatWorldInfo(),
                userInfo: __s.buildUserInfoPrompt(),
                relation: String(char.wechatRelation || '').trim(),
                scene: String(char.wechatScene || '').trim(),
                stickerRule: wxProtocol.stickerRuleFor(wechatStickerTier()),
                extraRules: `【重要】你们既是 roleplay 里的关系，也是现实里互加微信的人。`
                    + `把 roleplay 中已建立的称呼、关系、默契带进微信，像真人一样随口聊天，不要重来一遍自我介绍。`,
                memory: buildWechatMemory()
            });
        };
        __s.buildWechatSystemPrompt = buildWechatSystemPrompt;

        /**
         * 只保留最后一个 RP 剧情块，更早的交给【长期记忆】。
         * 注意是「丢掉多余的 RP 块」，不是「只留最后一个 RP 块之后的内容」——
         * 微信消息一条都不能少，它们才是这条对话线本身。
         */
        const dropEarlierRpBlocks = (entries) => {
            let lastRpIndex = -1;
            entries.forEach((entry, index) => { if (entry.rp) lastRpIndex = index; });
            if (lastRpIndex === -1) return entries;
            return entries.filter((entry, index) => !entry.rp || index === lastRpIndex);
        };

        /**
         * 微信历史 → 模型消息。严格按统一时间线的顺序走：
         * 微信消息原样发出，途中每一段连续 RP 合并成一条剧情背景块，插在它原本的时间位置。
         *
         * 这样「RP → 微信 → RP → 微信」交替时，模型看到的是完整的时间顺序，
         * 而不是把 RP 全堆进 system 提示词、微信消息单独排成一条线——
         * 后者会让模型分不清某段 RP 是在这轮微信之前还是之后。
         *
         * 再叠两条压缩，避免来回切换几次就把消息额度吃满：
         * - 相邻同角色气泡合并：一轮回复本来就是拆成 2~3 条短消息发的，逐条占额度的话
         *   30 条只装得下 7 轮。最近 WECHAT_RECENT_VERBATIM 条保持原样，
         *   免得模型把「合并后的多行一条」当成该模仿的格式。
         * - RP 块只留最近一段：更早的已经有【长期记忆】覆盖，不必重复塞原文。
         *   记忆没开或还是空的就照旧全留，否则那段内容就彻底没了。
         */
        const buildWechatModelMessages = () => {
            const entries = [];
            let rpBuffer = [];
            const flushRp = () => {
                if (!rpBuffer.length) return;
                const block = buildWechatRpBlock(rpBuffer);
                rpBuffer = [];
                if (block) entries.push({ message: { role: 'user', content: block }, mergeable: false, rp: true });
            };

            for (const item of wechatTimeline.value) {
                if (item.channel === 'rp') {
                    rpBuffer.push(item);
                    continue;
                }
                if (item.channel !== 'wechat') continue;
                flushRp();
                if (item.role !== 'user' && item.role !== 'assistant') continue;
                if (item.type === 'image' && item.role === 'user') {
                    const parts = [];
                    if (item.content) parts.push({ type: 'image_url', image_url: { url: item.content } });
                    // content 是数组，拼不了，也就不参与合并
                    entries.push({ message: { role: 'user', content: parts.length ? parts : '(图片)' }, mergeable: false });
                } else if (item.type === 'sticker') {
                    entries.push({ message: { role: item.role, content: item.content }, mergeable: true });
                } else {
                    const text = String(item.content || '').trim();
                    if (text) entries.push({ message: { role: item.role, content: text }, mergeable: true });
                }
            }
            // 时间线以 RP 收尾时（刚 RP 完还没发微信），这段同样是当前对话的背景
            flushRp();

            const memoryCoversHistory = __s.memorySettings?.enabled === true
                && (__s.classicMemories?.value || []).length > 0;
            const kept = memoryCoversHistory ? dropEarlierRpBlocks(entries) : entries;

            const merged = [];
            kept.forEach((entry, index) => {
                const verbatim = index >= kept.length - WECHAT_RECENT_VERBATIM;
                const previous = merged[merged.length - 1];
                if (!verbatim && entry.mergeable && previous?.mergeable
                    && previous.message.role === entry.message.role) {
                    previous.message.content = `${previous.message.content}\n${entry.message.content}`;
                    return;
                }
                merged.push({ message: { ...entry.message }, mergeable: entry.mergeable });
            });

            return merged.slice(-WECHAT_HISTORY_LIMIT).map(entry => entry.message);
        };

        // ---- 回 RP：微信段改写成剧情 ----
        const buildWechatRpDigest = () => {
            const char = __s.currentCharacter.value;
            if (!char?.wechatEnabled) return '';
            const timeline = wechatTimeline.value;
            let lastRpTs = -Infinity;
            for (const item of timeline) {
                if (item.channel === 'rp' && Number.isFinite(item.ts)) {
                    lastRpTs = Math.max(lastRpTs, item.ts);
                }
            }
            const segment = timeline.filter((item) => item.channel === 'wechat'
                && item.role !== 'system'
                && (!Number.isFinite(item.ts) || item.ts > lastRpTs));
            if (!segment.length) return '';
            const who = String(char.wechatPeerName || '').trim() || char.name;
            const lines = segment.map((item) => {
                const name = item.role === 'user' ? '你' : who;
                if (item.type === 'image') return `${name}：[图片]`;
                if (item.type === 'sticker') return `${name}：[表情 ${item.content}]`;
                return `${name}：${item.content}`;
            });
            return `【后来你们在微信上聊了这些（请据此延续，不必重复）】\n`
                + `你们暂时从 roleplay 场景切到了现实里的微信对话，${who}在微信上和你说：\n`
                + lines.join('\n');
        };
        __s.buildWechatRpDigest = buildWechatRpDigest;

        /** 把微信段摘要附到最新一条 user 消息末尾（在 RP 上下文组装之后调用）。 */
        const appendWechatDigestToMessages = (messages) => {
            const digest = buildWechatRpDigest();
            if (!digest) return messages;
            for (let index = messages.length - 1; index >= 0; index--) {
                if (messages[index].role === 'user') {
                    messages[index] = {
                        ...messages[index],
                        content: `${digest}\n\n${messages[index].content || ''}`.trim()
                    };
                    break;
                }
            }
            return messages;
        };
        __s.appendWechatDigestToMessages = appendWechatDigestToMessages;

        // ---- 打字节奏 ----
        const typingDuration = (message) => {
            const cfg = wechatSpeedConfig();
            if (message.type === 'sticker') return rand(350, 900);
            const base = cfg.base + String(message.content || '').length * cfg.perChar;
            const drift = Math.random() < 0.12 ? rand(300, 900) : 0;
            return Math.min(base, cfg.cap) + drift;
        };

        const startWechatStatusTicker = () => {
            const startedAt = Date.now();
            const render = () => {
                const seconds = Math.round((Date.now() - startedAt) / 1000);
                wechatStatusText.value = seconds >= 3 ? `对方正在输入… 已等待 ${seconds} 秒` : '对方正在输入…';
            };
            render();
            __s.wechatStatusTimer = setInterval(render, 1000);
        };
        const stopWechatStatusTicker = () => {
            if (__s.wechatStatusTimer) {
                clearInterval(__s.wechatStatusTimer);
                __s.wechatStatusTimer = null;
            }
        };

        // ---- 打开 / 关闭 ----
        const openWechat = async () => {
            const char = __s.currentCharacter.value;
            if (!char) {
                __s.showToast('请先选择一个角色', 'warning');
                return;
            }
            if (!char.wechatEnabled) {
                __s.showToast('该角色未开启微信，可在角色编辑里打开', 'info');
                return;
            }
            wechatTimeline.value = await loadWechatTimeline();
            loadedWechatScopeId = wechatScopeId();
            resetRpRecordCursor();
            // 把已有的 RP 历史补进时间线，保证进微信就有前情。
            await recordRpMessages();
            wechatInput.value = '';
            wechatPendingImage.value = null;
            wechatStatusText.value = '';
            showWechatPanel.value = true;
            await nextTick();
            scrollWechatToBottom();
        };
        __s.openWechat = openWechat;

        const closeWechat = async () => {
            if (isWechatGenerating.value) {
                __s.wechatAbortController?.abort();
            }
            showWechatPanel.value = false;
            showWechatSettings.value = false;
            wechatTyping.value = false;
            wechatStatusText.value = '';
            stopWechatStatusTicker();
            try {
                await saveWechatTimelineNow();
            } catch (error) {
                console.error('保存微信时间线失败:', error);
            }
            await __s.scrollChatToBottom();
        };
        __s.closeWechat = closeWechat;

        const scrollWechatToBottom = () => {
            const el = document.getElementById('wechat-chat-scroll');
            if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
        };
        __s.scrollWechatToBottom = scrollWechatToBottom;

        // ---- 设置面板（写回角色字段）----
        const openWechatSettings = () => {
            const char = __s.currentCharacter.value || {};
            wechatSettingsDraft.peerName = char.wechatPeerName || char.name || '';
            wechatSettingsDraft.relation = char.wechatRelation || '';
            wechatSettingsDraft.scene = char.wechatScene || '';
            wechatSettingsDraft.persona = char.wechatPersona || char.personality || char.description || '';
            wechatSettingsDraft.speed = WECHAT_SPEEDS[char.wechatSpeed] ? char.wechatSpeed : 'normal';
            wechatSettingsDraft.worldInfoComments = [...selectedWechatWorldInfoComments()];
            wechatSettingsDraft.presetNames = [...selectedWechatPresetNames()];
            wechatSettingsDraft.stickerRate = wxProtocol.normalizeStickerTier(char.wechatStickerRate);
            showWechatSettings.value = true;
        };
        __s.openWechatSettings = openWechatSettings;

        const saveWechatSettings = async () => {
            const char = __s.currentCharacter.value;
            if (!char) return;
            char.wechatPeerName = String(wechatSettingsDraft.peerName || '').trim();
            char.wechatRelation = String(wechatSettingsDraft.relation || '').trim();
            char.wechatScene = String(wechatSettingsDraft.scene || '').trim();
            char.wechatPersona = String(wechatSettingsDraft.persona || '');
            char.wechatSpeed = WECHAT_SPEEDS[wechatSettingsDraft.speed] ? wechatSettingsDraft.speed : 'normal';
            char.wechatWorldInfoComments = normalizeTrimmedList(wechatSettingsDraft.worldInfoComments);
            char.wechatPresetNames = normalizeTrimmedList(wechatSettingsDraft.presetNames);
            char.wechatStickerRate = wxProtocol.normalizeStickerTier(wechatSettingsDraft.stickerRate);
            showWechatSettings.value = false;
            try {
                await __s.saveCharactersNow();
                __s.showToast('微信设置已保存', 'success');
            } catch (error) {
                console.error('保存微信设置失败:', error);
                __s.showToast('保存失败，请稍后重试', 'error');
            }
        };
        __s.saveWechatSettings = saveWechatSettings;

        const clearWechatTimeline = () => {
            __s.confirmAction('确定要清空与该角色的全部微信聊天记录吗？此操作无法撤销。', async () => {
                wechatTimeline.value = wechatTimeline.value.filter((item) => item.channel !== 'wechat');
                resetRpRecordCursor();
                try {
                    await saveWechatTimelineNow();
                } catch (error) {
                    console.error('清空微信记录失败:', error);
                }
                __s.showToast('微信聊天记录已清空', 'success');
            });
        };
        __s.clearWechatTimeline = clearWechatTimeline;

        // ---- 图片 ----
        const handleWechatImageSelection = async (event) => {
            const file = event?.target?.files?.[0];
            if (event?.target) event.target.value = '';
            if (!file) return;
            if (!file.type.startsWith('image/')) {
                __s.showToast('只能发送图片文件', 'warning');
                return;
            }
            try {
                const dataUrl = await fileToDataURL(file);
                wechatPendingImage.value = await compressImage(dataUrl, 1024, 0.82);
            } catch (error) {
                __s.showToast(`图片处理失败：${error.message}`, 'error');
            }
        };
        __s.handleWechatImageSelection = handleWechatImageSelection;

        const removeWechatPendingImage = () => {
            wechatPendingImage.value = null;
        };
        __s.removeWechatPendingImage = removeWechatPendingImage;

        const fileToDataURL = (file) => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error('读取图片失败'));
            reader.readAsDataURL(file);
        });

        // ---- 生成 ----
        const requestWechatReply = async (signal) => {
            const model = __s.settings.model;
            const result = await __s.requestTrackedChatCompletion({
                model,
                messages: [
                    { role: 'system', content: buildWechatSystemPrompt() },
                    // 预注入轮次（破限预注入）夹在 system 与真实聊天记录之间
                    ...buildWechatPresetMessages(),
                    ...buildWechatModelMessages()
                ],
                temperature: 0.95,
                stream: true,
                signal
            }, 'chat');
            const raw = String(result?.content || '').trim();
            if (!raw) throw new Error('模型返回了空内容');
            const messages = wxProtocol.parseReply(raw);
            if (!messages.length) throw new Error('未能从回复中解析出任何消息');
            // 提示词之外再硬裁一道：模型无视档位刷表情时，这里兜底。
            return wxProtocol.applyStickerPolicy(messages, wechatStickerTier());
        };

        const playWechatReply = async (messages, signal) => {
            for (let index = 0; index < messages.length; index++) {
                const message = messages[index];
                if (index > 0) {
                    await sleep(rand(160, 420));
                    wechatTyping.value = true;
                    wechatStatusText.value = '对方正在输入…';
                    scrollWechatToBottom();
                }
                await sleep(typingDuration(message));
                if (signal?.aborted) return;
                wechatTyping.value = false;
                wechatStatusText.value = '';
                pushWechatItem({ channel: 'wechat', role: 'assistant', type: message.type, content: message.content });
                scheduleWechatSave();
                scrollWechatToBottom();
                if (index < messages.length - 1) await sleep(rand(220, 560));
            }
        };

        const sendWechatMessage = async () => {
            const text = String(wechatInput.value || '').trim();
            const image = wechatPendingImage.value;
            if ((!text && !image) || isWechatGenerating.value) return;
            if (!__s.currentCharacter.value) {
                __s.showToast('请先选择一个角色', 'warning');
                return;
            }
            if (!__s.settings.apiUrl || !__s.settings.apiKey || !__s.settings.model) {
                __s.showToast('请先在设置里填写 API 地址、Key 和模型', 'warning');
                return;
            }

            wechatInput.value = '';
            wechatPendingImage.value = null;

            if (text) pushWechatItem({ channel: 'wechat', role: 'user', type: 'text', content: text });
            if (image) pushWechatItem({ channel: 'wechat', role: 'user', type: 'image', content: image });
            scheduleWechatSave();
            scrollWechatToBottom();

            isWechatGenerating.value = true;
            __s.wechatAbortController = new AbortController();
            const signal = __s.wechatAbortController.signal;
            const cfg = wechatSpeedConfig();

            wechatTyping.value = true;
            wechatStatusText.value = '对方正在输入…';
            await sleep(rand(cfg.read[0], cfg.read[1]));
            startWechatStatusTicker();
            scrollWechatToBottom();

            let messages;
            try {
                messages = await requestWechatReply(signal);
            } catch (error) {
                stopWechatStatusTicker();
                wechatTyping.value = false;
                wechatStatusText.value = '';
                isWechatGenerating.value = false;
                __s.wechatAbortController = null;
                if (error?.name !== 'AbortError') {
                    __s.showToast(`发送失败：${error?.message || error}`, 'error', 4000);
                }
                return;
            }
            stopWechatStatusTicker();

            try {
                await playWechatReply(messages, signal);
            } finally {
                wechatTyping.value = false;
                wechatStatusText.value = '';
                stopWechatStatusTicker();
                isWechatGenerating.value = false;
                __s.wechatAbortController = null;
                await saveWechatTimelineNow().catch(() => {});
            }
        };
        __s.sendWechatMessage = sendWechatMessage;

        const stopWechatGeneration = () => {
            __s.wechatAbortController?.abort();
            stopWechatStatusTicker();
            wechatTyping.value = false;
            wechatStatusText.value = '';
            isWechatGenerating.value = false;
            __s.wechatAbortController = null;
        };
        __s.stopWechatGeneration = stopWechatGeneration;

        // ---- 展示用：日期分隔 + 时间 ----
        const pad2 = (value) => String(value).padStart(2, '0');
        const isSameDay = (a, b) => {
            const da = new Date(a);
            const db = new Date(b);
            return da.getFullYear() === db.getFullYear()
                && da.getMonth() === db.getMonth()
                && da.getDate() === db.getDate();
        };
        const formatWechatDayLabel = (ts) => {
            const date = new Date(ts);
            return `${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
        };
        const wechatDisplayItems = computed(() => {
            const items = [];
            let lastTs = null;
            for (const item of wechatTimeline.value) {
                if (item.channel !== 'wechat') continue;
                if (item.role === 'system') {
                    items.push({ kind: 'system', id: item.id, content: item.content });
                    continue;
                }
                if (lastTs === null || !isSameDay(lastTs, item.ts)) {
                    items.push({ kind: 'day', id: `day-${item.id}`, label: formatWechatDayLabel(item.ts) });
                }
                lastTs = item.ts;
                items.push({ kind: 'message', id: item.id, role: item.role, type: item.type, content: item.content });
            }
            return items;
        });
        __s.wechatDisplayItems = wechatDisplayItems;

        // ---- 角色切换 / 分支切换时重载 ----
        watch(() => __s.currentCharacter.value?.uuid, () => {
            if (showWechatPanel.value) {
                openWechat();
            }
        });
        watch(() => __s.activeStoryBranchId.value, () => {
            if (showWechatPanel.value) {
                openWechat();
            }
        });
    };
})();
