/** RP / 微信共用清理入口；本段以当前渠道之前的最后一个异渠道记录为边界。 */
(function () {
    window.RPHubAppSections = window.RPHubAppSections || {};

    const planClear = (history, timeline, channel, mode, initialHistory = []) => {
        if (mode === 'all') return { history: initialHistory, timeline: [], rpStart: 0, removed: timeline };
        const other = channel === 'wechat' ? 'rp' : 'wechat';
        let boundary = -1;
        timeline.forEach((item, index) => { if (item.channel === other) boundary = index; });
        const tail = timeline.slice(boundary + 1);
        if (channel === 'wechat') {
            const removed = tail.filter(item => item.channel === 'wechat');
            const ids = new Set(removed);
            return { history, timeline: timeline.filter(item => !ids.has(item)), rpStart: null, removed };
        }
        const indexes = tail.filter(item => item.channel === 'rp' && Number.isInteger(item.rpIndex)).map(item => item.rpIndex);
        // 从未进过微信时，整个 RP 是第一段；角色卡开场白仍是起点。
        const start = indexes.length ? Math.min(...indexes) : history.length;
        const rpStart = boundary < 0 ? Math.min(initialHistory.length, start) : start;
        return { history: history.slice(0, rpStart), timeline: timeline.slice(0, boundary + 1), rpStart, removed: tail };
    };
    window.RPHubConversationClear = { planClear };

    window.RPHubAppSections.conversationClear = function (__s) {
        __s.showConversationClear = ref(false);
        __s.conversationClearChannel = ref('rp');
        __s.conversationClearScope = '';
        __s.conversationClearPreview = computed(() => {
            const plan = planClear(__s.chatHistory.value, __s.wechatTimeline.value,
                __s.conversationClearChannel.value, 'segment', __s.createInitialChatHistory(__s.currentCharacter.value));
            return {
                rp: __s.chatHistory.value.length - plan.history.length,
                wechat: plan.removed.filter(item => item.channel === 'wechat' && item.role !== 'system').length
            };
        });
        __s.openConversationClear = async (channel = 'rp') => {
            if (__s.isConversationClearing.value || __s.fullBackupBusy?.value || __s.storyBranchSwitching.value || __s.switchingCharacterIndex.value !== -1) return;
            const scope = __s.getCurrentStoryBranchScopeId();
            if (!scope) return;
            try { await __s.ensureWechatTimelineLoaded(false, true); }
            catch (error) {
                __s.showToast(`读取聊天记录失败，清空菜单未打开：${error.message || error}`, 'error');
                return;
            }
            if (scope !== __s.getCurrentStoryBranchScopeId()) return;
            // 包括未生成完成/尚未镜像的 RP 消息，让预览和执行边界一致。
            __s.resetRpRecordCursor();
            await __s.recordRpMessages(true);
            if (scope !== __s.getCurrentStoryBranchScopeId()) return;
            if (__s.reconcileRpTimeline()) {
                __s.resetRpRecordCursor();
                __s.scheduleWechatSave();
            }
            __s.conversationClearScope = scope;
            __s.conversationClearChannel.value = channel;
            __s.showConversationClear.value = true;
        };

        __s.clearConversationContent = async (mode = 'all') => {
            if (!['all', 'segment'].includes(mode) || __s.isConversationClearing.value) return false;
            const scope = __s.conversationClearScope;
            if (!scope || scope !== __s.getCurrentStoryBranchScopeId()
                || __s.fullBackupBusy?.value || __s.storyBranchSwitching.value || __s.switchingCharacterIndex.value !== -1) {
                __s.showConversationClear.value = false;
                __s.showToast('角色或分支已切换，请重新打开清空菜单', 'info');
                return false;
            }
            __s.isConversationClearing.value = true;
            try {
                __s.stopGeneration();
                __s.stopWechatGeneration();
                __s.invalidateWechatMedia?.();
                __s.cancelStoryRecapWork();
                __s.pendingActiveWechatMessages.length = 0;
                __s.abortConversationBackgroundWork();
                if (!await __s.waitForConversationIdle()) throw new Error('生成尚未停止，请稍后重试清空');
                // 生成 finally 会调度后台补录，等它结束后再取消一次。
                __s.abortConversationBackgroundWork();
                __s.conversationRevision++;
                __s.retryingClassicMemoryId.value = '';
                __s.cancelPendingWechatSave();
                clearTimeout(__s.chatHistorySaveTimer);
                __s.chatHistorySaveTimer = null;
                __s.debouncedSave.cancel();
                await __s.chatHistorySaveQueue;
                if (scope !== __s.getCurrentStoryBranchScopeId()) throw new Error('角色或分支已切换，请重新清空');
                if (__s.getLoadedWechatScopeId() !== scope) {
                    const saved = await getScopedStoredValue('wechat_timeline', scope);
                    __s.replaceWechatTimeline(Array.isArray(saved) ? saved : [], scope);
                }
                if (!__s._classicMemoriesLoaded) {
                    const saved = await getScopedStoredValue('classic_memories', scope);
                    __s.classicMemories.value = prepareClassicMemoriesForRuntime(Array.isArray(saved) ? saved : []);
                    __s._classicMemoriesLoaded = true;
                }
                const savedRecap = await getScopedStoredValue('story_recap', scope);
                const recap = __s.storyRecap.value || savedRecap || null;
                const history = __s.chatHistory.value;
                const timeline = __s.wechatTimeline.value;
                const plan = planClear(history, timeline, __s.conversationClearChannel.value, mode,
                    __s.createInitialChatHistory(__s.currentCharacter.value));
                const removedRp = mode === 'all' ? history.length : history.length - plan.history.length;
                if (mode === 'segment' && !removedRp && !plan.removed.length) {
                    __s.showToast('当前渠道还没有本段内容', 'info');
                    return false;
                }
                const snapshot = __s.buildConversationTurnSnapshot();
                const firstRemovedTurn = removedRp && mode !== 'all'
                    ? snapshot.turns.find(turn => (turn.sourceIndexes || []).some(index => index >= plan.rpStart))?.turn
                    : null;
                if (firstRemovedTurn) {
                    const affected = new Set(snapshot.turns.filter(turn => turn.turn >= firstRemovedTurn)
                        .flatMap(turn => turn.sourceIndexes || []));
                    plan.history = plan.history.map((message, index) => {
                        if (!affected.has(index) || !message?.uiTemplateBlocks) return message;
                        const clean = { ...message }; delete clean.uiTemplateBlocks; return clean;
                    });
                }
                const memories = mode === 'all' ? [] : firstRemovedTurn
                    ? __s.trimClassicMemoriesToTurn(__s.classicMemories.value, firstRemovedTurn - 1)
                    : __s.classicMemories.value;
                const keptWechat = plan.timeline.filter(item => item.channel === 'wechat' && item.role !== 'system').length;
                const recapAffected = mode === 'all' || (firstRemovedTurn && firstRemovedTurn <= Number(recap?.coversThroughTurn))
                    || keptWechat < Number(recap?.coversWechatCount);
                const nextRecap = recapAffected ? null : recap;
                // 成功落盘后才替换界面；主事务失败时保留原记录，允许重试。
                await window.RPHubStorage.setScopedStoredValues(scope, {
                    chat: plan.history, classic_memories: memories, wechat_timeline: plan.timeline,
                    story_recap: nextRecap, wechat_media_tasks: []
                });
                __s.chatHistory.value = plan.history;
                __s.classicMemories.value = memories;
                __s.replaceWechatTimeline(plan.timeline, scope);
                __s.replaceStoryRecap(nextRecap, scope);
                __s.clearPendingChatImages();
                __s.clearPendingCardInteraction();
                __s.userInput.value = '';
                __s.wechatInput.value = '';
                __s.wechatPendingImage.value = null;
                __s.resetWechatSendTime();
                __s.cancelWechatEdit();
                __s.closeWechatMessageMenu();
                __s.resetChatRenderWindow();
                __s.clearStoryBranchTransientContext();
                __s.resetMemoryRecallFailure();
                __s.resetGeographyBudget?.();
                if (mode === 'all') __s.resetUiTemplateRuntimeState();
                else if (firstRemovedTurn) __s.pruneUiTemplateChangesFromTurn(firstRemovedTurn);
                __s.saveGlobalUiTemplateRuntimeForCharacter();
                __s.updateCurrentStoryBranchSummary();
                // 已取消旧防抖任务，显式保存它负责的配置，避免刚修改的设置丢失。
                await __s.saveData({ saveChat: false, saveMemories: false, throwOnError: true });
                await __s.saveStoryBranchesForCharacter();
                // 附件只删本次移除的引用；用户相册和其它分支仍可使用独立图片原件。
                const removedDocs = plan.removed.filter(item => item.type === 'document' && item.document?.id)
                    .filter(item => !plan.timeline.some(kept => kept.document?.id === item.document.id));
                if (mode === 'all') await __s.deleteWechatDocumentScope?.(scope);
                else await __s.deleteWechatDocumentsForMessages?.(removedDocs);
                __s.showConversationClear.value = false;
                __s.showToast(mode === 'all' ? '当前分支的 RP、微信、记忆和前情提要已全部清空' : '本段内容已清空，切换前的剧情已保留', 'success');
                return true;
            } catch (error) {
                console.error('清空对话失败:', error);
                __s.showToast(`清空未完成：${error.message || error}，请重试`, 'error', 5000);
                return false;
            } finally {
                __s.isConversationClearing.value = false;
            }
        };
    };
})();
