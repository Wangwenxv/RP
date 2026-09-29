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
        const recapScopeId = () => __s.getCurrentStoryBranchScopeId();

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
                createdAt: Number(value.createdAt) || 0
            };
        };

        /** 作用域切换后首次调用从 DB 载入。 */
        const ensureStoryRecapLoaded = async (force = false) => {
            const scope = recapScopeId();
            if (!force && loadedRecapScopeId === scope) return;
            loadedRecapScopeId = scope;
            if (!scope) { storyRecap.value = null; return; }
            try {
                if (!getMainDb()) await initDB();
                storyRecap.value = normalizeRecap(await getScopedStoredValue(STORY_RECAP_KEY, scope));
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

        /** 注入用：system/上下文里的前情提要块。无提要时返回空串。 */
        const buildStoryRecapBlock = () => {
            const text = String(storyRecap.value?.text || '').trim();
            if (!text) return '';
            return `【前情提要｜此前剧情的压缩摘要，作为你已知的背景】\n${text}`;
        };
        __s.buildStoryRecapBlock = buildStoryRecapBlock;

        const countWechatMessages = () => (__s.wechatTimeline?.value || [])
            .filter(item => item.channel === 'wechat' && item.role !== 'system').length;

        /**
         * 压缩覆盖范围：**全部** RP 轮次 + 全部微信消息（保留窗口为 0）。
         * 与前情提要是「压缩点之前全部内容的代表」这一设计一致：点一次压缩，
         * 截止当前的所有内容都塌成一条提要，之后只追加新内容。
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

        /** 手动压缩：生成并落盘前情提要。 */
        const runStoryRecap = async () => {
            if (isRecapGenerating.value) return;
            await ensureStoryRecapLoaded();
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
                    createdAt: Date.now()
                });
                storyRecap.value = next;
                await saveStoryRecapNow(next);
                __s.showToast(`已压缩 ${coverage.coversThroughTurn} 轮 RP + ${coverage.coversWechatCount} 条微信为前情提要`, 'success');
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
    };
})();
