/**
 * RP-Hub 应用模块 26 · 前情提要（上下文压缩）
 *
 * 设计见 docs/ARCHITECTURE.md §8。长期记忆是「每轮一份缩写」，和 RP/微信原文混排时会
 * 「弄没」（旧的被粗暴丢弃）或「多一份」（原文 + 摘要重复）。这里引入 agent 式的上下文
 * 压缩：用户从聊天快捷面板点「压缩上下文」，把**当前全部** RP 轮次 + 微信时间线（连同更早的
 * 旧提要）交给模型，压成一份第三人称「前情提要」。
 *
 * - 原文不销毁：chatHistory 与 wechat_timeline 原样保留，只是不再进上下文，前情提要代表它们。
 * - 覆盖范围用前缀计数表达：coversThroughTurn（覆盖到第几轮 RP）+ coversWechatCount（覆盖多少条微信）。
 *   压缩即全量，所以这两个计数恒等于「压缩那一刻」的全部内容。
 * - 保留窗口：摘要有损耗，除摘要外再各发一条最近 RP 原文、一条最近微信原文（独立 user 消息，不揉在
 *   摘要里）。最近这段原文能让模型接得上当下语气与细节，用户也没有「割裂感」。保留条数
 *   keepRPTurns / keepWechatCount 用户可调，存进 recap 对象（见下）。
 * - RP 侧：recap 作为独立 message 注入，被覆盖的老轮次（及其 per-turn 记忆）从上下文剔除。
 * - 微信侧：recap 作为对话记录首条注入（不进 system），被覆盖的旧 RP 块与微信老段剔除；记忆只注入
 *   未被覆盖的轮次。
 * - 压缩素材的顺序：按统一时间线 wechat_timeline 交错（RP1→微信1→RP2→微信2→RP3），不是
 *   「先全部 RP 再全部微信」——否则微信段会被判成发生在最后一轮之后。
 */
(function () {
    window.RPHubAppSections = window.RPHubAppSections || {};
    window.RPHubAppSections.recap = function (__s) {
        const STORY_RECAP_KEY = 'story_recap';
        // 保留条数设置与 recap 同库不同 scope：跨分支共享，改一次即对以后所有压缩生效。
        const RECAP_KEEP_SETTINGS_KEY = 'story_recap_keep_settings';
        const RECAP_KEEP_RP_TURNS_DEFAULT = 3;
        const RECAP_KEEP_RP_TURNS_MIN = 0;
        const RECAP_KEEP_RP_TURNS_MAX = 10;
        const RECAP_KEEP_WECHAT_COUNT_DEFAULT = 6;
        const RECAP_KEEP_WECHAT_COUNT_MIN = 0;
        const RECAP_KEEP_WECHAT_COUNT_MAX = 30;
        const recapScopeId = () => __s.getCurrentStoryBranchScopeId();

        const clampInt = (value, min, max, fallback) => {
            const number = Math.floor(Number(value));
            if (!Number.isFinite(number)) return fallback;
            return Math.min(max, Math.max(min, number));
        };

        const storyRecap = ref(null);
        __s.storyRecap = storyRecap;
        let loadedRecapScopeId = null;
        const isRecapGenerating = ref(false);
        __s.isRecapGenerating = isRecapGenerating;

        const normalizeRecap = (value) => {
            if (!value || typeof value !== 'object') return null;
            const text = String(value.text || '').trim();
            if (!text) return null;
            return {
                text,
                coversThroughTurn: Math.max(0, Number(value.coversThroughTurn) || 0),
                coversWechatCount: Math.max(0, Number(value.coversWechatCount) || 0),
                keepRPTurns: clampInt(value.keepRPTurns, RECAP_KEEP_RP_TURNS_MIN, RECAP_KEEP_RP_TURNS_MAX, RECAP_KEEP_RP_TURNS_DEFAULT),
                keepWechatCount: clampInt(value.keepWechatCount, RECAP_KEEP_WECHAT_COUNT_MIN, RECAP_KEEP_WECHAT_COUNT_MAX, RECAP_KEEP_WECHAT_COUNT_DEFAULT),
                createdAt: Number(value.createdAt) || 0
            };
        };

        // 快捷面板上的保留条数选择（跨分支），未载入前用默认值。
        const recapKeepSettings = reactive({
            rpTurns: RECAP_KEEP_RP_TURNS_DEFAULT,
            wechatCount: RECAP_KEEP_WECHAT_COUNT_DEFAULT
        });
        __s.recapKeepSettings = recapKeepSettings;
        let loadedKeepSettings = false;

        const ensureRecapKeepSettingsLoaded = async () => {
            if (loadedKeepSettings) return;
            loadedKeepSettings = true;
            try {
                if (!getMainDb()) await initDB();
                const stored = await getStoredValue(RECAP_KEEP_SETTINGS_KEY);
                if (stored && typeof stored === 'object') {
                    recapKeepSettings.rpTurns = clampInt(stored.rpTurns, RECAP_KEEP_RP_TURNS_MIN, RECAP_KEEP_RP_TURNS_MAX, RECAP_KEEP_RP_TURNS_DEFAULT);
                    recapKeepSettings.wechatCount = clampInt(stored.wechatCount, RECAP_KEEP_WECHAT_COUNT_MIN, RECAP_KEEP_WECHAT_COUNT_MAX, RECAP_KEEP_WECHAT_COUNT_DEFAULT);
                }
            } catch (error) {
                console.error('读取保留条数设置失败:', error);
            }
        };
        __s.ensureRecapKeepSettingsLoaded = ensureRecapKeepSettingsLoaded;

        /** 面板上改保留条数：立即落盘，供**下一次**压缩使用（已生成的提要沿用当时的值）。 */
        const setRecapKeepSettings = async (patch = {}) => {
            if (patch.rpTurns !== undefined) {
                recapKeepSettings.rpTurns = clampInt(patch.rpTurns, RECAP_KEEP_RP_TURNS_MIN, RECAP_KEEP_RP_TURNS_MAX, RECAP_KEEP_RP_TURNS_DEFAULT);
            }
            if (patch.wechatCount !== undefined) {
                recapKeepSettings.wechatCount = clampInt(patch.wechatCount, RECAP_KEEP_WECHAT_COUNT_MIN, RECAP_KEEP_WECHAT_COUNT_MAX, RECAP_KEEP_WECHAT_COUNT_DEFAULT);
            }
            try {
                if (!getMainDb()) await initDB();
                await setStoredValue(RECAP_KEEP_SETTINGS_KEY, {
                    rpTurns: recapKeepSettings.rpTurns,
                    wechatCount: recapKeepSettings.wechatCount
                });
            } catch (error) {
                console.error('保存保留条数设置失败:', error);
            }
        };
        __s.setRecapKeepSettings = setRecapKeepSettings;

        /** 作用域切换后首次调用从 DB 载入。 */
        const ensureStoryRecapLoaded = async (force = false) => {
            const scope = recapScopeId();
            if (!force && loadedRecapScopeId === scope) return;
            loadedRecapScopeId = scope;
            if (!scope) { storyRecap.value = null; return; }
            try {
                if (!getMainDb()) await initDB();
                storyRecap.value = normalizeRecap(await getScopedStoredValue(STORY_RECAP_KEY, scope));
                await ensureRecapKeepSettingsLoaded();
            } catch (error) {
                console.error('读取前情提要失败:', error);
                storyRecap.value = null;
            }
        };
        __s.ensureStoryRecapLoaded = ensureStoryRecapLoaded;

        const saveStoryRecapNow = async (value = storyRecap.value, scope = recapScopeId()) => {
            if (!scope) return false;
            if (!getMainDb()) await initDB();
            await setScopedStoredValue(STORY_RECAP_KEY, scope, value ? cloneForStorage(value) : null, { clone: false });
            return true;
        };
        __s.saveStoryRecapNow = saveStoryRecapNow;

        const countWechatMessages = () => (__s.wechatTimeline?.value || [])
            .filter(item => item.channel === 'wechat' && item.role !== 'system').length;

        /**
         * 压缩覆盖范围：**全部** RP 轮次 + 全部微信消息。
         * 覆盖点仍是「压缩那一刻的全部内容」；摘要下面另按 keepRPTurns/keepWechatCount 贴回最新原文，
         * 但那是注入层的保留窗口，不改覆盖计数。之后只追加新内容。
         */
        const computeRecapCoverage = () => {
            const turns = (__s.buildConversationTurnSnapshot(__s.chatHistory.value, { includeSystem: false }).turns || []).length;
            const wechatTotal = countWechatMessages();
            const prev = storyRecap.value;
            return {
                turns,
                wechatTotal,
                coversThroughTurn: turns,
                coversWechatCount: wechatTotal,
                // UI 用：相比上次压缩是否有新增内容（多了才值得再点）
                hasNewContent: turns > (prev?.coversThroughTurn || 0)
                    || wechatTotal > (prev?.coversWechatCount || 0)
            };
        };
        __s.computeRecapCoverage = computeRecapCoverage;

        /** 单条微信消息 → 转述素材行。 */
        const formatRecapWechatLine = (item, characterName) => {
            const name = item.role === 'user' ? __s.user.name : characterName;
            if (item.type === 'image') return `${name}：[图片]`;
            if (item.type === 'sticker') return `${name}：[表情 ${item.content}]`;
            return `${name}：${item.content}`;
        };

        /**
         * 截止点前的 RP 正文（压缩素材），按 chatHistory 下标索引。
         * 用 sourceIndexes 而不是 messageIndexes：前者是原始 chatHistory 下标，和 wechat_timeline
         * 里 RP 镜像的 rpIndex 对齐，交错时才放得回原位。正文先走一遍 RP 侧清洗（去 CoT / UI 模板 /
         * 下一句提示 / 图片上下文），免得原始注入漏进提要。
         */
        const collectRecapRpEntries = (coversThroughTurn) => {
            const entries = [];
            if (coversThroughTurn <= 0) return entries;
            const snapshot = __s.buildConversationTurnSnapshot(__s.chatHistory.value, { includeSystem: false });
            (snapshot.turns || []).slice(0, coversThroughTurn).forEach((turnInfo) => {
                (turnInfo.sourceIndexes || []).forEach((index) => {
                    const message = __s.chatHistory.value[index];
                    if (!message || !['user', 'assistant'].includes(message.role)) return;
                    const parsedMain = window.RPHubUtils.parseCot(String(message.content || '')).main;
                    const text = __s.stripDisabledImageGenContext(
                        __s.stripNextResponsePrompt(__s.stripUiTemplateContextInjection(parsedMain))
                    ).replace(/\s+/g, ' ').trim();
                    if (text) entries.push({ index, turn: turnInfo.turn, text });
                });
            });
            return entries;
        };

        /**
         * 压缩素材：按**剧情真实发生的顺序**交错排列 RP 轮次与微信消息。
         *
         * 权威顺序来自统一时间线 wechat_timeline（`channel: 'rp'` 的镜像带 rpIndex，
         * `channel: 'wechat'` 就是微信消息本身），于是「RP1→微信1→RP2→微信2→RP3」能原样重现。
         * 若按「先全部 RP、再全部微信」拼，整段微信会被判成发生在最后一轮之后，压缩出的前情提要
         * 就丢了微信在剧情里的时间位置（表现为「压缩只记住了最后一轮」）。正文一律取自 chatHistory，
         * 时间线只负责排序。
         */
        const buildRecapMaterial = (coversThroughTurn, coversWechatCount) => {
            const rpEntries = collectRecapRpEntries(coversThroughTurn);
            const byIndex = new Map(rpEntries.map(entry => [entry.index, entry]));
            const lines = [];
            const emittedIndexes = new Set();
            const emittedTurns = new Set();
            const emitRp = (index) => {
                const entry = byIndex.get(index);
                if (!entry || emittedIndexes.has(index)) return;
                emittedIndexes.add(index);
                const prefix = emittedTurns.has(entry.turn) ? '' : `【第 ${entry.turn} 轮】`;
                emittedTurns.add(entry.turn);
                lines.push(`${prefix}${entry.text}`);
            };

            const characterName = String(__s.currentCharacter.value?.wechatPeerName || '').trim()
                || __s.currentCharacter.value?.name || '角色';
            let wxSeen = 0;
            for (const item of (__s.wechatTimeline?.value || [])) {
                if (item.channel === 'rp') { emitRp(item.rpIndex); continue; }
                if (item.channel !== 'wechat' || item.role === 'system') continue;
                if (wxSeen >= coversWechatCount) continue;
                wxSeen += 1;
                lines.push(formatRecapWechatLine(item, characterName));
            }
            // 时间线里没有镜像的 RP 正文（微信未启用 / 镜像缺失）按原文顺序补在末尾
            rpEntries.forEach((entry) => emitRp(entry.index));
            return lines;
        };
        __s.buildRecapMaterial = buildRecapMaterial;

        /**
         * 保留窗口的 RP 原文：被覆盖范围内最新的 keepRPTurns 轮，按时间线贴回，带「【第 N 轮】」前缀。
         */
        const buildRecapRecentRpText = () => {
            const recap = storyRecap.value;
            if (!recap) return '';
            const keepRPTurns = Math.max(0, Number(recap.keepRPTurns) || 0);
            if (!keepRPTurns) return '';
            const coveredTurns = Math.max(0, Number(recap.coversThroughTurn) || 0);
            const rpStartTurn = Math.max(1, coveredTurns - keepRPTurns + 1);

            const rpEntries = collectRecapRpEntries(coveredTurns);
            const byIndex = new Map(rpEntries.map(entry => [entry.index, entry]));
            const lines = [];
            const emittedIndexes = new Set();
            const emittedTurns = new Set();
            const emitRp = (index) => {
                const entry = byIndex.get(index);
                if (!entry || emittedIndexes.has(index) || entry.turn < rpStartTurn) return;
                emittedIndexes.add(index);
                const prefix = emittedTurns.has(entry.turn) ? '' : `【第 ${entry.turn} 轮】`;
                emittedTurns.add(entry.turn);
                lines.push(`${prefix}${entry.text}`);
            };
            // 时间线里没有镜像的 RP 正文按原文顺序补（微信未启用 / 镜像缺失）
            for (const item of (__s.wechatTimeline?.value || [])) {
                if (item.channel === 'rp') emitRp(item.rpIndex);
            }
            rpEntries.forEach(entry => emitRp(entry.index));
            return lines.join('\n');
        };
        __s.buildRecapRecentRpText = buildRecapRecentRpText;

        /**
         * 保留窗口的微信原文：被覆盖范围内最新的 keepWechatCount 条，逐条成行。
         */
        const buildRecapRecentWechatText = () => {
            const recap = storyRecap.value;
            if (!recap) return '';
            const keepWechat = Math.max(0, Number(recap.keepWechatCount) || 0);
            if (!keepWechat) return '';
            const coveredWx = Math.max(0, Number(recap.coversWechatCount) || 0);
            const wxStartSeen = Math.max(1, coveredWx - keepWechat + 1);

            const characterName = String(__s.currentCharacter.value?.wechatPeerName || '').trim()
                || __s.currentCharacter.value?.name || '角色';
            const lines = [];
            let wxSeen = 0;
            for (const item of (__s.wechatTimeline?.value || [])) {
                if (item.channel !== 'wechat' || item.role === 'system') continue;
                wxSeen += 1;
                if (wxSeen < wxStartSeen || wxSeen > coveredWx) continue;
                lines.push(formatRecapWechatLine(item, characterName));
            }
            return lines.join('\n');
        };
        __s.buildRecapRecentWechatText = buildRecapRecentWechatText;

        /**
         * 注入用：前情提要「背景消息」序列。无提要时返回空数组。
         * 摘要、最近 RP 原文、最近微信原文各自成**独立的 user 消息**——原来揉成一条 content 会糊在一起，
         * 模型分不清哪段是摘要、哪段是 RP、哪段是微信（用户也会以为「没带微信」）。每条都带
         * `_preventContextMerge`，避免被相邻同 role 消息合并回去。
         */
        const buildStoryRecapMessages = () => {
            const text = String(storyRecap.value?.text || '').trim();
            if (!text) return [];
            const messages = [{
                role: 'user',
                content: `【前情提要｜此前剧情的压缩摘要，作为你已知的背景】\n${text}`,
                _sourceIndexes: [],
                _preventContextMerge: true
            }];
            const rpTail = buildRecapRecentRpText().trim();
            if (rpTail) {
                messages.push({
                    role: 'user',
                    content: `【最近 RP 原文｜以上摘要已覆盖到这段，这里是最近的原文，接下文时保持连贯】\n${rpTail}`,
                    _sourceIndexes: [],
                    _preventContextMerge: true
                });
            }
            const wxTail = buildRecapRecentWechatText().trim();
            if (wxTail) {
                messages.push({
                    role: 'user',
                    content: `【最近微信原文｜摘要覆盖到的最近微信对话原文，作为背景】\n${wxTail}`,
                    _sourceIndexes: [],
                    _preventContextMerge: true
                });
            }
            return messages;
        };
        __s.buildStoryRecapMessages = buildStoryRecapMessages;

        /** 手动压缩：生成并落盘前情提要。 */
        const runStoryRecap = async () => {
            if (isRecapGenerating.value) return;
            await ensureStoryRecapLoaded();
            await ensureRecapKeepSettingsLoaded();
            // 微信时间线只在打开微信面板时载入；在记忆页直接点压缩时它可能还是空的，
            // 那样素材里就没有微信对话（用户看到的「压缩没带微信记忆」）。先确保载入。
            if (__s.ensureWechatTimelineLoaded) await __s.ensureWechatTimelineLoaded();
            // 交错顺序靠时间线里的 RP 镜像，先和 chatHistory 对一次账（同进微信前的同步），
            // 否则编辑/重新生成后镜像位置错位，微信段会插回错误的时间点。
            if (__s.currentCharacter.value?.wechatEnabled && __s.reconcileRpTimeline) {
                try {
                    if (__s.reconcileRpTimeline()) {
                        if (__s.resetRpRecordCursor) __s.resetRpRecordCursor();
                        if (__s.scheduleWechatSave) __s.scheduleWechatSave();
                    }
                } catch (error) { console.error('压缩前同步 RP 时间线失败:', error); }
            }
            const coverage = computeRecapCoverage();
            if (coverage.coversThroughTurn <= 0 && coverage.coversWechatCount <= 0) {
                __s.showToast('没有可压缩的内容（先多聊几轮）', 'info');
                return;
            }
            const material = buildRecapMaterial(coverage.coversThroughTurn, coverage.coversWechatCount);
            if (!material.length) {
                __s.showToast('可压缩范围内没有正文内容', 'info');
                return;
            }
            isRecapGenerating.value = true;
            try {
                const requestMessages = [{
                    role: 'system',
                    content: BUILTIN_PROMPTS.buildStoryRecapSystemPrompt({
                        userName: __s.user.name,
                        characterName: __s.currentCharacter.value?.name
                    })
                }];
                const prevText = String(storyRecap.value?.text || '').trim();
                if (prevText) requestMessages.push({ role: 'user', content: `【已有前情提要】\n${prevText}` });
                requestMessages.push({ role: 'user', content: material.join('\n') });
                requestMessages.push({ role: 'user', content: '把以上内容压缩成一份完整的前情提要正文。' });
                const text = await __s.requestClassicMemoryCompletion(requestMessages);
                const next = normalizeRecap({
                    text,
                    coversThroughTurn: coverage.coversThroughTurn,
                    coversWechatCount: coverage.coversWechatCount,
                    keepRPTurns: recapKeepSettings.rpTurns,
                    keepWechatCount: recapKeepSettings.wechatCount,
                    createdAt: Date.now()
                });
                storyRecap.value = next;
                await saveStoryRecapNow(next);
                const keepNote = next.keepRPTurns || next.keepWechatCount
                    ? `，保留最近 ${next.keepRPTurns} 轮 RP + ${next.keepWechatCount} 条微信原文`
                    : '';
                __s.showToast(`已压缩 ${coverage.coversThroughTurn} 轮 RP + ${coverage.coversWechatCount} 条微信为前情提要${keepNote}`, 'success');
            } catch (error) {
                console.error('生成前情提要失败:', error);
                __s.showToast(`压缩失败：${error.message}`, 'error');
            } finally {
                isRecapGenerating.value = false;
            }
        };
        __s.runStoryRecap = runStoryRecap;

        const clearStoryRecap = () => {
            __s.confirmAction('确定要删除前情提要吗？被它覆盖的旧剧情会重新以原文进入上下文。', async () => {
                storyRecap.value = null;
                try { await saveStoryRecapNow(null); } catch (error) { console.error('清除前情提要失败:', error); }
                __s.showToast('前情提要已删除', 'success');
            });
        };
        __s.clearStoryRecap = clearStoryRecap;

        /** 静默清除（供「清空聊天记录」联动，不再弹确认框）。 */
        const clearStoryRecapSilently = async () => {
            if (!storyRecap.value) return;
            storyRecap.value = null;
            try { await saveStoryRecapNow(null); } catch (error) { console.error('清除前情提要失败:', error); }
        };
        __s.clearStoryRecapSilently = clearStoryRecapSilently;

        // 切角色/分支时重载
        const recapLoadingKey = computed(() => `${__s.currentCharacter.value?.uuid || ''}::${recapScopeId()}`);
        watch(recapLoadingKey, () => { ensureStoryRecapLoaded(true).catch(() => {}); });
        ensureStoryRecapLoaded().catch(() => {});
        // 保留条数设置跨分支共享，无论有无作用域都先载入，面板才不会一直显示默认值
        ensureRecapKeepSettingsLoaded().catch(() => {});
    };
})();
