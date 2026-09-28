/**
 * RP-Hub 应用模块 13 · 消息操作：清空 / 全屏 / 复制 / 编辑 / 删除 / 重新生成 / UI 模板更新
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 3702–4206 行。
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
    window.RPHubAppSections.methodsMsgOps = function (__s) {
        const getNativeFullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
        __s.getNativeFullscreenElement = getNativeFullscreenElement;
        const requestNativeFullscreen = (element) => {
            if (element.requestFullscreen) return element.requestFullscreen();
            if (element.webkitRequestFullscreen) return element.webkitRequestFullscreen();
            return Promise.reject(new Error('Fullscreen is not supported'));
        };
        __s.requestNativeFullscreen = requestNativeFullscreen;
        const exitNativeFullscreen = () => {
            if (document.exitFullscreen) return document.exitFullscreen();
            if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
            return Promise.resolve();
        };
        __s.exitNativeFullscreen = exitNativeFullscreen;
        const toggleChatFullscreen = async () => {
            try {
                if (getNativeFullscreenElement()) {
                    __s.isChatFullscreen.value = false;
                    await exitNativeFullscreen();
                    return;
                }
                const fullscreenTarget = document.documentElement || document.body;
                if (!fullscreenTarget || (!fullscreenTarget.requestFullscreen && !fullscreenTarget.webkitRequestFullscreen)) {
                    __s.showToast('当前浏览器不支持全屏', 'warning');
                    return;
                }
                __s.closeNavigation();
                __s.isChatFullscreen.value = true;
                await requestNativeFullscreen(fullscreenTarget);
            } catch (err) {
                __s.isChatFullscreen.value = !!getNativeFullscreenElement();
                console.error('Toggle fullscreen failed:', err);
                __s.showToast('全屏失败', 'error');
            }
        };
        __s.toggleChatFullscreen = toggleChatFullscreen;
        const syncChatFullscreenState = () => {
            __s.isChatFullscreen.value = !!getNativeFullscreenElement();
        };
        __s.syncChatFullscreenState = syncChatFullscreenState;
        const copyMessage = (content) => {
            navigator.clipboard.writeText(stripUiTemplateUpdateBlock(content)).then(() => {
                __s.showToast('已复制到剪贴板', 'success');
            }).catch(err => {
                console.error('Copy failed:', err);
                __s.showToast('复制失败', 'error');
            });
        };
        __s.copyMessage = copyMessage;
        const editMessage = (index) => {
            const msg = __s.chatHistory.value[index];
            if (msg) {
                const messageEl = __s.chatContainer.value?.querySelector(`[data-chat-index="${index}"] .message-content-wrapper`);
                const messageHeight = messageEl?.getBoundingClientRect?.().height || 0;
                msg.isEditing_Message = true;
                const cotInfo = parseCot(msg.content);
                const uiTemplateUpdateMatch = findUiTemplateUpdateBlock(msg.content);
                msg.originalCot = cotInfo.ranges.map(({ start, end }) => msg.content.slice(start, end)).join('\n\n')
                    + cotInfo.closingTags;
                msg.originalUiTemplateUpdate = uiTemplateUpdateMatch ? uiTemplateUpdateMatch[0] : '';
                msg.originalEditMessageContent = stripUiTemplateUpdateBlock(cotInfo.main);
                msg.editMessageContent = msg.originalEditMessageContent;
                msg.editMessageHeight = Math.min(0.7 * window.innerHeight, Math.max(88, Math.round(messageHeight || 160)));
            }
        };
        __s.editMessage = editMessage;
        const clearMessageEditState = (message) => {
            message.isEditing_Message = false;
            delete message.editMessageContent;
            delete message.editMessageHeight;
            delete message.originalCot;
            delete message.originalUiTemplateUpdate;
            delete message.originalEditMessageContent;
        };
        __s.clearMessageEditState = clearMessageEditState;
        const saveEditMessage = async (index) => {
            const msg = __s.chatHistory.value[index];
            if (msg) {
                const contentChanged = String(msg.editMessageContent || '') !== String(msg.originalEditMessageContent || '');
                if (!contentChanged) {
                    clearMessageEditState(msg);
                    await __s.saveChatHistoryNow();
                    __s.showToast('消息未改动', 'success');
                    return;
                }
                let finalContent = msg.editMessageContent;
                if (msg.originalUiTemplateUpdate) {
                    finalContent = finalContent.trimEnd() + '\n\n' + msg.originalUiTemplateUpdate;
                }
                if (msg.originalCot) {
                    finalContent = msg.originalCot + '\n\n' + finalContent;
                }
                msg.content = finalContent;
                delete msg.styleFilterHits;
                __s.openStyleFilterMessageKey.value = '';
                clearMessageEditState(msg);
                __s.abortConversationBackgroundWork();
                const snapshot = await __s.ensureConversationMessageIds();
                const affectedTurn = snapshot.turns.find(turnInfo =>
                    (turnInfo.sourceIndexes || []).includes(index)
                )?.turn || null;
                syncMemoryConversationBindings(snapshot, { backfill: true });
                await removeClassicMemoriesForConversationTurn(snapshot, affectedTurn);
                await __s.saveConversationMutationNow();
                await __s.saveMemorySettingsNow();
                if (affectedTurn && __s.memorySettings.enabled) {
                    nextTick(__s.startAutomaticMemoryPatrol);
                }
                __s.showToast('消息已保存', 'success');
            }
        };
        __s.saveEditMessage = saveEditMessage;
        const cancelEditMessage = (index) => {
            const msg = __s.chatHistory.value[index];
            if (msg) {
                clearMessageEditState(msg);
            }
        };
        __s.cancelEditMessage = cancelEditMessage;
        const markUiTemplateStatus = (state, message, remaining = 0, targetMessageId = null) => {
            __s.uiTemplateUpdateStatus.state = state;
            __s.uiTemplateUpdateStatus.message = message;
            __s.uiTemplateUpdateStatus.time = Date.now();
            __s.uiTemplateUpdateStatus.remaining = remaining;
            __s.uiTemplateUpdateStatus.targetMessageId = targetMessageId;
        };
        __s.markUiTemplateStatus = markUiTemplateStatus;
        const failUiTemplateAnalysis = (message, targetMessageId = null) => {
            markUiTemplateStatus('error', message, 0, targetMessageId);
            __s.showToast(message, 'error');
        };
        __s.failUiTemplateAnalysis = failUiTemplateAnalysis;
        const startUiTemplateUpdateRun = () => {
            if (__s.uiTemplateUpdateAbortController) {
                __s.uiTemplateUpdateAbortController.abort();
            }
            __s.uiTemplateUpdateAbortController = new AbortController();
            const seq = ++__s.uiTemplateUpdateSeq;
            return { seq, signal: __s.uiTemplateUpdateAbortController.signal };
        };
        __s.startUiTemplateUpdateRun = startUiTemplateUpdateRun;
        const isUiTemplateUpdateRunCurrent = (seq, targetMessageId) => (
            seq === __s.uiTemplateUpdateSeq
            && __s.uiTemplateUpdateAbortController
            && !__s.uiTemplateUpdateAbortController.signal.aborted
            && (!targetMessageId || __s.chatHistory.value.some(msg => msg && msg.id === targetMessageId))
        );
        __s.isUiTemplateUpdateRunCurrent = isUiTemplateUpdateRunCurrent;
        const abortUiTemplateUpdate = (targetMessageId = null) => {
            if (targetMessageId && __s.uiTemplateUpdateStatus.targetMessageId && __s.uiTemplateUpdateStatus.targetMessageId !== targetMessageId) return;
            if (__s.uiTemplateUpdateAbortController) {
                __s.uiTemplateUpdateAbortController.abort();
                __s.uiTemplateUpdateAbortController = null;
            }
            __s.uiTemplateUpdateSeq++;
            if (!targetMessageId || __s.uiTemplateUpdateStatus.targetMessageId === targetMessageId) {
                markUiTemplateStatus('idle', '待命');
            }
        };
        __s.abortUiTemplateUpdate = abortUiTemplateUpdate;
        const updateUiTemplatesFromChat = async ({ manual = false, targetMessageId = null } = {}) => {
            if (!__s.settings.uiTemplateEnabled) {
                markUiTemplateStatus('skipped', '未开启');
                return false;
            }
            if (!__s.currentCharacter.value) {
                markUiTemplateStatus('skipped', '未选择角色卡');
                return false;
            }
            const templates = __s.activeUiTemplates.value;
            if (!templates.length) {
                markUiTemplateStatus('skipped', '无启用模板');
                return false;
            }
            if (__s.buildConversationTurnSnapshot().turns.length < 1) {
                markUiTemplateStatus('skipped', '对话不足');
                return false;
            }

            const targetMessage = targetMessageId
                ? __s.chatHistory.value.find(msg => msg && msg.role === 'assistant' && msg.id === targetMessageId)
                : __s.getLastAssistantMessage();
            if (!targetMessage) {
                markUiTemplateStatus('skipped', '无AI回复');
                return false;
            }
            if (!targetMessage.id) targetMessage.id = generateUUID();
            const lockedTargetMessageId = targetMessage.id;
            const targetMessageIndex = __s.chatHistory.value.findIndex(msg => msg === targetMessage || msg.id === lockedTargetMessageId);
            const contextMessages = targetMessageIndex >= 0 ? __s.chatHistory.value.slice(0, targetMessageIndex + 1) : __s.chatHistory.value;

            const uiTemplateAnalysisDepth = Number(__s.settings.uiTemplateAnalysisDepth);
            const normalizedUiTemplateAnalysisDepth = Number.isFinite(uiTemplateAnalysisDepth)
                ? Math.max(4, Math.min(10, uiTemplateAnalysisDepth))
                : 4;
            const sourceMessages = __s.getPostprocessedChatMessages(contextMessages, { includeSystem: false })
                .map(m => ({
                    role: m.role,
                    name: m.role === 'user' ? __s.user.name : (m.name || __s.currentCharacter.value.name),
                    content: __s.replaceUserNamePlaceholder(__s.appendMessageImageDescriptions(
                        m,
                        parseCot(stripUiTemplateUpdateBlock(m.content || '')).main
                    ))
                }));
            const recentMessages = sourceMessages.slice(-normalizedUiTemplateAnalysisDepth);

            const fallbackModel = (__s.settings.uiTemplateModel || '').trim();
            if (!fallbackModel) {
                markUiTemplateStatus('skipped', '未选模型');
                return false;
            }
            try {
                const updateRun = startUiTemplateUpdateRun();
                const isCurrentRun = () => isUiTemplateUpdateRunCurrent(updateRun.seq, lockedTargetMessageId);
                markUiTemplateStatus('running', '分析中', templates.length, lockedTargetMessageId);
                const turn = __s.getAssistantTurnAtIndex(targetMessageIndex);
                let hasChanges = false;
                let changedFieldCount = 0;
                let failedTemplateCount = 0;
                const failedTemplateIds = new Set();
                const pendingTemplateUpdates = [];

                const normalizeUiTemplateUpdates = (parsed, template) => {
                    return normalizeUiTemplateUpdateList(parsed, [template]);
                };

                const applyTemplateUpdates = (template, updates, model) => {
                    updates.forEach(update => {
                        const result = applyUiTemplateUpdateListToTemplate(template, [update], { model, turn });
                        if (result.changed) {
                            changedFieldCount += result.fieldCount;
                            hasChanges = true;
                        }
                    });
                };

                await Promise.all(templates.map(async (template) => {
                    const model = fallbackModel;
                    try {
                        const currentVariableJson = JSON.stringify(template.variableState || {}, null, 2);
                        const variableSchemaText = stringifyUiSchema(template.variableSchema).trim();
                        const result = await __s.requestTrackedChatCompletion({
                            model, temperature: 0.2, stream: false,
                            messages: [
                                {
                                    role: 'system',
                                    content: __s.replaceUserNamePlaceholder(BUILTIN_PROMPTS.buildUiTemplateAnalysisSystemPrompt({
                                        templateId: template.id,
                                        userInfo: __s.buildUserInfoPrompt(),
                                        currentVariableJson,
                                        variableSchemaText,
                                        userName: __s.user.name
                                    }))
                                },
                                { role: 'user', content: JSON.stringify({ recentMessages }, null, 2) }
                            ],
                            signal: updateRun.signal
                        }, 'ui_template');
                        if (!isCurrentRun()) return;
                        const content = parseCot(result.content).main;
                        const latestUiTemplateAnalysis = {
                            time: new Date().toISOString(),
                            model,
                            templateId: template.id,
                            templateName: template.name || template.id,
                            content: String(content)
                        };
                        window.__RPHubLastUiTemplateAnalysis = latestUiTemplateAnalysis;
                        console.info('[UI模板][副模型] 最新一次变量输出：', latestUiTemplateAnalysis);
                        const updateBlock = findUiTemplateUpdateBlock(content);
                        const parsed = parseUiTemplateUpdates(updateBlock ? updateBlock[1] : content, [template]);
                        const updates = normalizeUiTemplateUpdates(parsed, template);
                        pendingTemplateUpdates.push({ template, updates, model });
                    } catch (e) {
                        if (updateRun.signal.aborted || !isCurrentRun()) return;
                        failedTemplateCount++;
                        failedTemplateIds.add(template.id);
                        console.warn(`[UI模板] ${template.name || template.id} 未成功:`, e.message);
                    } finally {
                        if (isCurrentRun()) {
                            __s.uiTemplateUpdateStatus.remaining = Math.max(0, __s.uiTemplateUpdateStatus.remaining - 1);
                        }
                    }
                }));

                if (!isCurrentRun()) {
                    if (__s.uiTemplateUpdateSeq === updateRun.seq) {
                        __s.uiTemplateUpdateAbortController = null;
                        markUiTemplateStatus('idle', '待命');
                    }
                    return false;
                }
                pendingTemplateUpdates.forEach(({ template, updates, model }) => {
                    applyTemplateUpdates(template, updates, model);
                });

                const inserted = __s.attachUiTemplateBlocksToLastAssistant({ excludeTemplateIds: failedTemplateIds, targetMessageId: lockedTargetMessageId });

                if (hasChanges) {
                    __s.saveGlobalUiTemplateRuntimeForCharacter();
                    __s.saveData({ saveMemories: false });
                    await __s.saveChatHistoryNow();
                } else if (inserted) {
                    await __s.saveChatHistoryNow();
                }
                if (failedTemplateCount) {
                    failUiTemplateAnalysis(`${failedTemplateCount} 个失败`, lockedTargetMessageId);
                } else if (hasChanges) {
                    markUiTemplateStatus('success', `更新 ${changedFieldCount} 项`, 0, lockedTargetMessageId);
                } else {
                    markUiTemplateStatus('skipped', '无变化', 0, lockedTargetMessageId);
                }
                if (__s.uiTemplateUpdateSeq === updateRun.seq) {
                    __s.uiTemplateUpdateAbortController = null;
                }
                return failedTemplateCount < templates.length;
            } catch (e) {
                if (e?.name === 'AbortError') {
                    return false;
                }
                __s.uiTemplateUpdateAbortController = null;
                console.warn('[UI模板] 未成功:', e.message);
                const failedCount = templates.length || 1;
                const message = `${failedCount} 个失败`;
                failUiTemplateAnalysis(message, lockedTargetMessageId);
                return false;
            }
        };
        __s.updateUiTemplatesFromChat = updateUiTemplatesFromChat;
        const filterClassicMemoriesAsync = async (keepMemory) => {
            const source = Array.isArray(__s.classicMemories.value) ? __s.classicMemories.value : [];
            const kept = [];
            let removed = 0;
            for (let i = 0; i < source.length; i++) {
                if (keepMemory(source[i], i)) kept.push(source[i]);
                else removed++;
                if (i > 0 && i % 512 === 0) await __s.yieldToUi();
            }
            __s.classicMemories.value = kept;
            return removed;
        };
        __s.filterClassicMemoriesAsync = filterClassicMemoriesAsync;
        const removeClassicMemoriesForConversationTurn = async (snapshot, turn) => {
            if (!Number.isFinite(turn) || turn <= 0) return 0;
            const turnInfo = snapshot?.turns?.find(item => item.turn === turn);
            const assistantIds = new Set(__s.getClassicTurnSourceIds(turnInfo, 'assistant'));
            __s.classicMemories.value = __s.classicMemories.value.flatMap(memory => {
                if (!__s.isSecondaryClassicMemory(memory)) return [memory];
                const range = __s.getClassicMemoryTurnRange(memory);
                const matchesSource = (memory.sourceAssistantIds || []).some(id => assistantIds.has(id));
                return matchesSource || (turn >= range.start && turn <= range.end)
                    ? __s.getSecondaryClassicSourceMemories(memory)
                    : [memory];
            });
            return filterClassicMemoriesAsync(memory => {
                const memoryIds = memory.sourceAssistantIds || [];
                const matchesSource = memoryIds.some(id => assistantIds.has(id));
                return !matchesSource && Number(memory.turn) !== turn;
            });
        };
        __s.removeClassicMemoriesForConversationTurn = removeClassicMemoriesForConversationTurn;
        const syncMemoryConversationBindings = (snapshot, { backfill = false } = {}) => {
            const turns = Array.isArray(snapshot?.turns) ? snapshot.turns : [];
            const turnByMessageId = new Map();
            const sourcesByTurn = new Map();
            turns.forEach(turnInfo => {
                const userIds = __s.getClassicTurnSourceIds(turnInfo, 'user');
                const assistantIds = __s.getClassicTurnSourceIds(turnInfo, 'assistant');
                const messageIds = [...new Set([...userIds, ...assistantIds])];
                sourcesByTurn.set(Number(turnInfo.turn), { userIds, assistantIds });
                messageIds.forEach(id => turnByMessageId.set(id, Number(turnInfo.turn)));
            });

            __s.classicMemories.value.flatMap(memory => [memory, ...(memory.sourceMemories || [])]).forEach(memory => {
                if (backfill && !(memory.sourceUserIds || []).length && !(memory.sourceAssistantIds || []).length) {
                    const sources = sourcesByTurn.get(Number(memory.turn));
                    if (sources) {
                        memory.sourceUserIds = sources.userIds;
                        memory.sourceAssistantIds = sources.assistantIds;
                    }
                }
                const sourceIds = (memory.sourceAssistantIds || []).length
                    ? memory.sourceAssistantIds
                    : (memory.sourceUserIds || []);
                const liveTurns = sourceIds.map(id => turnByMessageId.get(id)).filter(Number.isFinite);
                if (!liveTurns.length) return;
                if (__s.isSecondaryClassicMemory(memory)) {
                    memory.turnStart = Math.min(...liveTurns);
                    memory.turnEnd = Math.max(...liveTurns);
                    memory.turn = memory.turnEnd;
                } else {
                    memory.turn = liveTurns[0];
                }
            });
        };
        __s.syncMemoryConversationBindings = syncMemoryConversationBindings;
        const playMessageActionFeedback = (event) => {
            const button = event?.currentTarget;
            if (!button) return;
            button.classList.remove('is-tapped');
            void button.offsetWidth;
            button.classList.add('is-tapped');
            setTimeout(() => {
                button.classList.remove('is-tapped');
                button.blur();
            }, 280);
        };
        __s.playMessageActionFeedback = playMessageActionFeedback;
        const removeClassicMemoriesFromTurn = (firstRemovedTurn) => {
            const previousCount = __s.classicMemories.value.length;
            __s.classicMemories.value = __s.trimClassicMemoriesToTurn(__s.classicMemories.value, firstRemovedTurn - 1);
            return Math.max(0, previousCount - __s.classicMemories.value.length);
        };
        __s.removeClassicMemoriesFromTurn = removeClassicMemoriesFromTurn;
        const deleteMessage = (index) => {
            const targetMessage = __s.chatHistory.value[index];
            if (!targetMessage || !__s.canDeleteMessage(index)) return;
            const deletesUserTurn = targetMessage.role === 'user';
            const message = deletesUserTurn
                ? '确定要删除该轮次吗？该轮的相关项也将一并删除。'
                : '确定要删除这条 AI 消息吗？该轮的相关项也将一并删除。';
            __s.confirmAction(message, async () => {
                __s.abortConversationBackgroundWork();
                const snapshot = await __s.ensureConversationMessageIds();
                const removedIndexes = new Set([index]);
                if (deletesUserTurn) {
                    for (let nextIndex = index + 1; nextIndex < __s.chatHistory.value.length; nextIndex++) {
                        const role = __s.chatHistory.value[nextIndex]?.role;
                        if (role === 'user') break;
                        if (role === 'assistant' || role === 'system') removedIndexes.add(nextIndex);
                    }
                }
                const affectedTurnInfo = snapshot.turns.find(turnInfo =>
                    (turnInfo.sourceIndexes || []).some(sourceIndex => removedIndexes.has(sourceIndex))
                );
                const affectedTurn = affectedTurnInfo?.turn || null;
                const removedMessageIds = new Set([...removedIndexes]
                    .map(messageIndex => __s.chatHistory.value[messageIndex]?.id)
                    .filter(Boolean));
                __s.recentGenerationTimes.value = __s.recentGenerationTimes.value.filter(t => !removedMessageIds.has(t.id || t));
                const nextHistory = __s.chatHistory.value.filter((_, messageIndex) => !removedIndexes.has(messageIndex));
                const uiCleanup = __s.pruneUiTemplateChangesFromTurn(affectedTurn);
                if (affectedTurn) {
                    await removeClassicMemoriesForConversationTurn(snapshot, affectedTurn);
                }
                __s.chatHistory.value = nextHistory;
                __s.restoreSecondaryClassicMemoriesForTurnCount(
                    __s.buildConversationTurnSnapshot(nextHistory, { includeSystem: false }).turns.length
                );
                await __s.saveConversationMutationNow({ saveTemplateRuntime: uiCleanup.logs > 0 || uiCleanup.blocks > 0 });
                await __s.saveMemorySettingsNow();
                const deletedLabel = deletesUserTurn ? '该轮次' : 'AI 消息';
                __s.showToast(`${deletedLabel}已删除，相关项已一并清除`, 'success');
            });
        };
        __s.deleteMessage = deleteMessage;
        const regenerateMessage = async (index) => {
            if (__s.isGenerating.value) return;

            const startTime = Date.now(); // Record click time
            const startRegenerationStatus = () => {
                __s.isGenerating.value = true;
                __s.isReceiving.value = false;
                __s.isThinking.value = false;
                __s.currentWaitTime.value = '0.0';
            };

            const msg = __s.chatHistory.value[index];

            if (msg.role === 'user') {
                startRegenerationStatus();
                // 如果是用户消息，直接基于当前上下文生成（重试/继续）
                __s.abortConversationBackgroundWork();
                // 只删除最新一轮的记忆，保留之前的
                const snapshot = await __s.ensureConversationMessageIds();
                syncMemoryConversationBindings(snapshot, { backfill: true });
                const currentTurn = snapshot.turns.length;
                removeClassicMemoriesFromTurn(currentTurn);
                await Promise.all([__s.saveClassicMemoriesNow(), __s.saveMemorySettingsNow()]);
                await __s.generateResponse(startTime, { reuseGeneratingState: true });
            } else {
                // 如果是 AI 消息，删除它（及之后）然后重新生成
                __s.confirmAction('确定要重新生成这条消息吗？该楼层的记忆将被清除。', async () => {
                    startRegenerationStatus();
                __s.abortConversationBackgroundWork();
                    // 计算被删除区间的 assistant 轮次，只删除 >= 该轮次的记忆
                    const snapshot = await __s.ensureConversationMessageIds();
                    syncMemoryConversationBindings(snapshot, { backfill: true });
                    const turnAtIndex = getConversationTurnAtIndexFromSnapshot(snapshot, index);
                    const uiTurnAtIndex = turnAtIndex;
                    removeClassicMemoriesFromTurn(turnAtIndex);
                    const uiCleanup = __s.pruneUiTemplateChangesFromTurn(uiTurnAtIndex);
                    // Remove timing record for the message being regenerated
                    if (msg && msg.id) {
                        __s.recentGenerationTimes.value = __s.recentGenerationTimes.value.filter(t => (t.id || t) !== msg.id);
                    }
                    __s.chatHistory.value = __s.chatHistory.value.slice(0, index);
                    syncMemoryConversationBindings(__s.buildConversationTurnSnapshot());
                    __s.removeOrphanedUiTemplateCorrections();
                    await __s.saveConversationMutationNow({ saveTemplateRuntime: uiCleanup.logs > 0 || uiCleanup.blocks > 0 });
                    await __s.saveMemorySettingsNow();
                    await __s.generateResponse(startTime, { reuseGeneratingState: true });
                });
            }
        };
        __s.regenerateMessage = regenerateMessage;
    };
})();
