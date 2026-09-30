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
        // RP 段回放预算：一段 roleplay 最多回放进微信上下文多少条消息。
        // 段数不单独限——最终统一按 WECHAT_HISTORY_LIMIT 裁消息条数。
        // 每条消息不截断（保留完整原文；截断会把用户名、台词切一半）。
        const WECHAT_RP_SEGMENT_MESSAGES = 16;
        const WECHAT_MEMORY_LIMIT = 10;
        const WECHAT_TIMELINE_KEY = 'wechat_timeline';
        // 表情包库是全局的（用户自己的收藏，所有角色共用），非角色作用域。
        const WECHAT_STICKERS_KEY = 'wechat_stickers';
        // 目录注入上限：库再大也只把前 N 条塞进 system prompt，剩下的只影响手动发送。
        const WECHAT_STICKER_CATALOG_LIMIT = 50;
        const WECHAT_STICKER_DESC_LIMIT = 15;
        // 开源表情包商店（getActivity/EmojiPackage，Apache-2.0）——静态清单见 emoji-catalog.js
        const WECHAT_STICKER_ACTIVE_CAT = '__all__';
        const WECHAT_STICKER_NAME_LIMIT = 24;

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
        const showWechatStickers = ref(false);
        __s.showWechatStickers = showWechatStickers;
        const showStickerManager = ref(false);
        __s.showStickerManager = showStickerManager;
        const showStickerStore = ref(false);
        __s.showStickerStore = showStickerStore;
        // 连发模式：发送/表情包只落成气泡、不立刻请求回复，攒够了自己点「让对方回复」
        const wechatBurstMode = ref(false);
        __s.wechatBurstMode = wechatBurstMode;
        const wechatStickers = ref([]);
        __s.wechatStickers = wechatStickers;
        const stickerDraft = reactive({ id: '', name: '', description: '', image: '' });
        __s.stickerDraft = stickerDraft;
        const stickerStoreActiveCat = ref(WECHAT_STICKER_ACTIVE_CAT);
        __s.stickerStoreActiveCat = stickerStoreActiveCat;
        const stickerStorePicked = ref([]);
        __s.stickerStorePicked = stickerStorePicked;
        const stickerStoreImporting = ref(false);
        __s.stickerStoreImporting = stickerStoreImporting;
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
        // 用户头像：25 号模块在 app.js 之前求值，__s.user 那时还没赋值，
        // 所以必须惰性 computed（直接写 __s.user?.avatar 会在初始化时炸）。
        const wechatUserAvatar = computed(() => __s.user?.avatar || '');
        __s.wechatUserAvatar = wechatUserAvatar;

        /** 表情包条目归一化：补齐字段、裁剪描述长度。 */
        const normalizeSticker = (raw) => {
            const item = raw && typeof raw === 'object' ? raw : {};
            return {
                id: String(item.id || '').trim() || generateUUID(),
                name: String(item.name || '').trim(),
                description: String(item.description || '').trim().slice(0, WECHAT_STICKER_DESC_LIMIT),
                image: String(item.image || ''),
                createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
            };
        };
        __s.normalizeSticker = normalizeSticker;

        /** name → image，渲染时按名字贴图。同名时后写入的覆盖前者（保存时已去重）。 */
        const stickerImageMap = computed(() => {
            const map = new Map();
            for (const sticker of wechatStickers.value) {
                if (sticker?.name && sticker?.image) map.set(sticker.name, sticker.image);
            }
            return map;
        });
        __s.stickerImageMap = stickerImageMap;

        /** 命中库则返回图片 dataURL，否则返回 null（调用方回退当文本渲染）。 */
        const stickerImageOf = (content) => stickerImageMap.value.get(String(content || '').trim()) || null;
        __s.stickerImageOf = stickerImageOf;

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

        // ---- 表情包库持久化（全局，不随角色/分支）----
        const loadWechatStickers = async () => {
            try {
                const saved = await getStoredValue(WECHAT_STICKERS_KEY);
                wechatStickers.value = Array.isArray(saved) ? saved.map(normalizeSticker) : [];
            } catch (error) {
                console.error('读取表情包库失败:', error);
                wechatStickers.value = [];
            }
        };
        __s.loadWechatStickers = loadWechatStickers;

        const saveWechatStickers = async () => {
            try {
                if (!getMainDb()) await initDB();
                await setStoredValue(WECHAT_STICKERS_KEY, cloneForStorage(wechatStickers.value), { clone: false });
            } catch (error) {
                console.error('保存表情包库失败:', error);
                __s.showToast('表情包保存失败，请稍后重试', 'error');
            }
        };
        __s.saveWechatStickers = saveWechatStickers;

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
                    rpMsgId: message.id || null,
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
         * 把时间线里的 RP 镜像与当前 chatHistory 对齐，是进微信前的权威同步。
         *
         * recordRpMessages 只在游标之后追加，且靠「最大 rpIndex+1」重设游标；一旦重新生成
         * 让被删的消息换了新 id，游标会整段跳过它，那段剧情再也补不回微信块（用户看到的
         * 「从微信回 RP 后剧情块丢失」）。这里对活跃 RP 消息做一次完整同步：
         * - 编辑过的（id 命中）就地更新内容与角色；
         * - 新增的（重新生成的新 id）按它相对相邻镜像的顺序，插回原来的时间槽；
         * - 被删的（目录里找不到 id）连同镜像一并丢弃。
         * 微信消息是真人敲的、改动风险高，一律原样保留。
         */
        const reconcileRpTimeline = () => {
            const history = __s.chatHistory.value;
            const active = [];
            history.forEach((message, index) => {
                if (!message || !['user', 'assistant'].includes(message.role)) return;
                if (!message.id) message.id = generateUUID(); // 无 id 的就地补一个，免得对账时被当成已删
                active.push({ message, index });
            });
            if (!active.length) return false;

            const original = wechatTimeline.value;
            const wechatItems = original.filter((item) => item.channel === 'wechat');
            // 每个现有镜像的「时间槽」= 它前面有几条微信消息
            const anchorOf = new Map();
            let seen = 0;
            for (const item of original) {
                if (item.channel === 'wechat') seen++;
                else if (item.channel === 'rp') anchorOf.set(item, seen);
            }
            const byId = new Map();
            const byIndex = new Map();
            for (const item of original) {
                if (item.channel !== 'rp') continue;
                if (item.rpMsgId) byId.set(item.rpMsgId, item);
                if (Number.isFinite(item.rpIndex)) byIndex.set(item.rpIndex, item);
            }

            // 每条活跃消息的槽位：先按 rpMsgId 命中；id 对不上（重新生成换了 id）就按
            // rpIndex 兜底认领原位置，认领后把 id 刷成新的。都没有则视为新增。
            let changed = false;
            const claimed = new Set();
            const resolved = active.map((entry) => {
                let existing = byId.get(entry.message.id) || null;
                if (!existing) {
                    const candidate = byIndex.get(entry.index);
                    if (candidate && !claimed.has(candidate)) existing = candidate;
                }
                if (existing) {
                    claimed.add(existing);
                    if (existing.rpMsgId !== entry.message.id) {
                        existing.rpMsgId = entry.message.id;
                        changed = true;
                    }
                }
                return { entry, existing, anchor: existing ? anchorOf.get(existing) : null };
            });
            let prevAnchor = null;
            for (const r of resolved) {
                if (r.existing) prevAnchor = r.anchor;
                else r.anchor = prevAnchor;
            }
            let nextAnchor = 0;
            for (let i = resolved.length - 1; i >= 0; i--) {
                if (resolved[i].anchor === null) resolved[i].anchor = nextAnchor;
                else nextAnchor = resolved[i].anchor;
            }

            const slots = new Map();
            for (const r of resolved) {
                const content = String(r.entry.message.content || '').trim();
                const role = r.entry.message.role === 'user' ? 'user' : 'assistant';
                let item = r.existing;
                if (item) {
                    if (item.content !== content || item.role !== role || item.rpIndex !== r.entry.index) {
                        item.content = content;
                        item.role = role;
                        item.rpIndex = r.entry.index;
                        changed = true;
                    }
                } else {
                    item = {
                        id: generateUUID(),
                        ts: 0,
                        channel: 'rp',
                        rpIndex: r.entry.index,
                        rpMsgId: r.entry.message.id,
                        role,
                        type: 'text',
                        content,
                        _isNew: true
                    };
                    changed = true;
                }
                if (!slots.has(r.anchor)) slots.set(r.anchor, []);
                slots.get(r.anchor).push(item);
            }

            // 按槽交错回微信消息之间，还原「RP → 微信 → RP」的顺序
            const rebuilt = [];
            for (let k = 0; k <= wechatItems.length; k++) {
                for (const item of (slots.get(k) || [])) rebuilt.push(item);
                if (k < wechatItems.length) rebuilt.push(wechatItems[k]);
            }

            // 新插入的 RP 项 ts 取「紧接着前一条 +1」，避免比后面的微信消息还新——
            // 回 RP 的剧情摘要按 ts 找「最后一段 RP 之后」的微信消息，ts 错位会让摘要丢失。
            let prevTs = null;
            for (let i = 0; i < rebuilt.length; i++) {
                const item = rebuilt[i];
                if (item._isNew) {
                    if (prevTs !== null) item.ts = prevTs + 1;
                    else {
                        const next = rebuilt.slice(i + 1).find((x) => Number.isFinite(x.ts));
                        item.ts = next ? next.ts - 1 : Date.now() + i;
                    }
                    delete item._isNew;
                }
                if (Number.isFinite(item.ts)) prevTs = item.ts;
            }

            if (rebuilt.length !== original.length) changed = true;
            for (let i = 0; i < rebuilt.length && !changed; i++) {
                if (rebuilt[i] !== original[i]) changed = true;
            }
            if (!changed) return false;
            wechatTimeline.value = rebuilt;
            return true;
        };
        __s.reconcileRpTimeline = reconcileRpTimeline;

        /**
         * 一段连续的 RP 时间线 → 一条「剧情背景」消息。
         * 用 user 角色 + 明显标题，与项目里中途插世界书的既有做法一致
         * （injectContextMessages 也是 user + [标题] 的前缀形式）。
         *
         * 正文先走一遍 RP 的 processRegex（与 15-generate.js 生成时同参）：它会
         * replaceUserNamePlaceholder 把 {{user}} 等占位符解析掉，再跑用户自定义正则
         * （如遗留的「Auto Replace {{user}}」），免得原始占位符漏进微信上下文。
         * 正文不截断——截断会把用户名、台词切成半截。最后用 stripThinking 去掉
         * <thinking> 块：RP 正文里常见，带进微信是噪音。
         */
        const normalizeRpText = (raw, role) => {
            const processed = __s.processRegex(raw, { isPrompt: true, role }) || '';
            return wxProtocol.stripThinking(processed).replace(/\s+/g, ' ').trim();
        };

        const buildWechatRpBlock = (items) => {
            const char = __s.currentCharacter.value || {};
            const who = String(char.name || '').trim() || '你';
            const lines = [];
            for (const item of items) {
                if (item.role !== 'user' && item.role !== 'assistant') continue;
                const text = normalizeRpText(item.content, item.role);
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
            // 被前情提要覆盖的轮次不再重复注入这份逐轮记忆（提要已代表那段内容）
            const recapTurnCount = Number(__s.storyRecap?.value?.coversThroughTurn) || 0;
            const memories = (__s.classicMemories?.value || [])
                .filter(memory => memory?.enabled !== false && String(memory?.summary || '').trim())
                .filter(memory => Number(memory.turnEnd ?? memory.turn) > recapTurnCount);
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

        /**
         * 组装「可用表情包目录」注入 system prompt（docs/ARCHITECTURE.md §9.4）。
         * 只带 name + description——模型全程看不到图，靠描述挑名字，前端按名字贴图。
         * 库为空时返回空串：不注入，模型退回 PROTOCOL 里的 emoji 模式（零配置默认不变）。
         */
        const buildWechatStickerCatalog = () => {
            const all = wechatStickers.value.filter(sticker => sticker?.name);
            if (!all.length) return '';
            const list = all.slice(0, WECHAT_STICKER_CATALOG_LIMIT);
            const lines = list.map((sticker) => `- ${sticker.name}｜${sticker.description || '通用'}`);
            if (all.length > list.length) {
                console.warn(`表情包库共 ${all.length} 条，目录只注入前 ${list.length} 条`);
            }
            return [
                '【表情包库】',
                '你可以发送下列表情包，sticker 的 content 只能从下面这些名字里选（原样照抄，不要改动）：',
                ...lines
            ].join('\n');
        };
        __s.buildWechatStickerCatalog = buildWechatStickerCatalog;

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
                stickerCatalog: buildWechatStickerCatalog(),
                extraRules: `【重要】你们既是 roleplay 里的关系，也是现实里互加微信的人。`
                    + `把 roleplay 中已建立的称呼、关系、默契带进微信，像真人一样随口聊天，不要重来一遍自我介绍。`,
                memory: buildWechatMemory()
            });
        };
        __s.buildWechatSystemPrompt = buildWechatSystemPrompt;

        /**
         * 只保留最后一个 RP 剧情块（**无前情提要时**的兜底）。
         * 记忆启用但还没手动压缩时沿用旧做法：更早的交给【长期记忆】。
         * 一旦有了前情提要，改由 recap 覆盖范围精确裁剪（见 buildWechatModelMessages）。
         */
        const dropEarlierRpBlocks = (entries) => {
            let lastRpIndex = -1;
            entries.forEach((entry, index) => { if (entry.rp) lastRpIndex = index; });
            if (lastRpIndex === -1) return entries;
            return entries.filter((entry, index) => !entry.rp || index === lastRpIndex);
        };

        /**
         * 前情提要的覆盖边界：被覆盖的 RP 消息最大 chatHistory 索引 + 微信消息条数。
         * 压缩只压最老的内容，所以覆盖点必然是两条流的前缀。
         */
        const recapCoverage = () => {
            const recap = __s.storyRecap?.value;
            if (!recap) return null;
            const snapshot = __s.buildConversationTurnSnapshot(__s.chatHistory.value, { includeSystem: false });
            const coveredTurns = (snapshot.turns || []).slice(0, Math.max(0, Number(recap.coversThroughTurn) || 0));
            let rpMaxIndex = -1;
            coveredTurns.forEach(turnInfo => {
                (turnInfo.messageIndexes || []).forEach(index => { rpMaxIndex = Math.max(rpMaxIndex, index); });
            });
            return { rpMaxIndex, wxCount: Math.max(0, Number(recap.coversWechatCount) || 0) };
        };
        __s.recapCoverageRange = recapCoverage;

        /**
         * 微信历史 → 模型消息。严格按统一时间线的顺序走：
         * 微信消息原样发出，途中每一段连续 RP 合并成一条剧情背景块，插在它原本的时间位置。
         *
         * 这样「RP → 微信 → RP → 微信」交替时，模型看到的是完整的时间顺序，
         * 而不是把 RP 全堆进 system 提示词、微信消息单独排成一条线——
         * 后者会让模型分不清某段 RP 是在这轮微信之前还是之后。
         *
         * 再叠两条压缩，避免来回切换几次就把消息额度吃满：
         * - 相邻同角色气泡合并：整段历史都合并（含最近一轮），发出去的是一轮一条，
         *   而不是 assistant 拆成 4 条分别发。跨轮因 user/assistant 交替天然分开。
         * - 有前情提要时，被 recap 覆盖的旧 RP 块与旧微信段一律剔除（内容已进提要）；
         *   没有提要、但记忆开着时，退回「只留最近一段 RP 块」的旧做法。
         */
        const buildWechatModelMessages = () => {
            const entries = [];
            let rpBuffer = [];
            let wxSeen = 0;
            const flushRp = () => {
                if (!rpBuffer.length) return;
                const block = buildWechatRpBlock(rpBuffer);
                const maxRpIndex = rpBuffer.reduce((max, item) =>
                    Number.isFinite(item.rpIndex) ? Math.max(max, item.rpIndex) : max, -1);
                rpBuffer = [];
                if (block) entries.push({ message: { role: 'user', content: block }, mergeable: false, rp: true, maxRpIndex });
            };

            for (const item of wechatTimeline.value) {
                if (item.channel === 'rp') {
                    rpBuffer.push(item);
                    continue;
                }
                if (item.channel !== 'wechat') continue;
                flushRp();
                if (item.role !== 'user' && item.role !== 'assistant') continue;
                wxSeen += 1;
                if (item.type === 'image' && item.role === 'user') {
                    const parts = [];
                    if (item.content) parts.push({ type: 'image_url', image_url: { url: item.content } });
                    // content 是数组，拼不了，也就不参与合并
                    entries.push({ message: { role: 'user', content: parts.length ? parts : '(图片)' }, mergeable: false, wxSeen });
                } else if (item.type === 'sticker') {
                    // 标成 [表情 名字]：名字本身可能是句话（如「安排-被安排的明明白白」），
                    // 不标的话模型会把它当普通文字读、进而幻觉。与 RP 方向 buildWechatRpSegment 一致。
                    const name = String(item.content || '').trim();
                    entries.push({ message: { role: item.role, content: name ? `[表情 ${name}]` : '[表情]' }, mergeable: true, wxSeen });
                } else {
                    const text = String(item.content || '').trim();
                    if (text) entries.push({ message: { role: item.role, content: text }, mergeable: true, wxSeen });
                }
            }
            // 时间线以 RP 收尾时（刚 RP 完还没发微信），这段同样是当前对话的背景
            flushRp();

            let kept;
            const coverage = recapCoverage();
            if (coverage) {
                // 前情提要覆盖到的旧内容（RP 块、微信段）不再注入，提要已代表它们
                kept = entries.filter(entry => entry.rp
                    ? (coverage.rpMaxIndex >= 0 && entry.maxRpIndex > coverage.rpMaxIndex)
                    : !(Number.isFinite(entry.wxSeen) && entry.wxSeen <= coverage.wxCount));
            } else {
                const memoryCoversHistory = __s.memorySettings?.enabled === true
                    && (__s.classicMemories?.value || []).length > 0;
                kept = memoryCoversHistory ? dropEarlierRpBlocks(entries) : entries;
            }

            const merged = [];
            kept.forEach((entry) => {
                const previous = merged[merged.length - 1];
                if (entry.mergeable && previous?.mergeable
                    && previous.message.role === entry.message.role) {
                    previous.message.content = `${previous.message.content}\n${entry.message.content}`;
                    return;
                }
                merged.push({ message: { ...entry.message }, mergeable: entry.mergeable });
            });

            const head = merged.slice(-WECHAT_HISTORY_LIMIT).map(entry => entry.message);
            // 前情提要是对话记录的开头（不是 system 预设）：摘要、最近 RP 原文、最近微信原文各自成条，
            // 排在被覆盖的老内容之前（老内容已剔除），夹在 system 与聊天记录之间。
            const recapMessages = __s.buildStoryRecapMessages ? __s.buildStoryRecapMessages() : [];
            if (recapMessages.length) {
                head.unshift(...recapMessages);
            }
            return head;
        };

        // ---- 回 RP：微信段按时间位置插回对话 ----
        //
        // docs/wechat-and-RP.md 里 RP 侧上下文必须还原「RP1→微信1→RP2→微信2」的时间交错，
        // 而不是把所有微信拍成一段挪到最前或最后（那样顺序错位、跨段全缺）。做法：
        // 时间线里每一段连续微信压成一条「微信聊天记录」背景块（**段内**多条拍平成一处，
        // 这是刻意设计——降低请求条数，用户视角仍是分块），再按这段微信紧邻的那条 RP 消息
        // （镜像的 rpIndex = chatHistory 索引）插回它在对话里的原始位置。
        const buildWechatRpSegment = (items) => {
            if (!items.length) return null;
            const char = __s.currentCharacter.value;
            const who = String(char?.wechatPeerName || '').trim() || char?.name || '对方';
            // 玩家用名字（__s.user.name），不用「你」：这段插回 RP 上下文后，「你」= 主角 = 这个角色，
            // 玩家发言标成「你」会跟角色撞车，模型分不清谁说的。与 §8 摘要、{{user}} 替换口径一致。
            const playerName = String(__s.user?.name || '').trim() || '对方';
            const lines = items.map((item) => {
                const name = item.role === 'user' ? playerName : who;
                if (item.type === 'image') return `${name}：[图片]`;
                if (item.type === 'sticker') return `${name}：[表情 ${item.content}]`;
                return `${name}：${item.content}`;
            });
            return {
                role: 'user',
                content: `【微信聊天记录｜以下是你们在现实里互加微信后的对话，作为你已知的背景，不是 roleplay 正文】\n`
                    + `${who}在微信上和你说：\n`
                    + lines.join('\n'),
                _sourceIndexes: [],
                _preventContextMerge: true
            };
        };

        /**
         * 在 RP 上下文组装之后调用：按时间位置把每一段微信插进 messages。
         * - 锚点 = 这段微信之前最近一条 RP 镜像的 rpIndex（= chatHistory 索引）；
         *   插入位在「最后一条源索引 ≤ 锚点」的消息之后。
         * - 已被前情提要覆盖的微信段（coversWechatCount 前缀）跳过——那段内容已进提要。
         * - 段内没有 RP 镜像（RP 关闭 / 消息被删）时锚点为 null，落到收尾，避免错插。
         */
        const appendWechatDigestToMessages = (messages) => {
            const char = __s.currentCharacter.value;
            if (!char?.wechatEnabled) return messages;
            const coveredWx = (__s.recapCoverageRange?.() || {}).wxCount || 0;
            const segments = [];
            let buffer = [];
            let lastRpIndex = null;
            let wxSeen = 0;
            const flush = () => {
                if (buffer.length) segments.push({ items: buffer, anchor: lastRpIndex });
                buffer = [];
            };
            for (const item of wechatTimeline.value) {
                if (item.channel === 'wechat') {
                    if (item.role === 'system') continue;
                    wxSeen += 1;
                    if (wxSeen <= coveredWx) continue;
                    buffer.push(item);
                } else if (item.channel === 'rp') {
                    flush();
                    if (Number.isFinite(item.rpIndex)) lastRpIndex = item.rpIndex;
                }
            }
            flush();
            if (!segments.length) return messages;

            const pending = segments
                .map(seg => ({ anchor: seg.anchor, block: buildWechatRpSegment(seg.items) }))
                .filter(entry => entry.block);

            const result = [];
            for (const message of messages) {
                const sources = (Array.isArray(message._sourceIndexes) ? message._sourceIndexes : [])
                    .filter(Number.isFinite);
                if (sources.length) {
                    const minSource = Math.min(...sources);
                    // 锚点 < 本条最小源索引 → 这段微信应落在本条之前（即上一条之后）
                    for (let i = pending.length - 1; i >= 0; i--) {
                        if (Number.isFinite(pending[i].anchor) && pending[i].anchor < minSource) {
                            result.push(pending[i].block);
                            pending.splice(i, 1);
                        }
                    }
                }
                result.push(message);
            }
            for (const entry of pending) result.push(entry.block);
            return result;
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
            // 已镜像的 RP 消息可能被编辑/删除过，重新对齐，免得发出去还是旧文案。
            if (reconcileRpTimeline()) {
                resetRpRecordCursor();
                scheduleWechatSave();
            }
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
            showWechatStickers.value = false;
            showStickerManager.value = false;
            showStickerStore.value = false;
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

        /**
         * 最近一条对方（assistant）消息之后、自己（user）还没被回应了几条。
         * 连发模式下用它提示「你攒了 N 条，还没让对方回」。只在微信消息里数，RP 镜像不算。
         */
        const wechatUnansweredCount = computed(() => {
            let count = 0;
            for (const item of wechatTimeline.value) {
                if (item.channel !== 'wechat') continue;
                if (item.role === 'assistant') count = 0;
                else if (item.role === 'user') count++;
            }
            return count;
        });
        __s.wechatUnansweredCount = wechatUnansweredCount;

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

        // ---- 剪贴板粘贴图片 / 头像上传 ----
        /** 微信输入框粘贴：从剪贴板里捞出图片文件，走和 📎 同一条压缩链路。 */
        const handleWechatPaste = async (event) => {
            const items = event?.clipboardData?.items;
            if (!items) return;
            const file = [...items]
                .find(item => item.type && item.type.startsWith('image/'))
                ?.getAsFile();
            if (!file) return; // 纯文字粘贴交给 textarea 原生行为
            event.preventDefault();
            try {
                const dataUrl = await fileToDataURL(file);
                wechatPendingImage.value = await compressImage(dataUrl, 1024, 0.82);
            } catch (error) {
                __s.showToast(`图片处理失败：${error.message}`, 'error');
            }
        };
        __s.handleWechatPaste = handleWechatPaste;

        /**
         * 头像上传（微信内点击头像触发，靠 <label> 包隐藏 input 弹出选择器）。
         * which 为 'user' 改自己头像（__s.user，走 saveData），否则改当前角色头像。
         */
        const handleWechatAvatarSelection = async (which, event) => {
            const file = event?.target?.files?.[0];
            if (event?.target) event.target.value = '';
            if (!file) return;
            if (!file.type.startsWith('image/')) {
                __s.showToast('只能上传图片文件', 'warning');
                return;
            }
            try {
                const dataUrl = await compressImage(await fileToDataURL(file), 200, 0.7);
                if (which === 'user') {
                    __s.user.avatar = dataUrl;
                    await __s.saveData({ saveMemories: false, saveCharacters: false });
                } else {
                    const char = __s.currentCharacter.value;
                    if (!char) return;
                    char.avatar = dataUrl;
                    await __s.saveCharactersNow();
                }
                __s.showToast('头像已更新', 'success');
            } catch (error) {
                __s.showToast(`头像处理失败：${error.message}`, 'error');
            }
        };
        __s.handleWechatAvatarSelection = handleWechatAvatarSelection;

        // ---- 表情包库 CRUD ----
        const openWechatStickers = () => {
            showStickerStore.value = false;
            showWechatStickers.value = true;
        };
        __s.openWechatStickers = openWechatStickers;

        const openStickerManager = () => {
            resetStickerDraft();
            showWechatStickers.value = false;
            showWechatSettings.value = false;
            showStickerStore.value = false;
            showStickerManager.value = true;
        };
        __s.openStickerManager = openStickerManager;

        const resetStickerDraft = () => {
            stickerDraft.id = '';
            stickerDraft.name = '';
            stickerDraft.description = '';
            stickerDraft.image = '';
        };
        __s.resetStickerDraft = resetStickerDraft;

        const editSticker = (sticker) => {
            stickerDraft.id = sticker.id;
            stickerDraft.name = sticker.name;
            stickerDraft.description = sticker.description || '';
            stickerDraft.image = sticker.image;
        };
        __s.editSticker = editSticker;

        const handleStickerImageSelection = async (event) => {
            const file = event?.target?.files?.[0];
            if (event?.target) event.target.value = '';
            if (!file) return;
            if (!file.type.startsWith('image/')) {
                __s.showToast('只能上传图片文件', 'warning');
                return;
            }
            try {
                const dataUrl = await fileToDataURL(file);
                stickerDraft.image = await compressImage(dataUrl, 1024, 0.82);
            } catch (error) {
                __s.showToast(`图片处理失败：${error.message}`, 'error');
            }
        };
        __s.handleStickerImageSelection = handleStickerImageSelection;

        /** 保存（新增或改名）：name 必须唯一——重名会让「名字→图」映射二义，直接拒绝。 */
        const saveSticker = async () => {
            const name = String(stickerDraft.name || '').trim();
            if (!name) {
                __s.showToast('请填写表情包名字', 'warning');
                return;
            }
            if (!stickerDraft.image) {
                __s.showToast('请先上传表情包图片', 'warning');
                return;
            }
            const duplicate = wechatStickers.value.find(
                sticker => sticker.name === name && sticker.id !== stickerDraft.id
            );
            if (duplicate) {
                __s.showToast(`已有叫「${name}」的表情包，换个名字`, 'warning');
                return;
            }
            const existing = stickerDraft.id
                ? wechatStickers.value.find(sticker => sticker.id === stickerDraft.id)
                : null;
            if (existing) {
                existing.name = name;
                existing.description = String(stickerDraft.description || '').trim().slice(0, WECHAT_STICKER_DESC_LIMIT);
                existing.image = stickerDraft.image;
            } else {
                wechatStickers.value.push(normalizeSticker({
                    name,
                    description: stickerDraft.description,
                    image: stickerDraft.image
                }));
            }
            resetStickerDraft();
            await saveWechatStickers();
            __s.showToast('已保存', 'success');
        };
        __s.saveSticker = saveSticker;

        const deleteSticker = (sticker) => {
            __s.confirmAction(`确定删除表情包「${sticker.name}」吗？历史记录里发过的会回退成文本。`, async () => {
                wechatStickers.value = wechatStickers.value.filter(item => item.id !== sticker.id);
                if (stickerDraft.id === sticker.id) resetStickerDraft();
                await saveWechatStickers();
                __s.showToast('已删除', 'success');
            });
        };
        __s.deleteSticker = deleteSticker;

        /**
         * 用户发一个表情包：写进时间线的 type=sticker + content=名字，
         * 与模型发的那条走同一个渲染路径（§9.6「双方都能发」）。
         */
        const sendWechatSticker = async (sticker) => {
            if (!sticker?.name) return;
            if (!__s.currentCharacter.value) {
                __s.showToast('请先选择一个角色', 'warning');
                return;
            }
            if (isWechatGenerating.value) return;
            pushWechatItem({ channel: 'wechat', role: 'user', type: 'sticker', content: sticker.name });
            scheduleWechatSave();
            showWechatStickers.value = false;
            scrollWechatToBottom();
            if (wechatBurstMode.value) return;
            await runWechatGeneration();
        };
        __s.sendWechatSticker = sendWechatSticker;

        // ---- 开源表情包商店（CDN 清单 → 导入本地库）----
        const stickerStoreKey = (cat, file) => `${cat} ${file}`;
        const stickerStorePickName = (file) => String(file || '').replace(/\.[^.]+$/, '').trim();
        /** 有意义的文件名当「适用场景」；QQ图片xxx 这类无意义名退回分类名。 */
        const stickerStorePickDesc = (cat, name) => {
            const meaningful = name && /[一-龥A-Za-z]/.test(name)
                && !/^(QQ图片|IMG[_-]?\d|DSC[_-]?\d|\d{6,})/i.test(name);
            return (meaningful ? name : cat).slice(0, WECHAT_STICKER_DESC_LIMIT);
        };
        /** 导入后的库内名字：分类前缀保证唯一，同时把「这是什么」带进名字。 */
        const stickerStoreItemName = (cat, file) =>
            `${cat}-${stickerStorePickName(file)}`.slice(0, WECHAT_STICKER_NAME_LIMIT);

        const stickerStoreFileUrl = (cat, file, useFallback = false) => {
            const catalog = window.RPHubEmojiCatalog || {};
            const base = (useFallback ? catalog.fallbackBase : catalog.base) || catalog.base || '';
            if (!base) return '';
            return `${base}/${[cat, file].map(encodeURIComponent).join('/')}`;
        };
        __s.stickerStoreFileUrl = stickerStoreFileUrl;

        /**
         * 跨域图片 → dataURL。必须 crossOrigin='anonymous'（CDN 已给 ACAO:*），
         * 否则 canvas 被污染、toDataURL 抛 SecurityError。失败返回 null 由调用方回退存 URL。
         */
        const remoteImageToDataURL = (url, maxWidth, quality) => new Promise((resolve) => {
            const image = new Image();
            image.crossOrigin = 'anonymous';
            image.onload = () => {
                try {
                    const w = image.naturalWidth || image.width;
                    const h = image.naturalHeight || image.height;
                    const scale = Math.min(1, maxWidth / w);
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round(w * scale));
                    canvas.height = Math.max(1, Math.round(h * scale));
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                } catch (_) {
                    resolve(null);
                }
            };
            image.onerror = () => resolve(null);
            image.src = url;
        });
        __s.remoteImageToDataURL = remoteImageToDataURL;

        const stickerStoreCatalog = computed(() => window.RPHubEmojiCatalog || null);
        __s.stickerStoreCatalog = stickerStoreCatalog;

        /** 分类列表（含「全部」）。用于商店顶部筛选。 */
        const stickerStoreCategories = computed(() => {
            const catalog = stickerStoreCatalog.value;
            if (!catalog) return [];
            const total = catalog.categories.reduce((sum, cat) => sum + cat.files.length, 0);
            return [
                { name: WECHAT_STICKER_ACTIVE_CAT, label: `全部 ${total}` },
                ...catalog.categories.map(cat => ({ name: cat.name, label: `${cat.name} ${cat.files.length}` }))
            ];
        });
        __s.stickerStoreCategories = stickerStoreCategories;

        /** 当前筛选下要展示的条目（带 key / 加载状态）。 */
        const stickerStoreVisible = computed(() => {
            const catalog = stickerStoreCatalog.value;
            if (!catalog) return [];
            const active = stickerStoreActiveCat.value;
            const cats = active === WECHAT_STICKER_ACTIVE_CAT
                ? catalog.categories
                : catalog.categories.filter(cat => cat.name === active);
            const out = [];
            for (const cat of cats) {
                for (const file of cat.files) {
                    out.push({ key: stickerStoreKey(cat.name, file), cat: cat.name, file });
                }
            }
            return out;
        });
        __s.stickerStoreVisible = stickerStoreVisible;

        /** 已在库里的条目（按库内名字判重），用于商店里标「已加入」。 */
        const stickerStoreLoadedNames = computed(() =>
            new Set(wechatStickers.value.map(sticker => sticker.name)));
        __s.stickerStoreLoadedNames = stickerStoreLoadedNames;
        const stickerStoreItemState = (cat, file) =>
            stickerStoreLoadedNames.value.has(stickerStoreItemName(cat, file)) ? 'loaded' : 'new';
        __s.stickerStoreItemState = stickerStoreItemState;

        const stickerStoreIsPicked = (key) => stickerStorePicked.value.includes(key);
        __s.stickerStoreIsPicked = stickerStoreIsPicked;
        const toggleStickerStorePick = (key) => {
            const next = stickerStorePicked.value.slice();
            const i = next.indexOf(key);
            if (i >= 0) next.splice(i, 1);
            else next.push(key);
            stickerStorePicked.value = next;
        };
        __s.toggleStickerStorePick = toggleStickerStorePick;

        /** 选中/取消「当前筛选下」的整类未导入项。 */
        const toggleStickerStorePickAll = () => {
            const visible = stickerStoreVisible.value;
            const allPicked = visible.length > 0 && visible.every(item => stickerStoreIsPicked(item.key));
            stickerStorePicked.value = allPicked ? [] : visible.map(item => item.key);
        };
        __s.toggleStickerStorePickAll = toggleStickerStorePickAll;

        const openStickerStore = () => {
            showWechatStickers.value = false;
            showStickerManager.value = false;
            showWechatSettings.value = false;
            // 默认停在第一个分类，而不是「全部」——全部有 2000+ 张，一次铺开会很重
            stickerStoreActiveCat.value = window.RPHubEmojiCatalog?.categories?.[0]?.name
                || WECHAT_STICKER_ACTIVE_CAT;
            stickerStorePicked.value = [];
            showStickerStore.value = true;
        };
        __s.openStickerStore = openStickerStore;
        const closeStickerStore = () => { showStickerStore.value = false; };
        __s.closeStickerStore = closeStickerStore;
        const setStickerStoreCat = (name) => { stickerStoreActiveCat.value = name; };
        __s.setStickerStoreCat = setStickerStoreCat;

        /**
         * 导入一批：静态图压缩存本地 dataURL（离线可用），动图 GIF 保留动画、直接存 CDN 引用。
         * 跨域压缩失败时退到备用 CDN 的 URL 引用；同名（已导入过）跳过。
         */
        const importStickerStoreItems = async (items) => {
            if (!items.length || stickerStoreImporting.value) return;
            stickerStoreImporting.value = true;
            let added = 0, dup = 0, failed = 0;
            try {
                for (const { cat, file } of items) {
                    const name = stickerStoreItemName(cat, file);
                    if (wechatStickers.value.some(sticker => sticker.name === name)) { dup++; continue; }
                    const isGif = /\.gif$/i.test(file);
                    let image = '';
                    if (isGif) {
                        image = stickerStoreFileUrl(cat, file);
                    } else {
                        image = await remoteImageToDataURL(stickerStoreFileUrl(cat, file), 1024, 0.82)
                            || stickerStoreFileUrl(cat, file, true);
                    }
                    if (!image) { failed++; continue; }
                    wechatStickers.value.push(normalizeSticker({
                        name,
                        description: stickerStorePickDesc(cat, stickerStorePickName(file)),
                        image
                    }));
                    added++;
                }
                if (added) await saveWechatStickers();
            } finally {
                stickerStoreImporting.value = false;
            }
            const parts = [`导入 ${added} 个`];
            if (dup) parts.push(`跳过重复 ${dup}`);
            if (failed) parts.push(`失败 ${failed}`);
            __s.showToast(parts.join('，'), added ? 'success' : 'info');
            if (added) stickerStorePicked.value = [];
        };
        __s.importStickerStoreItems = importStickerStoreItems;

        const importStickerStorePicked = () =>
            importStickerStoreItems(stickerStoreVisible.value.filter(item => stickerStoreIsPicked(item.key)));
        __s.importStickerStorePicked = importStickerStorePicked;

        /** 一键导入本类全部：已导入的会按名字跳过。 */
        const importStickerStoreCategory = () => {
            const items = stickerStoreVisible.value.map(({ cat, file }) => ({ cat, file }));
            importStickerStoreItems(items);
        };
        __s.importStickerStoreCategory = importStickerStoreCategory;

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

        /**
         * 生成一轮微信回复（纯生成 + 播放，不负责把触发消息写进时间线）。
         * 发文字/发图/发表情包共用：调用方先把触发的消息 push 进时间线，再调这里。
         */
        const runWechatGeneration = async () => {
            if (isWechatGenerating.value) return;
            if (!__s.currentCharacter.value) {
                __s.showToast('请先选择一个角色', 'warning');
                return;
            }
            if (!__s.settings.apiUrl || !__s.settings.apiKey || !__s.settings.model) {
                __s.showToast('请先在设置里填写 API 地址、Key 和模型', 'warning');
                return;
            }

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
        __s.runWechatGeneration = runWechatGeneration;

        const sendWechatMessage = async () => {
            const text = String(wechatInput.value || '').trim();
            const image = wechatPendingImage.value;
            if ((!text && !image) || isWechatGenerating.value) return;

            wechatInput.value = '';
            wechatPendingImage.value = null;

            if (text) pushWechatItem({ channel: 'wechat', role: 'user', type: 'text', content: text });
            if (image) pushWechatItem({ channel: 'wechat', role: 'user', type: 'image', content: image });
            scheduleWechatSave();
            scrollWechatToBottom();

            // 连发模式：只落成气泡，攒到你点「让对方回复」再发请求
            if (wechatBurstMode.value) return;
            await runWechatGeneration();
        };
        __s.sendWechatMessage = sendWechatMessage;

        /**
         * 连发模式下，把攒着的发言一次性交给对方回应。
         * 没攒任何东西就不触发（避免空请求）。
         */
        const requestWechatReplyNow = async () => {
            if (isWechatGenerating.value || !wechatUnansweredCount.value) return;
            await runWechatGeneration();
        };
        __s.requestWechatReplyNow = requestWechatReplyNow;

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
                items.push({
                    kind: 'message',
                    id: item.id,
                    role: item.role,
                    type: item.type,
                    content: item.content,
                    // 命中表情包库则带上图，前端据此渲染成图；未命中为 null，回退文本。
                    stickerImage: item.type === 'sticker' ? stickerImageOf(item.content) : null
                });
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
