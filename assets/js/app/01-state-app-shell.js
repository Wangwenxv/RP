/**
 * RP-Hub 应用模块 01 · 应用外壳：全局 UI / 弹窗 / 生成状态 / 移动端视口
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 231–524 行。
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
    window.RPHubAppSections.stateAppShell = function (__s) {

        // --- State ---
        const globalConfirmModal = ref({
            show: false,
            title: '',
            message: '',
            onConfirm: null,
            onCancel: null
        });
        __s.globalConfirmModal = globalConfirmModal;
        const updateModalRef = ref(null);
        __s.updateModalRef = updateModalRef;
        const showVueConfirmModal = (title, message) => {
            return new Promise((resolve) => {
                globalConfirmModal.value = {
                    show: true,
                    title,
                    message,
                    onConfirm: () => {
                        globalConfirmModal.value.show = false;
                        resolve(true);
                    },
                    onCancel: () => {
                        globalConfirmModal.value.show = false;
                        resolve(false);
                    }
                };
            });
        };
        __s.showVueConfirmModal = showVueConfirmModal;
        const currentView = ref('chat');
        __s.currentView = currentView;
        const isNavigationOpen = ref(false);
        __s.isNavigationOpen = isNavigationOpen;
        const showDescriptionPanel = ref(false);
        __s.showDescriptionPanel = showDescriptionPanel;
        const showModelSelector = ref(false);
        __s.showModelSelector = showModelSelector;
        const modelSelectionTarget = ref('model');
        __s.modelSelectionTarget = modelSelectionTarget;
        const showChatModelSelector = ref(false);
        __s.showChatModelSelector = showChatModelSelector;
        const showCharacterEditor = ref(false);
        __s.showCharacterEditor = showCharacterEditor;
        const showPresetEditor = ref(false);
        __s.showPresetEditor = showPresetEditor;
        const showUiTemplateEditor = ref(false);
        __s.showUiTemplateEditor = showUiTemplateEditor;
        const uiTemplateUpdateStatus = reactive({ state: 'idle', message: '待命', time: 0, remaining: 0, targetMessageId: null });
        __s.uiTemplateUpdateStatus = uiTemplateUpdateStatus;
        __s.uiTemplateUpdateSeq = 0;
        __s.uiTemplateUpdateAbortController = null;
        const showRegexEditor = ref(false);
        __s.showRegexEditor = showRegexEditor;
        const showWorldInfoEditor = ref(false);
        __s.showWorldInfoEditor = showWorldInfoEditor;
        const showActiveToolEditor = ref(false);
        __s.showActiveToolEditor = showActiveToolEditor;
        const showUserSetupModal = ref(false);
        __s.showUserSetupModal = showUserSetupModal;
        const showAutoImageGenModal = ref(false);
        __s.showAutoImageGenModal = showAutoImageGenModal;

        // 仅保存本轮原生 assistant/tool 消息，不写入用户消息或长期记忆。
        const activeToolMessages = [];
        __s.activeToolMessages = activeToolMessages;
        const tempUserSetup = reactive({ name: '', description: '', person: 'second' });
        __s.tempUserSetup = tempUserSetup;
        const characterDisplayLimit = ref(8);
        __s.characterDisplayLimit = characterDisplayLimit;
        const hasOpenedCharacterManager = ref(false);
        __s.hasOpenedCharacterManager = hasOpenedCharacterManager;
        const isDesktopCharacterLayout = ref(window.innerWidth >= 768);
        __s.isDesktopCharacterLayout = isDesktopCharacterLayout;

        // Quota State
        const quotaValue = ref(0);
        __s.quotaValue = quotaValue;
        const quotaLoading = ref(false);
        __s.quotaLoading = quotaLoading;
        const quotaError = ref(false);
        __s.quotaError = quotaError;
        const fetchQuota = async () => {
            quotaLoading.value = true;
            quotaError.value = false;
            try {
                const imageGenToken = __s.settings.imageGenKey.trim();
                if (!imageGenToken) {
                    quotaValue.value = 0;
                    return;
                }
                const baseUrl = IMAGE_GEN_BASE_URL;
                const response = await fetch(`${baseUrl}/api/api/getUser`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ toUserId: imageGenToken })
                });
                const data = await response.json();
                if (data.status === 'ok' && data.type === 'sta1n') {
                    const val = Number.parseInt(data.data?.value, 10);
                    if (!Number.isFinite(val)) throw new Error('Invalid quota value');
                    quotaValue.value = val;
                } else {
                    quotaError.value = true;
                }
            } catch (e) {
                console.error('Quota fetch error:', e);
                quotaError.value = true;
            } finally {
                quotaLoading.value = false;
            }
        };
        __s.fetchQuota = fetchQuota;
        const showConfirmModal = ref(false);
        __s.showConfirmModal = showConfirmModal;
        const confirmMessage = ref('');
        __s.confirmMessage = confirmMessage;
        const confirmCallback = ref(null);
        __s.confirmCallback = confirmCallback;
        const showMemoryBackfillModal = ref(false);
        __s.showMemoryBackfillModal = showMemoryBackfillModal;
        const isGenerating = ref(false);
        __s.isGenerating = isGenerating;
        const isRemoteGenerating = ref(false);
        __s.isRemoteGenerating = isRemoteGenerating;

 // 新增：远程生成状态
        const remoteEstimatedTime = ref(null);
        __s.remoteEstimatedTime = remoteEstimatedTime;

 // 新增：远程预计时间
        const isReceiving = ref(false);
        __s.isReceiving = isReceiving;
        const isThinking = ref(false);
        __s.isThinking = isThinking;
        const activeToolContinuationMessageId = ref(null);
        __s.activeToolContinuationMessageId = activeToolContinuationMessageId;
        const activeToolContinuationToolCallId = ref(null);
        __s.activeToolContinuationToolCallId = activeToolContinuationToolCallId;
        const activeToolContinuationHasResponse = ref(false);
        __s.activeToolContinuationHasResponse = activeToolContinuationHasResponse;
        const activeToolHandoffPending = ref(false);
        __s.activeToolHandoffPending = activeToolHandoffPending;
        const activeToolQueueRunning = ref(false);
        __s.activeToolQueueRunning = activeToolQueueRunning;
        const activeToolContinuationPending = ref(false);
        __s.activeToolContinuationPending = activeToolContinuationPending;
        __s.activeToolQueueAbortController = null;
        const abortController = ref(null);
        __s.abortController = abortController;
        const userInput = ref('');
        __s.userInput = userInput;
        const pendingCardInteraction = ref('');
        __s.pendingCardInteraction = pendingCardInteraction;
        const pendingChatImages = ref([]);
        __s.pendingChatImages = pendingChatImages;
        const pendingChatImageReadCount = ref(0);
        __s.pendingChatImageReadCount = pendingChatImageReadCount;
        __s.chatImageSelectionEpoch = 0;
        const isRecognizingImages = computed(() => (
            pendingChatImageReadCount.value > 0 || pendingChatImages.value.some(image => image.status === 'analyzing')
        ));
        __s.isRecognizingImages = isRecognizingImages;
        const modelSearchQuery = ref('');
        __s.modelSearchQuery = modelSearchQuery;
        const activeModelTag = ref('all');
        __s.activeModelTag = activeModelTag;
        const characterSearchQuery = ref('');
        __s.characterSearchQuery = characterSearchQuery;
        const availableModels = ref([]);
        __s.availableModels = availableModels;
        const toasts = ref([]);
        __s.toasts = toasts;
        __s.toastIdSeed = 0;
        const chatContainer = ref(null);
        __s.chatContainer = chatContainer;
        const isChatFullscreen = ref(false);
        __s.isChatFullscreen = isChatFullscreen;
        const isMobileKeyboardOpen = ref(false);
        __s.isMobileKeyboardOpen = isMobileKeyboardOpen;
        const inputBox = ref(null);
        __s.inputBox = inputBox;
        const messageElements = ref([]);
        __s.messageElements = messageElements;
        __s.mobileViewportRaf = null;
        __s.mobileKeyboardBlurTimer = null;
        __s.lastAppliedMobileViewportHeight = 0;
        __s.lastAppliedMobileKeyboardInset = 0;
        __s.lastAppliedMobileBackgroundHeight = 0;

        // IntersectionObserver for lazy loading images or other visibility triggers could go here

        __s.scrollRevealObserver = null;
        const initScrollReveal = () => {
            if (window.IntersectionObserver) {
                __s.scrollRevealObserver = new IntersectionObserver((entries) => {
                    entries.forEach(entry => {
                        if (entry.isIntersecting) {
                            entry.target.dataset.revealed = 'true';
                            entry.target.classList.add('reveal-active');
                            __s.scrollRevealObserver.unobserve(entry.target);
                        }
                    });
                }, {
                    threshold: 0,
                    rootMargin: '50px 0px 50px 0px'
                });
            }
        };
        __s.initScrollReveal = initScrollReveal;

        // Watch for changes in the message list to observe new bubbles
        watch(messageElements, (newEls) => {
            if (!__s.scrollRevealObserver) initScrollReveal();
            if (__s.scrollRevealObserver && newEls) {
                newEls.forEach(el => {
                    if (el instanceof HTMLElement && el.dataset.revealed !== 'true' && !el.classList.contains('reveal-active')) {
                        __s.scrollRevealObserver.observe(el);
                    }
                });
            }
        }, { deep: true, flush: 'post' });
        const autoResizeInput = () => {
            if (inputBox.value) {
                inputBox.value.style.height = 'auto';
                if (userInput.value === '') {
                    inputBox.value.style.height = '';
                } else {
                    inputBox.value.style.height = Math.min(inputBox.value.scrollHeight, 180) + 'px';
                }
            }
        };
        __s.autoResizeInput = autoResizeInput;
        watch(userInput, () => {
            nextTick(autoResizeInput);
        });
        const isMobileViewport = () => (
            (window.matchMedia && window.matchMedia('(max-width: 768px)').matches)
            || window.innerWidth <= 768
        );
        __s.isMobileViewport = isMobileViewport;
        const toggleNavigation = () => {
            isNavigationOpen.value = !isNavigationOpen.value;
        };
        __s.toggleNavigation = toggleNavigation;
        const closeNavigation = () => {
            isNavigationOpen.value = false;
        };
        __s.closeNavigation = closeNavigation;
        const applyMobileVisualViewportHeight = (height, { force = false } = {}) => {
            if (!Number.isFinite(height) || height <= 0) return;
            const safeHeight = Math.max(320, Math.round(height));
            if (!force && Math.abs(safeHeight - __s.lastAppliedMobileViewportHeight) < 2) return;
            __s.lastAppliedMobileViewportHeight = safeHeight;
            document.documentElement.style.setProperty('--app-visual-height', `${safeHeight}px`);
            const appElement = document.getElementById('app');
            if (appElement?.style.height) appElement.style.height = '';
        };
        __s.applyMobileVisualViewportHeight = applyMobileVisualViewportHeight;
        const applyMobileKeyboardInset = (inset, { force = false } = {}) => {
            const safeInset = Math.max(0, Math.round(Number(inset) || 0));
            if (!force && Math.abs(safeInset - __s.lastAppliedMobileKeyboardInset) < 2) return;
            __s.lastAppliedMobileKeyboardInset = safeInset;
            document.documentElement.style.setProperty('--keyboard-inset', `${safeInset}px`);
        };
        __s.applyMobileKeyboardInset = applyMobileKeyboardInset;
        const applyMobileBackgroundHeight = (height, { force = false } = {}) => {
            if (!Number.isFinite(height) || height <= 0) return;
            const safeHeight = Math.max(
                320,
                Math.round(height),
                Math.round(__s.lastAppliedMobileBackgroundHeight || 0)
            );
            if (!force && Math.abs(safeHeight - __s.lastAppliedMobileBackgroundHeight) < 2) return;
            __s.lastAppliedMobileBackgroundHeight = safeHeight;
            document.documentElement.style.setProperty('--chat-bg-height', `${safeHeight}px`);
        };
        __s.applyMobileBackgroundHeight = applyMobileBackgroundHeight;
        const syncMobileVisualViewport = ({ force = false } = {}) => {
            if (!isMobileViewport()) {
                closeNavigation();
                isMobileKeyboardOpen.value = false;
                __s.lastAppliedMobileViewportHeight = 0;
                __s.lastAppliedMobileKeyboardInset = 0;
                __s.lastAppliedMobileBackgroundHeight = 0;
                document.documentElement.style.removeProperty('--app-visual-height');
                document.documentElement.style.removeProperty('--keyboard-inset');
                document.documentElement.style.removeProperty('--chat-bg-height');
                return;
            }

            const viewport = window.visualViewport;
            const height = viewport?.height || window.innerHeight || document.documentElement.clientHeight;
            const layoutHeight = window.innerHeight || document.documentElement.clientHeight || height;
            const viewportOffsetTop = viewport?.offsetTop || 0;
            const visualHeightForLayout = viewport ? height + viewportOffsetTop : height;
            const inputFocused = document.activeElement === inputBox.value;
            const keyboardInset = viewport
                ? Math.max(0, layoutHeight - height - viewportOffsetTop)
                : 0;
            const viewportCompressed = viewport && height < layoutHeight - 80;
            const keyboardOpen = !!(viewportCompressed || keyboardInset > 40);
            const keyboardInsetForLayout = keyboardOpen ? keyboardInset : 0;
            const appHeightForLayout = keyboardInsetForLayout > 0 ? layoutHeight : visualHeightForLayout;
            const freezeBackground = inputFocused || keyboardOpen || isMobileKeyboardOpen.value;
            const backgroundHeight = freezeBackground
                ? Math.max(__s.lastAppliedMobileBackgroundHeight, __s.lastAppliedMobileViewportHeight, appHeightForLayout)
                : Math.max(layoutHeight, visualHeightForLayout);

            applyMobileVisualViewportHeight(appHeightForLayout, { force });
            applyMobileKeyboardInset(keyboardInsetForLayout, { force });
            applyMobileBackgroundHeight(backgroundHeight, { force });
            isMobileKeyboardOpen.value = !!(inputFocused || keyboardOpen);

        };
        __s.syncMobileVisualViewport = syncMobileVisualViewport;
        const scheduleMobileVisualViewportSync = (options = {}) => {
            if (__s.mobileViewportRaf) cancelAnimationFrame(__s.mobileViewportRaf);
            __s.mobileViewportRaf = requestAnimationFrame(() => {
                __s.mobileViewportRaf = null;
                syncMobileVisualViewport(options);
            });
        };
        __s.scheduleMobileVisualViewportSync = scheduleMobileVisualViewportSync;
        const handleChatInputFocus = () => {
            if (!isMobileViewport()) return;
            clearTimeout(__s.mobileKeyboardBlurTimer);
            isMobileKeyboardOpen.value = true;
            scheduleMobileVisualViewportSync({ force: true });
        };
        __s.handleChatInputFocus = handleChatInputFocus;
        const handleChatInputBlur = () => {
            clearTimeout(__s.mobileKeyboardBlurTimer);
            __s.mobileKeyboardBlurTimer = setTimeout(() => {
                isMobileKeyboardOpen.value = false;
                scheduleMobileVisualViewportSync({ force: true });
            }, 180);
        };
        __s.handleChatInputBlur = handleChatInputBlur;
        const handleMobileViewportResize = () => {
            isDesktopCharacterLayout.value = window.innerWidth >= 768;
            scheduleMobileVisualViewportSync();
        };
        __s.handleMobileViewportResize = handleMobileViewportResize;
        const handleMobileOrientationChange = () => {
            __s.lastAppliedMobileBackgroundHeight = 0;
            document.documentElement.style.removeProperty('--chat-bg-height');
            scheduleMobileVisualViewportSync({ force: true });
        };
        __s.handleMobileOrientationChange = handleMobileOrientationChange;

        // Service Status
        const apiStatus = ref('unknown');
        __s.apiStatus = apiStatus;

 // 'unknown', 'checking', 'connected', 'error'
        const apiLatency = ref(0);
        __s.apiLatency = apiLatency;
        const imageGenStatus = ref('unknown');
        __s.imageGenStatus = imageGenStatus;
        const imageGenLatency = ref(0);
        __s.imageGenLatency = imageGenLatency;
    };
})();
