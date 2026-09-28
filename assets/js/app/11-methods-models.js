/**
 * RP-Hub 应用模块 11 · 模型列表拉取、模型选择与连接状态检查
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 3350–3503 行。
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
    window.RPHubAppSections.methodsModels = function (__s) {
        const openModelSelector = (target) => {
            __s.modelSelectionTarget.value = target;
            if (target === 'memoryEmbeddingModel') {
                __s.modelSearchQuery.value = 'embedding';
                __s.activeModelTag.value = 'all';
            } else if (__s.modelSearchQuery.value === 'embedding') {
                __s.modelSearchQuery.value = '';
            }
            __s.showModelSelector.value = true;
        };
        __s.openModelSelector = openModelSelector;
        const selectQuickModels = (models) => {
            const previousModel = __s.settings.model;
            const [qualityModel, balancedModel, fastModel] = models;
            __s.settings.qualityModel = qualityModel || '';
            __s.settings.balancedModel = balancedModel || '';
            __s.settings.fastModel = fastModel || '';
            const activeSlot = __s.chatModelSlots.value.find(slot => slot.mode === __s.currentModelMode.value && slot.model)
                || __s.chatModelSlots.value.find(slot => slot.model);
            if (activeSlot) {
                __s.currentModelMode.value = activeSlot.mode;
                __s.settings.model = activeSlot.model;
            } else {
                __s.settings.model = previousModel;
            }
        };
        __s.selectQuickModels = selectQuickModels;
        const selectModel = (modelId) => {
            if (__s.modelSelectionTarget.value === 'memoryEmbeddingModel') {
                __s.memorySettings.embeddingModel = modelId;
                __s.showModelSelector.value = false;
                return;
            }
            if (__s.modelSelectionTarget.value === 'memoryClassicModel') {
                __s.memorySettings.classicModel = modelId;
                __s.showModelSelector.value = false;
                return;
            }

            __s.settings[__s.modelSelectionTarget.value] = modelId;

            if (
                (__s.modelSelectionTarget.value === 'qualityModel' && __s.currentModelMode.value === 'quality') ||
                (__s.modelSelectionTarget.value === 'balancedModel' && __s.currentModelMode.value === 'balanced') ||
                (__s.modelSelectionTarget.value === 'fastModel' && __s.currentModelMode.value === 'fast')
            ) {
                __s.settings.model = modelId;
            }

            __s.showModelSelector.value = false;
        };
        __s.selectModel = selectModel;
        const checkConnectionStatus = async (status, latency, label, request, isConnected = response => response.ok) => {
            status.value = 'checking';
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            const startTime = performance.now();
            try {
                const response = await request(controller.signal);
                if (!isConnected(response)) {
                    status.value = 'error';
                    return;
                }
                status.value = 'connected';
                latency.value = Math.round(performance.now() - startTime);
            } catch (error) {
                console.warn(`${label} Status Check Failed:`, error);
                status.value = 'error';
            } finally {
                clearTimeout(timeoutId);
            }
        };
        __s.checkConnectionStatus = checkConnectionStatus;
        const checkApiStatus = async () => {
            if (!__s.settings.apiUrl || !__s.settings.apiKey) {
                __s.apiStatus.value = 'error';
                return;
            }
            await checkConnectionStatus(__s.apiStatus, __s.apiLatency, 'API', signal => (
                requestJson({ url: buildApiEndpoint(__s.settings.apiUrl, 'models'), apiKey: __s.settings.apiKey, signal })
            ), () => true);
        };
        __s.checkApiStatus = checkApiStatus;
        const checkImageGenStatus = async () => {
            await checkConnectionStatus(__s.imageGenStatus, __s.imageGenLatency, 'Image API', signal => (
                fetch(IMAGE_GEN_BASE_URL, {
                    method: 'HEAD',
                    mode: 'no-cors',
                    signal
                })
            ), () => true);
        };
        __s.checkImageGenStatus = checkImageGenStatus;
        const checkAllStatuses = () => {
            checkApiStatus();
            checkImageGenStatus();
            __s.fetchQuota();
        };
        __s.checkAllStatuses = checkAllStatuses;
        const createAbortReason = (message = 'Operation aborted') => {
            if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
            const error = new Error(message);
            error.name = 'AbortError';
            return error;
        };
        __s.createAbortReason = createAbortReason;
        const abortSafely = (controller, message) => {
            if (!controller || controller.signal?.aborted) return;
            controller.abort(createAbortReason(message));
        };
        __s.abortSafely = abortSafely;

        // Chat Logic
        const markActiveToolInlineWorkCancelled = () => {
            let changed = false;
            __s.chatHistory.value.forEach(msg => {
                if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.toolCalls)) return;
                msg.toolCalls.forEach(toolCall => {
                    if (!toolCall || !['receiving', 'queued', 'running', 'continuing'].includes(toolCall.status)) return;
                    toolCall.status = 'error';
                    toolCall.error = '生成已中止';
                    toolCall.resultText = toolCall.resultText || toolCall.error;
                    changed = true;
                });
            });
            if (changed) {
                __s.activeToolContinuationMessageId.value = null;
                __s.activeToolContinuationToolCallId.value = null;
                __s.activeToolContinuationHasResponse.value = false;
                __s.activeToolHandoffPending.value = false;
                __s.activeToolContinuationPending.value = false;
                __s.saveChatHistoryNow();
            }
            return changed;
        };
        __s.markActiveToolInlineWorkCancelled = markActiveToolInlineWorkCancelled;
        const stopGeneration = () => {
            __s.abortUiTemplateUpdate();
            if (__s.abortController.value) {
                abortSafely(__s.abortController.value, 'Generation cancelled by user');
            }
            if (__s.activeToolQueueAbortController) {
                abortSafely(__s.activeToolQueueAbortController, 'Generation cancelled by user');
            }
            if (__s.hasActiveToolInlineWork.value) {
                markActiveToolInlineWorkCancelled();
            }
        };
        __s.stopGeneration = stopGeneration;
        const waitForConversationIdle = async (timeoutMs = 3000) => {
            const startedAt = Date.now();
            while (__s.isConversationBusy.value && Date.now() - startedAt < timeoutMs) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return !__s.isConversationBusy.value;
        };
        __s.waitForConversationIdle = waitForConversationIdle;
    };
})();
