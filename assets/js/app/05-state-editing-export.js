/**
 * RP-Hub 应用模块 05 · 编辑器草稿、剧情分支视图状态、导出弹窗、内嵌页与拖拽排序
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 1308–1531 行。
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
    window.RPHubAppSections.stateEditing = function (__s) {

        // Editing States
        const editingCharacter = reactive({ id: undefined, data: {} });
        __s.editingCharacter = editingCharacter;
        const editorTab = ref('basic');
        __s.editorTab = editorTab;

 // 'basic', 'description', 'personality', 'first_mes'
        const isBatchDeleteMode = ref(false);
        __s.isBatchDeleteMode = isBatchDeleteMode;
        const characterGridView = ref(false);
        __s.characterGridView = characterGridView;
        const characterDeck = ref(null);
        __s.characterDeck = characterDeck;
        const useCharacterDeck = computed(() => !isBatchDeleteMode.value && !characterGridView.value);
        __s.useCharacterDeck = useCharacterDeck;
        const selectedCharacterIndices = ref(new Set());
        __s.selectedCharacterIndices = selectedCharacterIndices;
        const editingPreset = reactive({ id: undefined, data: {} });
        __s.editingPreset = editingPreset;
        const editingUiTemplate = reactive({ id: undefined, data: {}, tab: 'history' });
        __s.editingUiTemplate = editingUiTemplate;
        const editingRegex = reactive({ id: undefined, data: {} });
        __s.editingRegex = editingRegex;
        const editingWorldInfo = reactive({ id: undefined, data: {} });
        __s.editingWorldInfo = editingWorldInfo;
        const worldInfoKeysText = ref('');
        __s.worldInfoKeysText = worldInfoKeysText;
        const editingActiveTool = reactive({ id: undefined, data: {} });
        __s.editingActiveTool = editingActiveTool;
        const showContextViewerModal = ref(false);
        __s.showContextViewerModal = showContextViewerModal;
        const showStoryBranchModal = ref(false);
        __s.showStoryBranchModal = showStoryBranchModal;
        const showStoryBranchNameEditor = ref(false);
        __s.showStoryBranchNameEditor = showStoryBranchNameEditor;
        const storyBranchNameDraft = ref('');
        __s.storyBranchNameDraft = storyBranchNameDraft;
        const storyBranches = ref([]);
        __s.storyBranches = storyBranches;
        const activeStoryBranchId = ref('main');
        __s.activeStoryBranchId = activeStoryBranchId;
        const storyBranchSwitching = ref(false);
        __s.storyBranchSwitching = storyBranchSwitching;
        const selectedStoryBranchId = ref('main');
        __s.selectedStoryBranchId = selectedStoryBranchId;
        const storyRouteMapDragging = ref(false);
        __s.storyRouteMapDragging = storyRouteMapDragging;
        __s.storyRouteDragState = null;
        __s.suppressStoryRouteNodeClick = false;
        const lastContextMessages = ref([]);
        __s.lastContextMessages = lastContextMessages;
        const lastTriggeredWorldInfos = ref([]);
        __s.lastTriggeredWorldInfos = lastTriggeredWorldInfos;
        const lastContextTotalLength = computed(() => lastContextMessages.value.reduce(
            (total, message) => total + String(message?.content || '').length,
            0
        ));
        __s.lastContextTotalLength = lastContextTotalLength;
        const lastContextFloorCount = computed(() => lastContextMessages.value
            .filter(message => Number.isFinite(message?.floor)).length);
        __s.lastContextFloorCount = lastContextFloorCount;
        const CHARACTER_SCOPED_STORAGE_NAMES = ['chat', 'classic_memories', 'branches', 'wechat_timeline', 'story_recap'];
        __s.CHARACTER_SCOPED_STORAGE_NAMES = CHARACTER_SCOPED_STORAGE_NAMES;
        const {
            clearTokenUsageHistory,
            displayedTokenUsageHistory,
            filteredTokenUsageHistory,
            formatTokenAggregate,
            formatLatestTokenCount,
            formatLatestUsageCost,
            formatTokenCount,
            formatTokenUsageTime,
            getTokenUsageTypeLabel,
            getUncachedInputTokens,
            recordApiUsage,
            saveTokenUsageHistoryNow,
            showTokenUsageTimeFilter,
            tokenUsageFilter,
            tokenUsageHistory,
            tokenUsagePage,
            tokenUsagePageCount,
            tokenUsageStats,
            tokenUsageTimeFilter,
            tokenUsageTimeFilterLabel,
            tokenUsageTimeFilterOptions,
            latestMainTokenUsage
        } = useTokenUsage({
            pageSize: __s.LIST_PAGE_SIZE,
            cloneForStorage,
            confirm: (...args) => __s.confirmAction(...args),
            ensureStorage: async () => {
                if (!getMainDb()) await initDB();
            },
            generateUUID,
            getApiKey: () => __s.settings.apiKey,
            getApiUrl: () => __s.settings.apiUrl,
            normalizeApiUsage,
            saveStoredValue: setStoredValue,
            toast: (...args) => __s.showToast(...args)
        });
        __s.clearTokenUsageHistory = clearTokenUsageHistory;
        __s.displayedTokenUsageHistory = displayedTokenUsageHistory;
        __s.filteredTokenUsageHistory = filteredTokenUsageHistory;
        __s.formatTokenAggregate = formatTokenAggregate;
        __s.formatLatestTokenCount = formatLatestTokenCount;
        __s.formatLatestUsageCost = formatLatestUsageCost;
        __s.formatTokenCount = formatTokenCount;
        __s.formatTokenUsageTime = formatTokenUsageTime;
        __s.getTokenUsageTypeLabel = getTokenUsageTypeLabel;
        __s.getUncachedInputTokens = getUncachedInputTokens;
        __s.recordApiUsage = recordApiUsage;
        __s.saveTokenUsageHistoryNow = saveTokenUsageHistoryNow;
        __s.showTokenUsageTimeFilter = showTokenUsageTimeFilter;
        __s.tokenUsageFilter = tokenUsageFilter;
        __s.tokenUsageHistory = tokenUsageHistory;
        __s.tokenUsagePage = tokenUsagePage;
        __s.tokenUsagePageCount = tokenUsagePageCount;
        __s.tokenUsageStats = tokenUsageStats;
        __s.tokenUsageTimeFilter = tokenUsageTimeFilter;
        __s.tokenUsageTimeFilterLabel = tokenUsageTimeFilterLabel;
        __s.tokenUsageTimeFilterOptions = tokenUsageTimeFilterOptions;
        __s.latestMainTokenUsage = latestMainTokenUsage;
        const requestTrackedChatCompletion = (options, type) => {
            const apiUrl = __s.settings.apiUrl;
            const request = { url: buildApiEndpoint(apiUrl, 'chat/completions'), apiKey: __s.settings.apiKey, ...options };
            return requestChatCompletion({ ...request, onUsage: (usage, metrics) => recordApiUsage(usage, {
                type, model: request.model, apiUrl, apiKey: request.apiKey, ...metrics
            }) });
        };
        __s.requestTrackedChatCompletion = requestTrackedChatCompletion;
        const {
            cleanupUnusedStorage,
            formatStorageSize,
            refreshStorageStats,
            storageStats
        } = useStorageManagement({
            characters: __s.characters,
            confirm: (...args) => __s.confirmAction(...args),
            deleteStorageKeys,
            ensureStorage: async () => {
                if (!getMainDb()) await initDB();
            },
            getBranchOwnerId: scopeId => getStoryBranchOwnerId(scopeId),
            getLegacyDb,
            getMainDb,
            getStorageLogicalKey,
            globalUiTemplates: __s.globalUiTemplates,
            readStorageKeys,
            saveStoredValue: setStoredValue,
            scanStorageEntries,
            scopedStorageNames: CHARACTER_SCOPED_STORAGE_NAMES,
            toast: (...args) => __s.showToast(...args)
        });
        __s.cleanupUnusedStorage = cleanupUnusedStorage;
        __s.formatStorageSize = formatStorageSize;
        __s.refreshStorageStats = refreshStorageStats;
        __s.storageStats = storageStats;

        // Export Modal State
        const showExportModal = ref(false);
        __s.showExportModal = showExportModal;
        const exportType = ref(null);
        __s.exportType = exportType;

 // 'presets', 'regex', 'worldinfo', 'uitemplates'
        const exportItems = ref([]);
        __s.exportItems = exportItems;
        const selectedExportIndices = ref(new Set());
        __s.selectedExportIndices = selectedExportIndices;

        // Character Export Modal State
        const showCharacterExportModal = ref(false);
        __s.showCharacterExportModal = showCharacterExportModal;
        const characterToExportIndex = ref(null);
        __s.characterToExportIndex = characterToExportIndex;
        const openCharacterExportModal = (index) => {
            characterToExportIndex.value = index;
            showCharacterExportModal.value = true;
        };
        __s.openCharacterExportModal = openCharacterExportModal;
        const confirmCharacterExport = (type) => {
            showCharacterExportModal.value = false;
            if (characterToExportIndex.value !== null) {
                if (type === 'json') {
                    __s.exportCharacterJson(characterToExportIndex.value);
                } else if (type === 'chat') {
                    __s.exportCharacterChat(characterToExportIndex.value);
                } else {
                    __s.exportCharacterPng(characterToExportIndex.value);
                }
                characterToExportIndex.value = null;
            }
        };
        __s.confirmCharacterExport = confirmCharacterExport;

        // Generator State
        const isGeneratorLoading = ref(true);
        __s.isGeneratorLoading = isGeneratorLoading;
        const generatorUrl = ref('./character/index.html');
        __s.generatorUrl = generatorUrl;
        const onGeneratorLoad = () => {
            isGeneratorLoading.value = false;
            __s.syncSettingsToGenerator();
        };
        __s.onGeneratorLoad = onGeneratorLoad;

        // Square State
        const isSquareLoading = ref(true);
        __s.isSquareLoading = isSquareLoading;
        const squareUrl = ref('https://rphforum.zeabur.app/');
        __s.squareUrl = squareUrl;
        const onSquareLoad = () => {
            isSquareLoading.value = false;
            __s.getSquareFrame()?.contentWindow.postMessage({ type: 'RPHUB_IMPORT_READY' }, new URL(squareUrl.value).origin);
        };
        __s.onSquareLoad = onSquareLoad;

        // Novel State
        const isNovelLoading = ref(true);
        __s.isNovelLoading = isNovelLoading;
        const novelUrl = ref('./novel/index.html');
        __s.novelUrl = novelUrl;
        const onNovelLoad = () => {
            isNovelLoading.value = false;
        };
        __s.onNovelLoad = onNovelLoad;

        // 排序只改变位置，不改变条目的渲染身份，也不向导出数据添加内部字段。
        const sortableItemKeys = new WeakMap();
        __s.sortableItemKeys = sortableItemKeys;
        __s.sortableItemSequence = 0;
        const getSortableItemKey = (item) => {
            if (!sortableItemKeys.has(item)) sortableItemKeys.set(item, ++__s.sortableItemSequence);
            return sortableItemKeys.get(item);
        };
        __s.getSortableItemKey = getSortableItemKey;
        __s.activeSortable = null;
        const initializeSortableList = (elementId, items) => {
            nextTick(() => {
                const element = document.getElementById(elementId);
                if (!element || typeof Sortable === 'undefined') return;
                __s.activeSortable?.destroy();
                __s.activeSortable = new Sortable(element, {
                    handle: '.sortable-list-handle',
                    draggable: '.sortable-list-item',
                    direction: 'vertical',
                    animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260,
                    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                    forceFallback: true,
                    fallbackOnBody: true,
                    fallbackTolerance: 4,
                    ghostClass: 'sortable-list-placeholder',
                    chosenClass: 'sortable-list-chosen',
                    fallbackClass: 'sortable-list-preview',
                    onEnd: ({ item: movedElement, oldIndex, newIndex }) => {
                        if (!Number.isInteger(oldIndex) || !Number.isInteger(newIndex) || oldIndex === newIndex) return;
                        // 先还原 Sortable 移动过的 DOM，再让 Vue 按稳定 key 更新顺序。
                        element.insertBefore(
                            movedElement,
                            element.children[oldIndex < newIndex ? oldIndex : oldIndex + 1]
                        );
                        const item = items.value.splice(oldIndex, 1)[0];
                        items.value.splice(newIndex, 0, item);
                        __s.saveData();
                    }
                });
            });
        };
        __s.initializeSortableList = initializeSortableList;

        // Watch view change to refresh embedded pages and sortable lists
        watch(__s.currentView, (newView) => {
            __s.activeSortable?.destroy();
            __s.activeSortable = null;
            __s.settingsHelpTopic.value = '';
            if (newView === 'characters') {
                characterGridView.value = false;
                isBatchDeleteMode.value = false;
                selectedCharacterIndices.value.clear();
                __s.hasOpenedCharacterManager.value = true;
            } else if (newView === 'generator') {
                isGeneratorLoading.value = true;
                generatorUrl.value = `./character/index.html?t=${Date.now()}`;
            } else if (newView === 'square') {
                isSquareLoading.value = true;
                squareUrl.value = `https://rphforum.zeabur.app/?t=${Date.now()}`;
            } else if (newView === 'novel') {
                isNovelLoading.value = true;
                novelUrl.value = `./novel/index.html?t=${Date.now()}`;
            } else {
                const sortable = {
                    presets: ['presets-list', __s.presets],
                    regex: ['regex-list', __s.regexScripts],
                    worldinfo: ['worldinfo-list', __s.worldInfo]
                }[newView];
                if (sortable) initializeSortableList(...sortable);
            }
        });
    };
})();
