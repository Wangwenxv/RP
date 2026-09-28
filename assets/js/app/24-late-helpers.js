/**
 * RP-Hub 应用模块 24 · 正文流式截断、用户人设切换与记忆展示统计
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 8011–8180 行。
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
    window.RPHubAppSections.lateHelpers = function (__s) {

        // 解析并截断生成的包含 HTML UI 的正文，避免闪屏问题
        const processMainContent = (mainText, isGeneratingState) => {
            mainText = stripUiTemplateUpdateBlock(mainText);
            if (!isGeneratingState) return { text: mainText, showSpinner: false };
            const imageStart = cardUtils.findLastUnprotectedMatch(mainText, /image###/gi)?.index ?? -1;
            if (imageStart !== -1) {
                const imageTail = mainText.slice(imageStart + 'image###'.length);
                if (!imageTail.includes('###') && !/[\r\n]/.test(imageTail)) mainText = mainText.slice(0, imageStart);
            }
            // 只暂存未闭合的 UI；完整面板及其后的正文可以继续流式展示。
            const uiTokens = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\r\n]*`|<!--[\s\S]*?(?:-->|$)|<(script|style)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/\1\s*>|$)|<!doctype\b[^>]*(?:>|$)|<\/?[a-z][\w:-]*(?:[^"'<>]|"[^"]*(?:"|$)|'[^']*(?:'|$))*(>|$)/gi;
            const openTags = [];
            let pendingStart = -1;
            const waitForUi = index => ({ text: mainText.slice(0, pendingStart < 0 ? index : pendingStart), showSpinner: true });
            for (const match of mainText.matchAll(uiTokens)) {
                const token = match[0];
                const fence = token.startsWith('```') ? '```' : token.startsWith('~~~') ? '~~~' : '';
                if (fence) {
                    const isHtml = /^(?:```|~~~)[ \t]*(?:html|xml|vue)\b|^(?:```|~~~)[^\n]*\n\s*<(?:!doctype|html|head|body|div|span|style|script|table|img)\b/i.test(token);
                    if (isHtml && (token.length < 6 || !token.endsWith(fence))) return waitForUi(match.index);
                    continue;
                }
                if (token.startsWith('`') || token.startsWith('<!--')) continue;
                if (match[1]) {
                    if (!/<\/(?:script|style)\s*>$/i.test(token)) return waitForUi(match.index);
                    continue;
                }
                if (/^<!doctype\b/i.test(token)) {
                    if (pendingStart < 0) pendingStart = match.index;
                    continue;
                }
                const tag = token.match(/^<(\/?)(html|div|script|style)(?=[\s/>]|$)/i);
                if (!tag) continue;
                if (match[2] !== '>') return waitForUi(match.index);
                const name = tag[2].toLowerCase();
                if (!tag[1]) {
                    if (pendingStart < 0) pendingStart = match.index;
                    openTags.push(name);
                } else {
                    const openIndex = openTags.lastIndexOf(name);
                    if (openIndex < 0) continue;
                    openTags.splice(openIndex);
                    if (!openTags.length) pendingStart = -1;
                }
            }
            return pendingStart < 0 ? { text: mainText, showSpinner: false } : waitForUi(pendingStart);
        };
        __s.processMainContent = processMainContent;
        const switchProfile = (id) => {
            const profile = __s.userProfiles.value.find(p => p.uuid === id);
            if (profile) {
                __s.activeProfileId.value = id;
                Object.assign(__s.user, { preferences: '', ...JSON.parse(JSON.stringify(profile)) });
                __s.saveData();
                __s.showToast(`已切换为人设: ${__s.user.name}`, 'success');
            }
        };
        __s.switchProfile = switchProfile;
        const createNewProfile = () => {
            const newProfile = {
                uuid: generateUUID(),
                name: '新人设',
                description: '',
                preferences: '',
                avatar: null,
                person: 'second'
            };
            __s.userProfiles.value.push(newProfile);
            switchProfile(newProfile.uuid);
        };
        __s.createNewProfile = createNewProfile;
        const deleteProfile = (id) => {
            if (__s.userProfiles.value.length <= 1) {
                __s.showToast('无法删除唯一的人设', 'error');
                return;
            }

            __s.confirmAction('确定要删除此人设吗？此操作不可逆。', () => {
                const index = __s.userProfiles.value.findIndex(p => p.uuid === id);
                if (index !== -1) {
                    __s.userProfiles.value.splice(index, 1);
                    if (__s.activeProfileId.value === id) {
                        switchProfile(__s.userProfiles.value[0].uuid);
                    } else {
                        __s.saveData();
                    }
                    __s.showToast('人设已删除', 'success');
                }
            });
        };
        __s.deleteProfile = deleteProfile;
        const activeKeepFloors = computed(() => __s.memorySettings.summaryKeepFloors);
        __s.activeKeepFloors = activeKeepFloors;
        const keepFloorsSliderMin = __s.SUMMARY_KEEP_FLOORS_MIN;
        __s.keepFloorsSliderMin = keepFloorsSliderMin;
        const keepFloorsSliderMax = __s.SUMMARY_KEEP_FLOORS_MAX;
        __s.keepFloorsSliderMax = keepFloorsSliderMax;
        const keepFloorsSlider = computed({
            get: () => __s.memorySettings.summaryKeepFloors,
            set: value => {
                __s.memorySettings.summaryKeepFloors = __s.normalizeKeepFloors(
                    value, __s.SUMMARY_KEEP_FLOORS_MIN, __s.SUMMARY_KEEP_FLOORS_MAX, __s.SUMMARY_KEEP_FLOORS_DEFAULT
                );
            }
        });
        __s.keepFloorsSlider = keepFloorsSlider;
        const classicMemoryPageCount = computed(() => Math.max(1, Math.ceil(__s.classicMemories.value.length / __s.LIST_PAGE_SIZE)));
        __s.classicMemoryPageCount = classicMemoryPageCount;
        watch(classicMemoryPageCount, pageCount => { __s.classicMemoryPage.value = Math.min(__s.classicMemoryPage.value, pageCount); });
        watch(() => __s.currentCharacter.value?.uuid, () => { __s.classicMemoryPage.value = 1; });
        const displayedClassicMemories = computed(() => {
            const messagesById = new Map(
                __s.chatHistory.value.filter(message => message?.id).map(message => [message.id, message])
            );
            const currentTurnsByAssistantId = new Map();
            const snapshot = __s.buildConversationTurnSnapshot(__s.chatHistory.value, { includeSystem: false });
            snapshot.turns.forEach(turnInfo => {
                __s.getClassicTurnSourceIds(turnInfo, 'assistant').forEach(id => currentTurnsByAssistantId.set(id, turnInfo.turn));
            });
            const getLiveLength = (ids, fallback) => {
                const texts = (ids || [])
                    .map(id => messagesById.get(id))
                    .filter(Boolean)
                    .map(message => parseCot(message.content || '').main);
                return texts.length
                    ? texts.reduce((total, text) => total + text.length, 0)
                    : parseCot(fallback || '').main.length;
            };
            const sortedMemories = [...__s.classicMemories.value]
                .map(memory => {
                    const sourceMemories = __s.isSecondaryClassicMemory(memory)
                        ? __s.getSecondaryClassicSourceMemories(memory)
                        : [];
                    const userFallback = memory.sourceUserText
                        || sourceMemories.map(item => item.sourceUserText || '').filter(Boolean).join('\n\n');
                    const assistantFallback = memory.sourceAssistantText
                        || sourceMemories.map(item => item.sourceAssistantText || '').filter(Boolean).join('\n\n');
                    const userChars = getLiveLength(memory.sourceUserIds, userFallback);
                    const assistantChars = getLiveLength(memory.sourceAssistantIds, assistantFallback);
                    const summaryChars = parseCot(memory.summary || '').main.length;
                    const liveTurns = (memory.sourceAssistantIds || [])
                        .map(id => currentTurnsByAssistantId.get(id))
                        .filter(Number.isFinite);
                    const storedRange = __s.getClassicMemoryTurnRange(memory);
                    const displayTurnStart = __s.isSecondaryClassicMemory(memory)
                        ? (liveTurns.length ? Math.min(...liveTurns) : storedRange.start)
                        : (liveTurns[0] || Number(memory.turn) || 1);
                    const displayTurnEnd = __s.isSecondaryClassicMemory(memory)
                        ? (liveTurns.length ? Math.max(...liveTurns) : storedRange.end)
                        : displayTurnStart;
                    return {
                        ...memory,
                        displayTurn: displayTurnEnd,
                        displayTurnStart,
                        displayTurnEnd,
                        originalChars: userChars + assistantChars,
                        compressedChars: __s.isSecondaryClassicMemory(memory)
                            ? __s.getClassicSecondaryMemoryMarker(memory).length + summaryChars
                            : userChars + summaryChars
                    };
                })
                .sort((a, b) => (b.displayTurnEnd || 0) - (a.displayTurnEnd || 0));
            const start = (__s.classicMemoryPage.value - 1) * __s.LIST_PAGE_SIZE;
            return sortedMemories.slice(start, start + __s.LIST_PAGE_SIZE);
        });
        __s.displayedClassicMemories = displayedClassicMemories;
        const memoryStats = computed(() => ({ activeTotal: __s.classicMemories.value.length }));
        __s.memoryStats = memoryStats;
        const applyPersonPresetSelection = (person) => {
            __s.user.person = person === 'third' ? 'third' : 'second';
            const secondPersonPreset = __s.presets.value.find(preset => preset.name === '第二人称');
            const thirdPersonPreset = __s.presets.value.find(preset => preset.name === '第三人称');
            if (secondPersonPreset) secondPersonPreset.enabled = __s.user.person === 'second';
            if (thirdPersonPreset) thirdPersonPreset.enabled = __s.user.person === 'third';
        };
        __s.applyPersonPresetSelection = applyPersonPresetSelection;
    };
})();
