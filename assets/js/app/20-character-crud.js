/**
 * RP-Hub 应用模块 20 · 角色 / UI 模板增删改、批量删除与特殊规则
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 6320–6776 行。
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
    window.RPHubAppSections.characterCrud = function (__s) {

        // Character Management
        const createNewCharacter = () => {
            __s.editingCharacter.id = undefined;
            __s.editingCharacter.data = {
                name: 'New Character',
                description: '',
                first_mes: 'Hello!',
                avatar: defaultAvatar,
                personality: '',
                mes_example: '',
                uuid: generateUUID(),
                createdAt: Date.now(),
                uiTemplates: []
            };
            __s.editorTab.value = 'basic';
            __s.showCharacterEditor.value = true;
        };
        __s.createNewCharacter = createNewCharacter;
        const editCharacter = (index) => {
            const char = __s.characters.value[index];
            if (!char) {
                console.error('Invalid character index:', index);
                return;
            }
            __s.editingCharacter.id = index;
            __s.editingCharacter.data = JSON.parse(JSON.stringify(char));
            __s.editorTab.value = 'basic';
            __s.showCharacterEditor.value = true;
        };
        __s.editCharacter = editCharacter;
        const saveCharacter = () => {
            const characterRegexScripts = (__s.editingCharacter.data.regexScripts || [])
                .map(script => __s.normalizeRegexScript({ ...script, scope: 'character' }, 'character'))
                .filter(script => script.scope !== 'global');
            const normalizedCharacterData = {
                ...__s.editingCharacter.data,
                regexScripts: characterRegexScripts,
                uiTemplates: (__s.editingCharacter.data.uiTemplates || []).map(template => normalizeUiTemplate({ ...template, scope: 'character' }))
            };
            delete normalizedCharacterData.scenario;
            if (__s.editingCharacter.id !== undefined) {
                __s.characters.value[__s.editingCharacter.id] = normalizedCharacterData;
            } else {
                __s.characters.value.push(normalizedCharacterData);
            }
            __s.showCharacterEditor.value = false;
            __s.showToast('角色已保存', 'success');
        };
        __s.saveCharacter = saveCharacter;
        const createUiTemplate = () => {
            __s.editingUiTemplate.id = undefined;
            __s.editingUiTemplate.tab = 'edit';
            const data = normalizeUiTemplate({ scope: __s.currentCharacter.value ? 'character' : 'global' });
            __s.editingUiTemplate.data = {
                ...data,
                previewVariableState: cloneUiObject(data.initialVariableState || data.variableState),
                variableStateText: JSON.stringify(data.initialVariableState || data.variableState, null, 2),
                variableSchemaText: stringifyUiSchema(data.variableSchema)
            };
            __s.showUiTemplateEditor.value = true;
        };
        __s.createUiTemplate = createUiTemplate;
        const editUiTemplate = (index) => {
            const template = __s.currentUiTemplates.value[index];
            if (!template) return;
            __s.editingUiTemplate.id = template.id;
            __s.editingUiTemplate.tab = 'history';
            const data = normalizeUiTemplate(JSON.parse(JSON.stringify(template)));
            __s.editingUiTemplate.data = {
                ...data,
                previewVariableState: cloneUiObject(data.initialVariableState || data.variableState),
                variableStateText: JSON.stringify(data.initialVariableState || data.variableState || {}, null, 2),
                variableSchemaText: stringifyUiSchema(data.variableSchema)
            };
            __s.showUiTemplateEditor.value = true;
        };
        __s.editUiTemplate = editUiTemplate;
        const saveUiTemplate = () => {
            if (!__s.currentCharacter.value && __s.editingUiTemplate.data.scope !== 'global') return;
            let initialVariableState = {};
            try {
                initialVariableState = JSON.parse(__s.editingUiTemplate.data.variableStateText || '{}');
            } catch (e) {
                __s.showToast('变量 JSON 格式不正确', 'error');
                return;
            }
            let variableSchema = '';
            const schemaText = (__s.editingUiTemplate.data.variableSchemaText || '').trim();
            if (schemaText) {
                try {
                    variableSchema = JSON.parse(schemaText);
                } catch (e) {
                    variableSchema = schemaText;
                }
            }
            const existingTemplate = __s.editingUiTemplate.id !== undefined ? __s.currentUiTemplates.value.find(template => template.id === __s.editingUiTemplate.id) : null;
            const runtimeVariableState = existingTemplate ? cloneUiObject(existingTemplate.variableState || initialVariableState) : initialVariableState;
            const template = normalizeUiTemplate({
                ...__s.editingUiTemplate.data,
                initialVariableState,
                variableState: runtimeVariableState,
                variableSchema
            });
            delete template.variableStateText;
            delete template.variableSchemaText;
            delete template.previewVariableState;
            if (__s.editingUiTemplate.id !== undefined) {
                const oldScope = existingTemplate?.scope || 'character';
                const oldList = __s.getUiTemplateListByScope(oldScope);
                const oldIndex = oldList.findIndex(item => item.id === __s.editingUiTemplate.id);
                if (oldIndex !== -1) oldList.splice(oldIndex, 1);
            }
            const list = __s.getUiTemplateListByScope(template.scope);
            const targetIndex = list.findIndex(item => item.id === template.id);
            if (targetIndex !== -1) {
                list[targetIndex] = template;
            } else {
                list.push(template);
            }
            __s.showUiTemplateEditor.value = false;
            __s.saveData({ saveMemories: false });
            __s.showToast('UI模板已保存', 'success');
        };
        __s.saveUiTemplate = saveUiTemplate;
        const deleteUiTemplate = (index) => {
            __s.confirmAction('确定要删除这个UI模板吗？此操作无法撤销。', () => {
                const template = __s.currentUiTemplates.value[index];
                const list = __s.getUiTemplateListByScope(template?.scope);
                const targetIndex = list.findIndex(item => item.id === template?.id);
                if (targetIndex !== -1) list.splice(targetIndex, 1);
                __s.saveData();
                __s.showToast('UI模板已删除', 'success');
            });
        };
        __s.deleteUiTemplate = deleteUiTemplate;
        const downloadJsonFile = (data, fileName, spacing = 2, options = {}) => {
            const json = typeof data === 'string' ? data : JSON.stringify(data, null, spacing);
            const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
            cardUtils.downloadBlob(blob, fileName, options);
            return blob;
        };
        __s.downloadJsonFile = downloadJsonFile;
        const readJsonFileInput = (event, handleData, handleError) => {
            const input = event.target;
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async ({ target }) => {
                try {
                    await handleData(JSON.parse(target.result));
                } catch (error) {
                    handleError(error);
                } finally {
                    input.value = '';
                }
            };
            reader.onerror = () => {
                handleError(reader.error || new Error('读取文件失败'));
                input.value = '';
            };
            reader.readAsText(file);
        };
        __s.readJsonFileInput = readJsonFileInput;
        const importUiTemplates = (event) => readJsonFileInput(event, data => {
            const templates = Array.isArray(data) ? data : (Array.isArray(data.templates) ? data.templates : []);
            if (!templates.length) throw new Error('未找到模板数组');
            const normalized = templates.map(t => {
                const cleanTemplate = sanitizeUiTemplateImportEntry(t);
                return normalizeUiTemplate({ ...cleanTemplate, id: generateUUID(), enabled: cleanTemplate.enabled === true ? true : false });
            });
            const globalTemplates = normalized.filter(template => template.scope === 'global');
            const characterTemplates = normalized.filter(template => template.scope !== 'global');
            if (characterTemplates.length && !__s.currentCharacter.value) {
                __s.showToast('绑定角色卡的模板需要先选择角色卡', 'warning');
                return;
            }
            __s.ensureGlobalUiTemplates().push(...globalTemplates);
            __s.ensureCurrentUiTemplates().push(...characterTemplates);
            __s.saveData();
            __s.showToast(`成功导入 ${normalized.length} 个UI模板`, 'success');
        }, error => __s.showToast(`UI模板导入失败: ${error.message}`, 'error'));
        __s.importUiTemplates = importUiTemplates;
        const deleteCharacterData = async (char, legacyIndex, knownStorageKeys = null) => {
            if (!getMainDb()) await initDB();
            let savedBranches = null;
            if (char?.uuid) {
                try { savedBranches = await getScopedStoredValue('branches', char.uuid); } catch (_) { }
            }
            const branchList = __s.currentCharacter.value?.uuid === char?.uuid
                ? __s.storyBranches.value
                : (Array.isArray(savedBranches?.branches) ? savedBranches.branches : []);
            const branchScopeIds = new Set(branchList
                .filter(branch => branch?.id && branch.id !== STORY_BRANCH_MAIN_ID)
                .map(branch => __s.getStoryBranchScopeId(char.uuid, branch.id)));
            if (char?.uuid) {
                const storageKeys = knownStorageKeys || (await Promise.all([
                    readStorageKeys(getMainDb()),
                    readStorageKeys(getLegacyDb())
                ])).flat();
                storageKeys.forEach(key => {
                    const logicalKey = getStorageLogicalKey(key);
                    const storageName = __s.CHARACTER_SCOPED_STORAGE_NAMES
                        .find(name => logicalKey.startsWith(`${name}_`));
                    const scopeId = storageName ? logicalKey.slice(storageName.length + 1) : '';
                    if (scopeId && getStoryBranchOwnerId(scopeId) === char.uuid && scopeId !== char.uuid) {
                        branchScopeIds.add(scopeId);
                    }
                });
            }
            const allBranchScopeIds = [...branchScopeIds];
            const ids = [...new Set([char?.uuid, legacyIndex, ...allBranchScopeIds].filter(id => id !== undefined && id !== null))];
            await Promise.all(ids.flatMap(id => __s.CHARACTER_SCOPED_STORAGE_NAMES
                .map(name => deleteScopedStoredValue(name, id))));

            if (!char?.uuid) return;
            __s.ensureGlobalUiTemplates().forEach(template => {
                if (!template.runtimeByCharacter) return;
                [char.uuid, ...allBranchScopeIds].forEach(scopeId => delete template.runtimeByCharacter[scopeId]);
            });
        };
        __s.deleteCharacterData = deleteCharacterData;
        const finishCharacterDeletion = async () => {
            await Promise.all([
                __s.saveCharactersNow(),
                __s.saveMemorySettingsNow(),
                setStoredValue('global_ui_templates', __s.globalUiTemplates.value),
                __s.currentCharacterIndex.value >= 0
                    ? setStoredValue('last_active_char', __s.currentCharacterIndex.value)
                    : deleteStoredValue('last_active_char')
            ]);
        };
        __s.finishCharacterDeletion = finishCharacterDeletion;
        const stopCurrentCharacterWork = async () => {
            if (__s.isConversationBusy.value) {
                __s.stopGeneration();
                if (!await __s.waitForConversationIdle()) {
                    __s.showToast('正在停止生成，请稍后再删除角色', 'warning');
                    return false;
                }
            }
            await __s.flushPendingChatHistorySave();
            __s.abortConversationBackgroundWork();
            return true;
        };
        __s.stopCurrentCharacterWork = stopCurrentCharacterWork;
        const clearCurrentCharacterData = () => {
            __s._characterSwitchEpoch++;
            __s.currentCharacterIndex.value = -1;
            __s.chatHistory.value = [];
            __s.classicMemories.value = [];
            __s.storyBranches.value = [];
            __s.activeStoryBranchId.value = STORY_BRANCH_MAIN_ID;
            __s.selectedStoryBranchId.value = STORY_BRANCH_MAIN_ID;
            __s.storyRouteDragState = null;
            __s.storyRouteMapDragging.value = false;
            __s.suppressStoryRouteNodeClick = false;
            __s.showStoryBranchModal.value = false;
            __s._classicMemoriesLoaded = false;
        };
        __s.clearCurrentCharacterData = clearCurrentCharacterData;
        const deleteCharacter = (index) => {
            __s.confirmAction('确定要删除这个角色吗？此操作无法撤销。', async () => {
                try {
                    const char = __s.characters.value[index];
                    if (!char) return;
                    const isCurrent = __s.currentCharacterIndex.value === index;
                    if (isCurrent && !await stopCurrentCharacterWork()) return;

                    await deleteCharacterData(char, index);

                    __s.suspendCharacterAutoSave = true;
                    __s.characters.value.splice(index, 1);
                    if (isCurrent) {
                        clearCurrentCharacterData();
                    } else if (__s.currentCharacterIndex.value > index) {
                        __s.currentCharacterIndex.value--;
                    }
                    await finishCharacterDeletion();
                    __s.showToast('角色已删除', 'success');
                } catch (err) {
                    console.error('Failed to delete character or associated data:', err);
                    __s.showToast('删除角色失败', 'error');
                } finally {
                    __s.suspendCharacterAutoSave = false;
                }
            });
        };
        __s.deleteCharacter = deleteCharacter;
        const toggleCharacterFavorite = (index) => {
            const char = __s.characters.value[index];
            if (!char) return;

            if (__s.isCharacterFavorite(char)) {
                const { favoriteAt, ...characterData } = char;
                __s.characters.value[index] = characterData;
                __s.showToast('已取消收藏', 'info');
            } else {
                __s.characters.value[index] = {
                    ...char,
                    favoriteAt: Date.now()
                };
                __s.showToast('已收藏角色卡', 'success');
            }
            __s.saveCharactersNow().catch(error => {
                console.error('Save character favorite failed:', error);
                __s.showToast('收藏状态保存失败', 'error');
            });
        };
        __s.toggleCharacterFavorite = toggleCharacterFavorite;
        const toggleBatchDeleteMode = () => {
            __s.isBatchDeleteMode.value = !__s.isBatchDeleteMode.value;
            __s.selectedCharacterIndices.value.clear();
        };
        __s.toggleBatchDeleteMode = toggleBatchDeleteMode;
        const toggleCharacterSelection = (index) => {
            if (__s.selectedCharacterIndices.value.has(index)) {
                __s.selectedCharacterIndices.value.delete(index);
            } else {
                __s.selectedCharacterIndices.value.add(index);
            }
        };
        __s.toggleCharacterSelection = toggleCharacterSelection;
        const batchDeleteCharacters = () => {
            if (__s.selectedCharacterIndices.value.size === 0) return;

            __s.confirmAction(`确定要删除选中的 ${__s.selectedCharacterIndices.value.size} 个角色吗？此操作无法撤销。`, async () => {
                try {
                    const currentUUID = __s.currentCharacter.value ? __s.currentCharacter.value.uuid : null;
                    const indices = Array.from(__s.selectedCharacterIndices.value).sort((a, b) => b - a);
                    const deletingCurrent = indices.includes(__s.currentCharacterIndex.value);
                    if (deletingCurrent && !await stopCurrentCharacterWork()) return;
                    if (!getMainDb()) await initDB();
                    const storageKeys = (await Promise.all([
                        readStorageKeys(getMainDb()),
                        readStorageKeys(getLegacyDb())
                    ])).flat();

                    __s.suspendCharacterAutoSave = true;
                    for (const index of indices) {
                        const char = __s.characters.value[index];
                        if (!char) continue;
                        await deleteCharacterData(char, index, storageKeys);
                        __s.characters.value.splice(index, 1);
                    }

                    if (deletingCurrent) {
                        clearCurrentCharacterData();
                    } else if (currentUUID) {
                        const newIndex = __s.characters.value.findIndex(c => c.uuid === currentUUID);
                        __s.currentCharacterIndex.value = newIndex;
                    } else {
                        __s.currentCharacterIndex.value = -1;
                    }

                    await finishCharacterDeletion();
                    __s.showToast('删除成功', 'success');
                    toggleBatchDeleteMode();
                } catch (err) {
                    console.error('Batch delete failed:', err);
                    __s.showToast('删除失败', 'error');
                } finally {
                    __s.suspendCharacterAutoSave = false;
                }
            });
        };
        __s.batchDeleteCharacters = batchDeleteCharacters;
        const enforceSpecialRules = () => {
            const imageGenToken = __s.settings.imageGenKey.trim();
            const baseUrl = IMAGE_GEN_BASE_URL;

            // 1. NAI画图正则 (统一版本)
            const imageGenRegexName = 'NAI画图正则';
            const targetArtists = cardUtils.getImageStyleArtists(__s.settings.imageStyle, __s.settings.customImageArtists);

            const encodedTargetArtists = encodeURIComponent(targetArtists);
            const imageRequestUrl = `${baseUrl}/generate?tag=$1&token=${encodeURIComponent(imageGenToken)}&model=${__s.settings.imageModel}&artist=${encodedTargetArtists}&size=${__s.settings.imageSize}&steps=40&scale=6&cfg=0&sampler=k_dpmpp_2m_sde&negative={{{{bad anatomy}}}},{bad feet},bad hands,{{{bad proportions}}},{blurry},cloned face,cropped,{{{deformed}}},{{{disfigured}}},error,{{{extra arms}}},{extra digit},{{{extra legs}}},extra limbs,{{extra limbs}},{fewer digits},{{{fused fingers}}},gross proportions,ink eyes,ink hair,jpeg artifacts,{{{{long neck}}}},low quality,{malformed limbs},{{missing arms}},{missing fingers}},{{missing legs}},{{{more than 2 nipples}}},mutated hands,{{{mutation}}},normal quality,owres,{{poorly drawn face}},{{poorly drawn hands}},reen eyes,signature,text,{{too many fingers}},{{{ugly}}},username,uta,watermark,worst quality,{{{more than 2 legs}}},awkward hand sign,weird hand gesture,contorted hand,unnatural finger pose,deformed hand gesture,{shaka},{hang loose},{{rock on}},{shaka sign}&nocache=0&noise_schedule=karras`;
            const imageGenRegexContent = {
                name: imageGenRegexName,
                regex: getImageTagRegex().toString(),
            replacement: `<div class="generated-image-card is-generating" data-image-request="${imageRequestUrl}" style="width:100%;height:auto;max-width:100%;box-sizing:border-box;padding:2px;border:1px solid rgba(255,255,255,.58);background:transparent;position:relative;border-radius:12px;overflow:hidden;display:flex;justify-content:center;align-items:center;box-shadow:0 4px 14px rgba(148,163,184,.06)"><img alt="" style="max-width:100%;height:100%;width:100%;display:block;object-fit:contain;border-radius:9px;transition:transform .3s ease"><div class="generated-image-progress" aria-live="polite"><svg class="generated-image-spinner" viewBox="0 0 50 50" aria-hidden="true"><circle class="generated-image-spinner-path" cx="25" cy="25" r="20" fill="none" stroke-width="2"></circle></svg><span class="generated-image-progress-label">等待生成</span><span class="generated-image-progress-track"><i class="generated-image-progress-bar"></i></span></div><button type="button" class="generated-image-reroll" title="重新生成图片" aria-label="重新生成图片"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg></button></div>`,
                placement: [2],
                markdownOnly: true,
                promptOnly: false,
                scope: 'global',
                enabled: false // Default closed
            };
            // 查找当前是否已存在新命名的正则
            const newRegexIndex = __s.regexScripts.value.findIndex(r => r.name === imageGenRegexName);

            if (newRegexIndex !== -1) {
                // 如果已存在，保留目前的启用状态并更新内容
                imageGenRegexContent.enabled = __s.regexScripts.value[newRegexIndex].enabled;
                __s.regexScripts.value.splice(newRegexIndex, 1);
            }

            // 添加新的到首位
            __s.regexScripts.value.unshift(imageGenRegexContent);

            // 2. 自动生图世界书
            const autoImageGenWIName = '自动生图';
            const imageGenCount = Math.min(8, Math.max(2, Number(__s.settings.imageGenCount) || 2));
            const autoImageGenWIContent = {
                comment: autoImageGenWIName,
                keys: [],
                content: BUILTIN_PROMPTS.buildAutoImageGenPrompt(imageGenCount),
                constant: true,
                enabled: false, // Default closed
                scope: 'global',
                position: 'at_depth',
                depth: 4,
                order: 100,
                useProbability: false,
                probability: 100
            };

            const wiIndex = __s.worldInfo.value.findIndex(w => w.comment === autoImageGenWIName);
            if (wiIndex !== -1) {
                // 存在，保留启用状态并更新内容
                autoImageGenWIContent.enabled = __s.worldInfo.value[wiIndex].enabled;
                __s.worldInfo.value.splice(wiIndex, 1);
            }
            // 添加新的到首位
            __s.worldInfo.value.unshift(autoImageGenWIContent);

        };
        __s.enforceSpecialRules = enforceSpecialRules;
        watch(() => __s.settings.imageGenKey, () => {
            enforceSpecialRules();
            if (__s.isAutoImageGenEnabled.value) {
                __s.updateImageGenRegexState({ enableRegex: true });
            }
            __s.saveData();
            __s.fetchQuota();
        });
        const prepareLoadedChatHistoryForDisplay = (messages = []) => messages
            .filter(msg => msg !== null && msg !== undefined)
            .map(msg => {
                if (msg.isSelf === undefined) {
                    msg.isSelf = msg.role === 'user';
                }
                if (msg.role === 'user' || msg.role === 'assistant') {
                    delete msg.skipReveal;
                    msg.shouldAnimate = true;
                }
                if (msg.role === 'assistant' && msg.isSummaryOpen === undefined && __s.hasThinkingOrTools(msg)) {
                    msg.isSummaryOpen = false;
                }
                if (msg.role === 'assistant' && Array.isArray(msg.styleFilterHits)) {
                    msg.styleFilterHits = msg.styleFilterHits
                        .map(__s.normalizeStyleFilterHit)
                        .filter(Boolean);
                    if (!msg.styleFilterHits.length) delete msg.styleFilterHits;
                } else {
                    delete msg.styleFilterHits;
                }
                return msg;
            });
        __s.prepareLoadedChatHistoryForDisplay = prepareLoadedChatHistoryForDisplay;
    };
})();
