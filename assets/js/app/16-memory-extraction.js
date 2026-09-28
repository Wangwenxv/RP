/**
 * RP-Hub 应用模块 16 · 经典记忆抽取、二级压缩与向量索引
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 4956–5490 行。
 * 本文件是一个 App 模块函数，在 app.js 的 setup() 里按序号依次调用。
 *
 * 约定：
 * - 模块内顶层的 const/let 就是原 setup() 的顶层声明，语义保持不变；
 * - 每个声明会镜像到共享上下文 __s（return 给模板用的也是它）；
 * - 跨模块引用统一写作 __s.<name>；可被重新赋值的变量直接驻留在 __s 上；
 * - 文件顶部的全局辅助（ref/computed、RPHubXxx、bootstrap 常量）由 app.js
 *   顶部与 7 个基础 JS 提供，经典 script 共享全局词法作用域，直接用即可。
 */
(function () {
    window.RPHubAppSections = window.RPHubAppSections || {};
    window.RPHubAppSections.memoryExtraction = function (__s) {

        // --- Memory Extraction ---
        __s._classicBatchExtractAbort = null;
        __s._classicExtractionEpoch = 0;
        __s._classicBatchRescanRequested = false;
        const _classicSummaryInFlightKeys = new Set();
        __s._classicSummaryInFlightKeys = _classicSummaryInFlightKeys;
        const getMemoryEmbeddingModel = () => String(__s.memorySettings.embeddingModel || '').trim();
        __s.getMemoryEmbeddingModel = getMemoryEmbeddingModel;
        const getMemoryMessageText = message => {
            if (!message) return '';
            const indexes = message._sourceIndexes || [];
            const sources = indexes.length
                ? indexes.map(index => __s.chatHistory.value[index]).filter(source => source?.role === message.role)
                : [message];
            return sources.map(source => __s.appendMessageImageDescriptions(source,
                __s.stripNextResponsePrompt(__s.stripUiTemplateContextInjection(parseCot(source.content || '').main))
            )).filter(Boolean).join('\n\n');
        };
        __s.getMemoryMessageText = getMemoryMessageText;
        const getClassicTurnSourceIds = (turnInfo, role) => {
            const sourceIndexes = turnInfo?.[role]?._sourceIndexes || [];
            return sourceIndexes
                .map(index => __s.chatHistory.value[index])
                .filter(message => message?.role === role && message.id)
                .map(message => message.id);
        };
        __s.getClassicTurnSourceIds = getClassicTurnSourceIds;
        const ensureConversationMessageIds = async () => {
            const snapshot = __s.buildConversationTurnSnapshot(__s.chatHistory.value, { includeSystem: false });
            let changed = false;
            snapshot.turns.forEach(turnInfo => {
                (turnInfo.sourceIndexes || []).forEach(index => {
                    const message = __s.chatHistory.value[index];
                    if (!message || !['user', 'assistant'].includes(message.role) || message.id) return;
                    message.id = generateUUID();
                    changed = true;
                });
            });
            if (changed) await __s.saveChatHistoryNow();
            return changed
                ? __s.buildConversationTurnSnapshot(__s.chatHistory.value, { includeSystem: false })
                : snapshot;
        };
        __s.ensureConversationMessageIds = ensureConversationMessageIds;
        const hasClassicMemoryForJob = (job) => {
            const targetIds = new Set(job.sourceAssistantIds || []);
            return __s.classicMemories.value.some(memory => {
                const memoryIds = memory.sourceAssistantIds || [];
                if (targetIds.size > 0 && memoryIds.some(id => targetIds.has(id))) return true;
                return targetIds.size === 0 && Number(memory.turn) === Number(job.turn);
            });
        };
        __s.hasClassicMemoryForJob = hasClassicMemoryForJob;
        const buildClassicSummaryJob = (snapshot, targetIndex) => {
            const turns = Array.isArray(snapshot?.turns) ? snapshot.turns : [];
            const targetTurn = turns[targetIndex];
            if (!targetTurn || !__s.currentCharacter.value?.uuid) return null;

            const contextTurns = turns.slice(Math.max(0, targetIndex - 3), targetIndex + 1).map(turnInfo => ({
                turn: turnInfo.turn,
                userContent: getMemoryMessageText(turnInfo.user),
                assistantContent: getMemoryMessageText(turnInfo.assistant),
                isTarget: turnInfo === targetTurn
            }));
            const targetContext = contextTurns[contextTurns.length - 1];
            if (!targetContext?.userContent || !targetContext?.assistantContent) return null;

            const sourceUserIds = getClassicTurnSourceIds(targetTurn, 'user');
            const sourceAssistantIds = getClassicTurnSourceIds(targetTurn, 'assistant');
            return {
                characterId: __s.currentCharacter.value.uuid,
                storyScopeId: __s.getCurrentStoryBranchScopeId(),
                epoch: __s._classicExtractionEpoch,
                turn: targetTurn.turn,
                contextTurns,
                sourceUserIds,
                sourceAssistantIds,
                sourceUserText: (targetTurn.user?._sourceIndexes || [])
                    .map(index => __s.chatHistory.value[index])
                    .filter(message => message?.role === 'user')
                    .map(message => String(message.content || ''))
                    .join('\n\n') || String(targetTurn.user?.content || ''),
                sourceAssistantText: targetContext.assistantContent,
                key: getClassicMemoryKey(sourceAssistantIds, targetTurn.turn)
            };
        };
        __s.buildClassicSummaryJob = buildClassicSummaryJob;
        const requestClassicMemoryCompletion = async (requestMessages, signal) => {
            const model = String(__s.memorySettings.classicModel || '').trim();
            if (!__s.settings.apiUrl || !__s.settings.apiKey) throw new Error('请先配置 API 地址和 Key');
            if (!model) throw new Error('请先选择总结模型');

            const result = await __s.requestTrackedChatCompletion({
                model, temperature: 0.2, stream: false, messages: requestMessages, signal
            }, 'summary');
            const summary = parseCot(result.content).main
                .replace(/^```(?:text|markdown)?\s*/i, '')
                .replace(/\s*```$/, '')
                .replace(/^(?:最新对话总结|总结)[:：]\s*/i, '')
                .trim();
            if (!summary) throw new Error('副模型没有返回有效总结');
            return summary.replace(/\n{3,}/g, '\n\n');
        };
        __s.requestClassicMemoryCompletion = requestClassicMemoryCompletion;
        const requestClassicMemorySummary = async (job, signal) => {
            const requestMessages = [{
                role: 'system',
                content: BUILTIN_PROMPTS.buildClassicSummarySystemPrompt({
                    userName: __s.user.name,
                    characterName: __s.currentCharacter.value?.name
                })
            }];

            job.contextTurns.forEach(turnInfo => {
                const marker = turnInfo.isTarget
                    ? `【最新对话：唯一总结目标｜第 ${turnInfo.turn} 轮】`
                    : `【历史背景：仅供理解，不得作为总结目标｜第 ${turnInfo.turn} 轮】`;
                requestMessages.push({ role: 'user', content: `${marker}\n${turnInfo.userContent}` });
                requestMessages.push({ role: 'assistant', content: `${marker}\n${turnInfo.assistantContent}` });
            });
            requestMessages.push({
                role: 'user',
                content: BUILTIN_PROMPTS.buildClassicSummaryFinalInstruction(job.turn)
            });
            return requestClassicMemoryCompletion(requestMessages, signal);
        };
        __s.requestClassicMemorySummary = requestClassicMemorySummary;
        const requestClassicSecondarySummary = async (group, signal) => {
            const ordered = [...group].sort((a, b) => Number(a.turn) - Number(b.turn));
            const startTurn = Number(ordered[0]?.turn) || 1;
            const endTurn = Number(ordered[ordered.length - 1]?.turn) || startTurn;
            const requestMessages = [{
                role: 'system',
                content: BUILTIN_PROMPTS.buildClassicSecondarySummaryPrompt({
                    userName: __s.user.name,
                    characterName: __s.currentCharacter.value?.name,
                    startTurn,
                    endTurn
                })
            }, {
                role: 'user',
                content: ordered.map(memory => `【第 ${memory.turn} 轮】\n${memory.summary}`).join('\n\n')
            }];
            return requestClassicMemoryCompletion(requestMessages, signal);
        };
        __s.requestClassicSecondarySummary = requestClassicSecondarySummary;
        const getSecondaryClassicSourceMemories = (memory) => prepareClassicMemoriesForRuntime(
            Array.isArray(memory?.sourceMemories) ? memory.sourceMemories : []
        ).filter(item => !__s.isSecondaryClassicMemory(item));
        __s.getSecondaryClassicSourceMemories = getSecondaryClassicSourceMemories;
        const trimClassicMemoriesToTurn = (items, lastTurn) => (Array.isArray(items) ? items : []).flatMap(memory => {
            if (!__s.isSecondaryClassicMemory(memory)) {
                return Number(memory?.turn) <= lastTurn ? [memory] : [];
            }
            const range = __s.getClassicMemoryTurnRange(memory);
            if (range.end <= lastTurn) return [memory];
            if (range.start > lastTurn) return [];
            return getSecondaryClassicSourceMemories(memory)
                .filter(sourceMemory => Number(sourceMemory.turn) <= lastTurn);
        });
        __s.trimClassicMemoriesToTurn = trimClassicMemoriesToTurn;
        const getEligibleClassicSecondaryGroups = (totalTurns, memories = __s.classicMemories.value) => {
            const compressionLimit = Math.max(0, Number(totalTurns) - __s.CLASSIC_SECONDARY_KEEP_TURNS);
            if (compressionLimit < __s.CLASSIC_SECONDARY_GROUP_SIZE) return [];
            const { turns } = __s.buildConversationTurnSnapshot(__s.chatHistory.value, { includeSystem: false });
            const byTurn = new Map();
            memories.forEach(memory => {
                const turn = Number(memory?.turn);
                if (!__s.isSecondaryClassicMemory(memory) && turn > 0 && turn <= compressionLimit) byTurn.set(turn, memory);
            });
            const groups = [];
            for (let start = 1; start + __s.CLASSIC_SECONDARY_GROUP_SIZE - 1 <= compressionLimit; start += __s.CLASSIC_SECONDARY_GROUP_SIZE) {
                const group = Array.from({ length: __s.CLASSIC_SECONDARY_GROUP_SIZE }, (_, offset) => byTurn.get(start + offset));
                // 仅跳过确认没有正文的空轮；有正文却缺总结的轮次必须先补录。
                const complete = group.every((memory, offset) => {
                    const turnInfo = turns[start + offset - 1];
                    return memory || (turnInfo && !getMemoryMessageText(turnInfo.assistant).trim());
                });
                const summaries = group.filter(Boolean);
                if (complete && summaries.length > 1) groups.push(summaries);
            }
            return groups;
        };
        __s.getEligibleClassicSecondaryGroups = getEligibleClassicSecondaryGroups;
        const compressEligibleClassicMemories = async (totalTurns, signal, interactive = false, onProgress) => {
            const groups = getEligibleClassicSecondaryGroups(totalTurns);
            if (!groups.length) return 0;
            const characterId = __s.currentCharacter.value?.uuid;
            const storyScopeId = __s.getCurrentStoryBranchScopeId();
            const epoch = __s._classicExtractionEpoch;
            const concurrency = __s.normalizeClassicMemoryConcurrency(__s.memorySettings.classicConcurrency);
            let completed = 0;
            let memorySourceForSave = null;
            onProgress?.(0, groups.length);
            try {
                for (let offset = 0; offset < groups.length; offset += concurrency) {
                    if (signal?.aborted || epoch !== __s._classicExtractionEpoch
                        || __s.currentCharacter.value?.uuid !== characterId
                        || __s.getCurrentStoryBranchScopeId() !== storyScopeId) break;
                    const results = await Promise.all(groups.slice(offset, offset + concurrency).map(async group => {
                        try {
                            return { group, summary: await requestClassicSecondarySummary(group, signal) };
                        } catch (error) {
                            return { group, error };
                        }
                    }));
                    if (signal?.aborted || epoch !== __s._classicExtractionEpoch
                        || __s.currentCharacter.value?.uuid !== characterId
                        || __s.getCurrentStoryBranchScopeId() !== storyScopeId) break;
                    let failed = false;
                    for (let result of results) {
                        if (result.error) {
                            if (result.error.name === 'AbortError') throw result.error;
                            if (interactive) {
                                let retryError = result.error;
                                const range = `${result.group[0].turn}-${result.group[result.group.length - 1].turn}`;
                                while (true) {
                                    const retry = await __s.showVueConfirmModal(
                                        '基础模式补录遇到错误',
                                        `第 ${range} 轮二次压缩失败：\n${retryError.message}\n\n是否立即重试？`
                                    );
                                    if (signal?.aborted || epoch !== __s._classicExtractionEpoch) throw __s.createAbortReason();
                                    if (!retry) {
                                        const abortError = new Error('用户取消了重试并中止了二次压缩');
                                        abortError.name = 'AbortError';
                                        throw abortError;
                                    }
                                    try {
                                        result = {
                                            group: result.group,
                                            summary: await requestClassicSecondarySummary(result.group, signal)
                                        };
                                        break;
                                    } catch (error) {
                                        if (error.name === 'AbortError') throw error;
                                        retryError = error;
                                    }
                                }
                            } else {
                                console.warn('Classic memory secondary compression failed:', result.error);
                                failed = true;
                                continue;
                            }
                        }
                        const { group, summary } = result;
                        const sourceIds = new Set(group.map(memory => memory.id));
                        if (!group.every(memory => __s.classicMemories.value.some(item => item.id === memory.id))) continue;
                        const startTurn = Number(group[0].turn);
                        const endTurn = Number(group[group.length - 1].turn);
                        const sourceMemories = group.map(memory => cloneForStorage(memory));
                        const mergedMemory = markRuntimeRaw({
                            id: generateUUID(),
                            timestamp: Date.now(),
                            turn: endTurn,
                            turnStart: startTurn,
                            turnEnd: endTurn,
                            summary,
                            enabled: true,
                            classicMemory: true,
                            secondaryCompressed: true,
                            summaryModel: String(__s.memorySettings.classicModel || '').trim(),
                            sourceUserIds: [...new Set(group.flatMap(memory => memory.sourceUserIds || []))],
                            sourceAssistantIds: [...new Set(group.flatMap(memory => memory.sourceAssistantIds || []))],
                            sourceMemories
                        });
                        __s.classicMemories.value = [
                            ...__s.classicMemories.value.filter(memory => !sourceIds.has(memory.id)),
                            mergedMemory
                        ];
                        memorySourceForSave = __s.classicMemories.value;
                        completed++;
                        onProgress?.(completed, groups.length);
                    }
                    if (failed) break;
                }
            } finally {
                if (completed > 0) await __s.saveClassicMemoriesNow(storyScopeId, memorySourceForSave);
            }
            return completed;
        };
        __s.compressEligibleClassicMemories = compressEligibleClassicMemories;
        const restoreSecondaryClassicMemoriesForTurnCount = (totalTurns) => {
            const compressionLimit = Math.max(0, Number(totalTurns) - __s.CLASSIC_SECONDARY_KEEP_TURNS);
            let restored = 0;
            __s.classicMemories.value = __s.classicMemories.value.flatMap(memory => {
                if (!__s.isSecondaryClassicMemory(memory) || __s.getClassicMemoryTurnRange(memory).end <= compressionLimit) return [memory];
                const sourceMemories = getSecondaryClassicSourceMemories(memory);
                if (!sourceMemories.length) return [memory];
                restored += sourceMemories.length;
                return sourceMemories;
            });
            return restored;
        };
        __s.restoreSecondaryClassicMemoriesForTurnCount = restoreSecondaryClassicMemoriesForTurnCount;
        const retryClassicMemory = async (memory) => {
            if (!memory?.id || __s.retryingClassicMemoryId.value) return;
            if (__s.memorySettings.mode === __s.MEMORY_MODE_ENHANCED && !getMemoryEmbeddingModel()) {
                __s.showToast('请先选择向量模型', 'warning');
                return;
            }
            if (__s.isClassicBatchExtracting.value) {
                __s.showToast('请先等待补录完成', 'warning');
                return;
            }

            const memoryId = memory.id;
            const retryEpoch = __s._classicExtractionEpoch;
            const retryCharacterId = __s.currentCharacter.value?.uuid;
            const retryStoryScopeId = __s.getCurrentStoryBranchScopeId();
            __s.retryingClassicMemoryId.value = memoryId;
            try {
                if (__s.isSecondaryClassicMemory(memory)) {
                    const sourceMemories = getSecondaryClassicSourceMemories(memory);
                    if (sourceMemories.length !== __s.CLASSIC_SECONDARY_GROUP_SIZE) {
                        __s.showToast('找不到这条二次压缩记忆的原始总结', 'warning');
                        return;
                    }
                    const summary = await requestClassicSecondarySummary(sourceMemories);
                    if (retryEpoch !== __s._classicExtractionEpoch || __s.currentCharacter.value?.uuid !== retryCharacterId
                        || __s.getCurrentStoryBranchScopeId() !== retryStoryScopeId) return;
                    const memoryIndex = __s.classicMemories.value.findIndex(item => item.id === memoryId);
                    if (memoryIndex < 0) return;
                    __s.classicMemories.value[memoryIndex] = markRuntimeRaw({
                        ...__s.classicMemories.value[memoryIndex],
                        summary,
                        summaryModel: String(__s.memorySettings.classicModel || '').trim()
                    });
                    await __s.saveClassicMemoriesNow(retryStoryScopeId, __s.classicMemories.value);
                    const range = __s.getClassicMemoryTurnRange(memory);
                    __s.showToast(`第 ${range.start}-${range.end} 轮总结已重新生成`, 'success');
                    return;
                }
                const snapshot = await ensureConversationMessageIds();
                const sourceAssistantIds = new Set((memory.sourceAssistantIds || []).filter(Boolean));
                const targetIndex = snapshot.turns.findIndex(turnInfo => {
                    if (sourceAssistantIds.size > 0) {
                        return getClassicTurnSourceIds(turnInfo, 'assistant')
                            .some(id => sourceAssistantIds.has(id));
                    }
                    return Number(turnInfo.turn) === Number(memory.displayTurn || memory.turn);
                });
                const job = buildClassicSummaryJob(snapshot, targetIndex);
                if (!job) {
                    __s.showToast('找不到这条记忆对应的原始对话', 'warning');
                    return;
                }
                const summary = await requestClassicMemorySummary(job);
                if (retryEpoch !== __s._classicExtractionEpoch || __s.currentCharacter.value?.uuid !== job.characterId || __s.getCurrentStoryBranchScopeId() !== job.storyScopeId) return;

                const memoryIndex = __s.classicMemories.value.findIndex(item => item.id === memoryId);
                if (memoryIndex < 0) return;
                __s.classicMemories.value[memoryIndex] = markRuntimeRaw({
                    ...__s.classicMemories.value[memoryIndex],
                    turn: job.turn,
                    summary,
                    summaryModel: String(__s.memorySettings.classicModel || '').trim(),
                    sourceUserIds: job.sourceUserIds,
                    sourceAssistantIds: job.sourceAssistantIds,
                    sourceUserText: job.sourceUserText,
                    sourceAssistantText: job.sourceAssistantText
                });
                const updated = __s.classicMemories.value[memoryIndex];
                ['embeddingQ', 'embeddingScale', 'embeddingDims', 'embeddingEncoding', 'embeddingModel', 'embeddingApiUrl']
                    .forEach(key => delete updated[key]);
                await __s.saveClassicMemoriesNow();
                if (__s.memorySettings.mode === __s.MEMORY_MODE_ENHANCED) await indexSummaryMemories(snapshot, undefined, [updated]);
                __s.showToast(`第 ${job.turn} 轮总结已重新生成`, 'success');
            } catch (error) {
                console.error('Retry classic memory failed:', error);
                __s.showToast(`重试失败：${error.message}`, 'error');
            } finally {
                if (__s.retryingClassicMemoryId.value === memoryId) __s.retryingClassicMemoryId.value = '';
            }
        };
        __s.retryClassicMemory = retryClassicMemory;
        const generateAndStoreClassicMemory = async (job, signal) => {
            if (!job || job.epoch !== __s._classicExtractionEpoch) return false;
            if (__s.currentCharacter.value?.uuid !== job.characterId || __s.getCurrentStoryBranchScopeId() !== job.storyScopeId || hasClassicMemoryForJob(job)) return false;
            const inFlightKey = `${job.epoch}:${job.key}`;
            if (_classicSummaryInFlightKeys.has(inFlightKey)) return false;

            _classicSummaryInFlightKeys.add(inFlightKey);
            try {
                const summary = await requestClassicMemorySummary(job, signal);
                if (signal?.aborted || job.epoch !== __s._classicExtractionEpoch) return false;
                if (__s.currentCharacter.value?.uuid !== job.characterId || __s.getCurrentStoryBranchScopeId() !== job.storyScopeId || hasClassicMemoryForJob(job)) return false;
                __s.classicMemories.value.push(markRuntimeRaw({
                    id: generateUUID(),
                    timestamp: Date.now(),
                    turn: job.turn,
                    summary,
                    enabled: true,
                    classicMemory: true,
                    summaryModel: String(__s.memorySettings.classicModel || '').trim(),
                    sourceUserIds: job.sourceUserIds,
                    sourceAssistantIds: job.sourceAssistantIds,
                    sourceUserText: job.sourceUserText,
                    sourceAssistantText: job.sourceAssistantText
                }));
                return true;
            } finally {
                _classicSummaryInFlightKeys.delete(inFlightKey);
            }
        };
        __s.generateAndStoreClassicMemory = generateAndStoreClassicMemory;
        const requestMemoryEmbeddings = async (inputs, signal, model = getMemoryEmbeddingModel()) => {
            if (!__s.settings.apiUrl || !__s.settings.apiKey) throw new Error('请先配置 API 地址和 Key');
            if (!model) throw new Error('请先选择向量模型');

            const normalizedInputs = inputs.map(input => String(input || '').trim());
            if (normalizedInputs.some(input => !input)) throw new Error('嵌入内容不能为空');

            const requestStartedAt = Date.now();
            const apiUrl = __s.settings.apiUrl;
            const apiKey = __s.settings.apiKey;
            const data = await requestJson({
                url: buildApiEndpoint(apiUrl, 'embeddings'), apiKey, signal,
                body: { model, input: normalizedInputs.length === 1 ? normalizedInputs[0] : normalizedInputs }
            });
            __s.recordApiUsage(getApiUsagePayload(data), {
                type: 'embedding', model, apiUrl, apiKey, isStream: false,
                durationMs: Date.now() - requestStartedAt, outputCharacters: 0
            });
            const rows = Array.isArray(data.data) ? [...data.data] : [];
            rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
            const vectors = rows.map(row => normalizeEmbedding(row.embedding));

            if (signal?.aborted) {
                const abortError = new Error('Aborted');
                abortError.name = 'AbortError';
                throw abortError;
            }
            if (vectors.length !== normalizedInputs.length || vectors.some(vector => vector.length === 0 || vector.length !== vectors[0].length)) {
                throw new Error('嵌入接口返回的数据不完整');
            }

            return vectors;
        };
        __s.requestMemoryEmbeddings = requestMemoryEmbeddings;
        const hasCurrentSummaryEmbedding = (memory, model = getMemoryEmbeddingModel(), apiUrl = __s.settings.apiUrl) =>
            memory.embeddingModel === model && memory.embeddingApiUrl === apiUrl
            && getSummaryEmbedding(memory).length > 0;
        __s.hasCurrentSummaryEmbedding = hasCurrentSummaryEmbedding;
        const getSummaryEmbeddingJobs = (snapshot, sources = getSummarySources(__s.classicMemories.value)) => {
            const model = getMemoryEmbeddingModel();
            const apiUrl = __s.settings.apiUrl;
            const messagesById = new Map(__s.chatHistory.value.filter(message => message.id).map(message => [message.id, message]));
            const turnsByNumber = new Map(snapshot.turns.map(turn => [turn.turn, turn]));
            return sources.map(memory => {
                const inputs = (memory.sourceUserIds || []).map(id => messagesById.get(id))
                    .filter(message => message?.role === 'user').map(message => String(message.content || ''));
                const turn = turnsByNumber.get(Number(memory.turn));
                const sourceUserText = inputs.length ? inputs.join('\n\n')
                    : memory.sourceUserText || String(turn?.user?.content || '');
                return { memory, sourceUserText };
            }).filter(({ memory, sourceUserText }) =>
                !hasCurrentSummaryEmbedding(memory, model, apiUrl) || sourceUserText !== memory.sourceUserText
            );
        };
        __s.getSummaryEmbeddingJobs = getSummaryEmbeddingJobs;
        const indexSummaryMemories = async (snapshot, signal, sources, onProgress) => {
            const model = getMemoryEmbeddingModel();
            const apiUrl = __s.settings.apiUrl;
            const epoch = __s._classicExtractionEpoch;
            const scopeId = __s.getCurrentStoryBranchScopeId();
            const isCurrent = () => !signal?.aborted && epoch === __s._classicExtractionEpoch
                && scopeId === __s.getCurrentStoryBranchScopeId()
                && __s.memorySettings.mode === __s.MEMORY_MODE_ENHANCED;
            const jobs = getSummaryEmbeddingJobs(snapshot, sources);
            if (!jobs.length) return 0;
            if (!model) throw new Error('请先选择向量模型');
            onProgress?.(0, jobs.length);
            let completed = 0;
            for (let offset = 0; offset < jobs.length; offset += __s.SUMMARY_EMBEDDING_BATCH_SIZE) {
                if (!isCurrent()) return completed;
                const batch = jobs.slice(offset, offset + __s.SUMMARY_EMBEDDING_BATCH_SIZE);
                if (batch.some(job => !job.sourceUserText.trim())) {
                    throw new Error('部分总结找不到用户原输入，无法生成坐标，请重新补录对应对话');
                }
                const vectors = await requestMemoryEmbeddings(batch.map(job => buildSummaryEmbeddingText({
                    ...job.memory, sourceUserText: job.sourceUserText
                })), signal, model);
                if (!isCurrent()) return completed;
                const packed = vectors.map(quantizeEmbeddingForStorage);
                if (packed.some(value => !value)) throw new Error('嵌入接口返回了无效坐标');
                const currentSources = new Set(getSummarySources(__s.classicMemories.value));
                batch.forEach((job, index) => {
                    if (!currentSources.has(job.memory)) return;
                    Object.assign(job.memory, packed[index], {
                        embeddingModel: model,
                        embeddingApiUrl: apiUrl,
                        sourceUserText: job.sourceUserText
                    });
                    completed++;
                });
                __s.classicMemories.value = [...__s.classicMemories.value];
                await __s.saveClassicMemoriesNow(scopeId, __s.classicMemories.value);
                if (isCurrent()) onProgress?.(completed, jobs.length);
            }
            return completed;
        };
        __s.indexSummaryMemories = indexSummaryMemories;
        const selectEnhancedMemories = async signal => {
            const sources = getSummarySources(__s.classicMemories.value).filter(memory => hasCurrentSummaryEmbedding(memory));
            if (!sources.length) return [];
            const latestUser = [...__s.chatHistory.value].reverse().find(message => message.role === 'user');
            const query = String(latestUser?.content || '').trim();
            if (!query) return [];
            const epoch = __s._classicExtractionEpoch;
            const scopeId = __s.getCurrentStoryBranchScopeId();
            const isCurrent = () => !signal?.aborted && epoch === __s._classicExtractionEpoch
                && scopeId === __s.getCurrentStoryBranchScopeId() && __s.memorySettings.enabled
                && __s.memorySettings.mode === __s.MEMORY_MODE_ENHANCED;
            try {
                const [queryVector] = await requestMemoryEmbeddings([query], signal);
                if (!isCurrent()) return [];
                const selected = [];
                for (let index = 0; index < sources.length; index++) {
                    const memory = sources[index];
                    const score = cosineSimilarity(queryVector, getSummaryEmbedding(memory));
                    if (score >= __s.SUMMARY_RECALL_MIN_SIMILARITY) selected.push({ ...memory, score });
                    if (index > 0 && index % 256 === 0) {
                        await __s.yieldToUi();
                        if (!isCurrent()) return [];
                    }
                }
                return selected.sort((a, b) => b.score - a.score || a.turn - b.turn)
                    .slice(0, __s.SUMMARY_RECALL_LIMIT).sort((a, b) => a.turn - b.turn);
            } catch (error) {
                if (signal?.aborted || error.name === 'AbortError') throw error;
                if (isCurrent()) {
                    console.warn('[增强记忆] 召回失败：', error.message);
                    __s.showToast('记忆召回失败，本次仍使用总结上下文', 'warning');
                }
                return [];
            }
        };
        __s.selectEnhancedMemories = selectEnhancedMemories;
    };
})();
