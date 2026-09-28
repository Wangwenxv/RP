/**
 * RP-Hub 应用模块 09 · 对话展示窗口、滚动锚点、剧情分支视图与统计
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 2725–3119 行。
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
    window.RPHubAppSections.chatDisplay = function (__s) {
        const getCharacterFavoriteTime = (char) => {
            const time = Number(char?.favoriteAt || 0);
            return Number.isFinite(time) && time > 0 ? time : 0;
        };
        __s.getCharacterFavoriteTime = getCharacterFavoriteTime;
        const isCharacterFavorite = (char) => getCharacterFavoriteTime(char) > 0;
        __s.isCharacterFavorite = isCharacterFavorite;
        const filteredCharacters = computed(() => {
            let result = __s.characters.value.map((char, originalIndex) => ({ char, originalIndex }));

            if (__s.characterSearchQuery.value) {
                const query = __s.characterSearchQuery.value.toLowerCase();
                result = result.filter(({ char }) =>
                    String(char.name || '').toLowerCase().includes(query) ||
                    String(char.description || '').toLowerCase().includes(query)
                );
            }

            // Favorites stay on top, with the most recently favorited first.
            result.sort((a, b) => {
                const favoriteDiff = getCharacterFavoriteTime(b.char) - getCharacterFavoriteTime(a.char);
                if (favoriteDiff !== 0) return favoriteDiff;
                const timeA = a.char.createdAt || 0;
                const timeB = b.char.createdAt || 0;
                if (timeB !== timeA) return timeB - timeA;
                // Fallback to UUID if timestamps are missing or identical
                return (b.char.uuid || '').localeCompare(a.char.uuid || '');
            });

            return result;
        });
        __s.filteredCharacters = filteredCharacters;
        const displayedCharacters = computed(() => {
            return filteredCharacters.value.slice(0, __s.characterDisplayLimit.value).map(({ char, originalIndex }) => ({
                originalIndex,
                uuid: char.uuid,
                name: char.name,
                avatar: char.avatar,
                favoriteAt: char.favoriteAt,
                worldInfoCount: getCharacterWICount(char),
                regexCount: getCharacterRegexCount(char)
            }));
        });
        __s.displayedCharacters = displayedCharacters;
        const loadMoreCharacters = () => {
            __s.characterDisplayLimit.value += 8;
        };
        __s.loadMoreCharacters = loadMoreCharacters;
        const resetChatRenderWindow = () => {
            __s.chatRenderLimit.value = __s.CHAT_RENDER_INITIAL_LIMIT;
            __s.isChatTopUnlockArmed = true;
        };
        __s.resetChatRenderWindow = resetChatRenderWindow;
        const hiddenChatMessageCount = computed(() => Math.max(0, __s.chatHistory.value.length - __s.chatRenderLimit.value));
        __s.hiddenChatMessageCount = hiddenChatMessageCount;
        const displayedChatMessages = computed(() => {
            const startIndex = Math.max(0, __s.chatHistory.value.length - __s.chatRenderLimit.value);
            return __s.chatHistory.value.slice(startIndex).map((msg, offset) => ({
                msg,
                index: startIndex + offset
            }));
        });
        __s.displayedChatMessages = displayedChatMessages;
        const getChatScrollAnchor = () => {
            const container = __s.chatContainer.value;
            const elements = (__s.messageElements.value || [])
                .filter(el => el && el.dataset && el.dataset.chatIndex)
                .sort((a, b) => Number(a.dataset.chatIndex) - Number(b.dataset.chatIndex));
            if (!container || elements.length === 0) return null;

            const containerTop = container.getBoundingClientRect().top;
            const anchorElement = elements.find(el => el.getBoundingClientRect().bottom >= containerTop + 8) || elements[0];

            return {
                index: anchorElement.dataset.chatIndex,
                topOffset: anchorElement.getBoundingClientRect().top - containerTop
            };
        };
        __s.getChatScrollAnchor = getChatScrollAnchor;
        const restoreChatScrollAnchor = async (anchor, scrollSnapshot = null) => {
            const container = __s.chatContainer.value;
            if (!container) return;

            await nextTick();

            const restoreByHeight = () => {
                if (!scrollSnapshot) return;
                container.scrollTop = scrollSnapshot.scrollTop + (container.scrollHeight - scrollSnapshot.scrollHeight);
            };

            if (!anchor) {
                restoreByHeight();
                return;
            }

            const anchorElement = container.querySelector(`[data-chat-index="${anchor.index}"]`);
            if (!anchorElement) {
                restoreByHeight();
                return;
            }

            const containerTop = container.getBoundingClientRect().top;
            const newTopOffset = anchorElement.getBoundingClientRect().top - containerTop;
            container.scrollTop += newTopOffset - anchor.topOffset;
        };
        __s.restoreChatScrollAnchor = restoreChatScrollAnchor;
        const loadEarlierChatMessages = async (batchSize = __s.CHAT_RENDER_BATCH_SIZE) => {
            if (hiddenChatMessageCount.value <= 0 || __s.isLoadingEarlierChatMessages) return;
            __s.isLoadingEarlierChatMessages = true;
            const anchor = getChatScrollAnchor();
            const container = __s.chatContainer.value;
            const scrollSnapshot = container ? {
                scrollTop: container.scrollTop,
                scrollHeight: container.scrollHeight
            } : null;
            const previousStartIndex = Math.max(0, __s.chatHistory.value.length - __s.chatRenderLimit.value);
            const nextRenderLimit = Math.min(
                __s.chatHistory.value.length,
                __s.chatRenderLimit.value + batchSize
            );
            const nextStartIndex = Math.max(0, __s.chatHistory.value.length - nextRenderLimit);

            for (let i = nextStartIndex; i < previousStartIndex; i++) {
                const message = __s.chatHistory.value[i];
                if (!message || !['user', 'assistant'].includes(message.role)) continue;
                message.skipReveal = true;
                message.shouldAnimate = false;
            }

            __s.chatRenderLimit.value = nextRenderLimit;

            await restoreChatScrollAnchor(anchor, scrollSnapshot);
            __s.isLoadingEarlierChatMessages = false;
        };
        __s.loadEarlierChatMessages = loadEarlierChatMessages;
        const handleChatScroll = () => {
            const container = __s.chatContainer.value;
            if (!container || hiddenChatMessageCount.value <= 0) return;
            if (container.scrollTop > 160) {
                __s.isChatTopUnlockArmed = true;
                return;
            }
            if (__s.isChatTopUnlockArmed && container.scrollTop <= 80) {
                __s.isChatTopUnlockArmed = false;
                loadEarlierChatMessages();
            }
        };
        __s.handleChatScroll = handleChatScroll;

        // Reset limit when search query changes
        watch(__s.characterSearchQuery, () => {
            __s.characterDisplayLimit.value = 8;
        });
        const conversationBodyLength = computed(() => getConversationBodyLength(__s.chatHistory.value));
        __s.conversationBodyLength = conversationBodyLength;
        const chatRoundStats = computed(() => ({
            floors: __s.getPostprocessedChatMessages(__s.chatHistory.value, { includeSystem: false }).length
        }));
        __s.chatRoundStats = chatRoundStats;
        const currentStoryBranch = computed(() => (
            __s.storyBranches.value.find(branch => branch.id === __s.activeStoryBranchId.value) || null
        ));
        __s.currentStoryBranch = currentStoryBranch;
        const storyRouteMap = computed(() => createStoryRouteMap({
            branches: __s.storyBranches.value,
            activeBranchId: __s.activeStoryBranchId.value,
            selectedBranchId: __s.selectedStoryBranchId.value,
            activeWordCount: conversationBodyLength.value,
            activeFloorCount: chatRoundStats.value.floors
        }));
        __s.storyRouteMap = storyRouteMap;
        const selectedStoryRouteNode = computed(() => (
            storyRouteMap.value.nodes.find(node => node.id === __s.selectedStoryBranchId.value)
            || null
        ));
        __s.selectedStoryRouteNode = selectedStoryRouteNode;
        const selectedStoryRouteCanDelete = computed(() => (
            Boolean(selectedStoryRouteNode.value && selectedStoryRouteNode.value.id !== STORY_BRANCH_MAIN_ID)
        ));
        __s.selectedStoryRouteCanDelete = selectedStoryRouteCanDelete;
        const startStoryRouteDrag = (event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            const container = event.currentTarget;
            __s.storyRouteDragState = {
                container,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                scrollLeft: container.scrollLeft,
                scrollTop: container.scrollTop,
                moved: false
            };
            if (!event.target?.closest?.('.story-route-node')) {
                container.setPointerCapture?.(event.pointerId);
            }
        };
        __s.startStoryRouteDrag = startStoryRouteDrag;
        const moveStoryRouteDrag = (event) => {
            const state = __s.storyRouteDragState;
            if (!state || state.pointerId !== event.pointerId) return;
            const container = state.container;
            const deltaX = event.clientX - state.startX;
            const deltaY = event.clientY - state.startY;
            if (!state.moved) {
                if (Math.hypot(deltaX, deltaY) < 4) return;
                state.moved = true;
                __s.storyRouteMapDragging.value = true;
                container.setPointerCapture?.(event.pointerId);
            }
            container.scrollLeft = state.scrollLeft - deltaX;
            container.scrollTop = state.scrollTop - deltaY;
            event.preventDefault();
        };
        __s.moveStoryRouteDrag = moveStoryRouteDrag;
        const endStoryRouteDrag = (event) => {
            const state = __s.storyRouteDragState;
            if (!state || state.pointerId !== event.pointerId) return;
            __s.storyRouteDragState = null;
            __s.storyRouteMapDragging.value = false;
            if (state.container.hasPointerCapture?.(event.pointerId)) {
                state.container.releasePointerCapture(event.pointerId);
            }
            if (state.moved) {
                __s.suppressStoryRouteNodeClick = true;
                setTimeout(() => { __s.suppressStoryRouteNodeClick = false; }, 0);
            }
        };
        __s.endStoryRouteDrag = endStoryRouteDrag;
        const handleStoryRouteNodeClick = (branchId) => {
            if (__s.suppressStoryRouteNodeClick) return;
            __s.selectStoryBranchNode(branchId);
        };
        __s.handleStoryRouteNodeClick = handleStoryRouteNodeClick;
        const isSecondaryClassicMemory = (memory) => memory?.secondaryCompressed === true;
        __s.isSecondaryClassicMemory = isSecondaryClassicMemory;
        const getClassicMemoryTurnRange = (memory) => {
            const fallbackTurn = Math.max(1, Number(memory?.turn) || 1);
            const start = Math.max(1, Number(memory?.turnStart) || fallbackTurn);
            const end = Math.max(start, Number(memory?.turnEnd) || fallbackTurn);
            return { start, end };
        };
        __s.getClassicMemoryTurnRange = getClassicMemoryTurnRange;
        const getClassicSecondaryMemoryMarker = (memory) => {
            const range = getClassicMemoryTurnRange(memory);
            return `总结记忆 第 ${range.start}-${range.end} 轮`;
        };
        __s.getClassicSecondaryMemoryMarker = getClassicSecondaryMemoryMarker;
        const buildClassicMemoryLookup = () => {
            const byAssistantId = new Map();
            const byTurn = new Map();
            const secondaryByAssistantId = new Map();
            const secondaryRanges = [];
            __s.classicMemories.value.filter(memory => memory.enabled !== false).forEach(memory => {
                if (isSecondaryClassicMemory(memory)) {
                    (memory.sourceAssistantIds || []).forEach(id => secondaryByAssistantId.set(id, memory));
                    secondaryRanges.push({
                        memory, ...getClassicMemoryTurnRange(memory),
                        turns: memory.sourceMemories?.length
                            ? new Set(memory.sourceMemories.map(source => Number(source.turn)))
                            : null
                    });
                    return;
                }
                (memory.sourceAssistantIds || []).forEach(id => byAssistantId.set(id, memory));
                if (memory.turn > 0 && !byTurn.has(memory.turn)) byTurn.set(memory.turn, memory);
            });
            return { byAssistantId, byTurn, secondaryByAssistantId, secondaryRanges };
        };
        __s.buildClassicMemoryLookup = buildClassicMemoryLookup;
        const findClassicMemoryForTurn = (turnInfo, lookup) => {
            const sourceIds = (turnInfo.assistant?._sourceIndexes || [])
                .map(index => __s.chatHistory.value[index]?.id)
                .filter(Boolean);
            return sourceIds.map(id => lookup.byAssistantId.get(id)).find(Boolean)
                || lookup.byTurn.get(turnInfo.turn);
        };
        __s.findClassicMemoryForTurn = findClassicMemoryForTurn;
        const findSecondaryClassicMemoryForTurn = (turnInfo, lookup) => {
            const sourceIds = (turnInfo.assistant?._sourceIndexes || [])
                .map(index => __s.chatHistory.value[index]?.id)
                .filter(Boolean);
            return sourceIds.map(id => lookup.secondaryByAssistantId.get(id)).find(Boolean)
                || lookup.secondaryRanges.find(range => range.turns
                    ? range.turns.has(turnInfo.turn)
                    : turnInfo.turn >= range.start && turnInfo.turn <= range.end)?.memory;
        };
        __s.findSecondaryClassicMemoryForTurn = findSecondaryClassicMemoryForTurn;
        const summaryCompressedBodyLength = computed(() => {
            let predictedLength = conversationBodyLength.value;
            if (!__s.memorySettings.enabled
                || __s.classicMemories.value.length === 0) return predictedLength;

            const messages = __s.getPostprocessedChatMessages(__s.chatHistory.value, { includeSystem: false });
            const candidateCount = Math.max(0, messages.length - __s.memorySettings.summaryKeepFloors);
            if (candidateCount === 0) return predictedLength;

            const lookup = buildClassicMemoryLookup();
            const snapshot = __s.buildConversationTurnSnapshot(messages, { alreadyPostprocessed: true });
            const eligibleTurns = snapshot.turns.filter(turnInfo => turnInfo.messageIndexes[1] < candidateCount);
            const getRoleLength = (turnInfo, role) => {
                const sourceMessages = (turnInfo[role]?._sourceIndexes || [])
                    .map(index => __s.chatHistory.value[index])
                    .filter(message => message?.role === role);
                const originalMessages = sourceMessages.length > 0 ? sourceMessages : [turnInfo[role]];
                return originalMessages.reduce(
                    (total, message) => total + parseCot(message?.content || '').main.length,
                    0
                );
            };
            const secondaryGroups = new Map();
            eligibleTurns.forEach(turnInfo => {
                const memory = findSecondaryClassicMemoryForTurn(turnInfo, lookup);
                if (!memory) return;
                if (!secondaryGroups.has(memory.id)) secondaryGroups.set(memory.id, { memory, turns: [] });
                secondaryGroups.get(memory.id).turns.push(turnInfo);
            });
            const secondaryTurnSet = new Set();
            secondaryGroups.forEach(({ memory, turns }) => {
                const originalLength = turns.reduce(
                    (total, turnInfo) => total + getRoleLength(turnInfo, 'user') + getRoleLength(turnInfo, 'assistant'),
                    0
                );
                predictedLength += getClassicSecondaryMemoryMarker(memory).length
                    + parseCot(memory.summary || '').main.length
                    - originalLength;
                turns.forEach(turnInfo => secondaryTurnSet.add(turnInfo.turn));
            });

            eligibleTurns.forEach(turnInfo => {
                if (secondaryTurnSet.has(turnInfo.turn)) return;
                const memory = findClassicMemoryForTurn(turnInfo, lookup);
                if (!memory?.summary) return;
                const originalLength = getRoleLength(turnInfo, 'assistant');
                predictedLength += parseCot(memory.summary).main.length - originalLength;
            });
            return Math.max(0, predictedLength);
        });
        __s.summaryCompressedBodyLength = summaryCompressedBodyLength;
        const summaryCompressionRate = computed(() => {
            const floorCount = __s.getPostprocessedChatMessages(__s.chatHistory.value, { includeSystem: false }).length;
            if (floorCount <= __s.memorySettings.summaryKeepFloors) return null;
            return conversationBodyLength.value > 0
                ? Math.max(0, Math.round((1 - summaryCompressedBodyLength.value / conversationBodyLength.value) * 100))
                : 0;
        });
        __s.summaryCompressionRate = summaryCompressionRate;
        const modelTags = computed(() => {
            const counts = { all: __s.availableModels.value.length, other: 0 };
            const tags = new Set();

            __s.availableModels.value.forEach(m => {
                const id = m.id.toLowerCase();
                let found = false;
                for (const family of popularModelFamilies) {
                    if (id.includes(family)) {
                        tags.add(family);
                        counts[family] = (counts[family] || 0) + 1;
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    counts.other++;
                }
            });
            const result = [{ name: 'all', count: counts.all }];
            Array.from(tags).sort().forEach(t => result.push({ name: t, count: counts[t] }));
            if (counts.other > 0) result.push({ name: 'other', count: counts.other });
            return result;
        });
        __s.modelTags = modelTags;
        const filteredModels = computed(() => {
            let result = __s.availableModels.value;

            if (__s.activeModelTag.value && __s.activeModelTag.value !== 'all') {
                if (__s.activeModelTag.value === 'other') {
                    result = result.filter(m => {
                        const id = m.id.toLowerCase();
                        return !popularModelFamilies.some(family => id.includes(family));
                    });
                } else {
                    result = result.filter(m => m.id.toLowerCase().includes(__s.activeModelTag.value));
                }
            }

            const searchQuery = __s.modelSelectionTarget.value === 'memoryEmbeddingModel' ? 'embedding' : __s.modelSearchQuery.value;
            if (searchQuery) {
                const query = searchQuery.toLowerCase();
                result = result.filter(m => m.id.toLowerCase().includes(query));
            }

            return result.sort((a, b) => a.id.localeCompare(b.id));
        });
        __s.filteredModels = filteredModels;
        const getCharacterWICount = (char) => {
            if (!char.worldInfo) return 0;
            return char.worldInfo.reduce((count, entry) => (
                count + (systemWorldInfoNames.includes(entry.comment) ? 0 : 1)
            ), 0);
        };
        __s.getCharacterWICount = getCharacterWICount;
        const getCharacterRegexCount = (char) => {
            if (!char.regexScripts) return 0;
            return char.regexScripts.reduce((count, script) => (
                count + (systemRegexNames.includes(script.name || script.scriptName) ? 0 : 1)
            ), 0);
        };
        __s.getCharacterRegexCount = getCharacterRegexCount;
    };
})();
