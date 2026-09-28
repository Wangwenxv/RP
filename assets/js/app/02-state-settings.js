/**
 * RP-Hub 应用模块 02 · 用户人设、应用设置、API 提供商与模型槽位
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 526–893 行。
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
    window.RPHubAppSections.stateSettings = function (__s) {
        const user = reactive({
            name: '请前往设置自定义你的名称',
            description: '',
            preferences: '',
            avatar: '',
            person: 'second', //记录人称偏好：second 或 third
        });
        __s.user = user;
        const replaceUserNamePlaceholder = (value) => String(value ?? '')
            .replace(/\{\{\s*user\s*\}\}/gi, () => String(user.name || '').trim());
        __s.replaceUserNamePlaceholder = replaceUserNamePlaceholder;
        const buildUserInfoPrompt = () => BUILTIN_PROMPTS.buildUserInfoPrompt(user);
        __s.buildUserInfoPrompt = buildUserInfoPrompt;
        const getCurrentCharacterPrompt = () => BUILTIN_PROMPTS.buildCharacterPrompt(__s.currentCharacter.value);
        __s.getCurrentCharacterPrompt = getCurrentCharacterPrompt;
        const userProfiles = ref([]);
        __s.userProfiles = userProfiles;
        const activeProfileId = ref(null);
        __s.activeProfileId = activeProfileId;
        const showProfileDropdown = ref(false);
        __s.showProfileDropdown = showProfileDropdown;
        watch(user, (newVal) => {
            if (activeProfileId.value && userProfiles.value.length > 0) {
                const profileIndex = userProfiles.value.findIndex(p => p.uuid === activeProfileId.value);
                if (profileIndex !== -1) {
                    const currentProfile = userProfiles.value[profileIndex];
                    if (currentProfile.name !== newVal.name ||
                        currentProfile.description !== newVal.description ||
                        currentProfile.preferences !== newVal.preferences ||
                        currentProfile.avatar !== newVal.avatar ||
                        currentProfile.person !== newVal.person) {
                        userProfiles.value[profileIndex] = JSON.parse(JSON.stringify(newVal));
                        userProfiles.value[profileIndex].uuid = activeProfileId.value;
                    }
                }
            }
        }, { deep: true });
        const MAX_CONTEXT_SIZE = 1000000;
        __s.MAX_CONTEXT_SIZE = MAX_CONTEXT_SIZE;
        const settings = reactive({
            apiUrl: DEFAULT_API_CONFIG.apiUrl,
            apiKey: DEFAULT_API_CONFIG.apiKey,
            apiProviderId: DEFAULT_API_PROVIDER_ID,
            apiProviderKeys: {},
            customApiUrl: '',
            model: DEFAULT_API_CONFIG.qualityModel,
            contextSize: MAX_CONTEXT_SIZE,
            temperature: 1.0,
            reasoningEffort: '',
            stream: true,
            activeToolAggressiveness: 'adaptive',

            useCharacterBackground: true,
            immersiveMode: false,
            showLatestUsageBar: false,
            preventTruncation: false,
            styleFilterEnabled: true,
            uiTemplateEnabled: false,
            uiTemplateModel: '',
            uiTemplateAnalysisDepth: 4,
            uiTemplateInjectContext: false,
            uiTemplateMainModelAnalysis: true,
            fontFamily: 'modern',
            fontFamilyVersion: 4,
            fontSize: window.innerWidth > 768 ? 16 : 14,
            imageGenKey: '',
            imageStyle: 'vertical',
            customImageArtists: '',
            imageModel: 'nai-diffusion-4-5-full',
            imageSize: '竖图',
            imageGenCount: 2,
            qualityModel: DEFAULT_API_CONFIG.qualityModel,
            balancedModel: DEFAULT_API_CONFIG.balancedModel,
            fastModel: DEFAULT_API_CONFIG.fastModel,
            visionModel: ''
        });
        __s.settings = settings;
        const v5UnsupportedImageStyles = new Set(['r18', 'lolita25d', 'anime']);
        __s.v5UnsupportedImageStyles = v5UnsupportedImageStyles;
        const availableImageStyleOptions = computed(() => settings.imageModel === 'nai-diffusion-5-full'
            ? imageStyleOptions.filter(option => !v5UnsupportedImageStyles.has(option.value))
            : imageStyleOptions);
        __s.availableImageStyleOptions = availableImageStyleOptions;
        const getImageModelName = (value) => (imageModelOptions.find(option => option.value === value)?.label
            || imageModelOptions[0].label).replace(/（[^）]*）$/, '');
        __s.getImageModelName = getImageModelName;
        const normalizeFontFamily = (value) => ['modern', 'serif', 'system'].includes(value) ? value : 'modern';
        __s.normalizeFontFamily = normalizeFontFamily;
        const normalizeFontSize = (value) => {
            const size = Number(value);
            return Number.isFinite(size) ? Math.max(12, Math.min(20, Math.round(size))) : 16;
        };
        __s.normalizeFontSize = normalizeFontSize;
        const applyFontFamily = (value) => {
            document.documentElement.dataset.appFont = normalizeFontFamily(value);
        };
        __s.applyFontFamily = applyFontFamily;
        watch(() => settings.fontFamily, applyFontFamily, { immediate: true });
        const showApiProviderSelector = ref(false);
        __s.showApiProviderSelector = showApiProviderSelector;
        const selectedApiProviderId = ref(DEFAULT_API_PROVIDER_ID);
        __s.selectedApiProviderId = selectedApiProviderId;
        const customApiProviderOption = {
            id: 'custom',
            name: '自定义',
            apiUrl: '',
            icon: ''
        };
        __s.customApiProviderOption = customApiProviderOption;
        const customApiProviderOptions = [customApiProviderOption];
        __s.customApiProviderOptions = customApiProviderOptions;
        const isCustomApiProviderId = (id) => id === 'custom';
        __s.isCustomApiProviderId = isCustomApiProviderId;
        const normalizeApiProviderUrl = (url) => String(url || '').replace(/\/+$/, '').toLowerCase();
        __s.normalizeApiProviderUrl = normalizeApiProviderUrl;
        const getApiProviderById = (id) => apiProviderOptions.find(provider => provider.id === id);
        __s.getApiProviderById = getApiProviderById;
        const getApiProviderByUrl = (url) => {
            const currentUrl = normalizeApiProviderUrl(url);
            return apiProviderOptions.find(provider => normalizeApiProviderUrl(provider.apiUrl) === currentUrl);
        };
        __s.getApiProviderByUrl = getApiProviderByUrl;
        const syncCurrentApiKeyToProvider = () => {
            const providerId = settings.apiProviderId || selectedApiProvider.value.id || DEFAULT_API_PROVIDER_ID;
            if (!settings.apiProviderKeys || typeof settings.apiProviderKeys !== 'object' || Array.isArray(settings.apiProviderKeys)) {
                settings.apiProviderKeys = {};
            }
            settings.apiProviderKeys[providerId] = settings.apiKey || '';
            if (isCustomApiProviderId(providerId)) {
                settings.customApiUrl = settings.apiUrl || '';
            }
        };
        __s.syncCurrentApiKeyToProvider = syncCurrentApiKeyToProvider;
        const normalizeApiProviderSettings = (savedSettings = settings) => {
            if (!settings.apiProviderKeys || typeof settings.apiProviderKeys !== 'object' || Array.isArray(settings.apiProviderKeys)) {
                settings.apiProviderKeys = {};
            }
            // 将旧的当前自定义2配置并入唯一的自定义入口。
            if (settings.apiProviderId === 'custom2') {
                settings.apiProviderId = 'custom';
                settings.customApiUrl = savedSettings.customApiUrl2 || settings.apiUrl || '';
                settings.apiProviderKeys.custom = settings.apiKey || settings.apiProviderKeys.custom2 || '';
            }
            delete settings.apiProviderKeys.custom2;
            [...apiProviderOptions, ...customApiProviderOptions].forEach(provider => {
                if (typeof settings.apiProviderKeys[provider.id] !== 'string') {
                    settings.apiProviderKeys[provider.id] = '';
                }
            });

            let provider = getApiProviderById(settings.apiProviderId);
            if (!provider && !isCustomApiProviderId(settings.apiProviderId)) {
                provider = getApiProviderByUrl(settings.apiUrl);
                settings.apiProviderId = provider?.id || DEFAULT_API_PROVIDER_ID;
            }
            if (isCustomApiProviderId(settings.apiProviderId)) {
                settings.customApiUrl = settings.customApiUrl || settings.apiUrl || '';
                settings.apiUrl = settings.customApiUrl;
            } else {
                provider = getApiProviderById(settings.apiProviderId) || getApiProviderById(DEFAULT_API_PROVIDER_ID);
                settings.apiProviderId = provider.id;
                settings.apiUrl = provider.apiUrl;
            }

            selectedApiProviderId.value = settings.apiProviderId;
            if (settings.apiKey && !settings.apiProviderKeys[settings.apiProviderId]) {
                settings.apiProviderKeys[settings.apiProviderId] = settings.apiKey;
            }
            settings.apiKey = settings.apiProviderKeys[settings.apiProviderId] || '';
        };
        __s.normalizeApiProviderSettings = normalizeApiProviderSettings;
        const selectedApiProvider = computed(() => {
            if (isCustomApiProviderId(settings.apiProviderId) || isCustomApiProviderId(selectedApiProviderId.value)) return customApiProviderOption;
            const selectedProvider = getApiProviderById(settings.apiProviderId) || getApiProviderById(selectedApiProviderId.value);
            if (selectedProvider) return selectedProvider;
            return getApiProviderByUrl(settings.apiUrl) || customApiProviderOption;
        });
        __s.selectedApiProvider = selectedApiProvider;
        const isCustomApiProvider = computed(() => isCustomApiProviderId(selectedApiProvider.value.id));
        __s.isCustomApiProvider = isCustomApiProvider;
        const selectApiProvider = (provider) => {
            syncCurrentApiKeyToProvider();
            selectedApiProviderId.value = provider.id;
            settings.apiProviderId = provider.id;
            settings.apiUrl = isCustomApiProviderId(provider.id)
                ? settings.customApiUrl || ''
                : provider.apiUrl;
            settings.apiKey = settings.apiProviderKeys[provider.id] || '';
            showApiProviderSelector.value = false;
        };
        __s.selectApiProvider = selectApiProvider;
        normalizeApiProviderSettings();
        watch(() => settings.apiKey, (newKey) => {
            if (!settings.apiProviderKeys || typeof settings.apiProviderKeys !== 'object' || Array.isArray(settings.apiProviderKeys)) {
                settings.apiProviderKeys = {};
            }
            const providerId = settings.apiProviderId || selectedApiProvider.value.id || DEFAULT_API_PROVIDER_ID;
            if (settings.apiProviderKeys[providerId] !== (newKey || '')) {
                settings.apiProviderKeys[providerId] = newKey || '';
            }
        });
        watch(() => settings.apiUrl, (newUrl) => {
            if (isCustomApiProviderId(settings.apiProviderId)) {
                settings.customApiUrl = newUrl || '';
            }
        });
        const syncSettingsToGenerator = () => {
            const iframe = document.querySelector('iframe[src*="character"]');
            if (iframe && iframe.contentWindow) {
                try {
                    const syncData = {
                        type: 'SYNC_SETTINGS',
                        settings: JSON.parse(JSON.stringify(settings))
                    };
                    iframe.contentWindow.postMessage(syncData, '*');
                } catch (e) {
                    console.error('Settings sync failed:', e);
                }
            }
        };
        __s.syncSettingsToGenerator = syncSettingsToGenerator;
        __s.workshopImportPending = false;
        __s.squareImportPending = false;
        const getSquareFrame = () => document.querySelector(`iframe[src="${__s.squareUrl.value}"]`);
        __s.getSquareFrame = getSquareFrame;

        // Each embedded page may only use its own message bridge.
        window.addEventListener('message', async (event) => {
            if (event.data?.type === 'RPH_FORUM_READY' || event.data?.type === 'RPH_FORUM_IMPORT_CARD') {
                const iframe = getSquareFrame();
                if (!iframe || event.source !== iframe.contentWindow || event.origin !== new URL(__s.squareUrl.value).origin) return;
                if (event.data.type === 'RPH_FORUM_READY') {
                    event.source.postMessage({ type: 'RPHUB_IMPORT_READY' }, event.origin);
                    return;
                }
                const { requestId, buffer } = event.data;
                if (typeof requestId !== 'string' || !/^[\w-]{1,80}$/.test(requestId)) return;
                const reply = (result) => event.source.postMessage({ type: 'RPHUB_IMPORT_RESULT', requestId, ...result }, event.origin);
                if (__s.squareImportPending) {
                    reply({ error: '上一张角色卡仍在导入，请稍后再试' });
                    return;
                }
                __s.squareImportPending = true;
                try {
                    if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength > 100 * 1024 * 1024) {
                        throw new Error('角色卡文件无效或超过 100 MB');
                    }
                    const { data } = cardUtils.parsePngCharacterData(buffer);
                    const source = data?.data || data;
                    if (!source || typeof source.name !== 'string' || !source.name.trim()) throw new Error('角色卡缺少有效名称');
                    const avatar = await cardUtils.blobToDataUrl(new Blob([buffer], { type: 'image/png' }));
                    const char = await __s.importCharacterData(data, avatar, { activate: false });
                    try {
                        const index = __s.characters.value.findIndex(item => item.uuid === char.uuid);
                        if (!await __s.selectCharacter(index, false, { silent: true })) throw new Error('切换未完成');
                    } catch (error) {
                        console.error('Square character switch failed:', error);
                        throw new Error('角色卡已导入，但自动切换未完成，请在角色库手动选择，无需重复导入');
                    }
                    reply({ name: char.name });
                } catch (error) {
                    console.error('Square import failed:', error);
                    reply({ error: error.message || '导入失败，请重试' });
                } finally {
                    __s.squareImportPending = false;
                }
                return;
            }

            if (event.data && event.data.type === 'WORKSHOP_READY') {
                if (event.source !== document.querySelector('iframe[src*="character/index.html"]')?.contentWindow) return;
                syncSettingsToGenerator();
            }

            if (event.data?.type === 'WORKSHOP_IMPORT_AND_PLAY') {
                const iframe = document.querySelector('iframe[src*="character/index.html"]');
                if (!iframe || event.source !== iframe.contentWindow || __s.workshopImportPending) return;
                __s.workshopImportPending = true;
                try {
                    if (!event.data.card?.data || typeof event.data.card.data.name !== 'string' || !event.data.card.data.name.trim()) {
                        throw new Error('角色卡缺少名称，请先完善角色卡');
                    }
                    const char = await __s.importCharacterData(event.data.card, event.data.avatar, { askImageGeneration: false });
                    if (__s.currentCharacter.value?.uuid !== char.uuid || __s.currentView.value !== 'chat') {
                        throw new Error('角色卡已导入，暂时未能进入对话，请从角色卡管理中打开');
                    }
                } catch (error) {
                    console.error('Workshop import failed:', error);
                    event.source.postMessage({ type: 'WORKSHOP_IMPORT_RESULT', error: error.message || '导入失败，请重试' }, '*');
                    __s.showToast(error.message || '导入失败，请重试', 'error');
                } finally {
                    __s.workshopImportPending = false;
                }
                return;
            }

            if (event.data?.type === 'REQUEST_RPHUB_API_SETTINGS') {
                const iframe = document.querySelector('iframe[src*="novel/index.html"]');
                if (event.source !== iframe?.contentWindow) return;

                const providers = [
                    ...apiProviderOptions.map(({ id, name, apiUrl, icon }) => ({ id, name, apiUrl, icon })),
                    ...customApiProviderOptions.map(({ id, name }) => ({
                        id,
                        name,
                        apiUrl: settings.customApiUrl || '',
                        icon: ''
                    }))
                ];
                event.source.postMessage({
                    type: 'RPHUB_API_SETTINGS',
                    requestId: event.data.requestId,
                    settings: {
                        apiProviderId: settings.apiProviderId,
                        apiProviderKeys: JSON.parse(JSON.stringify(settings.apiProviderKeys || {})),
                        apiKey: settings.apiKey,
                        customApiUrl: settings.customApiUrl
                    },
                    providers
                }, '*');
            }
        });
        watch(() => [settings.apiUrl, settings.apiKey, settings.model], ([, , newModel]) => {
            if (newModel !== settings.fastModel && newModel !== settings.balancedModel) {
                settings.qualityModel = newModel; // 确保 qualityModel 也同步更新
            }



            // Update currentModelMode based on the actual selected model
            if (newModel === settings.fastModel) {
                currentModelMode.value = 'fast';
            } else if (newModel === settings.balancedModel) {
                currentModelMode.value = 'balanced';
            } else {
                currentModelMode.value = 'quality';
            }

            syncSettingsToGenerator();
        }, { deep: true });

        // Watch image gen and model settings for sync
        watch(() => [settings.imageGenKey, settings.imageModel, settings.imageStyle, settings.customImageArtists, settings.imageGenCount, settings.qualityModel, settings.balancedModel, settings.fastModel, settings.uiTemplateModel, settings.fontFamily, settings.fontFamilyVersion], () => {
            syncSettingsToGenerator();
        });
        const currentModelMode = ref('quality');
        __s.currentModelMode = currentModelMode;
        const isGeminiModel = computed(() => /gemini/i.test(String(settings.model || '')));
        __s.isGeminiModel = isGeminiModel;
        const isTruncationEnabled = computed(() => isGeminiModel.value && settings.preventTruncation);
        __s.isTruncationEnabled = isTruncationEnabled;
        const modelMode = computed({
            get: () => {
                return currentModelMode.value;
            },
            set: (val) => {
                currentModelMode.value = val;
                if (val === 'fast') {
                    settings.model = settings.fastModel;
                } else if (val === 'balanced') {
                    settings.model = settings.balancedModel;
                } else {
                    settings.model = settings.qualityModel;
                }
                __s.showModelSelector.value = false;
                __s.showChatModelSelector.value = false;
            }
        });
        __s.modelMode = modelMode;
        const reasoningEffortOptions = [
            { value: 'none', label: '关闭' },
            { value: 'low', label: '低（Low）' },
            { value: 'medium', label: '中（Medium）' },
            { value: 'high', label: '高（High）' },
            { value: 'max', label: '最高（Max）' },
            { value: '', label: '默认' }
        ];
        __s.reasoningEffortOptions = reasoningEffortOptions;
        const reasoningEffortSlider = computed({
            get: () => Math.max(0, reasoningEffortOptions.findIndex(option => option.value === settings.reasoningEffort)),
            set: index => { settings.reasoningEffort = reasoningEffortOptions[index]?.value || ''; }
        });
        __s.reasoningEffortSlider = reasoningEffortSlider;
        const reasoningEffortLabel = computed(() => reasoningEffortOptions[reasoningEffortSlider.value].label);
        __s.reasoningEffortLabel = reasoningEffortLabel;
        const chatModelSlots = computed(() => [
            { mode: 'quality', model: settings.qualityModel },
            { mode: 'balanced', model: settings.balancedModel },
            { mode: 'fast', model: settings.fastModel }
        ]);
        __s.chatModelSlots = chatModelSlots;
        const selectChatModelSlot = (slot) => {
            if (!slot?.model) return;
            currentModelMode.value = slot.mode;
            settings.model = slot.model;
        };
        __s.selectChatModelSlot = selectChatModelSlot;
    };
})();
