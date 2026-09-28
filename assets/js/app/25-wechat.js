/**
 * RP-Hub 应用模块 25 · 微信聊天子系统
 *
 * 目标：角色扮演（RP）↔ 拟真微信 双场景互通，共享角色记忆，按统一时间线无缝衔接。
 *
 * 核心设计（见 docs/ARCHITECTURE.md §7）：
 * - 统一时间线：每条消息写 { id, ts, channel: 'rp' | 'wechat', role, type, content }，
 *   存在角色作用域键 'wechat_timeline'（粒度跟随剧情分支，与 chat 一致）。
 * - 进微信：system prompt = 该角色卡人设 + "你们刚才在以 roleplay 方式互动" + RP 近况摘要；
 *   微信历史只取 channel==='wechat' 的段。
 * - 回 RP：把"最后一次 RP 之后"的微信段改写成第三人称剧情片段，附到最新用户消息末尾。
 * - 微信侧生成复用 requestTrackedChatCompletion（RP 当前模型）+ 微信 agent 的 JSON 分段协议
 *   与打字节奏；不触发 RP 的世界书/正则/记忆抽取管线，避免互相污染。
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
        const WECHAT_TIMELINE_KEY = 'wechat_timeline';

        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const rand = (a, b) => a + Math.random() * (b - a);

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
            speed: 'normal'
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

        // ---- 进微信：RP 近况摘要 ----
        const buildRpDigestForWechat = () => {
            const char = __s.currentCharacter.value;
            const history = __s.chatHistory.value;
            if (!char || history.length === 0) return '';
            let snapshot;
            try {
                snapshot = __s.buildConversationTurnSnapshot(history, { includeSystem: false });
            } catch (_) {
                return '';
            }
            const turns = (snapshot?.turns || []).slice(-12);
            if (!turns.length) return '';
            const lines = turns.map((turn) => {
                const userText = String(turn.user?.content || '').trim().slice(0, 160);
                const assistantText = String(turn.assistant?.content || '').trim().slice(0, 160);
                return `对方：${userText}\n你（${char.name}）：${assistantText}`;
            });
            return [
                `你们刚才在以 roleplay 方式互动，最近几段是这样的（只作为背景，不要在微信里复述）：`,
                ...lines
            ].join('\n');
        };
        __s.buildRpDigestForWechat = buildRpDigestForWechat;

        const buildWechatSystemPrompt = () => {
            const char = __s.currentCharacter.value || {};
            const persona = String(char.wechatPersona || '').trim()
                || String(char.personality || '').trim()
                || String(char.description || '').trim();
            return wxProtocol.buildSystemPrompt(persona, {
                relation: String(char.wechatRelation || '').trim(),
                scene: String(char.wechatScene || '').trim(),
                rpSummary: buildRpDigestForWechat(),
                extraRules: `【重要】你们既是 roleplay 里的关系，也是现实里互加微信的人。`
                    + `把 roleplay 中已建立的称呼、关系、默契带进微信，像真人一样随口聊天，不要重来一遍自我介绍。`
            });
        };
        __s.buildWechatSystemPrompt = buildWechatSystemPrompt;

        // ---- 微信历史 → 模型消息 ----
        const buildWechatModelMessages = () => {
            const rows = wechatTimeline.value.filter((item) => item.channel === 'wechat');
            const history = [];
            for (const item of rows) {
                if (item.role !== 'user' && item.role !== 'assistant') continue;
                if (item.type === 'image' && item.role === 'user') {
                    const parts = [];
                    if (item.content) parts.push({ type: 'image_url', image_url: { url: item.content } });
                    history.push({ role: 'user', content: parts.length ? parts : '(图片)' });
                } else if (item.type === 'sticker') {
                    history.push({ role: item.role, content: item.content });
                } else {
                    const text = String(item.content || '').trim();
                    if (text) history.push({ role: item.role, content: text });
                }
            }
            return history.slice(-WECHAT_HISTORY_LIMIT);
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
            const char = __s.currentCharacter.value;
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
            return messages;
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
