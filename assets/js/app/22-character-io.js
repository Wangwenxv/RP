/**
 * RP-Hub 应用模块 22 · 世界书辅助函数与角色卡 / 聊天记录导入导出
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 7354–7737 行。
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
    window.RPHubAppSections.characterIo = function (__s) {

        // Import/Export Logic

        const normalizeWorldInfoEntry = (entry) => (
            cardUtils.normalizeWorldInfoEntry(entry, { systemNames: systemWorldInfoNames })
        );
        __s.normalizeWorldInfoEntry = normalizeWorldInfoEntry;
        const toWorldInfoExportEntry = (entry) => {
            const normalized = normalizeWorldInfoEntry(entry);
            return cardUtils.toWorldInfoExportEntry(normalized);
        };
        __s.toWorldInfoExportEntry = toWorldInfoExportEntry;
        const getCombinedWorldInfo = (char) => {
            const characterEntries = Array.isArray(char.worldInfo)
                ? JSON.parse(JSON.stringify(char.worldInfo))
                    .map(entry => normalizeWorldInfoEntry({ ...entry, scope: 'character' }))
                    .filter(entry => entry.scope !== 'global')
                : [];
            return [
                ...JSON.parse(JSON.stringify(__s.globalWorldInfo.value))
                    .map(entry => normalizeWorldInfoEntry({ ...entry, scope: 'global' })),
                ...characterEntries
            ];
        };
        __s.getCombinedWorldInfo = getCombinedWorldInfo;
        const applyCharacterScopedResources = (char) => {
            __s.worldInfo.value = getCombinedWorldInfo(char);
            __s.combineRegexScriptsForCharacter(char);
        };
        __s.applyCharacterScopedResources = applyCharacterScopedResources;
        const syncWorldInfoToCurrentCharacter = () => {
            const char = __s.characters.value[__s.currentCharacterIndex.value];
            if (char) char.worldInfo = JSON.parse(JSON.stringify(__s.worldInfo.value));
        };
        __s.syncWorldInfoToCurrentCharacter = syncWorldInfoToCurrentCharacter;
        const parseWorldInfoKeysText = cardUtils.parseWorldInfoKeysText;
        __s.parseWorldInfoKeysText = parseWorldInfoKeysText;
        const setWorldInfoKeysText = (keys = []) => {
            __s.worldInfoKeysText.value = (Array.isArray(keys) ? keys : [])
                .map(key => String(key || '').trim())
                .filter(Boolean)
                .join(', ');
        };
        __s.setWorldInfoKeysText = setWorldInfoKeysText;
        const updateEditingWorldInfoKeys = (text) => {
            __s.worldInfoKeysText.value = String(text || '');
            __s.editingWorldInfo.data.keys = parseWorldInfoKeysText(__s.worldInfoKeysText.value, __s.editingWorldInfo.data.useRegex);
        };
        __s.updateEditingWorldInfoKeys = updateEditingWorldInfoKeys;
        const importCharacterData = async (rawData, avatarUrl, { askImageGeneration = true, activate = true } = {}) => {
            const imported = cardUtils.parseImportedCharacterCard(rawData);
            const char = {
                name: imported.name,
                description: imported.description,
                first_mes: imported.first_mes,
                avatar: avatarUrl || defaultAvatar,
                personality: imported.personality,
                creator_notes: imported.creator_notes,
                worldInfo: imported.worldInfoEntries
                    .map(entry => normalizeWorldInfoEntry({ ...entry, scope: 'character' }))
                    .filter(entry => entry.scope !== 'global'),
                regexScripts: imported.regexScripts
                    .map(script => cardUtils.normalizeImportedRegexScript(
                        { ...script, scope: 'character' },
                        { fallbackScope: 'character', systemNames: systemRegexNames }
                    ))
                    .filter(script => script.scope !== 'global'),
                uiTemplates: imported.uiTemplates.map(template => normalizeUiTemplate({
                    ...sanitizeUiTemplateImportEntry(template),
                    id: generateUUID(),
                    scope: 'character'
                })),
                recentGenerationTimes: [],
                uuid: generateUUID(),
                createdAt: Date.now()
            };

            __s.characters.value.push(char);
            try {
                await __s.saveCharactersNow();
            } catch (error) {
                const index = __s.characters.value.findIndex(item => item.uuid === char.uuid);
                if (index >= 0) __s.characters.value.splice(index, 1);
                throw error;
            }

            if (!activate) return char;
            __s.showAddCharacterMenu.value = false;
            if (__s.currentView.value === 'characters' && __s.useCharacterDeck.value) {
                __s.characterSearchQuery.value = '';
                await nextTick();
                await __s.characterDeck.value?.revealImportedCard(char.uuid);
            }
            const newCharacterIndex = __s.characters.value.findIndex(item => item.uuid === char.uuid);
            await __s.selectCharacter(newCharacterIndex, askImageGeneration);
            return char;
        };
        __s.importCharacterData = importCharacterData;
        const importCharacter = (event) => {
            const file = event.target.files[0];
            if (!file) return;

            __s.showAddCharacterMenu.value = false;

            // Reset file input
            event.target.value = '';

            if (file.name.toLowerCase().endsWith('.jsonl')) {
                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        const records = String(e.target.result || '')
                            .split(/\r?\n/)
                            .filter(line => line.trim())
                            .map(line => JSON.parse(line));
                        if (!records.length) throw new Error('文件中没有有效的聊天记录');
                        if (__s.currentCharacterIndex.value < 0) {
                            __s.showToast('请先选择一个角色才能导入聊天记录', 'warning');
                            return;
                        }

                        const char = __s.currentCharacter.value;
                        if (!char?.uuid) throw new Error('当前角色缺少有效标识');

                        if (records[0]?.type === STORY_BRANCH_CHAT_EXPORT_TYPE) {
                            const manifest = records[0];
                            if (Number(manifest.version) !== STORY_BRANCH_CHAT_EXPORT_VERSION) {
                                throw new Error(`不支持的分支聊天版本：${manifest.version}`);
                            }
                            if (!Array.isArray(manifest.branches) || !manifest.branches.length) {
                                throw new Error('文件中没有分支信息');
                            }

                            const chatByBranch = new Map();
                            records.slice(1).forEach(record => {
                                const branchId = String(record?.branchId || '').trim();
                                if (!branchId || !Array.isArray(record?.messages)) {
                                    throw new Error('分支聊天数据不完整');
                                }
                                if (record.messages.some(message => !message || typeof message !== 'object' || Array.isArray(message))) {
                                    throw new Error(`分支“${branchId}”包含无效消息`);
                                }
                                if (chatByBranch.has(branchId)) throw new Error(`分支“${branchId}”重复`);
                                chatByBranch.set(branchId, cloneForStorage(record.messages));
                            });

                            const importedBranches = normalizeStoryBranches(char, { branches: manifest.branches });
                            importedBranches.forEach(branch => {
                                if (!chatByBranch.has(branch.id)) throw new Error(`缺少分支“${branch.name}”的聊天记录`);
                                const messages = chatByBranch.get(branch.id);
                                branch.floorCount = __s.getPostprocessedChatMessages(messages, { includeSystem: false }).length;
                                branch.messageCount = messages.filter(message => ['user', 'assistant'].includes(message.role)).length;
                                branch.wordCount = getConversationBodyLength(messages);
                            });
                            const importedIds = new Set(importedBranches.map(branch => branch.id));
                            if ([...chatByBranch.keys()].some(branchId => !importedIds.has(branchId))) {
                                throw new Error('聊天记录中包含未知分支');
                            }
                            const importedActiveId = importedIds.has(String(manifest.activeBranchId))
                                ? String(manifest.activeBranchId)
                                : STORY_BRANCH_MAIN_ID;

                            if (!await __s.stopCurrentCharacterWork()) return;
                            if (!getMainDb()) await initDB();
                            await Promise.all([
                                ...importedBranches.map(branch => setScopedStoredValue(
                                    'chat',
                                    __s.getStoryBranchScopeId(char.uuid, branch.id),
                                    chatByBranch.get(branch.id),
                                    { clone: false }
                                )),
                                setScopedStoredValue('branches', char.uuid, {
                                    version: 1,
                                    activeBranchId: importedActiveId,
                                    branches: cloneForStorage(importedBranches)
                                }, { clone: false })
                            ]);

                            __s._isApplyingCharacterScopedData = true;
                            __s.storyBranches.value = importedBranches;
                            __s.activeStoryBranchId.value = importedActiveId;
                            __s.selectedStoryBranchId.value = importedActiveId;
                            __s.resetChatRenderWindow();
                            const activeChat = chatByBranch.get(importedActiveId);
                            __s.chatHistory.value = activeChat.length
                                ? __s.prepareLoadedChatHistoryForDisplay(activeChat)
                                : __s.createInitialChatHistory(char);
                            await __s.loadCharacterMemories(__s.getStoryBranchScopeId(char.uuid, importedActiveId), ' during branch chat import');
                            __s.loadGlobalUiTemplateRuntimeForCharacter(char);
                            __s.clearStoryBranchTransientContext();
                            __s.finishApplyingCharacterScopedData();
                            __s.currentView.value = 'chat';
                            await __s.scrollChatToBottom();

                            const messageCount = [...chatByBranch.values()].reduce((sum, messages) => sum + messages.length, 0);
                            __s.showToast(`成功导入 ${importedBranches.length} 个分支，共 ${messageCount} 条聊天记录`, 'success');
                            return;
                        }

                        if (records.some(message => !message || typeof message !== 'object' || Array.isArray(message))) {
                            throw new Error('聊天记录包含无效消息');
                        }
                        const importedChat = cloneForStorage(records);
                        if (!await __s.stopCurrentCharacterWork()) return;
                        __s._isApplyingCharacterScopedData = true;
                        __s.chatHistory.value = __s.prepareLoadedChatHistoryForDisplay(importedChat);
                        await setScopedStoredValue('chat', __s.getCurrentStoryBranchScopeId(), importedChat, { clone: false });
                        __s.updateCurrentStoryBranchSummary();
                        await __s.saveStoryBranchesForCharacter(char);
                        __s.finishApplyingCharacterScopedData();
                        __s.showToast(`成功为 ${char.name} 导入 ${importedChat.length} 条聊天记录`, 'success');
                    } catch (err) {
                        __s._isApplyingCharacterScopedData = false;
                        console.error('Chat import error:', err);
                        __s.showToast('聊天记录解析失败: ' + err.message, 'error');
                    }
                };
                reader.readAsText(file);
            } else if (file.type === 'application/json' || file.name.toLowerCase().endsWith('.json')) {
                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        const data = JSON.parse(e.target.result);
                        await importCharacterData(data, null);
                    } catch (err) {
                        __s.showToast('JSON解析失败: ' + err.message, 'error');
                    }
                };
                reader.readAsText(file);
            } else if (file.type === 'image/png' || file.name.endsWith('.png')) {
                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        const buffer = e.target.result;
                        const { data } = cardUtils.parsePngCharacterData(buffer);
                        const blob = new Blob([buffer], { type: 'image/png' });
                        const avatarUrl = await cardUtils.blobToDataUrl(blob);
                        await importCharacterData(data, avatarUrl);
                    } catch (err) {
                        if (err.chunks) console.warn("Available chunks:", Object.keys(err.chunks));
                        console.error(err);
                        __s.showToast('PNG解析失败: ' + err.message, 'error');
                    }
                };
                reader.readAsArrayBuffer(file);
            } else {
                __s.showToast('不支持的文件格式', 'error');
            }
        };
        __s.importCharacter = importCharacter;
        const buildCharacterExportData = (char) => cardUtils.buildCharacterCardData(char, {
            worldInfoMapper: (entry) => toWorldInfoExportEntry({ ...entry, scope: 'character' }),
            uiTemplateMapper: (template) => __s.toUiTemplateExportEntry({ ...template, scope: 'character' }),
            regexScriptMapper: (script) => __s.toRegexExportEntry({ ...script, scope: 'character' }, 'character')
        });
        __s.buildCharacterExportData = buildCharacterExportData;
        const exportCharacterJson = (index) => {
            const char = __s.characters.value[index];
            if (!char) return;

            try {
                const v2Data = buildCharacterExportData(char);
                const blob = new Blob([JSON.stringify(v2Data, null, 2)], { type: 'application/json' });
                cardUtils.downloadBlob(blob, (char.name || 'character') + '.json');
                __s.showToast('角色卡 JSON 导出成功', 'success');
            } catch (e) {
                console.error('JSON export error:', e);
                __s.showToast('JSON 导出失败: ' + e.message, 'error');
            }
        };
        __s.exportCharacterJson = exportCharacterJson;
        const exportCharacterChat = async (index) => {
            const char = __s.characters.value[index];
            if (!char) return;

            try {
                if (!getMainDb()) await initDB();
                const isCurrentCharacter = __s.currentCharacterIndex.value === index;
                if (isCurrentCharacter) await __s.flushPendingChatHistorySave();
                const savedBranches = char.uuid ? await getScopedStoredValue('branches', char.uuid) : null;
                const branches = isCurrentCharacter
                    ? cloneForStorage(__s.storyBranches.value)
                    : normalizeStoryBranches(char, savedBranches);
                const activeBranchId = isCurrentCharacter
                    ? __s.activeStoryBranchId.value
                    : String(savedBranches?.activeBranchId || STORY_BRANCH_MAIN_ID);

                const branchChats = await Promise.all(branches.map(async branch => {
                    let messages;
                    if (isCurrentCharacter && branch.id === __s.activeStoryBranchId.value) {
                        messages = cloneForStorage(__s.chatHistory.value);
                    } else if (char.uuid) {
                        messages = await getScopedStoredValue('chat', __s.getStoryBranchScopeId(char.uuid, branch.id));
                    }
                    if (messages === undefined && branch.id === STORY_BRANCH_MAIN_ID) {
                        messages = await getScopedStoredValue('chat', index);
                    }
                    return {
                        branchId: branch.id,
                        messages: Array.isArray(messages) ? cloneForStorage(messages) : []
                    };
                }));
                const totalMessages = branchChats.reduce((sum, branch) => sum + branch.messages.length, 0);
                if (!totalMessages) {
                    __s.showToast('当前角色没有可导出的聊天记录', 'warning');
                    return;
                }

                const chatByBranch = new Map(branchChats.map(branch => [branch.branchId, branch.messages]));
                const branchMetadata = branches.map(branch => {
                    const messages = chatByBranch.get(branch.id) || [];
                    return {
                        ...branch,
                        floorCount: __s.getPostprocessedChatMessages(messages, { includeSystem: false }).length,
                        messageCount: messages.filter(message => ['user', 'assistant'].includes(message?.role)).length,
                        wordCount: getConversationBodyLength(messages)
                    };
                });
                const manifest = {
                    type: STORY_BRANCH_CHAT_EXPORT_TYPE,
                    version: STORY_BRANCH_CHAT_EXPORT_VERSION,
                    characterName: char.name || '',
                    exportedAt: new Date().toISOString(),
                    activeBranchId: branchMetadata.some(branch => branch.id === activeBranchId)
                        ? activeBranchId
                        : STORY_BRANCH_MAIN_ID,
                    branches: branchMetadata
                };
                const chatLines = [manifest, ...branchChats].map(record => JSON.stringify(record)).join('\n');
                const chatBlob = new Blob([chatLines], { type: 'application/x-ndjson;charset=utf-8' });
                cardUtils.downloadBlob(chatBlob, (char.name || 'character') + '_全部分支_chat.jsonl');
                __s.showToast(`已导出 ${branches.length} 个分支，共 ${totalMessages} 条聊天记录`, 'success');
            } catch (chatExpError) {
                console.error('Chat export error:', chatExpError);
                __s.showToast('聊天记录导出失败: ' + chatExpError.message, 'error');
            }
        };
        __s.exportCharacterChat = exportCharacterChat;
        const exportCharacterPng = async (index) => {
            const char = __s.characters.value[index];
            if (!char) return;

            try {
                const v2Data = buildCharacterExportData(char);
                const pngBytes = await cardUtils.imageUrlToPngBytes(char.avatar, { crossOrigin: "Anonymous" });
                const finalPng = cardUtils.injectPngTextChunk(
                    pngBytes,
                    'chara',
                    cardUtils.encodeBase64Utf8(JSON.stringify(v2Data))
                );
                cardUtils.downloadBlob(new Blob([finalPng], { type: 'image/png' }), (char.name || 'character') + '.png');
                __s.showToast('角色卡 PNG 导出成功', 'success');
            } catch (e) {
                console.error('PNG export error:', e);
                __s.showToast('PNG 导出失败: ' + e.message, 'error');
            }
        };
        __s.exportCharacterPng = exportCharacterPng;

        // Preset Management
        const createPreset = () => {
            __s.editingPreset.id = undefined;
            __s.editingPreset.data = { name: 'New Preset', content: '', enabled: false, role: 'system' };
            __s.showPresetEditor.value = true;
        };
        __s.createPreset = createPreset;
        const editPreset = (index) => {
            __s.editingPreset.id = index;
            __s.editingPreset.data = __s.normalizePreset(JSON.parse(JSON.stringify(__s.presets.value[index])));
            __s.showPresetEditor.value = true;
        };
        __s.editPreset = editPreset;
        const savePreset = () => {
            const normalizedPreset = __s.normalizePreset(__s.editingPreset.data);
            if (__s.editingPreset.id !== undefined) {
                __s.presets.value[__s.editingPreset.id] = normalizedPreset;
            } else {
                __s.presets.value.push(normalizedPreset);
            }
            __s.showPresetEditor.value = false;
        };
        __s.savePreset = savePreset;
        const deletePreset = (index) => {
            __s.confirmAction('确定要删除这个预设吗？此操作无法撤销。', () => {
                __s.presets.value.splice(index, 1);
                __s.showToast('预设已删除', 'success');
            });
        };
        __s.deletePreset = deletePreset;
    };
})();
