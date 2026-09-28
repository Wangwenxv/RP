const { createApp, ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } = Vue;
const { useStorageManagement, useTokenUsage } = window.RPHubComposables;
const { createMessageRenderer } = window.RPHubMessageRenderer;
const { AppNavigation } = window.RPHubLayoutComponents;
const { requestChatCompletion, requestJson } = window.RPHubApiClient;
const { buildApiEndpoint } = window.RPHubApiUtils;
const {
    ActionConfirmModal,
    ActiveToolEditorModal,
    AddCharacterModal,
    AutoImageGenModal,
    CharacterExportModal,
    CharacterEditorModal,
    CharacterCard,
    CharacterDeck,
    ContextViewerModal,
    EmbeddedViewContent,
    GenerationTimer,
    ExportSelectionModal,
    ModelSelectorModal,
    ModalHeader,
    ModalShell,
    PaginationControls,
    PresetEditorModal,
    RegexEditorModal,
    RetryConfirmModal,
    SettingsHelp,
    SettingsPageHeader,
    MemoryBackfillModal,
    StoryBranchModal,
    TokenUsageView,
    UiTemplatesView,
    UiTemplateEditorModal,
    UiTemplatePending,
    UpdateNotificationModal,
    UserSetupModal,
    WorldInfoEditorModal
} = window.RPHubComponents;
const {
    compressImage,
    defaultAvatar,
    generateUUID,
    getApiUsagePayload,
    getImageTagRegex,
    normalizeApiUsage,
    parseCot,
    stringifyErrorDetail
} = window.RPHubUtils;
const {
    buildSummaryEmbeddingText,
    cosineSimilarity,
    getClassicMemoryKey,
    getSummaryEmbedding,
    getSummarySources,
    markRuntimeRaw,
    normalizeEmbedding,
    prepareClassicMemoriesForRuntime,
    quantizeEmbeddingForStorage,
    trimMemoryText
} = window.RPHubMemoryUtils;
const {
    appendEnhancedMemoryRecall,
    buildContextViewerState,
    buildConversationTurnSnapshot: createConversationTurnSnapshot,
    escapeXmlAttribute,
    getConversationTurnAtIndexFromSnapshot,
    getPostprocessedChatMessages: postprocessChatHistory,
    indentXmlText,
    injectContextMessages,
    isRoleMemoryContextContent,
    postprocessContextMessages,
    resolveWorldInfoEntries
} = window.RPHubContextUtils;
const {
    STORY_BRANCH_CHAT_EXPORT_TYPE,
    STORY_BRANCH_CHAT_EXPORT_VERSION,
    STORY_BRANCH_MAIN_ID,
    createStoryRouteMap,
    getConversationBodyLength,
    getStoryBranchOwnerId,
    getStoryBranchScopeId: buildStoryBranchScopeId,
    normalizeStoryBranches
} = window.RPHubStoryBranches;
const {
    buildCotPresetContent,
    corePresets: BUILTIN_CORE_PRESETS,
    managedPresets: BUILTIN_PRESETS
} = window.RPHubBuiltinPresets;
const {
    applyUiTemplateUpdateListToTemplate,
    cloneUiObject,
    createExecutableHtmlIframe,
    findUiTemplateUpdateBlock,
    inferInitialUiTemplateState,
    normalizeUiTemplate,
    normalizeUiTemplateUpdateList,
    parseUiTemplateUpdates,
    renderUiTemplateHtml,
    sanitizeUiTemplateImportEntry,
    setUiTemplateValue,
    stringifyUiSchema,
    stripUiTemplateUpdateBlock
} = window.RPHubUiTemplateUtils;
const {
    cloneForStorage,
    deleteScopedStoredValue,
    deleteStorageKeys,
    deleteStoredValue,
    getLegacyDb,
    getMainDb,
    getScopedStoredValue,
    getStoredValue,
    getStorageLogicalKey,
    initDB,
    isDatabaseClosingError,
    readStorageKeys,
    scanStorageEntries,
    setScopedStoredValue,
    setStoredValue,
    unwrapForStorage
} = window.RPHubStorage;
const { prompts: BUILTIN_PROMPTS } = window.RPHubBuiltinContent;
const {
    activeTools: activeToolConfig,
    apiProviderOptions,
    defaultApiConfig: DEFAULT_API_CONFIG,
    defaultApiProviderId: DEFAULT_API_PROVIDER_ID,
    imageGenBaseUrl: IMAGE_GEN_BASE_URL,
    latestUpdate: latestUpdateConfig,
    systemRegexNames,
    systemWorldInfoNames,
    uiOptions
} = window.RPHubConfig;

// Configure marked to disable indented code blocks
// This allows indented HTML (like details/summary) to be rendered as HTML instead of code
marked.use({
    breaks: true,
    tokenizer: {
        // Disable the indentation-based code block tokenizer
        code(src) {
            return undefined;
        }
    }
});

const RollingText = {
    props: { value: { type: [String, Number], default: '' } },
    setup(props) {
        const text = computed(() => String(props.value ?? ''));
        const characters = computed(() => Array.from(text.value));
        return { characters, text };
    },
    template: `
        <span class="inline-flex" :aria-label="text">
            <span v-for="(character, index) in characters" :key="index" class="inline-grid overflow-hidden">
                <transition name="usage-roll" appear>
                    <span :key="character" class="col-start-1 row-start-1" aria-hidden="true">{{ character }}</span>
                </transition>
            </span>
        </span>`
};


// ============================================================================
// setup() 引导常量（原 setup() 前 29 行，提升到文件顶层，供各 App 模块共享。
// 经典 script 的全局词法作用域跨文件共享，app/*.js 模块可直接引用。）
// ============================================================================
const cardUtils = window.RPHubCardUtils;
const {
    fontFamilies: fontFamilyOptions,
    fontSizes: fontSizeOptions,
    imageCounts: imageGenCountOptions,
    imageModels: imageModelOptions,
    imageSizes: imageSizeOptions,
    imageStyles: imageStyleOptions,
    popularModelFamilies,
    presetRoleDisplayLabels,
    presetRoles: presetRoleOptions,
    uiTemplatePlacements: uiTemplatePlacementOptions,
    worldInfoPositions: worldInfoPositionOptions
} = uiOptions;
const ACTIVE_TOOL_KEYWORD_TYPE = activeToolConfig.types.keyword;
const ACTIVE_TOOL_WEB_TYPE = activeToolConfig.types.web;
const ACTIVE_TOOL_RANDOM_TYPE = activeToolConfig.types.random;
const ACTIVE_TOOL_MIN_RESULT_COUNT = activeToolConfig.resultCount.min;
const ACTIVE_TOOL_DEFAULT_RESULT_COUNT = activeToolConfig.resultCount.default;
const ACTIVE_TOOL_MAX_RESULT_COUNT = activeToolConfig.resultCount.max;
const ACTIVE_TOOL_RESULT_COUNT_VERSION = activeToolConfig.resultCount.version;
const ACTIVE_TOOL_MAX_AUTO_CONTINUE = activeToolConfig.maxAutoContinue;
const ACTIVE_TOOL_AGGRESSIVENESS_ADAPTIVE = activeToolConfig.aggressiveness.adaptive;
const ACTIVE_TOOL_AGGRESSIVENESS_OPTIONS = activeToolConfig.aggressiveness.options;
const ACTIVE_TOOL_REMINDERS = activeToolConfig.aggressiveness.reminders;
const ACTIVE_TOOL_TAVILY_ENDPOINT = activeToolConfig.tavily.searchEndpoint;
const ACTIVE_TOOL_TAVILY_EXTRACT_ENDPOINT = activeToolConfig.tavily.extractEndpoint;
const ACTIVE_TOOL_TAVILY_SEARCH_DEPTH = activeToolConfig.tavily.searchDepth;
const ACTIVE_TOOL_TAVILY_EXTRACT_MAX_URLS = ACTIVE_TOOL_DEFAULT_RESULT_COUNT;
const getDefaultActiveToolDefinitions = () => activeToolConfig.defaults.map(tool => ({ ...tool }));

const app = createApp({
    components: {
        ActionConfirmModal,
        ActiveToolEditorModal,
        AddCharacterModal,
        AppNavigation,
        AutoImageGenModal,
        CharacterExportModal,
        CharacterEditorModal,
        CharacterCard,
        CharacterDeck,
        CustomSelect: window.RPHubCustomSelect,
        ContextViewerModal,
        EmbeddedViewContent,
        GenerationTimer,
        ExportSelectionModal,
        ModelSelectorModal,
        PaginationControls,
        PresetEditorModal,
        RegexEditorModal,
        RetryConfirmModal,
        RollingText,
        SettingsHelp,
        SettingsPageHeader,
        MemoryBackfillModal,
        StoryBranchModal,
        TokenUsageView,
        UiTemplatesView,
        UiTemplateEditorModal,
        UpdateNotificationModal,
        UiTemplatePending,
        UserSetupModal,
        WorldInfoEditorModal
    },
    setup() {
        // 共享上下文：全部 App 模块（assets/js/app/*.js）声明的状态与方法都镜像在此。
        // 模块按依赖顺序调用（与原 setup() 内的声明顺序一致），跨模块一律通过 __s 互访。
        const __s = {};
        const __sections = window.RPHubAppSections;
        __sections.stateAppShell(__s);
        __sections.stateSettings(__s);
        __sections.stateChat(__s);
        __sections.stateMemoryTools(__s);
        __sections.stateEditing(__s);
        __sections.persistence(__s);
        __sections.imageGenAutosave(__s);
        __sections.scopedUiTemplate(__s);
        __sections.chatDisplay(__s);
        __sections.methodsCore(__s);
        __sections.methodsModels(__s);
        __sections.methodsChatSend(__s);
        __sections.methodsMsgOps(__s);
        __sections.toolsRuntime(__s);
        __sections.generate(__s);
        __sections.memoryExtraction(__s);
        __sections.retrievalWeb(__s);
        __sections.toolsUi(__s);
        __sections.memoryBatch(__s);
        __sections.characterCrud(__s);
        __sections.characterLife(__s);
        __sections.characterIo(__s);
        __sections.lifecycle(__s);
        __sections.lateHelpers(__s);
        __sections.wechat(__s);

        return {
            switchProfile: __s.switchProfile, createNewProfile: __s.createNewProfile, deleteProfile: __s.deleteProfile, userProfiles: __s.userProfiles, activeProfileId: __s.activeProfileId, showProfileDropdown: __s.showProfileDropdown,
            processMainContent: __s.processMainContent, replaceUserNamePlaceholder: __s.replaceUserNamePlaceholder,
            currentView: __s.currentView, showDescriptionPanel: __s.showDescriptionPanel, showModelSelector: __s.showModelSelector, modelSelectionTarget: __s.modelSelectionTarget, openModelSelector: __s.openModelSelector, showChatModelSelector: __s.showChatModelSelector, showCharacterEditor: __s.showCharacterEditor, showAddCharacterMenu: __s.showAddCharacterMenu, showPresetEditor: __s.showPresetEditor, showUiTemplateEditor: __s.showUiTemplateEditor,
            showActiveToolEditor: __s.showActiveToolEditor,
            showExportModal: __s.showExportModal, exportItems: __s.exportItems, selectedExportIndices: __s.selectedExportIndices, // Export Modal
            showContextViewerModal: __s.showContextViewerModal, lastContextMessages: __s.lastContextMessages, lastTriggeredWorldInfos: __s.lastTriggeredWorldInfos,
            lastContextTotalLength: __s.lastContextTotalLength, lastContextFloorCount: __s.lastContextFloorCount, // Context Viewer
            showStoryBranchModal: __s.showStoryBranchModal, showStoryBranchNameEditor: __s.showStoryBranchNameEditor, storyBranchNameDraft: __s.storyBranchNameDraft,
            storyBranches: __s.storyBranches, storyRouteMap: __s.storyRouteMap, currentStoryBranch: __s.currentStoryBranch, selectedStoryRouteNode: __s.selectedStoryRouteNode,
            selectedStoryBranchId: __s.selectedStoryBranchId, storyBranchSwitching: __s.storyBranchSwitching, storyRouteMapDragging: __s.storyRouteMapDragging,
            selectedStoryRouteCanDelete: __s.selectedStoryRouteCanDelete,
            openStoryBranchModal: __s.openStoryBranchModal, openStoryBranchNameEditor: __s.openStoryBranchNameEditor, saveStoryBranchName: __s.saveStoryBranchName,
            createStoryBranch: __s.createStoryBranch, deleteSelectedStoryBranch: __s.deleteSelectedStoryBranch,
            selectStoryBranchNode: __s.selectStoryBranchNode, switchStoryBranch: __s.switchStoryBranch, handleStoryRouteNodeClick: __s.handleStoryRouteNodeClick,
            startStoryRouteDrag: __s.startStoryRouteDrag, moveStoryRouteDrag: __s.moveStoryRouteDrag, endStoryRouteDrag: __s.endStoryRouteDrag,
            tokenUsageHistory: __s.tokenUsageHistory, tokenUsagePage: __s.tokenUsagePage, tokenUsagePageCount: __s.tokenUsagePageCount, tokenUsageFilter: __s.tokenUsageFilter, tokenUsageTimeFilter: __s.tokenUsageTimeFilter,
            showTokenUsageTimeFilter: __s.showTokenUsageTimeFilter, tokenUsageTimeFilterOptions: __s.tokenUsageTimeFilterOptions, tokenUsageTimeFilterLabel: __s.tokenUsageTimeFilterLabel,
            filteredTokenUsageHistory: __s.filteredTokenUsageHistory, tokenUsageStats: __s.tokenUsageStats, displayedTokenUsageHistory: __s.displayedTokenUsageHistory,
            latestMainTokenUsage: __s.latestMainTokenUsage, formatLatestTokenCount: __s.formatLatestTokenCount, formatLatestUsageCost: __s.formatLatestUsageCost,
            getUncachedInputTokens: __s.getUncachedInputTokens, formatTokenCount: __s.formatTokenCount, formatTokenAggregate: __s.formatTokenAggregate, formatTokenUsageTime: __s.formatTokenUsageTime, getTokenUsageTypeLabel: __s.getTokenUsageTypeLabel, clearTokenUsageHistory: __s.clearTokenUsageHistory,
            storageStats: __s.storageStats, refreshStorageStats: __s.refreshStorageStats, cleanupUnusedStorage: __s.cleanupUnusedStorage, formatStorageSize: __s.formatStorageSize,
            showCharacterExportModal: __s.showCharacterExportModal, openCharacterExportModal: __s.openCharacterExportModal, confirmCharacterExport: __s.confirmCharacterExport, // Character Export Modal
            updateModalRef: __s.updateModalRef, latestUpdateConfig,
            showConfirmModal: __s.showConfirmModal, confirmMessage: __s.confirmMessage, modelMode: __s.modelMode, isGeminiModel: __s.isGeminiModel, isTruncationEnabled: __s.isTruncationEnabled, isPresetEnabled: __s.isPresetEnabled, chatModelSlots: __s.chatModelSlots, selectChatModelSlot: __s.selectChatModelSlot, reasoningEffortSlider: __s.reasoningEffortSlider, reasoningEffortLabel: __s.reasoningEffortLabel, // Export for template
            isGenerating: __s.isGenerating, isRemoteGenerating: __s.isRemoteGenerating, remoteEstimatedTime: __s.remoteEstimatedTime, isReceiving: __s.isReceiving, isThinking: __s.isThinking, hasActiveToolInlineWork: __s.hasActiveToolInlineWork, isConversationBusy: __s.isConversationBusy, activeToolContinuationMessageId: __s.activeToolContinuationMessageId, activeToolContinuationHasResponse: __s.activeToolContinuationHasResponse, userInput: __s.userInput, pendingCardInteraction: __s.pendingCardInteraction, clearPendingCardInteraction: __s.clearPendingCardInteraction, pendingChatImages: __s.pendingChatImages, pendingChatImageReadCount: __s.pendingChatImageReadCount, isRecognizingImages: __s.isRecognizingImages, requestChatImageSelection: __s.requestChatImageSelection, handleChatImageSelection: __s.handleChatImageSelection, removePendingChatImage: __s.removePendingChatImage, modelSearchQuery: __s.modelSearchQuery, activeModelTag: __s.activeModelTag, modelTags: __s.modelTags, characterSearchQuery: __s.characterSearchQuery, filteredModels: __s.filteredModels, filteredCharacters: __s.filteredCharacters,
            user: __s.user, settings: __s.settings, apiProviderOptions, selectedApiProvider: __s.selectedApiProvider, isCustomApiProvider: __s.isCustomApiProvider, customApiProviderOptions: __s.customApiProviderOptions, showApiProviderSelector: __s.showApiProviderSelector, selectApiProvider: __s.selectApiProvider, characters: __s.characters, currentCharacter: __s.currentCharacter, currentCharacterIndex: __s.currentCharacterIndex, switchingCharacterIndex: __s.switchingCharacterIndex, chatHistory: __s.chatHistory, displayedChatMessages: __s.displayedChatMessages, handleChatScroll: __s.handleChatScroll, presets: __s.presets, presetRoleOptions, fontFamilyOptions, fontSizeOptions, availableImageStyleOptions: __s.availableImageStyleOptions, imageModelOptions, imageSizeOptions, imageGenCountOptions, scopeOptions: __s.scopeOptions, uiTemplatePlacementOptions, worldInfoPositionOptions, getPresetRoleLabel: __s.getPresetRoleLabel, getPresetRoleDisplayLabel: __s.getPresetRoleDisplayLabel, getPresetRoleBadgeClass: __s.getPresetRoleBadgeClass, getSortableItemKey: __s.getSortableItemKey, regexScripts: __s.regexScripts, worldInfo: __s.worldInfo,
            activeTools: __s.activeTools, activeToolAggressivenessOptions: ACTIVE_TOOL_AGGRESSIVENESS_OPTIONS, editingActiveTool: __s.editingActiveTool, normalizeActiveTools: __s.normalizeActiveTools, isWebActiveTool: __s.isWebActiveTool, getActiveToolDisplayDescription: __s.getActiveToolDisplayDescription, getActiveToolResultCountMin: __s.getActiveToolResultCountMin, getActiveToolResultCountMax: __s.getActiveToolResultCountMax,
            getToolCallModeText: __s.getToolCallModeText, hasThinkingOrTools: __s.hasThinkingOrTools, isMessageThinkingOrRunning: __s.isMessageThinkingOrRunning, isThinkingSummaryOpen: __s.isThinkingSummaryOpen, toggleThinkingSummary: __s.toggleThinkingSummary, markThinkingSummaryDetailOpened: __s.markThinkingSummaryDetailOpened, getTimelineSteps: __s.getTimelineSteps,
            isStyleFilterDetailsOpen: __s.isStyleFilterDetailsOpen, toggleStyleFilterDetails: __s.toggleStyleFilterDetails, getStyleFilterHitSegments: __s.getStyleFilterHitSegments,
            chatRoundStats: __s.chatRoundStats, conversationBodyLength: __s.conversationBodyLength, summaryCompressedBodyLength: __s.summaryCompressedBodyLength, summaryCompressionRate: __s.summaryCompressionRate,
            editingCharacter: __s.editingCharacter, editingPreset: __s.editingPreset, editingUiTemplate: __s.editingUiTemplate, toasts: __s.toasts, chatContainer: __s.chatContainer, isChatFullscreen: __s.isChatFullscreen, isMobileKeyboardOpen: __s.isMobileKeyboardOpen, inputBox: __s.inputBox, messageElements: __s.messageElements,
            isGeneratorLoading: __s.isGeneratorLoading, generatorUrl: __s.generatorUrl, onGeneratorLoad: __s.onGeneratorLoad, // Generator exports
            isSquareLoading: __s.isSquareLoading, squareUrl: __s.squareUrl, onSquareLoad: __s.onSquareLoad, // Square exports
            isNovelLoading: __s.isNovelLoading, novelUrl: __s.novelUrl, onNovelLoad: __s.onNovelLoad, // Novel exports
            editorTab: __s.editorTab, characterDisplayLimit: __s.characterDisplayLimit, hasOpenedCharacterManager: __s.hasOpenedCharacterManager, isDesktopCharacterLayout: __s.isDesktopCharacterLayout, characterGridView: __s.characterGridView, characterDeck: __s.characterDeck, useCharacterDeck: __s.useCharacterDeck, displayedCharacters: __s.displayedCharacters, loadMoreCharacters: __s.loadMoreCharacters, getCharacterWICount: __s.getCharacterWICount, getCharacterRegexCount: __s.getCharacterRegexCount,
            isAutoImageGenEnabled: __s.isAutoImageGenEnabled,
            apiStatus: __s.apiStatus, apiLatency: __s.apiLatency, imageGenStatus: __s.imageGenStatus, imageGenLatency: __s.imageGenLatency, checkAllStatuses: __s.checkAllStatuses, // Status Exports
            toggleAutoImageGen: __s.toggleAutoImageGen, setWorldInfoEnabled: __s.setWorldInfoEnabled, handleGeneratedImageReroll: __s.handleGeneratedImageReroll,
            quotaValue: __s.quotaValue, quotaLoading: __s.quotaLoading, quotaError: __s.quotaError,
            // Memory System Exports
            classicMemoryPage: __s.classicMemoryPage, classicMemoryPageCount: __s.classicMemoryPageCount, classicMemories: __s.classicMemories, memorySettings: __s.memorySettings, retryingClassicMemoryId: __s.retryingClassicMemoryId, retryClassicMemory: __s.retryClassicMemory,
            isActiveBatchExtracting: __s.isClassicBatchExtracting,
            showMemoryBackfillModal: __s.showMemoryBackfillModal, memoryBackfillProgress: __s.memoryBackfillProgress,
            startBatchMemoryExtraction: __s.startBatchMemoryExtraction, abortBatchExtraction: __s.abortClassicBatchExtraction,
            activeKeepFloors: __s.activeKeepFloors, keepFloorsSlider: __s.keepFloorsSlider, keepFloorsSliderMin: __s.keepFloorsSliderMin, keepFloorsSliderMax: __s.keepFloorsSliderMax,
            // 滑块值映射：4-10 为变量分析消息层数。
            uiTemplateAnalysisDepthSlider: computed({
                get: () => Math.max(4, Math.min(10, Number(__s.settings.uiTemplateAnalysisDepth) || 4)),
                set: (val) => { __s.settings.uiTemplateAnalysisDepth = Math.max(4, Math.min(10, Number(val) || 4)); }
            }),
            displayedClassicMemories: __s.displayedClassicMemories,
            memoryStats: __s.memoryStats,
            clearAllMemories: () => {
                __s.confirmAction('确定要清空所有总结记忆及其向量吗？两个模式共享这些记忆，此操作无法撤销。', async () => {
                    __s.abortClassicBatchExtraction();
                    __s.classicMemories.value = [];
                    await __s.saveClassicMemoriesNow();
                    __s.showToast('记忆已清空', 'success');
                });
            },
            toggleNavigation: __s.toggleNavigation, closeNavigation: __s.closeNavigation,
            fetchModels: __s.fetchModels, selectModel: __s.selectModel, selectQuickModels: __s.selectQuickModels, sendMessage: __s.sendMessage, autoResizeInput: __s.autoResizeInput, handleChatInputFocus: __s.handleChatInputFocus, handleChatInputBlur: __s.handleChatInputBlur, stopGeneration: __s.stopGeneration, clearChat: __s.clearChat, toggleChatFullscreen: __s.toggleChatFullscreen,
            handleConfirm: __s.handleConfirm, handleCancel: __s.handleCancel, // Export handlers
            copyMessage: __s.copyMessage, playMessageActionFeedback: __s.playMessageActionFeedback, canDeleteMessage: __s.canDeleteMessage, deleteMessage: __s.deleteMessage, regenerateMessage: __s.regenerateMessage,
            editMessage: __s.editMessage, saveEditMessage: __s.saveEditMessage, cancelEditMessage: __s.cancelEditMessage,
            createNewCharacter: __s.createNewCharacter, editCharacter: __s.editCharacter, saveCharacter: __s.saveCharacter, deleteCharacter: __s.deleteCharacter, selectCharacter: __s.selectCharacter, toggleCharacterFavorite: __s.toggleCharacterFavorite, isCharacterFavorite: __s.isCharacterFavorite,
            currentUiTemplates: __s.currentUiTemplates, activeUiTemplates: __s.activeUiTemplates, uiTemplateUpdateStatus: __s.uiTemplateUpdateStatus, createUiTemplate: __s.createUiTemplate, editUiTemplate: __s.editUiTemplate, saveUiTemplate: __s.saveUiTemplate, deleteUiTemplate: __s.deleteUiTemplate, importUiTemplates: __s.importUiTemplates, updateUiTemplatesFromChat: __s.updateUiTemplatesFromChat, renderEditingUiTemplatePreview: __s.renderEditingUiTemplatePreview, handleUiTemplateClick: __s.handleUiTemplateClick,
            isBatchDeleteMode: __s.isBatchDeleteMode, isNavigationOpen: __s.isNavigationOpen, selectedCharacterIndices: __s.selectedCharacterIndices, toggleBatchDeleteMode: __s.toggleBatchDeleteMode, toggleCharacterSelection: __s.toggleCharacterSelection, batchDeleteCharacters: __s.batchDeleteCharacters,
            handleAvatarUpload: __s.handleAvatarUpload, importCharacter: __s.importCharacter,
            createPreset: __s.createPreset, editPreset: __s.editPreset, savePreset: __s.savePreset, deletePreset: __s.deletePreset,
            renderMarkdown: __s.renderMarkdown, messageUsesWideLayout: __s.messageUsesWideLayout, parseCot, closeCharacterEditor: () => __s.showCharacterEditor.value = false,
            openExportModal: (type) => {
                __s.exportType.value = type;
                __s.selectedExportIndices.value.clear();

                if (type === 'presets') {
                    __s.exportItems.value = __s.presets.value;
                } else if (type === 'regex') {
                    __s.exportItems.value = __s.regexScripts.value;
                } else if (type === 'worldinfo') {
                    __s.exportItems.value = __s.worldInfo.value;
                } else if (type === 'uitemplates') {
                    __s.exportItems.value = __s.currentUiTemplates.value;
                }

                __s.showExportModal.value = true;
            },
            toggleExportSelection: (index) => {
                if (__s.selectedExportIndices.value.has(index)) {
                    __s.selectedExportIndices.value.delete(index);
                } else {
                    __s.selectedExportIndices.value.add(index);
                }
            },
            selectAllExportItems: () => {
                __s.exportItems.value.forEach((_, index) => __s.selectedExportIndices.value.add(index));
            },
            deselectAllExportItems: () => {
                __s.selectedExportIndices.value.clear();
            },
            confirmExport: () => {
                const indices = Array.from(__s.selectedExportIndices.value).sort((a, b) => a - b);
                const items = indices.map(i => __s.exportItems.value[i]);

                if (items.length === 0) return;

                let fileName = 'export.json';
                let dataToExport = items;

                if (__s.exportType.value === 'presets') {
                    fileName = 'presets.json';
                    // Presets are exported as a direct array of objects
                } else if (__s.exportType.value === 'regex') {
                    fileName = 'regex_scripts.json';
                    dataToExport = items.map(script => __s.toRegexExportEntry(script));
                } else if (__s.exportType.value === 'worldinfo') {
                    fileName = 'world_info.json';
                    // World Info should be wrapped in entries object
                    dataToExport = { entries: items.map(__s.toWorldInfoExportEntry) };
                } else if (__s.exportType.value === 'uitemplates') {
                    fileName = `${__s.currentCharacter.value?.name || 'global'}_ui_templates.json`;
                    dataToExport = {
                        type: 'rp-hub-ui-templates',
                        templates: items.map(__s.toUiTemplateExportEntry)
                    };
                }

                __s.downloadJsonFile(dataToExport, fileName);

                __s.showExportModal.value = false;
                __s.showToast(`成功导出 ${items.length} 个项目`, 'success');
            },
            importPresets: (event) => __s.readJsonFileInput(event, data => {
                const items = Array.isArray(data) ? data : [data];
                if (items.length > 0) {
                    __s.presets.value = [...__s.presets.value, ...items.map(__s.normalizePreset)];
                    __s.showToast(`成功导入 ${items.length} 条预设`, 'success');
                }
            }, () => __s.showToast('导入失败: 格式错误', 'error')),

            // Regex Methods
            importRegex: (event) => __s.readJsonFileInput(event, data => {
                const items = Array.isArray(data) ? data : [data];
                const fallbackScope = __s.currentCharacter.value ? 'character' : 'global';
                const normalized = items.map(script => {
                    const scope = script?.scope || fallbackScope;
                    const result = cardUtils.normalizeImportedRegexScript(
                        { ...script, scope },
                        { fallbackScope: scope, systemNames: systemRegexNames }
                    );
                    if (Object.prototype.hasOwnProperty.call(script || {}, 'name')) result.name = script.name;
                    else if (!script?.scriptName) delete result.name;
                    if (!Object.prototype.hasOwnProperty.call(script || {}, 'regex') && !script?.findRegex) delete result.regex;
                    return result;
                });

                __s.regexScripts.value = [...__s.regexScripts.value, ...normalized];
                __s.showToast(`成功导入 ${normalized.length} 个正则脚本`, 'success');
            }, error => __s.showToast(`导入失败: ${error.message}`, 'error')),
            createRegex: () => {
                __s.editingRegex.id = undefined;
                __s.editingRegex.data = {
                    name: 'New Script',
                    regex: '',
                    flags: 'g',
                    replacement: '',
                    placement: [1, 2],
                    scope: __s.currentCharacter.value ? 'character' : 'global',
                    markdownOnly: false,
                    promptOnly: false,
                    runOnEdit: false,
                    minDepth: null,
                    maxDepth: null
                };
                __s.showRegexEditor.value = true;
            },
            editRegex: (index) => {
                __s.editingRegex.id = index;
                __s.editingRegex.data = __s.normalizeRegexScript({ ...__s.regexScripts.value[index] });
                __s.showRegexEditor.value = true;
            },
            saveRegex: () => {
                const data = __s.normalizeRegexScript(__s.editingRegex.data, __s.editingRegex.data.scope);
                if (__s.editingRegex.id !== undefined) {
                    __s.regexScripts.value[__s.editingRegex.id] = data;
                } else {
                    __s.regexScripts.value.push(data);
                }
                __s.showRegexEditor.value = false;
            },
            deleteRegex: (index) => {
                __s.confirmAction('确定要删除这个正则脚本吗？此操作无法撤销。', () => {
                    __s.regexScripts.value.splice(index, 1);
                    __s.showToast('正则脚本已删除', 'success');
                });
            },

            editActiveTool: (index) => {
                const tool = __s.activeTools.value[index];
                if (!tool) return;
                __s.editingActiveTool.id = index;
                __s.editingActiveTool.data = __s.normalizeActiveTool(JSON.parse(JSON.stringify(tool)));
                __s.showActiveToolEditor.value = true;
            },
            saveActiveTool: () => {
                const index = __s.editingActiveTool.id;
                if (index === undefined || !__s.activeTools.value[index]) {
                    __s.showActiveToolEditor.value = false;
                    return;
                }
                const previous = __s.activeTools.value[index];
                const data = __s.normalizeActiveTool({
                    ...previous,
                    id: previous.id,
                    name: previous.name,
                    enabled: previous.enabled,
                    callName: previous.callName,
                    type: previous.type,
                    description: previous.description,
                    displayDescription: previous.displayDescription,
                    resultCount: __s.editingActiveTool.data.resultCount,
                    resultCountVersion: ACTIVE_TOOL_RESULT_COUNT_VERSION,
                    tavilyApiKey: __s.editingActiveTool.data.tavilyApiKey
                });
                __s.activeTools.value[index] = data;
                __s.normalizeActiveTools();
                __s.showActiveToolEditor.value = false;
                __s.showToast('工具设置已保存', 'success');
            },

            // World Info Methods
            importWorldInfo: (event) => __s.readJsonFileInput(event, data => {
                let entries = [];
                if (Array.isArray(data)) {
                    entries = data;
                } else if (Array.isArray(data?.entries)) {
                    entries = data.entries;
                } else if (data?.entries && typeof data.entries === 'object') {
                    entries = Object.values(data.entries);
                }
                if (entries.length > 0) {
                    const normalizedEntries = entries.map(__s.normalizeWorldInfoEntry);
                    __s.worldInfo.value = [...__s.worldInfo.value, ...normalizedEntries];
                    __s.syncWorldInfoToCurrentCharacter();
                    __s.showToast('世界书导入成功', 'success');
                }
            }, () => __s.showToast('导入失败: 格式错误', 'error')),
            createWorldInfo: () => {
                __s.editingWorldInfo.id = undefined;
                __s.editingWorldInfo.data = {
                    // Basic
                    comment: '',
                    keys: [],
                    content: '',
                    enabled: true,
                    scope: __s.currentCharacter.value ? 'character' : 'global',

                    // Position & Order
                    position: 'global_note',
                    depth: 4,
                    order: 100,

                    // Matching Strategy
                    useRegex: false,
                    scanDepth: 2,
                    probability: 100,
                    useProbability: true,

                    constant: false
                };
                __s.setWorldInfoKeysText(__s.editingWorldInfo.data.keys);
                __s.showWorldInfoEditor.value = true;
            },
            editWorldInfo: (index) => {
                __s.editingWorldInfo.id = index;
                const data = JSON.parse(JSON.stringify(__s.worldInfo.value[index]));
                // Ensure defaults
                if (!data.position) data.position = 'at_depth';
                if (data.depth === undefined) data.depth = 4;
                if (data.order === undefined) data.order = 100;
                if (data.probability === undefined) data.probability = 100;
                if (data.useProbability === undefined) data.useProbability = true;
                if (!data.comment) data.comment = '';
                if (!data.scope) data.scope = 'character';

                // New fields defaults
                if (data.useRegex === undefined) data.useRegex = false;
                if (data.scanDepth === undefined) data.scanDepth = 2;
                if (data.constant === undefined) data.constant = false;

                __s.editingWorldInfo.data = __s.normalizeWorldInfoEntry(data);
                __s.setWorldInfoKeysText(__s.editingWorldInfo.data.keys);
                __s.showWorldInfoEditor.value = true;
            },
            saveWorldInfo: () => {
                __s.editingWorldInfo.data.keys = __s.parseWorldInfoKeysText(__s.worldInfoKeysText.value, __s.editingWorldInfo.data.useRegex);
                const data = __s.normalizeWorldInfoEntry(__s.editingWorldInfo.data);
                if (__s.editingWorldInfo.id !== undefined) {
                    __s.worldInfo.value[__s.editingWorldInfo.id] = data;
                } else {
                    __s.worldInfo.value.push(data);
                }
                __s.syncWorldInfoToCurrentCharacter();
                __s.showWorldInfoEditor.value = false;

            },
            deleteWorldInfo: (index) => {
                __s.confirmAction('确定要删除这个世界书条目吗？此操作无法撤销。', () => {
                    __s.worldInfo.value.splice(index, 1);
                    __s.syncWorldInfoToCurrentCharacter();
                    __s.showToast('世界书条目已删除', 'success');
                });
            },

            showRegexEditor: __s.showRegexEditor, showWorldInfoEditor: __s.showWorldInfoEditor, editingRegex: __s.editingRegex, editingWorldInfo: __s.editingWorldInfo, worldInfoKeysText: __s.worldInfoKeysText, updateEditingWorldInfoKeys: __s.updateEditingWorldInfoKeys,
            worldInfoSettings: __s.worldInfoSettings, showWorldInfoSettings: __s.showWorldInfoSettings, showMemorySettings: __s.showMemorySettings, settingsHelpTopic: __s.settingsHelpTopic, showActiveToolSettings: __s.showActiveToolSettings, showUiTemplateSettings: __s.showUiTemplateSettings, estimatedGenerationTime: __s.estimatedGenerationTime, currentWaitTime: __s.currentWaitTime,
            globalConfirmModal: __s.globalConfirmModal,

            // User Setup Method
            showUserSetupModal: __s.showUserSetupModal, tempUserSetup: __s.tempUserSetup,
            handleUserAvatarUpload: (event) => {
                const file = event.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = async (e) => {
                        try {
                            __s.user.avatar = await compressImage(e.target.result, 200, 0.6);
                        } catch (err) {
                            __s.user.avatar = e.target.result;
                        }
                        __s.saveData();
                    };
                    reader.readAsDataURL(file);
                }
            },
            saveUserSetup: () => {
                if (!__s.tempUserSetup.name || __s.tempUserSetup.name === '请前往设置自定义你的名称') {
                    __s.showToast('请输入有效的名称', 'error');
                    return;
                }
                __s.user.name = __s.tempUserSetup.name;
                __s.applyPersonPresetSelection(__s.tempUserSetup.person);

                __s.showUserSetupModal.value = false;
                __s.saveData();
                __s.showToast('用户信息已保存', 'success');
            },

            // Person Toggle Logic
            isSecondPerson: computed(() => __s.user.person !== 'third'),
            togglePerson: (person) => {
                __s.applyPersonPresetSelection(person);
                __s.showToast(__s.user.person === 'second' ? '已切换至第二人称视角' : '已切换至第三人称视角', 'success');
                __s.saveData();
            },

            // Auto Image Gen Inquiry
            showAutoImageGenModal: __s.showAutoImageGenModal,

            setAutoImageGen: (enabled) => {
                const autoImageGenWIName = '自动生图';
                const entry = __s.worldInfo.value.find(w => w.comment === autoImageGenWIName);
                if (entry) {
                    entry.enabled = enabled;
                    __s.showToast(enabled ? '自动生图已开启' : '已保持关闭状态', enabled ? 'success' : 'info');
                }
                __s.showAutoImageGenModal.value = false;
                __s.saveData();
            },

            // 微信子系统（25-wechat.js）
            showWechatPanel: __s.showWechatPanel, showWechatSettings: __s.showWechatSettings,
            wechatInput: __s.wechatInput, wechatPendingImage: __s.wechatPendingImage,
            isWechatGenerating: __s.isWechatGenerating, wechatTyping: __s.wechatTyping,
            wechatStatusText: __s.wechatStatusText, wechatSettingsDraft: __s.wechatSettingsDraft,
            wechatPeerName: __s.wechatPeerName, wechatAvatar: __s.wechatAvatar,
            wechatWorldInfoOptions: __s.wechatWorldInfoOptions,
            wechatPresetOptions: __s.wechatPresetOptions,
            wechatDisplayItems: __s.wechatDisplayItems,
            openWechat: __s.openWechat, closeWechat: __s.closeWechat,
            openWechatSettings: __s.openWechatSettings, saveWechatSettings: __s.saveWechatSettings,
            clearWechatTimeline: __s.clearWechatTimeline,
            handleWechatImageSelection: __s.handleWechatImageSelection,
            removeWechatPendingImage: __s.removeWechatPendingImage,
            sendWechatMessage: __s.sendWechatMessage, stopWechatGeneration: __s.stopWechatGeneration
        };
    }
});


// 公共弹窗部件需要全局注册，供其他弹窗组件内部直接复用。
app.component('ModalShell', ModalShell);
app.component('ModalHeader', ModalHeader);
app.mount('#app');
