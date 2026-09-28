/**
 * RP-Hub 应用模块 21 · 角色切换、会话加载、剧情分支持久化与角色记忆加载
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 6778–7350 行。
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
    window.RPHubAppSections.characterLife = function (__s) {
        const createInitialChatHistory = (char) => char?.first_mes ? [{
            role: 'assistant',
            name: char.name,
            content: char.first_mes
        }] : [];
        __s.createInitialChatHistory = createInitialChatHistory;
        const getStoredChatHistoryWithRetry = async (id) => {
            let lastError = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    return await getScopedStoredValue('chat', id);
                } catch (error) {
                    lastError = error;
                    if (attempt === 3 || !__s.isRetryableChatStorageError(error)) throw error;
                    await new Promise(resolve => setTimeout(resolve, attempt * 250));
                }
            }
            throw lastError;
        };
        __s.getStoredChatHistoryWithRetry = getStoredChatHistoryWithRetry;
        const loadStoredChatHistory = async (char, fallbackIndex = null, storyScopeId = char?.uuid) => {
            let savedChat = await getStoredChatHistoryWithRetry(storyScopeId);
            if (savedChat === undefined && storyScopeId === char?.uuid && Number.isInteger(fallbackIndex)) {
                savedChat = await getStoredChatHistoryWithRetry(fallbackIndex);
            }
            if (savedChat === undefined) return createInitialChatHistory(char);
            if (!Array.isArray(savedChat)) {
                throw new TypeError('保存的聊天记录格式不是数组');
            }
            if (savedChat.some(message => message !== null && (typeof message !== 'object' || Array.isArray(message)))) {
                throw new TypeError('保存的聊天记录包含无效消息');
            }
            return savedChat.length > 0
                ? __s.prepareLoadedChatHistoryForDisplay(savedChat)
                : createInitialChatHistory(char);
        };
        __s.loadStoredChatHistory = loadStoredChatHistory;
        const saveStoryBranchesForCharacter = async (char = __s.currentCharacter.value, branchState = {}) => {
            if (!char?.uuid) return;
            if (!getMainDb()) await initDB();
            await setScopedStoredValue('branches', char.uuid, {
                version: 1,
                activeBranchId: branchState.activeBranchId ?? __s.activeStoryBranchId.value,
                branches: cloneForStorage(branchState.branches ?? __s.storyBranches.value)
            }, { clone: false });
        };
        __s.saveStoryBranchesForCharacter = saveStoryBranchesForCharacter;
        const readStoryBranchesForCharacter = async (char) => {
            if (!getMainDb()) await initDB();
            const saved = char?.uuid ? await getScopedStoredValue('branches', char.uuid) : null;
            const branches = normalizeStoryBranches(char, saved);
            const requestedActiveId = String(saved?.activeBranchId || STORY_BRANCH_MAIN_ID);
            const activeBranchId = branches.some(branch => branch.id === requestedActiveId)
                ? requestedActiveId
                : STORY_BRANCH_MAIN_ID;
            const mainNameWasChanged = saved?.branches?.some(branch => (
                String(branch?.id) === STORY_BRANCH_MAIN_ID && branch?.name !== '主线'
            ));
            if (char?.uuid && (!saved || mainNameWasChanged)) {
                await saveStoryBranchesForCharacter(char, { activeBranchId, branches });
            }
            return { activeBranchId, branches };
        };
        __s.readStoryBranchesForCharacter = readStoryBranchesForCharacter;
        const loadStoryBranchesForCharacter = async (char) => {
            const branchState = await readStoryBranchesForCharacter(char);
            __s.storyBranches.value = branchState.branches;
            __s.activeStoryBranchId.value = branchState.activeBranchId;
            return branchState;
        };
        __s.loadStoryBranchesForCharacter = loadStoryBranchesForCharacter;
        const updateCurrentStoryBranchSummary = () => {
            const branch = __s.storyBranches.value.find(item => item.id === __s.activeStoryBranchId.value);
            if (!branch) return;
            branch.updatedAt = Date.now();
            branch.floorCount = __s.getPostprocessedChatMessages(__s.chatHistory.value, { includeSystem: false }).length;
            branch.messageCount = __s.chatHistory.value.filter(message => ['user', 'assistant'].includes(message?.role)).length;
            branch.wordCount = getConversationBodyLength(__s.chatHistory.value);
        };
        __s.updateCurrentStoryBranchSummary = updateCurrentStoryBranchSummary;
        const clearStoryBranchTransientContext = () => {
            __s.lastContextMessages.value = [];
            __s.lastTriggeredWorldInfos.value = [];
            __s.resetActiveToolResultContext();
        };
        __s.clearStoryBranchTransientContext = clearStoryBranchTransientContext;
        const saveCurrentStoryBranchState = async (switchEpoch = null) => {
            const char = __s.currentCharacter.value;
            const storyScopeId = __s.getCurrentStoryBranchScopeId();
            if (!char?.uuid || !storyScopeId) return true;
            const isCurrentRequest = () => switchEpoch === null || switchEpoch === __s._characterSwitchEpoch;
            if (__s.retryingClassicMemoryId.value) {
                __s.showToast('请等待当前总结记忆重试完成后再切换分支', 'warning');
                return false;
            }
            if (__s.isConversationBusy.value) {
                __s.stopGeneration();
                const stopped = await __s.waitForConversationIdle();
                if (!stopped) {
                    __s.showToast('正在停止生成，请稍后再切换分支', 'warning');
                    return false;
                }
            }
            if (!isCurrentRequest()) return false;
            __s.abortConversationBackgroundWork();
            await __s.flushPendingChatHistorySave();
            if (!isCurrentRequest()) return false;
            updateCurrentStoryBranchSummary();
            const historySource = __s.chatHistory.value;
            const classicMemorySource = __s.classicMemories.value;
            const branchState = {
                activeBranchId: __s.activeStoryBranchId.value,
                branches: cloneForStorage(__s.storyBranches.value)
            };
            __s.saveGlobalUiTemplateRuntimeForCharacter();
            await __s.saveChatHistoryNow(storyScopeId, historySource);
            await __s.saveClassicMemoriesNow(storyScopeId, classicMemorySource);
            if (!isCurrentRequest()) return false;
            await Promise.all([
                saveStoryBranchesForCharacter(char, branchState),
                __s.saveMemorySettingsNow(),
                setStoredValue('global_ui_templates', __s.globalUiTemplates.value),
                __s.saveCharactersNow()
            ]);
            return true;
        };
        __s.saveCurrentStoryBranchState = saveCurrentStoryBranchState;
        const selectStoryBranchNode = (branchId) => {
            if (!__s.storyBranches.value.some(branch => branch.id === branchId)) return;
            __s.selectedStoryBranchId.value = branchId;
        };
        __s.selectStoryBranchNode = selectStoryBranchNode;
        const openStoryBranchNameEditor = () => {
            const target = __s.storyBranches.value.find(branch => branch.id === __s.selectedStoryBranchId.value);
            if (!target || __s.storyBranchSwitching.value) return;
            if (target.id === STORY_BRANCH_MAIN_ID) {
                __s.showToast('主线名称不可修改', 'warning');
                return;
            }
            __s.storyBranchNameDraft.value = target.name;
            __s.showStoryBranchNameEditor.value = true;
        };
        __s.openStoryBranchNameEditor = openStoryBranchNameEditor;
        const saveStoryBranchName = async () => {
            const target = __s.storyBranches.value.find(branch => branch.id === __s.selectedStoryBranchId.value);
            const name = __s.storyBranchNameDraft.value.trim().replace(/\s+/g, ' ').slice(0, 30);
            if (!target || __s.storyBranchSwitching.value) return;
            if (target.id === STORY_BRANCH_MAIN_ID) {
                __s.showStoryBranchNameEditor.value = false;
                __s.showToast('主线名称不可修改', 'warning');
                return;
            }
            if (!name) {
                __s.showToast('分支名称不能为空', 'warning');
                return;
            }
            if (name === target.name) {
                __s.showStoryBranchNameEditor.value = false;
                return;
            }
            const previousName = target.name;
            const previousUpdatedAt = target.updatedAt;
            __s.storyBranchSwitching.value = true;
            try {
                target.name = name;
                target.updatedAt = Date.now();
                await saveStoryBranchesForCharacter();
                __s.showStoryBranchNameEditor.value = false;
                __s.showToast(`已将“${previousName}”改名为“${name}”`, 'success');
            } catch (error) {
                target.name = previousName;
                target.updatedAt = previousUpdatedAt;
                console.error('Failed to rename story branch:', error);
                __s.showToast(`修改分支名称失败：${error.message || '请稍后重试'}`, 'error');
            } finally {
                __s.storyBranchSwitching.value = false;
            }
        };
        __s.saveStoryBranchName = saveStoryBranchName;
        const deleteSelectedStoryBranch = () => {
            const target = __s.storyBranches.value.find(branch => branch.id === __s.selectedStoryBranchId.value);
            const char = __s.currentCharacter.value;
            if (!target || !char?.uuid) return;
            if (!__s.selectedStoryRouteCanDelete.value) {
                __s.showToast('请选择需要删除的分支，主线不能删除', 'warning');
                return;
            }
            const parentId = __s.storyBranches.value.some(branch => branch.id === target.parentId)
                ? target.parentId
                : STORY_BRANCH_MAIN_ID;
            const parent = __s.storyBranches.value.find(branch => branch.id === parentId);
            const hasChildren = __s.storyBranches.value.some(branch => branch.parentId === target.id);
            __s.confirmAction(
                `确定要删除“${target.name}”吗？${hasChildren ? `下级分支会顺延到“${parent?.name || '主线'}”下，` : ''}该分支的聊天、记忆和 UI 状态会被删除，此操作无法撤销。`,
                async () => {
                    try {
                        if (target.id === __s.activeStoryBranchId.value) {
                            await switchStoryBranch(parentId, { closeModal: false, notify: false });
                            if (__s.activeStoryBranchId.value !== parentId) {
                                throw new Error(`无法切换到“${parent?.name || '主线'}”`);
                            }
                        }
                        __s.storyBranchSwitching.value = true;
                        if (!getMainDb()) await initDB();
                        const scopeId = __s.getStoryBranchScopeId(char.uuid, target.id);
                        await Promise.all([
                            deleteScopedStoredValue('chat', scopeId),
                            deleteScopedStoredValue('classic_memories', scopeId)
                        ]);
                        __s.getUiTemplatesForRuntime(char).forEach(template => {
                            if (!template.runtimeByCharacter) return;
                            delete template.runtimeByCharacter[scopeId];
                        });
                        __s.storyBranches.value.forEach(branch => {
                            if (branch.parentId === target.id) branch.parentId = parentId;
                        });
                        __s.storyBranches.value = __s.storyBranches.value.filter(branch => branch.id !== target.id);
                        __s.selectedStoryBranchId.value = parentId;
                        await Promise.all([
                            saveStoryBranchesForCharacter(char),
                            __s.saveMemorySettingsNow(),
                            setStoredValue('global_ui_templates', __s.globalUiTemplates.value),
                            __s.saveCharactersNow()
                        ]);
                        __s.showToast(`已删除“${target.name}”${hasChildren ? '，下级分支已顺延保留' : ''}`, 'success');
                    } catch (error) {
                        console.error('Failed to delete story branch:', error);
                        __s.showToast(`删除分支失败：${error.message || '请稍后重试'}`, 'error');
                    } finally {
                        __s.storyBranchSwitching.value = false;
                    }
                }
            );
        };
        __s.deleteSelectedStoryBranch = deleteSelectedStoryBranch;
        const createStoryBranch = async (forkMessageIndex = null) => {
            const char = __s.currentCharacter.value;
            if (!char?.uuid || __s.storyBranchSwitching.value) return;
            const forkFromMessage = Number.isInteger(forkMessageIndex);
            const forkMessage = forkFromMessage ? __s.chatHistory.value[forkMessageIndex] : null;
            if (forkFromMessage && forkMessage?.role !== 'assistant') return;
            const forkMessageId = forkMessage?.id;
            const parent = forkFromMessage
                ? __s.currentStoryBranch.value
                : __s.storyBranches.value.find(branch => branch.id === __s.selectedStoryBranchId.value)
                || __s.currentStoryBranch.value;
            if (!parent) return;
            __s.storyBranchSwitching.value = true;
            let createdBranch = null;
            const previousState = {
                activeId: __s.activeStoryBranchId.value,
                chatHistory: __s.chatHistory.value,
                classicMemories: __s.classicMemories.value
            };
            try {
                if (!await saveCurrentStoryBranchState()) return;
                const parentId = parent.id;
                const parentScopeId = __s.getStoryBranchScopeId(char.uuid, parentId);
                const branchId = generateUUID();
                const branchScopeId = __s.getStoryBranchScopeId(char.uuid, branchId);
                createdBranch = { branchId, branchScopeId, parentId };
                const branchNumber = __s.storyBranches.value.filter(branch => branch.id !== STORY_BRANCH_MAIN_ID).length + 1;
                const branchName = `分支 ${branchNumber}`;
                const now = Date.now();
                const [loadedChatHistory, sourceClassicMemories] = await Promise.all([
                    loadStoredChatHistory(char, null, parentScopeId),
                    getScopedStoredValue('classic_memories', parentScopeId)
                ]);
                const storedClassicMemories = Array.isArray(sourceClassicMemories) ? sourceClassicMemories : [];
                let sourceChatHistory = loadedChatHistory;
                let branchClassicMemories = storedClassicMemories;
                let forkTurn = null;
                if (forkFromMessage) {
                    const sourceIndex = forkMessageId
                        ? loadedChatHistory.findIndex(message => message?.id === forkMessageId)
                        : forkMessageIndex;
                    if (sourceIndex < 0 || loadedChatHistory[sourceIndex]?.role !== 'assistant') {
                        throw new Error('目标消息已发生变化，请重试');
                    }
                    sourceChatHistory = loadedChatHistory.slice(0, sourceIndex + 1);
                    forkTurn = __s.buildConversationTurnSnapshot(sourceChatHistory, { includeSystem: false }).turns.length;
                    branchClassicMemories = __s.trimClassicMemoriesToTurn(storedClassicMemories, forkTurn);
                }
                const floorCount = __s.getPostprocessedChatMessages(sourceChatHistory, { includeSystem: false }).length;
                const wordCount = getConversationBodyLength(sourceChatHistory);

                await setScopedStoredValue('chat', branchScopeId, cloneForStorage(sourceChatHistory), { clone: false });
                await setScopedStoredValue('classic_memories', branchScopeId, cloneForStorage(branchClassicMemories), { clone: false });

                __s.getUiTemplatesForRuntime(char).forEach(template => {
                    if (!template.runtimeByCharacter || typeof template.runtimeByCharacter !== 'object') {
                        template.runtimeByCharacter = {};
                    }
                    const sourceRuntime = template.runtimeByCharacter[parentScopeId] || {
                        variableState: template.variableState || template.initialVariableState || {},
                        changeLog: template.changeLog || []
                    };
                    if (forkFromMessage) {
                        const changeLog = Array.isArray(sourceRuntime.changeLog) ? sourceRuntime.changeLog : [];
                        template.runtimeByCharacter[branchScopeId] = {
                            variableState: __s.buildUiTemplateStateAtTurn({ ...template, changeLog }, forkTurn),
                            changeLog: cloneForStorage(changeLog.filter(log => Number(log?.turn || 0) <= forkTurn))
                        };
                    } else {
                        template.runtimeByCharacter[branchScopeId] = cloneForStorage(sourceRuntime);
                    }
                });

                __s.storyBranches.value.push({
                    id: branchId,
                    name: branchName,
                    parentId,
                    createdAt: now,
                    updatedAt: now,
                    forkFloor: floorCount,
                    floorCount,
                    messageCount: sourceChatHistory.filter(message => ['user', 'assistant'].includes(message?.role)).length,
                    wordCount
                });
                __s.activeStoryBranchId.value = branchId;
                await Promise.all([
                    saveStoryBranchesForCharacter(char),
                    __s.saveMemorySettingsNow(),
                    setStoredValue('global_ui_templates', __s.globalUiTemplates.value),
                    __s.saveCharactersNow()
                ]);
                __s.loadGlobalUiTemplateRuntimeForCharacter(char);
                __s._isApplyingCharacterScopedData = true;
                __s.resetChatRenderWindow();
                __s.chatHistory.value = sourceChatHistory;
                __s.classicMemories.value = prepareClassicMemoriesForRuntime(branchClassicMemories);
                __s._classicMemoriesLoaded = true;
                clearStoryBranchTransientContext();
                __s.finishApplyingCharacterScopedData();
                __s.selectedStoryBranchId.value = branchId;
                __s.showToast(`已创建并进入“${branchName}”`, 'success');
            } catch (error) {
                __s._isApplyingCharacterScopedData = false;
                if (createdBranch) {
                    __s.storyBranches.value = __s.storyBranches.value.filter(branch => branch.id !== createdBranch.branchId);
                    __s.activeStoryBranchId.value = previousState.activeId;
                    __s.chatHistory.value = previousState.chatHistory;
                    __s.classicMemories.value = previousState.classicMemories;
                    __s.getUiTemplatesForRuntime(char).forEach(template => {
                        if (template.runtimeByCharacter) delete template.runtimeByCharacter[createdBranch.branchScopeId];
                    });
                    __s.loadGlobalUiTemplateRuntimeForCharacter(char);
                    await Promise.allSettled([
                        deleteScopedStoredValue('chat', createdBranch.branchScopeId),
                        deleteScopedStoredValue('classic_memories', createdBranch.branchScopeId),
                        saveStoryBranchesForCharacter(char),
                        __s.saveMemorySettingsNow(),
                        setStoredValue('global_ui_templates', __s.globalUiTemplates.value),
                        __s.saveCharactersNow()
                    ]);
                }
                console.error('Failed to create story branch:', error);
                __s.showToast(`创建分支失败：${error.message || '请稍后重试'}`, 'error');
            } finally {
                __s.storyBranchSwitching.value = false;
            }
        };
        __s.createStoryBranch = createStoryBranch;
        const switchStoryBranch = async (branchId, options = {}) => {
            const { closeModal = true, notify = true } = options;
            const char = __s.currentCharacter.value;
            const target = __s.storyBranches.value.find(branch => branch.id === branchId);
            if (!char?.uuid || !target || branchId === __s.activeStoryBranchId.value || __s.storyBranchSwitching.value) return;
            __s.clearPendingChatImages();
            __s.clearPendingCardInteraction();
            __s.storyBranchSwitching.value = true;
            try {
                if (!await saveCurrentStoryBranchState()) return;
                const targetScopeId = __s.getStoryBranchScopeId(char.uuid, branchId);
                const [loadedChatHistory, savedClassicMemories] = await Promise.all([
                    loadStoredChatHistory(char, null, targetScopeId),
                    getScopedStoredValue('classic_memories', targetScopeId)
                ]);

                __s._isApplyingCharacterScopedData = true;
                __s.activeStoryBranchId.value = branchId;
                __s.resetChatRenderWindow();
                __s.chatHistory.value = loadedChatHistory;
                __s.classicMemories.value = prepareClassicMemoriesForRuntime(savedClassicMemories);
                __s._classicMemoriesLoaded = true;
                __s.loadGlobalUiTemplateRuntimeForCharacter(char);
                clearStoryBranchTransientContext();
                updateCurrentStoryBranchSummary();
                __s.finishApplyingCharacterScopedData();
                await saveStoryBranchesForCharacter(char);
                __s.currentView.value = 'chat';
                await __s.scrollChatToBottom();
                __s.selectedStoryBranchId.value = branchId;
                if (closeModal) __s.showStoryBranchModal.value = false;
                if (notify) __s.showToast(`已进入“${target.name}”`, 'success');
            } catch (error) {
                __s._isApplyingCharacterScopedData = false;
                console.error('Failed to switch story branch:', error);
                __s.showToast(`切换分支失败：${error.message || '原分支未被覆盖'}`, 'error');
            } finally {
                __s.storyBranchSwitching.value = false;
            }
        };
        __s.switchStoryBranch = switchStoryBranch;
        const openStoryBranchModal = () => {
            if (!__s.currentCharacter.value) {
                __s.showToast('请先选择角色卡', 'warning');
                return;
            }
            __s.selectedStoryBranchId.value = __s.activeStoryBranchId.value;
            __s.storyRouteDragState = null;
            __s.storyRouteMapDragging.value = false;
            __s.suppressStoryRouteNodeClick = false;
            __s.showStoryBranchModal.value = true;
        };
        __s.openStoryBranchModal = openStoryBranchModal;
        const readCharacterMemories = async (characterId, errorContext = '') => {
            let summaryMemories = [];
            let summaryLoaded = false;
            try {
                const savedMemories = await getScopedStoredValue('classic_memories', characterId);
                summaryMemories = prepareClassicMemoriesForRuntime(savedMemories);
                summaryLoaded = true;
            } catch (error) {
                console.error(`Error loading classic memories${errorContext}:`, error);
            }
            return { summaryMemories, summaryLoaded };
        };
        __s.readCharacterMemories = readCharacterMemories;
        const loadCharacterMemories = async (characterId, errorContext = '') => {
            const loadEpoch = __s._characterSwitchEpoch;
            __s._classicMemoriesLoaded = false;
            const loaded = await readCharacterMemories(characterId, errorContext);
            if (loadEpoch !== __s._characterSwitchEpoch || __s.getCurrentStoryBranchScopeId() !== characterId) {
                return loaded;
            }
            __s.classicMemories.value = loaded.summaryMemories;
            __s._classicMemoriesLoaded = loaded.summaryLoaded;
            return loaded;
        };
        __s.loadCharacterMemories = loadCharacterMemories;
        const selectCharacter = async (index, isNewImport = false, { silent = false } = {}) => {
            const char = __s.characters.value[index];
            if (!char) {
                __s.showToast('角色不存在，无法读取聊天记录', 'error');
                return;
            }
            if (!isNewImport && __s.currentCharacterIndex.value === index) {
                if (!silent) {
                    __s.currentView.value = 'chat';
                    await __s.scrollChatToBottom();
                }
                return true;
            }
            __s.clearPendingChatImages();
            __s.clearPendingCardInteraction();
            const switchEpoch = ++__s._characterSwitchEpoch;
            const isLatestSwitch = () => switchEpoch === __s._characterSwitchEpoch;
            __s.switchingCharacterIndex.value = index;
            try {
            await __s._characterSwitchSavePromise;
            if (!isLatestSwitch()) return;

            if (__s.isConversationBusy.value) {
                __s.stopGeneration();
                const stopped = await __s.waitForConversationIdle();
                if (!isLatestSwitch()) return;
                await __s.saveChatHistoryNow(__s.getCurrentStoryBranchScopeId(), __s.chatHistory.value);
                if (!isLatestSwitch()) return;
                if (!stopped) {
                    __s.showToast('正在停止生成，请稍后再切换角色卡', 'warning');
                    return;
                }
            }
            await __s.flushPendingChatHistorySave();
            if (!isLatestSwitch()) return;
            __s.abortUiTemplateUpdate();
            const previousCharacterIndex = __s.currentCharacterIndex.value;
            __s.abortClassicBatchExtraction();
            if (previousCharacterIndex !== -1 && !await saveCurrentStoryBranchState(switchEpoch)) return;
            if (!isLatestSwitch()) return;

            let branchState;
            let loadedChatHistory;
            let loadedMemories;
            try {
                if (!char.uuid) {
                    char.uuid = generateUUID();
                    await __s.saveCharactersNow();
                    if (!isLatestSwitch()) return;
                }
                branchState = await readStoryBranchesForCharacter(char);
                if (!isLatestSwitch()) return;
                const storyScopeId = __s.getStoryBranchScopeId(char.uuid, branchState.activeBranchId);
                [loadedChatHistory, loadedMemories] = await Promise.all([
                    loadStoredChatHistory(char, index, storyScopeId),
                    readCharacterMemories(storyScopeId)
                ]);
                if (!isLatestSwitch()) return;
            } catch (error) {
                if (!isLatestSwitch()) return;
                console.error('Error loading chat history:', error);
                __s.showToast('聊天记录读取失败，已保留当前会话且不会覆盖原记录，请稍后重试', 'error', 5000);
                return;
            }

            __s._isApplyingCharacterScopedData = true;
            __s.currentCharacterIndex.value = index;
            __s.storyBranches.value = branchState.branches;
            __s.activeStoryBranchId.value = branchState.activeBranchId;
            __s.selectedStoryBranchId.value = branchState.activeBranchId;
            __s.resetChatRenderWindow();
            if (previousCharacterIndex !== index) {
                __s.loadGlobalUiTemplateRuntimeForCharacter(char);
            }
            __s.chatHistory.value = loadedChatHistory;
            __s.classicMemories.value = loadedMemories.summaryMemories;
            __s._classicMemoriesLoaded = loadedMemories.summaryLoaded;

            // Load Character Specific Data
            __s.applyCharacterScopedResources(char);
            clearStoryBranchTransientContext();
            __s.finishApplyingCharacterScopedData();

            if (char.recentGenerationTimes) {
                __s.recentGenerationTimes.value = JSON.parse(JSON.stringify(char.recentGenerationTimes));
            } else {
                __s.recentGenerationTimes.value = [];
            }

            // Enforce special rules (Nai画图正则 & 自动生图)
            __s.enforceSpecialRules();

            // Sync image style rules
            if (__s.isAutoImageGenEnabled.value) {
                const messages = __s.updateImageGenRegexState({ enableRegex: true });
                if (!silent && messages && messages.length > 0) {
                    __s.showToast('已同步生图风格：' + messages.join('，'), 'success');
                }
            }

            if (!silent) {
                __s.currentView.value = 'chat';
                await __s.scrollChatToBottom();
                if (!isLatestSwitch()) return;
                __s.showToast(`已切换到角色: ${char.name}`, 'success');

                // 弹出自动生图询问 (仅在导入新卡时)
                if (isNewImport) __s.showAutoImageGenModal.value = true;
            }

            __s._characterSwitchSavePromise = setStoredValue('last_active_char', index);
            await __s._characterSwitchSavePromise;
            return isLatestSwitch();
            } finally {
                if (isLatestSwitch()) __s.switchingCharacterIndex.value = -1;
            }
        };
        __s.selectCharacter = selectCharacter;
        const handleAvatarUpload = (event) => {
            const file = event.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        __s.editingCharacter.data.avatar = await compressImage(e.target.result, 400, 0.8);
                    } catch (err) {
                        __s.editingCharacter.data.avatar = e.target.result;
                    }
                };
                reader.readAsDataURL(file);
            }
        };
        __s.handleAvatarUpload = handleAvatarUpload;
    };
})();
