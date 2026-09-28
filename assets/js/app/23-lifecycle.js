/**
 * RP-Hub 应用模块 23 · 启动初始化（onMounted）与卸载清理（onBeforeUnmount）
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 7740–8009 行。
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
    window.RPHubAppSections.lifecycle = function (__s) {

        // Expose triggerSlash for character cards (Defined early)
        window.triggerSlash = async (text) => {
            const command = String(text || '').trim();
            if (!command) return;

            if (__s.isConversationBusy.value) {
                __s.showToast('正在生成中，请稍后...', 'warning');
                return;
            }

            __s.pendingCardInteraction.value = command;
            await nextTick();
            __s.inputBox.value?.focus();
        };

        // Lifecycle
        onMounted(async () => {
            document.addEventListener('fullscreenchange', __s.syncChatFullscreenState);
            document.addEventListener('webkitfullscreenchange', __s.syncChatFullscreenState);

            await __s.loadData();
            __s.fetchQuota(); // Fetch quota after saved settings are loaded

            __s.updateModalRef.value?.check(); // 必须在 loadData 之后检查，否则同步存储尚未加载

            // Check for default username
            if (__s.user.name === '请前往设置自定义你的名称') {
                __s.tempUserSetup.name = '';
                __s.tempUserSetup.description = __s.user.description;
                __s.tempUserSetup.person = __s.user.person || 'second';
                __s.showUserSetupModal.value = true;
            }

            // 每次启动时强制重置温度为 1.0
            __s.settings.temperature = 1.0;

            // --- Enforce Defaults ---

            // 1. Enforce Default Preset (破限)
            const builtinPresetDefaults = BUILTIN_CORE_PRESETS;
            const defaultPresetName = builtinPresetDefaults[0].name;
            const builtinPresetNameSet = new Set(builtinPresetDefaults.map(preset => preset.name));
            const existingBuiltinPresetMap = new Map();

            __s.presets.value.forEach((preset) => {
                if (!preset || !builtinPresetNameSet.has(preset.name) || existingBuiltinPresetMap.has(preset.name)) {
                    return;
                }
                existingBuiltinPresetMap.set(preset.name, __s.normalizePreset(preset));
            });

            const existingDefaultPreset = existingBuiltinPresetMap.get(defaultPresetName);
            const fallbackBuiltinEnabled = existingDefaultPreset ? existingDefaultPreset.enabled !== false : true;
            const orderedBuiltinPresets = builtinPresetDefaults.map((preset) => {
                const existingPresetData = existingBuiltinPresetMap.get(preset.name);
                return __s.normalizePreset({
                    ...existingPresetData,
                    name: preset.name,
                    role: preset.role,
                    content: preset.content,
                    // 微信版文案也走这条同步路径，否则破限/预注入在微信侧永远没有内容
                    wechatContent: preset.wechatContent || '',
                    enabled: existingPresetData ? existingPresetData.enabled !== false : fallbackBuiltinEnabled
                });
            });

            __s.presets.value = [
                ...orderedBuiltinPresets,
                ...__s.presets.value.filter(preset => preset && !builtinPresetNameSet.has(preset.name))
            ];
            // 1.6 Enforce Default Preset (防抢话)
            __s.syncBuiltinPreset(BUILTIN_PRESETS.antiRobbery);

            // 1.6.1 Enforce Default Preset (防神化)
            __s.syncBuiltinPreset(BUILTIN_PRESETS.antiDeification);
            // 1.7 Enforce Default Preset (防重复)
            __s.syncBuiltinPreset(BUILTIN_PRESETS.antiRepeat);

            // 1.7.2 Enforce Default Preset (人格内核)
            __s.syncBuiltinPreset(BUILTIN_PRESETS.personalityCore);

            // 1.7.3 Enforce Default Preset (去User中心化)
            __s.syncBuiltinPreset(BUILTIN_PRESETS.deUserCentric);

            // 1.7.5 Enforce Default Preset (文风（抗八股）)
            __s.syncBuiltinPreset(BUILTIN_PRESETS.writingStyle);
            __s.syncBuiltinPreset(BUILTIN_PRESETS.storyPanels);
            __s.syncBuiltinPreset(BUILTIN_PRESETS.lifelike);

            // 1.7.5.1 固定 NSFW增强在文风预设之后
            __s.syncBuiltinPreset(BUILTIN_PRESETS.nsfw);

            // 1.7.6 Enforce Default Preset (时间戳)
            __s.syncBuiltinPreset(BUILTIN_PRESETS.timestamp);

            // 1.8 Enforce Default Preset (第二人称)
            __s.syncBuiltinPreset({
                ...BUILTIN_PRESETS.secondPerson,
                enabled: __s.user.person !== 'third',
                syncEnabled: true
            });

            // 1.7 Enforce Default Preset (第三人称)
            __s.syncBuiltinPreset({
                ...BUILTIN_PRESETS.thirdPerson,
                enabled: __s.user.person === 'third',
                syncEnabled: true
            });

            // 1.9 Enforce Default Preset (禁止规则)
            __s.syncBuiltinPreset(BUILTIN_PRESETS.prohibited);

            // 1.10 Enforce Default Preset (COT)
            const cotPresetName = 'COT';
            const syncDynamicPresetContent = () => {
                const useThinkingOpening = __s.usesThinkingCotTag(__s.settings.model);
                const uiTemplateAnalysisEnabled = __s.isUiTemplateAnalysisEnabled();
                const cotPresetContent = buildCotPresetContent({
                    memoryEnabled: __s.memorySettings.enabled,
                    uiTemplateAnalysisEnabled,
                    storyPanelsEnabled: __s.isStoryPanelsEnabled.value,
                    useThinkingOpening
                });
                let existingCotPreset = __s.presets.value.find(p => p.name === cotPresetName);
                if (!existingCotPreset) {
                    __s.presets.value.push({
                        name: cotPresetName,
                        content: cotPresetContent,
                        enabled: true
                    });
                    existingCotPreset = __s.presets.value.find(p => p.name === cotPresetName);
                } else if (existingCotPreset.content !== cotPresetContent) {
                    existingCotPreset.content = cotPresetContent;
                }

                const prefillEnabled = __s.isPresetEnabled(existingCotPreset);
                BUILTIN_CORE_PRESETS.forEach(preset => {
                    const prefillPhase = preset.name === '破限预注入 · AI 1' ? 1
                        : preset.name === '破限预注入 · AI 2' ? 2
                            : 0;
                    if (!prefillPhase) return;
                    const existingPreset = __s.presets.value.find(item => item.name === preset.name);
                    if (!existingPreset) return;
                    existingPreset.content = buildCotPresetContent({
                        memoryEnabled: __s.memorySettings.enabled,
                        uiTemplateAnalysisEnabled,
                        useThinkingOpening,
                        prefillPhase,
                        prefillEnabled,
                        prefillBaseContent: preset.content
                    });
                });
            };
            syncDynamicPresetContent();
            watch([
                () => __s.memorySettings.enabled,
                () => __s.settings.uiTemplateEnabled,
                () => __s.settings.uiTemplateMainModelAnalysis,
                () => __s.activeUiTemplates.value.length,
                __s.isStoryPanelsEnabled,
                () => __s.settings.model,
                __s.isTruncationEnabled,
                () => __s.presets.value.find(preset => preset.name === cotPresetName)?.enabled
            ], syncDynamicPresetContent);
            __s.removeLegacyUserRegex();

            // Save enforced defaults immediately (仅保存预设/正则等结构性数据)
            __s.saveData({ saveMemories: false, saveCharacters: false });

            // 初始化守卫解除：此后 saveData 才允许写入 user / memorySettings
            __s._initComplete = true;

            // Restore Last Active Session
            if (__s.lastActiveCharacterId.value !== null && __s.characters.value[__s.lastActiveCharacterId.value]) {
                // Restore character selection without clearing chat history (we load it from DB)
                __s._isApplyingCharacterScopedData = true;
                __s.currentCharacterIndex.value = __s.lastActiveCharacterId.value;
                __s.resetChatRenderWindow();
                const char = __s.characters.value[__s.currentCharacterIndex.value];

                // Load Chat History for this character
                try {
                    if (!char.uuid) {
                        char.uuid = generateUUID();
                        await __s.saveCharactersNow();
                    }
                    await __s.loadStoryBranchesForCharacter(char);
                    __s.chatHistory.value = await __s.loadStoredChatHistory(
                        char,
                        __s.currentCharacterIndex.value,
                        __s.getStoryBranchScopeId(char.uuid)
                    );
                } catch (error) {
                    console.error('Error loading chat history on restore:', error);
                    __s.currentCharacterIndex.value = -1;
                    __s._isApplyingCharacterScopedData = false;
                    __s.showToast('聊天记录恢复失败，原记录未被覆盖，请重新选择角色重试', 'error', 5000);
                    return;
                }
                __s.loadGlobalUiTemplateRuntimeForCharacter(char);

                // Load Char Specifics
                __s.applyCharacterScopedResources(char);
                __s.finishApplyingCharacterScopedData();

                if (char.recentGenerationTimes) __s.recentGenerationTimes.value = JSON.parse(JSON.stringify(char.recentGenerationTimes));
                else __s.recentGenerationTimes.value = [];

                await __s.loadCharacterMemories(__s.getStoryBranchScopeId(char.uuid), ' on restore');

                // Enforce special rules (Nai画图正则 & 自动生图)
                __s.enforceSpecialRules();

                // Sync image style rules
                if (__s.isAutoImageGenEnabled.value) {
                    __s.updateImageGenRegexState({ enableRegex: true });
                }

                await __s.scrollChatToBottom();
            } else if (__s.characters.value.length > 0) {
                // Fallback to first character if no last active
                __s.selectCharacter(0);
            }

            __s.fetchModels();

            // Initial Status Check
            __s.checkAllStatuses();

            // --- Mobile Keyboard Adaptation (VisualViewport) ---
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', __s.handleMobileViewportResize, { passive: true });
                window.visualViewport.addEventListener('scroll', __s.handleMobileViewportResize, { passive: true });
            }
            window.addEventListener('orientationchange', __s.handleMobileOrientationChange, { passive: true });
            window.addEventListener('resize', __s.handleMobileViewportResize, { passive: true });
            __s.scheduleMobileVisualViewportSync({ force: true });

            // --- 全局点击外部区域收起面板 ---
            document.addEventListener('click', (e) => {
                if (__s.settingsHelpTopic.value
                    && !e.target.closest('.settings-help-trigger')
                    && !e.target.closest('.settings-help-popover')) {
                    __s.settingsHelpTopic.value = '';
                }
                if (__s.showTokenUsageTimeFilter.value && !e.target.closest('.token-usage-time-filter-container')) {
                    __s.showTokenUsageTimeFilter.value = false;
                }
                if (__s.showProfileDropdown.value && !e.target.closest('.profile-dropdown-container')) {
                    __s.showProfileDropdown.value = false;
                }
                if (__s.showApiProviderSelector.value && !e.target.closest('.api-provider-selector-container')) {
                    __s.showApiProviderSelector.value = false;
                }
            });
        });
        onBeforeUnmount(() => {
            __s.activeSortable?.destroy();
            __s.generatedImageObserver?.disconnect();
            __s.generatedImageTasks.clear();
            __s.closeNavigation();
            document.removeEventListener('fullscreenchange', __s.syncChatFullscreenState);
            document.removeEventListener('webkitfullscreenchange', __s.syncChatFullscreenState);
            if (window.visualViewport) {
                window.visualViewport.removeEventListener('resize', __s.handleMobileViewportResize);
                window.visualViewport.removeEventListener('scroll', __s.handleMobileViewportResize);
            }
            window.removeEventListener('orientationchange', __s.handleMobileOrientationChange);
            window.removeEventListener('resize', __s.handleMobileViewportResize);
            if (__s.mobileViewportRaf) cancelAnimationFrame(__s.mobileViewportRaf);
            clearTimeout(__s.mobileKeyboardBlurTimer);
        });
    };
})();
