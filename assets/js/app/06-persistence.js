/**
 * RP-Hub 应用模块 06 · 持久化：聊天 / 角色 / 记忆 / 设置的读写与失败重试
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 1535–1906 行。
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
    window.RPHubAppSections.persistence = function (__s) {

        // --- Character-scoped persistence ---
        const getStoryBranchScopeId = (characterId, branchId = __s.activeStoryBranchId.value) => (
            buildStoryBranchScopeId(characterId, branchId)
        );
        __s.getStoryBranchScopeId = getStoryBranchScopeId;
        const getCurrentStoryBranchScopeId = () => getStoryBranchScopeId(__s.currentCharacter.value?.uuid);
        __s.getCurrentStoryBranchScopeId = getCurrentStoryBranchScopeId;
        __s.chatHistorySaveTimer = null;
        __s.chatHistorySaveQueue = Promise.resolve(true);
        __s.lastChatSaveErrorToastAt = 0;
        const isRetryableChatStorageError = (error) => {
            const name = String(error?.name || '');
            return isDatabaseClosingError(error)
                || ['AbortError', 'UnknownError', 'InvalidStateError', 'TransactionInactiveError'].includes(name);
        };
        __s.isRetryableChatStorageError = isRetryableChatStorageError;
        const notifyChatSaveFailure = (error) => {
            console.error('Failed to save chat history after retries:', error);
            const now = Date.now();
            if (now - __s.lastChatSaveErrorToastAt < 5000) return;
            __s.lastChatSaveErrorToastAt = now;
            const message = error?.name === 'QuotaExceededError'
                ? '存储空间不足，聊天记录未能保存，请先释放浏览器存储空间'
                : '聊天记录保存失败，旧记录未被覆盖，请不要刷新并稍后重试';
            __s.showToast(message, 'error', 5000);
        };
        __s.notifyChatSaveFailure = notifyChatSaveFailure;
        const saveChatHistoryNow = (storyScopeId = getCurrentStoryBranchScopeId(), history = __s.chatHistory.value) => {
            if (__s.chatHistorySaveTimer) {
                clearTimeout(__s.chatHistorySaveTimer);
                __s.chatHistorySaveTimer = null;
            }
            if (!storyScopeId) return Promise.resolve(false);

            try {
                const historyToSave = cloneForStorage(history);
                const saveTask = async () => {
                    let lastError = null;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            if (!getMainDb()) await initDB();
                            await setScopedStoredValue('chat', storyScopeId, historyToSave, { clone: false });
                            return true;
                        } catch (error) {
                            lastError = error;
                            if (attempt === 3 || !isRetryableChatStorageError(error)) break;
                            await new Promise(resolve => setTimeout(resolve, attempt * 250));
                        }
                    }
                    notifyChatSaveFailure(lastError);
                    return false;
                };

                __s.chatHistorySaveQueue = __s.chatHistorySaveQueue.then(saveTask, saveTask);
                return __s.chatHistorySaveQueue;
            } catch (error) {
                notifyChatSaveFailure(error);
                return Promise.resolve(false);
            }
        };
        __s.saveChatHistoryNow = saveChatHistoryNow;
        const scheduleChatHistorySave = () => {
            if (__s.chatHistorySaveTimer) clearTimeout(__s.chatHistorySaveTimer);
            const delay = (__s.isGenerating.value || __s.isRemoteGenerating.value) ? 1500 : 300;
            __s.chatHistorySaveTimer = setTimeout(() => {
                __s.chatHistorySaveTimer = null;
                saveChatHistoryNow();
            }, delay);
        };
        __s.scheduleChatHistorySave = scheduleChatHistorySave;
        const flushPendingChatHistorySave = async () => {
            if (__s.chatHistorySaveTimer) {
                await saveChatHistoryNow();
                return;
            }
            await __s.chatHistorySaveQueue;
        };
        __s.flushPendingChatHistorySave = flushPendingChatHistorySave;
        const saveMemorySettingsNow = async () => {
            if (!__s._initComplete) return;
            if (!getMainDb()) await initDB();
            await setStoredValue('memory_settings', cloneForStorage(__s.memorySettings), { clone: false });
        };
        __s.saveMemorySettingsNow = saveMemorySettingsNow;
        const saveClassicMemoriesNow = async (
            storyScopeId = getCurrentStoryBranchScopeId(),
            memorySource = __s.classicMemories.value
        ) => {
            if (!storyScopeId || (!__s._classicMemoriesLoaded && memorySource === __s.classicMemories.value)) return;
            if (!getMainDb()) await initDB();
            await setScopedStoredValue('classic_memories', storyScopeId, cloneForStorage(memorySource), { clone: false });
        };
        __s.saveClassicMemoriesNow = saveClassicMemoriesNow;
        const saveCharactersNow = async () => {
            if (!getMainDb()) await initDB();
            await setStoredValue('characters', unwrapForStorage(__s.characters.value), { clone: false });
        };
        __s.saveCharactersNow = saveCharactersNow;
        const saveData = async (options = {}) => {
            const { saveMemories = true, saveCharacters = true } = options;
            try {
                if (!getMainDb()) await initDB();
                __s.settings.contextSize = __s.MAX_CONTEXT_SIZE;
                __s.normalizeActiveToolAggressivenessSettings();
                if (saveCharacters) await saveCharactersNow();
                await setStoredValue('settings', __s.settings);
                await setStoredValue('presets', __s.presets.value);
                await setStoredValue('regex', __s.regexScripts.value);
                await setStoredValue('global_regex', __s.globalRegexScripts.value);
                await setStoredValue('worldinfo', __s.worldInfo.value);
                await setStoredValue('global_worldinfo', __s.globalWorldInfo.value);
                await setStoredValue('worldinfo_settings', __s.worldInfoSettings);
                await setStoredValue('global_ui_templates', __s.globalUiTemplates.value);
                await setStoredValue('wechat_stickers', unwrapForStorage(__s.wechatStickers.value), { clone: false });
                await setStoredValue('active_tools', __s.normalizeActiveTools(), { clone: false });
                // 守卫：初始化完成前不写入用户/记忆数据，防止默认值覆盖服务端已有数据
                if (__s._initComplete) {
                    await setStoredValue('user', __s.user);
                    await setStoredValue('user_profiles', JSON.parse(JSON.stringify(__s.userProfiles.value)));
                    if (__s.activeProfileId.value) await setStoredValue('active_profile_id', __s.activeProfileId.value);
                }

                // Save Chat State
                if (__s.currentCharacterIndex.value >= 0) {
                    await setStoredValue('last_active_char', __s.currentCharacterIndex.value);
                    await saveChatHistoryNow();
                }

                // Save Memory State
                await saveMemorySettingsNow();
                if (saveMemories) {
                    await saveClassicMemoriesNow();
                }
            } catch (e) {
                console.error('Save failed:', e);
                if (e.name === 'QuotaExceededError') {
                    __s.showToast('存储空间不足，无法保存', 'error');
                }
            }
        };
        __s.saveData = saveData;
        const saveConversationMutationNow = async ({ saveTemplateRuntime = false } = {}) => {
            try {
                const storyScopeId = getCurrentStoryBranchScopeId();
                const historySource = __s.chatHistory.value;
                const classicMemorySource = __s.classicMemories.value;
                if (saveTemplateRuntime) {
                    __s.saveGlobalUiTemplateRuntimeForCharacter(__s.currentCharacter.value, __s.activeStoryBranchId.value);
                }
                if (!getMainDb()) await initDB();
                await saveChatHistoryNow(storyScopeId, historySource);
                await saveClassicMemoriesNow(storyScopeId, classicMemorySource);
                if (saveTemplateRuntime) {
                    await saveCharactersNow();
                    await setStoredValue('global_ui_templates', __s.globalUiTemplates.value);
                }
            } catch (e) {
                console.error('Save conversation mutation failed:', e);
            }
        };
        __s.saveConversationMutationNow = saveConversationMutationNow;

        // Auto-save memory settings when changed (debounced to avoid lag on slider drag)
        __s._memorySettingsSaveTimer = null;
        watch(__s.memorySettings, () => {
            clearTimeout(__s._memorySettingsSaveTimer);
            __s._memorySettingsSaveTimer = setTimeout(() => {
                saveMemorySettingsNow().catch(e => console.error('Save memory settings failed:', e));
            }, 500);
        }, { deep: true });
        const loadData = async () => {
            try {
                await initDB();

                // Load from DB
                const savedChars = await getStoredValue('characters');
                if (savedChars) {
                    // Migration: Ensure all characters have a UUID and createdAt
                    let migrated = false;
                    __s.characters.value = savedChars.filter(char => char).map((char, index) => {
                        if (!char.uuid) {
                            char.uuid = generateUUID();
                            migrated = true;
                            // Try to migrate old index-based chat history to UUID-based
                            getScopedStoredValue('chat', index).then(oldChat => {
                                if (oldChat) {
                                    setScopedStoredValue('chat', char.uuid, oldChat);
                                    deleteScopedStoredValue('chat', index); // Clean up old key
                                }
                            }).catch(() => { });
                        }
                        if (!char.createdAt) {
                            // Use a slightly offset timestamp based on index to preserve some order for old cards
                            char.createdAt = Date.now() - (savedChars.length - index) * 1000;
                            migrated = true;
                        }
                        if (Object.prototype.hasOwnProperty.call(char, 'scenario')) {
                            delete char.scenario;
                            migrated = true;
                        }
                        return char;
                    });
                    if (migrated) {
                        await saveCharactersNow();
                    }
                }

                const savedSettings = await getStoredValue('settings');
                if (savedSettings) {
                    Object.keys(savedSettings).forEach(key => {
                        if (Object.prototype.hasOwnProperty.call(__s.settings, key)) {
                            __s.settings[key] = savedSettings[key];
                        }
                    });
                    if (!Object.prototype.hasOwnProperty.call(savedSettings, 'apiProviderId')) {
                        const legacyProvider = __s.getApiProviderByUrl(savedSettings.apiUrl);
                        __s.settings.apiProviderId = legacyProvider?.id || (savedSettings.apiUrl ? 'custom' : DEFAULT_API_PROVIDER_ID);
                        if (!legacyProvider && savedSettings.apiUrl) __s.settings.customApiUrl = savedSettings.apiUrl;
                    }
                    __s.normalizeApiProviderSettings(savedSettings);
                } else {
                    __s.normalizeApiProviderSettings();
                }
                if ((!savedSettings || Number(savedSettings.fontFamilyVersion || 0) < 4) && __s.settings.fontFamily === 'serif') {
                    __s.settings.fontFamily = 'modern';
                }
                __s.settings.fontFamily = __s.normalizeFontFamily(__s.settings.fontFamily);
                __s.settings.fontSize = __s.normalizeFontSize(__s.settings.fontSize);
                if (__s.settings.reasoningEffort === 'xhigh') __s.settings.reasoningEffort = 'max';
                if (!imageModelOptions.some(option => option.value === __s.settings.imageModel)) {
                    __s.settings.imageModel = imageModelOptions[0].value;
                }
                if (!imageSizeOptions.some(option => option.value === __s.settings.imageSize)) {
                    const legacySize = String(__s.settings.imageSize || '');
                    __s.settings.imageSize = legacySize.includes('横') ? '横图' : legacySize.includes('方') ? '方图' : '竖图';
                }
                __s.settings.imageGenCount = Math.min(8, Math.max(2, Math.round(Number(__s.settings.imageGenCount) || 2)));
                __s.settings.fontFamilyVersion = 4;
                __s.applyFontFamily(__s.settings.fontFamily);
                delete __s.settings.renderLayerLimit;
                __s.settings.contextSize = __s.MAX_CONTEXT_SIZE;
                __s.settings.stream = true;
                __s.normalizeActiveToolAggressivenessSettings();

                const savedPresets = await getStoredValue('presets');
                if (savedPresets) __s.presets.value = savedPresets.map(__s.normalizePreset);

                const savedGlobalRegex = await getStoredValue('global_regex');
                if (savedGlobalRegex) __s.globalRegexScripts.value = savedGlobalRegex.map(script => __s.normalizeRegexScript(script, 'global'));

                const savedRegex = await getStoredValue('regex');
                if (savedGlobalRegex) {
                    __s.regexScripts.value = JSON.parse(JSON.stringify(__s.globalRegexScripts.value)).map(script => __s.normalizeRegexScript(script, 'global'));
                } else if (savedRegex) {
                    __s.regexScripts.value = savedRegex.map(script => __s.normalizeRegexScript(script, 'character'));
                }

                const savedGlobalWI = await getStoredValue('global_worldinfo');
                if (savedGlobalWI) __s.globalWorldInfo.value = savedGlobalWI.map(entry => __s.normalizeWorldInfoEntry({ ...entry, scope: 'global' }));

                const savedWI = await getStoredValue('worldinfo');
                if (savedGlobalWI) {
                    __s.worldInfo.value = JSON.parse(JSON.stringify(__s.globalWorldInfo.value)).map(entry => __s.normalizeWorldInfoEntry({ ...entry, scope: 'global' }));
                } else if (savedWI) {
                    __s.worldInfo.value = savedWI.map(__s.normalizeWorldInfoEntry);
                }

                const savedGlobalUiTemplates = await getStoredValue('global_ui_templates');
                if (savedGlobalUiTemplates) __s.globalUiTemplates.value = savedGlobalUiTemplates.map(template => normalizeUiTemplate({ ...template, scope: 'global' }));

                const savedActiveTools = await getStoredValue('active_tools');
                __s.normalizeActiveTools(savedActiveTools || __s.activeTools.value);

                // 表情包库：全局的，跟着 loadData 一次性读进来，
                // 免得首轮 saveData（初始化后可能触发）用空数组把它覆盖掉。
                await __s.loadWechatStickers();

                const savedWISettings = await getStoredValue('worldinfo_settings');
                if (savedWISettings) {
                    ['scanDepth', 'maxDepth'].forEach(key => {
                        if (savedWISettings[key] !== undefined) __s.worldInfoSettings[key] = savedWISettings[key];
                    });
                }

                const savedUser = await getStoredValue('user');
                if (savedUser) Object.assign(__s.user, savedUser);
                if (!__s.user.uuid) __s.user.uuid = generateUUID(); // Ensure UUID

                const savedProfiles = await getStoredValue('user_profiles');
                const savedActiveId = await getStoredValue('active_profile_id');

                if (savedProfiles && savedProfiles.length > 0) {
                    __s.userProfiles.value = savedProfiles.map(profile => ({ ...profile, preferences: String(profile?.preferences || '') }));
                    __s.activeProfileId.value = savedActiveId || savedProfiles[0].uuid;
                    const activeProfile = __s.userProfiles.value.find(p => p.uuid === __s.activeProfileId.value);
                    if (activeProfile) {
                        Object.assign(__s.user, activeProfile);
                        if (!__s.user.uuid) __s.user.uuid = __s.activeProfileId.value;
                    }
                } else {
                    // Migrate single user to profiles
                    const firstProfile = JSON.parse(JSON.stringify(__s.user));
                    if (!firstProfile.uuid) firstProfile.uuid = generateUUID();
                    __s.user.uuid = firstProfile.uuid;
                    __s.userProfiles.value = [firstProfile];
                    __s.activeProfileId.value = firstProfile.uuid;
                }

                // Load Last Active Character Index
                const lastCharIndex = await getStoredValue('last_active_char');
                if (lastCharIndex !== undefined) {
                    __s.lastActiveCharacterId.value = lastCharIndex;
                }

                // Load Memory Settings
                const savedMemorySettings = await getStoredValue('memory_settings');
                if (savedMemorySettings) Object.assign(__s.memorySettings, savedMemorySettings);
                __s.normalizeMemorySettings();

                const savedTokenUsageHistory = await getStoredValue('token_usage_history');
                if (Array.isArray(savedTokenUsageHistory)) {
                    __s.tokenUsageHistory.value = savedTokenUsageHistory
                        .filter(record => record && typeof record === 'object')
                        .map(record => ({
                            ...record,
                            cacheWriteTokens: Number.isFinite(record.cacheWriteTokens) ? record.cacheWriteTokens : 0
                        }))
                        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                }

            } catch (e) {
                console.error('Failed to load saved data', e);
                __s.showToast('加载保存的数据失败', 'error');
            }
        };
        __s.loadData = loadData;

        // Sync World Info and Regex to Current Character
        watch(__s.worldInfo, (newVal) => {
            const normalized = JSON.parse(JSON.stringify(newVal)).map(__s.normalizeWorldInfoEntry);
            const globalEntries = normalized.filter(entry => entry.scope === 'global');
            if (JSON.stringify(__s.globalWorldInfo.value) !== JSON.stringify(globalEntries)) {
                __s.globalWorldInfo.value = globalEntries;
            }
            if (__s.currentCharacterIndex.value !== -1 && __s.characters.value[__s.currentCharacterIndex.value]) {
                if (__s._isApplyingCharacterScopedData) return;
                // Only update if different to avoid infinite loops or unnecessary updates
                const char = __s.characters.value[__s.currentCharacterIndex.value];
                const characterEntries = normalized.filter(entry => entry.scope !== 'global');
                if (JSON.stringify(char.worldInfo) !== JSON.stringify(characterEntries)) {
                    char.worldInfo = characterEntries;
                }
            }
        }, { deep: true });
        watch(__s.regexScripts, (newVal) => {
            const normalized = JSON.parse(JSON.stringify(newVal)).map(script => __s.normalizeRegexScript(script));
            const globalScripts = normalized.filter(script => script.scope === 'global');
            if (JSON.stringify(__s.globalRegexScripts.value) !== JSON.stringify(globalScripts)) {
                __s.globalRegexScripts.value = globalScripts;
            }
            if (__s.currentCharacterIndex.value !== -1 && __s.characters.value[__s.currentCharacterIndex.value]) {
                if (__s._isApplyingCharacterScopedData) return;
                const char = __s.characters.value[__s.currentCharacterIndex.value];
                const characterScripts = normalized.filter(script => script.scope !== 'global');
                if (JSON.stringify(char.regexScripts) !== JSON.stringify(characterScripts)) {
                    char.regexScripts = characterScripts;
                }
            }
        }, { deep: true });
        watch(__s.recentGenerationTimes, (newVal) => {
            if (__s.currentCharacterIndex.value !== -1 && __s.characters.value[__s.currentCharacterIndex.value]) {
                const char = __s.characters.value[__s.currentCharacterIndex.value];
                if (JSON.stringify(char.recentGenerationTimes) !== JSON.stringify(newVal)) {
                    char.recentGenerationTimes = JSON.parse(JSON.stringify(newVal));
                }
            }
        }, { deep: true });
    };
})();
