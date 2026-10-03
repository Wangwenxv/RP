/**
 * RP-Hub 应用模块 04 · 记忆系统与主动工具的状态及归一化
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 1110–1305 行。
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
    window.RPHubAppSections.stateMemoryTools = function (__s) {

        // --- Memory System State ---
        const SUMMARY_EMBEDDING_BATCH_SIZE = 16;
        __s.SUMMARY_EMBEDDING_BATCH_SIZE = SUMMARY_EMBEDDING_BATCH_SIZE;
        const SUMMARY_RECALL_LIMIT = 10;
        __s.SUMMARY_RECALL_LIMIT = SUMMARY_RECALL_LIMIT;
        const SUMMARY_RECALL_MIN_SIMILARITY = 0.48;
        __s.SUMMARY_RECALL_MIN_SIMILARITY = SUMMARY_RECALL_MIN_SIMILARITY;
        const CLASSIC_MEMORY_MIN_CONCURRENCY = 1;
        __s.CLASSIC_MEMORY_MIN_CONCURRENCY = CLASSIC_MEMORY_MIN_CONCURRENCY;
        const CLASSIC_MEMORY_MAX_CONCURRENCY = 10;
        __s.CLASSIC_MEMORY_MAX_CONCURRENCY = CLASSIC_MEMORY_MAX_CONCURRENCY;
        const CLASSIC_MEMORY_DEFAULT_CONCURRENCY = 5;
        __s.CLASSIC_MEMORY_DEFAULT_CONCURRENCY = CLASSIC_MEMORY_DEFAULT_CONCURRENCY;
        const CLASSIC_SECONDARY_KEEP_TURNS = 25;
        __s.CLASSIC_SECONDARY_KEEP_TURNS = CLASSIC_SECONDARY_KEEP_TURNS;
        const CLASSIC_SECONDARY_GROUP_SIZE = 5;
        __s.CLASSIC_SECONDARY_GROUP_SIZE = CLASSIC_SECONDARY_GROUP_SIZE;
        const MEMORY_MODE_ENHANCED = 'enhanced';
        __s.MEMORY_MODE_ENHANCED = MEMORY_MODE_ENHANCED;
        const MEMORY_MODE_CLASSIC = 'classic';
        __s.MEMORY_MODE_CLASSIC = MEMORY_MODE_CLASSIC;
        const SUMMARY_KEEP_FLOORS_MIN = 10;
        __s.SUMMARY_KEEP_FLOORS_MIN = SUMMARY_KEEP_FLOORS_MIN;
        const SUMMARY_KEEP_FLOORS_MAX = 40;
        __s.SUMMARY_KEEP_FLOORS_MAX = SUMMARY_KEEP_FLOORS_MAX;
        const SUMMARY_KEEP_FLOORS_DEFAULT = 20;
        __s.SUMMARY_KEEP_FLOORS_DEFAULT = SUMMARY_KEEP_FLOORS_DEFAULT;
        const LIST_PAGE_SIZE = 10;
        __s.LIST_PAGE_SIZE = LIST_PAGE_SIZE;
        const classicMemories = ref([]);
        __s.classicMemories = classicMemories;
        const classicMemoryPage = ref(1);
        __s.classicMemoryPage = classicMemoryPage;
        const memorySettings = reactive({
            enabled: false,
            mode: MEMORY_MODE_CLASSIC,
            embeddingModel: '',
            classicModel: '',
            summaryKeepFloors: SUMMARY_KEEP_FLOORS_DEFAULT,
            classicConcurrency: CLASSIC_MEMORY_DEFAULT_CONCURRENCY
        });
        __s.memorySettings = memorySettings;
        const isClassicBatchExtracting = ref(false);
        __s.isClassicBatchExtracting = isClassicBatchExtracting;
        const memoryBackfillProgress = ref({ status: 'idle', message: '', phase: '', stages: [] });
        __s.memoryBackfillProgress = memoryBackfillProgress;
        const retryingClassicMemoryId = ref('');
        __s.retryingClassicMemoryId = retryingClassicMemoryId;
        __s._isApplyingCharacterScopedData = false;
        __s._classicMemoriesLoaded = false;
        __s._characterSwitchEpoch = 0;
        __s._characterSwitchSavePromise = Promise.resolve();
        __s._initComplete = false;

 // 守卫标志：防止 onMounted 初始化阶段写入默认值覆盖服务端数据

        // --- Active Tool System State ---
        const normalizeActiveToolAggressiveness = (value) => (
            ACTIVE_TOOL_AGGRESSIVENESS_OPTIONS.some(option => option.value === value)
                ? value
                : ACTIVE_TOOL_AGGRESSIVENESS_ADAPTIVE
        );
        __s.normalizeActiveToolAggressiveness = normalizeActiveToolAggressiveness;
        const getActiveToolAggressiveness = () => {
            const normalized = normalizeActiveToolAggressiveness(__s.settings.activeToolAggressiveness);
            if (__s.settings.activeToolAggressiveness !== normalized) {
                __s.settings.activeToolAggressiveness = normalized;
            }
            return normalized;
        };
        __s.getActiveToolAggressiveness = getActiveToolAggressiveness;
        const getActiveToolAggressivenessLabel = () => (
            ACTIVE_TOOL_AGGRESSIVENESS_OPTIONS.find(option => option.value === getActiveToolAggressiveness())?.label || '自适应'
        );
        __s.getActiveToolAggressivenessLabel = getActiveToolAggressivenessLabel;
        const getActiveToolLatestUserReminder = () => ACTIVE_TOOL_REMINDERS[getActiveToolAggressiveness()];
        __s.getActiveToolLatestUserReminder = getActiveToolLatestUserReminder;
        const normalizeActiveToolAggressivenessSettings = () => {
            __s.settings.activeToolAggressiveness = normalizeActiveToolAggressiveness(__s.settings.activeToolAggressiveness);
            delete __s.settings.activeToolAggressivenessVersion;
        };
        __s.normalizeActiveToolAggressivenessSettings = normalizeActiveToolAggressivenessSettings;
        const activeTools = ref(getDefaultActiveToolDefinitions());
        __s.activeTools = activeTools;
        const normalizeKeepFloors = (value, min, max, fallback) => {
            const floors = Number(value);
            if (!Number.isFinite(floors)) return fallback;
            return Math.max(min, Math.min(max, Math.round(floors / 2) * 2));
        };
        __s.normalizeKeepFloors = normalizeKeepFloors;
        const normalizeClassicMemoryConcurrency = (value) => {
            const concurrency = Number(value);
            if (!Number.isFinite(concurrency)) return CLASSIC_MEMORY_DEFAULT_CONCURRENCY;
            return Math.max(CLASSIC_MEMORY_MIN_CONCURRENCY, Math.min(CLASSIC_MEMORY_MAX_CONCURRENCY, Math.round(concurrency)));
        };
        __s.normalizeClassicMemoryConcurrency = normalizeClassicMemoryConcurrency;
        const normalizeMemorySettings = () => {
            if (!memorySettings.classicModel && memorySettings.model) {
                memorySettings.classicModel = String(memorySettings.model).trim();
            }
            const fields = new Set(['enabled', 'mode', 'embeddingModel', 'classicModel', 'summaryKeepFloors', 'classicConcurrency']);
            Object.keys(memorySettings).forEach(key => {
                if (!fields.has(key)) delete memorySettings[key];
            });
            // 只迁移旧模式选择，不读取旧分片。
            memorySettings.mode = [MEMORY_MODE_ENHANCED, 'vector'].includes(memorySettings.mode)
                ? MEMORY_MODE_ENHANCED : MEMORY_MODE_CLASSIC;
            memorySettings.classicModel = String(memorySettings.classicModel || '').trim();
            memorySettings.embeddingModel = String(memorySettings.embeddingModel || '').trim();
            memorySettings.summaryKeepFloors = normalizeKeepFloors(
                memorySettings.summaryKeepFloors,
                SUMMARY_KEEP_FLOORS_MIN,
                SUMMARY_KEEP_FLOORS_MAX,
                SUMMARY_KEEP_FLOORS_DEFAULT
            );
            memorySettings.classicConcurrency = normalizeClassicMemoryConcurrency(memorySettings.classicConcurrency);
        };
        __s.normalizeMemorySettings = normalizeMemorySettings;
        const normalizeActiveToolCallName = (value) => {
            const raw = String(value || '').trim();
            const matched = raw.match(/^<\s*([^:\s>]+)\s*:/);
            const source = matched ? matched[1] : raw;
            return source
                .replace(/[<>：:]/g, '')
                .replace(/\s+/g, '_')
                .trim() || 'tool_grep';
        };
        __s.normalizeActiveToolCallName = normalizeActiveToolCallName;
        const normalizeActiveToolBaseCallName = (value) => normalizeActiveToolCallName(value)
            .replace(/_(?:add|cover)$/i, '');
        __s.normalizeActiveToolBaseCallName = normalizeActiveToolBaseCallName;
        const getActiveToolResultCountMin = () => ACTIVE_TOOL_MIN_RESULT_COUNT;
        __s.getActiveToolResultCountMin = getActiveToolResultCountMin;
        const getActiveToolResultCountMax = () => ACTIVE_TOOL_MAX_RESULT_COUNT;
        __s.getActiveToolResultCountMax = getActiveToolResultCountMax;
        const normalizeActiveTool = (tool = {}) => {
            const resultCount = Number(tool.resultCount);
            const rawCallName = normalizeActiveToolBaseCallName(tool.callName || tool.callPattern || 'tool_grep');
            const isLegacyWebTool = rawCallName === 'tool_web'
                || ['web_search', 'tavily', 'tavily_search'].includes(tool.type)
                || ['tool_web', 'tool_web_add', 'tool_web_cover'].includes(tool.id)
                || /tavily|联网搜索/i.test(String(tool.name || ''));
            const callName = isLegacyWebTool ? 'tool_web' : rawCallName;
            const defaultTool = getDefaultActiveToolDefinitions()
                .find(item => item.id === (isLegacyWebTool ? 'tool_web' : tool.id) || item.callName === callName);
            if (!defaultTool) return null;
            const fallback = defaultTool;
            if (fallback.type === ACTIVE_TOOL_RANDOM_TYPE || fallback.type === ACTIVE_TOOL_WECHAT_TYPE) {
                return { ...fallback, enabled: tool.enabled !== false };
            }
            const normalizedCallName = fallback.callName;
            const resultCountVersion = Number(tool.resultCountVersion) || 1;
            const normalizedType = fallback.type;
            const countMin = getActiveToolResultCountMin({ type: normalizedType });
            const countMax = getActiveToolResultCountMax({ type: normalizedType });
            let normalizedResultCount = Number.isFinite(resultCount)
                ? Math.max(countMin, Math.min(countMax, Math.round(resultCount)))
                : (fallback.resultCount || ACTIVE_TOOL_DEFAULT_RESULT_COUNT);
            if (resultCountVersion < ACTIVE_TOOL_RESULT_COUNT_VERSION
                && normalizedCallName === fallback.callName
                && normalizedType !== ACTIVE_TOOL_WEB_TYPE
                && (!Number.isFinite(resultCount) || Math.round(resultCount) <= ACTIVE_TOOL_MIN_RESULT_COUNT || Math.round(resultCount) === 10)) {
                normalizedResultCount = ACTIVE_TOOL_DEFAULT_RESULT_COUNT;
            }
            const normalized = {
                id: fallback.id,
                name: fallback.name,
                enabled: tool.enabled !== false,
                type: normalizedType,
                callName: normalizedCallName,
                resultCount: normalizedResultCount,
                resultCountVersion: ACTIVE_TOOL_RESULT_COUNT_VERSION,
                description: fallback.description,
                displayDescription: fallback.displayDescription
            };
            if (normalizedType === ACTIVE_TOOL_WEB_TYPE) {
                normalized.tavilyApiKey = String(tool.tavilyApiKey || tool.apiKey || fallback.tavilyApiKey || '').trim();
            }
            return normalized;
        };
        __s.normalizeActiveTool = normalizeActiveTool;
        const normalizeActiveTools = (items = activeTools.value) => {
            const normalized = [];
            (Array.isArray(items) ? items : [])
                .map(normalizeActiveTool)
                .filter(tool => tool && tool.callName)
                .forEach(tool => {
                    const duplicateIndex = normalized.findIndex(item => item.id === tool.id || item.callName === tool.callName);
                    if (duplicateIndex >= 0) {
                        normalized[duplicateIndex] = {
                            ...normalized[duplicateIndex],
                            enabled: normalized[duplicateIndex].enabled || tool.enabled
                        };
                        return;
                    }
                    normalized.push(tool);
                });
            getDefaultActiveToolDefinitions().forEach(defaultTool => {
                const hasDefaultTool = normalized.some(tool => tool.id === defaultTool.id || tool.callName === defaultTool.callName);
                if (!hasDefaultTool) normalized.push(defaultTool);
            });
            if (JSON.stringify(activeTools.value) !== JSON.stringify(normalized)) {
                activeTools.value = normalized;
            }
            return normalized;
        };
        __s.normalizeActiveTools = normalizeActiveTools;
        const estimatedGenerationTime = computed(() => {
            if (__s.recentGenerationTimes.value.length === 0) return null;
            const total = __s.recentGenerationTimes.value.reduce((sum, item) => {
                // Compatibility: handle both number and object
                const duration = typeof item === 'number' ? item : item.duration;
                return sum + duration;
            }, 0);
            return (total / __s.recentGenerationTimes.value.length / 1000).toFixed(1);
        });
        __s.estimatedGenerationTime = estimatedGenerationTime;
        const showWorldInfoSettings = ref(false);
        __s.showWorldInfoSettings = showWorldInfoSettings;
        const showMemorySettings = ref(false);
        __s.showMemorySettings = showMemorySettings;
        const settingsHelpTopic = ref('');
        __s.settingsHelpTopic = settingsHelpTopic;
        const showActiveToolSettings = ref(false);
        __s.showActiveToolSettings = showActiveToolSettings;
        const showUiTemplateSettings = ref(false);
        __s.showUiTemplateSettings = showUiTemplateSettings;
        const worldInfoSettings = reactive({
            scanDepth: 2,
            maxDepth: 0,
        });
        __s.worldInfoSettings = worldInfoSettings;
    };
})();
