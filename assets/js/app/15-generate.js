/**
 * RP-Hub 应用模块 15 · 主生成管线 generateResponse（流式、工具调用、思考链）
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 4305–4953 行。
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
    window.RPHubAppSections.generate = function (__s) {
        const generateResponse = async (startTime = null, options = {}) => {
            const reuseGeneratingState = options.reuseGeneratingState === true;
            if (__s.isGenerating.value && !reuseGeneratingState) return;
            const activeToolDepth = Number(options.activeToolDepth) || 0;
            const continueAssistantMessageId = options.continueAssistantMessageId || null;
            const continuationToolCallId = options.continuationToolCallId || null;
            const requestModel = __s.settings.model;
            const requestTools = activeToolDepth < ACTIVE_TOOL_MAX_AUTO_CONTINUE ? __s.getEnabledActiveTools() : [];

            if (!__s.currentCharacter.value) {
                __s.showToast('请先选择一个角色', 'error');
                return;
            }

            const continuationTargetMessage = continueAssistantMessageId
                ? __s.chatHistory.value.find(msg => msg && msg.role === 'assistant' && msg.id === continueAssistantMessageId) || null
                : null;
            if (!continuationTargetMessage && activeToolDepth === 0) {
                __s.resetActiveToolResultContext();
            }

            __s.isGenerating.value = true;
            // 工具续写时内容会回填到旧气泡里，这里先占住“已在接收”的状态，
            // 避免底部全局 typing 占位气泡冒出来。
            __s.isReceiving.value = !!continuationTargetMessage;
            __s.isThinking.value = false;
            const isToolContinuation = !!(continuationTargetMessage && continuationToolCallId);
            __s.activeToolContinuationMessageId.value = isToolContinuation ? continuationTargetMessage.id : null;
            __s.activeToolContinuationToolCallId.value = isToolContinuation ? continuationToolCallId : null;
            __s.activeToolContinuationHasResponse.value = false;
            __s.abortController.value = new AbortController();
            let generationStartTime = startTime || Date.now();

            // Start Timer
            const startTimer = () => {
                if (__s.waitTimer) clearInterval(__s.waitTimer);
                __s.currentWaitTime.value = '0.0';
                __s.waitTimer = setInterval(() => {
                    const now = Date.now();
                    __s.currentWaitTime.value = ((now - generationStartTime) / 1000).toFixed(1);
                }, 100);
            };
            startTimer(); // Start timer immediately upon request initiation


            // --- Advanced World Info Processing ---

            // 中途检索的 assistant 已由原生调用消息携带，不能再作为普通聊天重复注入。
            const postprocessedChatHistory = __s.getPostprocessedChatMessages(__s.chatHistory.value.map(message => (
                message === continuationTargetMessage ? null : message
            )), { includeSystem: false });
            const {
                entries: budgetedEntries,
                groups: wiGroups,
                triggerMap: triggeredEntries
            } = resolveWorldInfoEntries(__s.worldInfo.value, postprocessedChatHistory, __s.worldInfoSettings);

            // Construct Prompt Parts
            const enabledPresets = __s.presets.value
                .map(__s.normalizePreset)
                .filter(p => __s.isPresetEnabled(p) && p.content.trim());
            const noncePreset = enabledPresets.find(p => p.role === 'system');
            if (/gemini/i.test(requestModel) && noncePreset) {
                let nonce;
                do {
                    nonce = Math.random().toString(36).slice(2, 8 + Math.floor(Math.random() * 3));
                } while (!/^(?=.*[a-z])(?=.*\d)[a-z\d]{6,8}$/.test(nonce) || __s.usedGeminiPromptNonces.has(nonce));
                __s.usedGeminiPromptNonces.add(nonce);
                noncePreset.content = `${nonce}\n${noncePreset.content}`;
            }
            const writingStylePresets = enabledPresets.filter(p => p.name === BUILTIN_PRESETS.writingStyle.name);
            const cotPresets = enabledPresets.filter(p => p.name === 'COT');
            const systemPresets = enabledPresets.filter(p => p.name !== 'COT'
                && (p.role === 'system' || p.name === BUILTIN_PRESETS.writingStyle.name));
            const messagePresets = enabledPresets.filter(p => p.name !== 'COT'
                && p.name !== BUILTIN_PRESETS.writingStyle.name
                && (p.role === 'user' || p.role === 'assistant'));
            const systemPresetPrompt = systemPresets
                .filter(p => p.name === '破限')
                .map(p => p.content)
                .join('\n\n');
            const otherPresets = systemPresets.filter(p => p.name !== '破限');

            const charPrompt = __s.getCurrentCharacterPrompt();
            const mesExample = __s.currentCharacter.value.mes_example;

            let userPrompt = __s.buildUserInfoPrompt();

            // Helper to join content with comments
            const joinContent = (entries) => entries.map(e => `[${e.comment || 'Entry'}]\n${e.content}`).join('\n\n');
            // Build System Prompt
            let systemPromptParts = [];

            // 1. Presets (只有设定环境的破限预设保留在 system 中)
            if (systemPresetPrompt) systemPromptParts.push(systemPresetPrompt);

            // 2. System Top WI
            if (wiGroups.system_top.length > 0) systemPromptParts.push(joinContent(wiGroups.system_top));

            // 3. Global Notes
            if (wiGroups.global_note.length > 0) systemPromptParts.push(joinContent(wiGroups.global_note));

            // 4. Other Presets (辅助约束 - 提前于角色设定)
            if (otherPresets.length > 0) {
                systemPromptParts.push(`[System Presets]\n${otherPresets.map(p => p.content).join('\n\n---\n\n')}`);
            }

            // 5. Character pre-dialogue context (user side)
            const characterPreludeParts = [];
            if (wiGroups.before_char.length > 0) {
                characterPreludeParts.push(joinContent(wiGroups.before_char));
            }
            let charDefinitionParts = [`[Character]`, charPrompt];
            if (mesExample && mesExample.trim()) {
                charDefinitionParts.push(mesExample);
            }
            characterPreludeParts.push(charDefinitionParts.join('\n\n'));
            if (wiGroups.after_char.length > 0) {
                characterPreludeParts.push(joinContent(wiGroups.after_char));
            }
            const characterPreludePrompt = characterPreludeParts.join('\n\n');

            // 6. User Info (Moved to end)
            systemPromptParts.push(userPrompt);

            const activeToolPrompt = __s.buildActiveToolSystemPrompt(requestTools);
            if (activeToolPrompt) systemPromptParts.push(activeToolPrompt);
            else if (activeToolDepth > 0) systemPromptParts.push('本轮工具调用已结束，请依据已有结果完成回复，不再调用工具；无法确认的信息明确说明。');

            const uiTemplateContextPrompt = __s.buildUiTemplateContextSystemPrompt();
            if (uiTemplateContextPrompt) systemPromptParts.push(uiTemplateContextPrompt);

            const mainModelUiTemplatePrompt = __s.buildMainModelUiTemplateUpdatePrompt();
            if (mainModelUiTemplatePrompt) systemPromptParts.push(mainModelUiTemplatePrompt);

            if (cotPresets.length > 0) {
                systemPromptParts.push(cotPresets.map(p => p.content).join('\n\n---\n\n'));
            }

            const systemPrompt = systemPromptParts.join('\n\n');
            const systemWorldInfo = [
                ...wiGroups.system_top,
                ...wiGroups.global_note
            ];

            // Base Messages
            let messages = [
                {
                    role: 'system',
                    content: systemPrompt,
                    _worldInfoEntries: systemWorldInfo
                }
            ];

            let safeTargetLimit = 1;
            messagePresets.forEach(preset => {
                messages.push({
                    role: preset.role,
                    content: preset.content
                });
            });
            safeTargetLimit += messagePresets.length;

            if (characterPreludePrompt) {
                messages.push({
                    role: 'user',
                    content: characterPreludePrompt,
                    _worldInfoEntries: [
                        ...wiGroups.before_char,
                        ...wiGroups.after_char
                    ]
                });
                safeTargetLimit += 1;
            }

            // 确保开场白存在 (Double check for First Message)
            // 如果聊天记录为空，或者第一条不是开场白，且角色有开场白，则手动添加
            // 注意：通常 chatHistory 会包含开场白，这里是为了响应用户反馈的强制保险
            const hasFirstMesInHistory = __s.chatHistory.value.length > 0 &&
                __s.chatHistory.value[0].role === 'assistant' &&
                __s.chatHistory.value[0].content === __s.currentCharacter.value.first_mes;

            const useThinkingTag = __s.usesThinkingCotTag(requestModel);
            const retainedThinkingTag = useThinkingTag ? 'thinking' : 'cot';
            const openingText = String(__s.currentCharacter.value.first_mes || '').trim();
            const openingSourceMessage = openingText
                ? __s.chatHistory.value.find(source => source?.role === 'assistant'
                    && parseCot(source.content || '').main.trim() === openingText)
                : null;
            const openingThinking = cotPresets.length > 0
                ? __s.wrapAnalysis(retainedThinkingTag, BUILTIN_PROMPTS.buildOpeningAnalysisContent({
                    memoryEnabled: __s.memorySettings.enabled,
                    uiTemplateEnabled: __s.isUiTemplateAnalysisEnabled(),
                    characterName: __s.currentCharacter.value.name
                }))
                : '';

            // 如果当前历史记录的第一条是“总结”消息，则认为开场白已被总结包含，不再强制补录开场白
            if (!hasFirstMesInHistory && __s.currentCharacter.value.first_mes) {
                messages.push({
                    role: 'assistant',
                    name: __s.currentCharacter.value.name,
                    content: `${openingThinking}${__s.currentCharacter.value.first_mes}`
                });
            }

            // 记忆压缩：一次总结替换旧 AI 消息；二次总结合并每五轮中有效的记忆。
            const recentThinkingByMessage = new Map();
            if (cotPresets.length > 0) {
                for (let index = __s.chatHistory.value.length - 1; index >= 0 && recentThinkingByMessage.size < 2; index--) {
                    const source = __s.chatHistory.value[index];
                    if (source?.role !== 'assistant' || source === openingSourceMessage || source === continuationTargetMessage) continue;
                    const thinking = __s.getMessageThinkingText(source, useThinkingTag);
                    if (thinking) recentThinkingByMessage.set(source, thinking);
                }
            }
            let chatHistoryForContext = postprocessedChatHistory.map((message, index) => ({
                ...message,
                _contextFloor: index + 1
            }));
            const suppressedUiTemplateCorrectionIndexes = new Set();

            // 前情提要（上下文压缩）：被覆盖的老轮次从上下文剔除——它们的原文和对应的
            // per-turn 记忆一起消失，改由提要代表（避免「弄没」也避免「多一份」）。
            const recapCoverage = __s.recapCoverageRange ? __s.recapCoverageRange() : null;
            if (recapCoverage && recapCoverage.rpMaxIndex >= 0) {
                chatHistoryForContext = chatHistoryForContext.filter((message) =>
                    !(Array.isArray(message._sourceIndexes)
                        && message._sourceIndexes.length > 0
                        && message._sourceIndexes.every(index => index <= recapCoverage.rpMaxIndex)));
            }

            if (__s.memorySettings.enabled
                && __s.classicMemories.value.length > 0) {
                const candidateCount = Math.max(0, chatHistoryForContext.length - __s.memorySettings.summaryKeepFloors);
                if (candidateCount > 0) {
                    const lookup = __s.buildClassicMemoryLookup();
                    const contextSnapshot = __s.buildConversationTurnSnapshot(chatHistoryForContext, { alreadyPostprocessed: true });
                    const secondaryGroups = new Map();
                    contextSnapshot.turns.forEach(turnInfo => {
                        const assistantIndex = turnInfo.messageIndexes[1];
                        if (assistantIndex >= candidateCount) return;
                        const secondaryMemory = __s.findSecondaryClassicMemoryForTurn(turnInfo, lookup);
                        if (secondaryMemory) {
                            if (!secondaryGroups.has(secondaryMemory.id)) {
                                secondaryGroups.set(secondaryMemory.id, { memory: secondaryMemory, turns: [] });
                            }
                            secondaryGroups.get(secondaryMemory.id).turns.push(turnInfo);
                        }
                    });

                    const secondaryTurnSet = new Set();
                    const removableIndices = new Set();
                    secondaryGroups.forEach(({ memory, turns }) => {
                        const orderedTurns = [...turns].sort((a, b) => a.turn - b.turn);
                        const retainedIndexes = orderedTurns[orderedTurns.length - 1]?.messageIndexes || [];
                        const retainedUserIndex = retainedIndexes[0];
                        const retainedAssistantIndex = retainedIndexes[1];
                        if (!Number.isFinite(retainedUserIndex) || !Number.isFinite(retainedAssistantIndex)) return;
                        orderedTurns.forEach(turnInfo => {
                            secondaryTurnSet.add(turnInfo.turn);
                            turnInfo.messageIndexes.forEach(messageIndex => {
                                if (messageIndex !== retainedUserIndex && messageIndex !== retainedAssistantIndex) {
                                    removableIndices.add(messageIndex);
                                }
                            });
                        });
                        chatHistoryForContext[retainedUserIndex] = {
                            ...chatHistoryForContext[retainedUserIndex],
                            content: __s.getClassicSecondaryMemoryMarker(memory),
                            _sourceIndexes: [],
                            _preventContextMerge: true,
                            _suppressUiTemplateCorrection: true
                        };
                        chatHistoryForContext[retainedAssistantIndex] = {
                            ...chatHistoryForContext[retainedAssistantIndex],
                            content: memory.summary,
                            _sourceIndexes: []
                        };
                    });

                    contextSnapshot.turns.forEach(turnInfo => {
                        if (secondaryTurnSet.has(turnInfo.turn)) return;
                        const assistantIndex = turnInfo.messageIndexes[1];
                        if (assistantIndex >= candidateCount) return;
                        const memory = __s.findClassicMemoryForTurn(turnInfo, lookup);
                        if (!memory?.summary) return;
                        suppressedUiTemplateCorrectionIndexes.add(turnInfo.messageIndexes[0]);
                        chatHistoryForContext[turnInfo.messageIndexes[0]] = {
                            ...chatHistoryForContext[turnInfo.messageIndexes[0]],
                            _suppressUiTemplateCorrection: true
                        };
                        chatHistoryForContext[assistantIndex] = {
                            ...chatHistoryForContext[assistantIndex],
                            content: memory.summary,
                            _sourceIndexes: []
                        };
                    });
                    if (removableIndices.size > 0) {
                        chatHistoryForContext = chatHistoryForContext.filter((_, index) => !removableIndices.has(index));
                    }
                }
            }

            // 前情提要正文：作为一条独立背景消息插在聊天记录之前。
            const recapBlockText = __s.buildStoryRecapBlock ? __s.buildStoryRecapBlock() : '';
            if (recapBlockText) {
                chatHistoryForContext = [
                    { role: 'user', content: recapBlockText, _sourceIndexes: [], _preventContextMerge: true },
                    ...chatHistoryForContext
                ];
            }

            // 添加聊天记录
            messages = messages.concat(chatHistoryForContext
                .map((m, messageIndex) => {
                    const sourceIndexes = Array.isArray(m._sourceIndexes) ? m._sourceIndexes : [];
                    const suppressUiTemplateCorrection = m._suppressUiTemplateCorrection === true
                        || suppressedUiTemplateCorrectionIndexes.has(messageIndex);
                    const sourceMessages = sourceIndexes.length > 0
                        ? sourceIndexes.map(sourceIndex => __s.chatHistory.value[sourceIndex]).filter(source => source && source.role === m.role)
                        : [m];
                    const cleanSourceContent = (source) => {
                        // Remove internal thinking/COT from history before sending, then restore only the retained recent blocks.
                        const parsedData = parseCot(source.content || '');
                        let content = __s.stripUiTemplateContextInjection(parsedData.main);
                        if (!__s.settings.uiTemplateEnabled || !__s.settings.uiTemplateMainModelAnalysis) content = stripUiTemplateUpdateBlock(content);
                        content = __s.stripDisabledImageGenContext(__s.stripNextResponsePrompt(content));
                        const recentThinking = source.role === 'assistant' ? recentThinkingByMessage.get(source) : '';
                        if (recentThinking) content = `${__s.wrapAnalysis(retainedThinkingTag, recentThinking)}${content}`;
                        if (source === openingSourceMessage && openingThinking) content = `${openingThinking}${content}`;
                        if (source.role === 'user') content = __s.appendMessageImageDescriptions(source, content);
                        if (__s.settings.uiTemplateEnabled
                            && __s.settings.uiTemplateMainModelAnalysis
                            && source.role === 'user'
                            && !suppressUiTemplateCorrection
                            && source.uiTemplateCorrection) {
                            content = `${BUILTIN_PROMPTS.buildMainModelUiTemplateCorrectionPrompt({
                                failureSummary: source.uiTemplateCorrection.summary,
                                failureReason: source.uiTemplateCorrection.reason
                            })}\n\n${content.trimStart()}`;
                        }
                        return content.trim();
                    };
                    const cleanContent = sourceMessages
                        .map(cleanSourceContent)
                        .filter(Boolean)
                        .join('\n\n');

                    return {
                        role: m.role === 'user' ? 'user' : 'assistant',
                        name: m.name || (m.role === 'user' ? __s.user.name : __s.currentCharacter.value.name),
                        content: cleanContent,
                        _sourceIndexes: sourceIndexes,
                        _contextFloor: m._contextFloor,
                        _preventContextMerge: m._preventContextMerge === true
                    };
                })
                .filter(m => String(m.content || '').trim())
            );
            __s.appendPendingUiTemplateCorrection(messages);
            __s.appendNextResponsePrompt(messages, {
                cotEnabled: cotPresets.length > 0,
                useThinkingTag: __s.usesThinkingCotTag(requestModel),
                writingStylePrompt: writingStylePresets
                    .map(preset => preset.content
                        .replace(/^\s*<writing_style>\s*/i, '')
                        .replace(/\s*<\/writing_style>\s*$/i, ''))
                .concat(/deepseek/i.test(requestModel) ? '正文最少700字。' : [])
                    .join('\n\n')
            });

            // 世界书与其他提示处理完成后，再把召回附在最新用户消息末尾。
            messages = injectContextMessages({
                messages,
                worldInfoGroups: wiGroups,
                safeTargetLimit
            });
            if (activeToolDepth === 0) messages = __s.appendActiveToolReminderToLatestUserMessage(messages);
            messages = postprocessContextMessages(messages).map((message, index, array) => ({
                ...message,
                content: __s.processRegex(message.content || '', {
                    isPrompt: true,
                    role: message.role,
                    depth: array.length - 1 - index
                })
            }));
            // 微信 ↔ RP 衔接：若从上次 RP 之后又在微信聊过，把这段改写成剧情附到最新用户消息。
            messages = __s.appendWechatDigestToMessages(messages);

            let generatedAssistantMessageId = null;
            let assistantMessage = null;
            let continuingAssistantMessage = continuationTargetMessage;
            let continuationToolCall = null;
            let continuationContentStarted = false;
            let continuationReasoningStarted = false;
            let generationFailed = false;
            let wasCancelled = false;
            let toolResponse = null;
            const requestToolUis = new Map();
            const requestSignal = __s.abortController.value.signal;

            if (continuingAssistantMessage && continuationToolCallId && Array.isArray(continuingAssistantMessage.toolCalls)) {
                continuationToolCall = continuingAssistantMessage.toolCalls.find(call => call && call.id === continuationToolCallId) || null;
                if (continuationToolCall && typeof continuationToolCall.reasoning !== 'string') continuationToolCall.reasoning = '';
            }

            const prepareAssistantMessageForAppend = (message) => {
                if (!message) return null;
                delete message.responseError;
                if (!message.id) message.id = generateUUID();
                if (typeof message.content !== 'string') message.content = '';
                if (typeof message.reasoning !== 'string') message.reasoning = '';
                if (message.isCotOpen === undefined) message.isCotOpen = false;
                if (message.isReasoningOpen === undefined) message.isReasoningOpen = true;
                if (message.isReasoningUserToggled === undefined) message.isReasoningUserToggled = false;
                if (message.isReasoningAutoCollapsed === undefined) message.isReasoningAutoCollapsed = false;
                message.shouldAnimate = !continuingAssistantMessage;
                return message;
            };

            const appendAssistantText = (message, field, text) => {
                if (!message || !text) return;
                const isContinuation = continuingAssistantMessage && message.id === continuingAssistantMessage.id;
                const startedKey = field === 'reasoning' ? 'continuationReasoningStarted' : 'continuationContentStarted';
                const hasStarted = field === 'reasoning' ? continuationReasoningStarted : continuationContentStarted;

                const existing = String(message[field] || '');
                const appendValue = isContinuation && field === 'content' && !hasStarted
                    ? String(text).replace(/^\s+/, '')
                    : text;
                if (!appendValue) return;

                if (isContinuation && !hasStarted && existing.trim()) {
                    message[field] = existing.replace(/\s+$/, '') + '\n\n' + appendValue;
                } else {
                    message[field] = existing + appendValue;
                }

                if (isContinuation && !hasStarted) {
                    if (startedKey === 'continuationReasoningStarted') continuationReasoningStarted = true;
                    else continuationContentStarted = true;
                }
                if (isContinuation) __s.activeToolContinuationHasResponse.value = true;
            };

            const createAssistantMessage = (content = '', reasoning = '') => reactive({
                role: 'assistant',
                name: __s.currentCharacter.value.name,
                content: content || '',
                reasoning: reasoning || '',
                id: generateUUID(),
                shouldAnimate: true,
                isCotOpen: false,
                isReasoningOpen: true,
                isReasoningUserToggled: false,
                isReasoningAutoCollapsed: false
            });

            const ensureAssistantMessage = (content = '', reasoning = '') => {
                if (assistantMessage) return assistantMessage;
                if (continuingAssistantMessage) {
                    assistantMessage = prepareAssistantMessageForAppend(continuingAssistantMessage);
                    if (reasoning) appendAssistantText(assistantMessage, 'reasoning', reasoning);
                    if (content) appendAssistantText(assistantMessage, 'content', content);
                    __s.isReceiving.value = true;
                    return assistantMessage;
                }

                assistantMessage = createAssistantMessage(content, reasoning);
                __s.chatHistory.value.push(assistantMessage);
                __s.isReceiving.value = true;
                return assistantMessage;
            };

            try {
                // 召回与主请求共用取消处理，避免停止时遗漏状态和计时器的清理。
                if (__s.memorySettings.enabled && __s.memorySettings.mode === __s.MEMORY_MODE_ENHANCED) {
                    const recalled = await __s.selectEnhancedMemories(requestSignal);
                    messages = appendEnhancedMemoryRecall(messages, recalled);
                }
                if (requestSignal.aborted) throw __s.createAbortReason();

                // 必须在正则、角色合并和记忆处理之后追加，保留 tool_call_id 及服务端签名。
                messages.push(...__s.activeToolMessages);
                const contextViewerState = buildContextViewerState({
                    messages,
                    budgetedEntries,
                    triggeredEntries,
                    postprocessedChatHistory,
                    worldInfoSettings: __s.worldInfoSettings
                });
                __s.lastContextMessages.value = contextViewerState.contextMessages;
                __s.lastTriggeredWorldInfos.value = contextViewerState.triggeredWorldInfos;

                const apiMessages = messages.map(({ role, name, content, tool_calls, tool_call_id, reasoning_content, reasoning, reasoning_details, extra_content }) => ({
                    role,
                    name,
                    content,
                    ...(tool_calls ? { tool_calls } : {}),
                    ...(tool_call_id ? { tool_call_id } : {}),
                    ...(reasoning_content ? { reasoning_content } : {}),
                    ...(reasoning ? { reasoning } : {}),
                    ...(reasoning_details ? { reasoning_details } : {}),
                    ...(extra_content ? { extra_content } : {})
                }));
                const responseResult = await __s.requestTrackedChatCompletion({
                    model: requestModel,
                    messages: apiMessages,
                    logResponse: true,
                    replyInTool: __s.isTruncationEnabled.value,
                    tools: __s.buildActiveToolDefinitions(requestTools),
                    requireTool: activeToolDepth === 0 && requestTools.length > 0 && __s.getActiveToolAggressiveness() === 'force',
                    temperature: __s.settings.temperature,
                    reasoningEffort: __s.settings.reasoningEffort,
                    stream: __s.settings.stream,
                    signal: requestSignal,
                    onDelta: async ({ content: rawContent, reasoning, toolCalls }) => {
                        const content = (!assistantMessage && !String(rawContent).trim()) ? '' : rawContent;
                        if (!content && !reasoning && !toolCalls?.length) return;

                        let seededContent = false;
                        let seededReasoning = false;
                        if (!assistantMessage) {
                            assistantMessage = ensureAssistantMessage(content, reasoning);
                            seededContent = !!content;
                            seededReasoning = !!reasoning;
                            if (seededReasoning) {
                                __s.isThinking.value = true;
                            }
                            if (seededContent && !reasoning) {
                                __s.isThinking.value = false;
                                __s.collapseNativeReasoning(assistantMessage);
                            }
                            await nextTick();
                        }
                        if (reasoning && !seededReasoning) {
                            // 原生思考中的文字标签不能改变 API 已指定的通道。
                            appendAssistantText(assistantMessage, 'reasoning', reasoning);
                            __s.isThinking.value = true;
                        }
                        if (content && !seededContent) {
                            appendAssistantText(assistantMessage, 'content', content);
                            __s.isThinking.value = false;
                            __s.collapseNativeReasoning(assistantMessage);
                        }
                        if (toolCalls?.length) __s.syncNativeActiveToolUis(assistantMessage, toolCalls, requestToolUis, requestTools);
                    }
                }, activeToolDepth > 0 ? 'tool_continuation' : 'chat');
                if (requestSignal.aborted) throw __s.createAbortReason();
                if (activeToolDepth > 0 && !responseResult.toolCalls.length && !responseResult.content.trim()) {
                    throw new Error('工具调用完成，但 API 未返回正文，请重新尝试。');
                }
                if (!responseResult.isStream) {
                    const { content, reasoning } = responseResult;
                    __s.isThinking.value = !!(reasoning && !content);
                    if (content || reasoning) {
                        assistantMessage = ensureAssistantMessage(content, reasoning);
                        const hasReasoning = !!String(assistantMessage.reasoning || '').trim();
                        const hasContent = !!String(assistantMessage.content || '').trim();
                        __s.isThinking.value = hasReasoning && !hasContent;
                        const hasReasoningAndContent = hasReasoning && hasContent;
                        if (!continuingAssistantMessage) {
                            assistantMessage.isReasoningOpen = !hasReasoningAndContent;
                            assistantMessage.isReasoningAutoCollapsed = hasReasoningAndContent;
                        } else if (hasReasoningAndContent) {
                            __s.collapseNativeReasoning(assistantMessage);
                        }
                    }
                }
                if (responseResult.toolCalls.length) {
                    assistantMessage = ensureAssistantMessage();
                    __s.syncNativeActiveToolUis(assistantMessage, responseResult.toolCalls, requestToolUis, requestTools, true);
                    toolResponse = responseResult;
                    __s.activeToolHandoffPending.value = true;
                }
                const duration = Date.now() - generationStartTime;

                if (assistantMessage) {
                    generatedAssistantMessageId = assistantMessage.id;
                    if (!toolResponse && __s.settings.uiTemplateEnabled && __s.settings.uiTemplateMainModelAnalysis) {
                        __s.applyMainModelUiTemplateUpdates(assistantMessage, requestModel);
                    }

                    __s.recentGenerationTimes.value.push({ id: assistantMessage.id, duration });
                    if (__s.recentGenerationTimes.value.length > 5) __s.recentGenerationTimes.value.shift();
                }
            } catch (error) {
                generationFailed = true;
                for (const toolUi of requestToolUis.values()) {
                    toolUi.status = 'error';
                    toolUi.error = error.name === 'AbortError' ? '生成已中止' : (error.message || '工具调用未完整返回');
                }
                const cancelled = error.name === 'AbortError';
                const errorMessage = cancelled ? '生成已中止' : (error.message || '生成失败');
                const targetMessage = assistantMessage || continuingAssistantMessage;
                if (cancelled) {
                    wasCancelled = true;
                    __s.showToast('生成已中止', 'info');
                    __s.isGenerating.value = false;
                    __s.isRemoteGenerating.value = false;
                    __s.isThinking.value = false;
                }
                if (targetMessage) {
                    __s.appendAssistantResponseError(targetMessage, errorMessage);
                    if (continuingAssistantMessage) __s.activeToolContinuationHasResponse.value = true;
                } else {
                    __s.chatHistory.value.push({ role: 'system', name: __s.currentCharacter.value.name, content: errorMessage, skipReveal: true });
                }
            } finally {
                if (assistantMessage?.content) {
                    const styleFilterHits = [];
                    assistantMessage.content = __s.filterBlockedStyleText(assistantMessage.content, {
                        log: true,
                        collect: styleFilterHits
                    });
                    const previousHits = continuingAssistantMessage && Array.isArray(assistantMessage.styleFilterHits)
                        ? assistantMessage.styleFilterHits
                        : [];
                    const combinedHits = [...previousHits, ...styleFilterHits]
                        .map(__s.normalizeStyleFilterHit)
                        .filter(Boolean);
                    if (combinedHits.length) assistantMessage.styleFilterHits = combinedHits;
                    else delete assistantMessage.styleFilterHits;
                }
                if (continuationToolCall && continuationToolCall.status === 'continuing') {
                    continuationToolCall.status = 'done';
                }
                __s.collapseActiveNativeReasoning();
                await __s.saveChatHistoryNow();
                // 把本轮 RP 消息镜像进角色统一时间线（微信侧据此衔接；角色未开启微信时为空操作）。
                await __s.recordRpMessages();
                __s.isThinking.value = false;
                __s.isGenerating.value = false;
                __s.isReceiving.value = false;
                if (!continueAssistantMessageId || __s.activeToolContinuationMessageId.value === continueAssistantMessageId) {
                    __s.activeToolContinuationMessageId.value = null;
                    __s.activeToolContinuationToolCallId.value = null;
                    __s.activeToolContinuationHasResponse.value = false;
                }
                __s.abortController.value = null;
                if (__s.waitTimer) {
                    clearInterval(__s.waitTimer);
                    __s.waitTimer = null;
                }

                wasCancelled ||= requestSignal.aborted;
                const activeToolContinued = !wasCancelled && !generationFailed && toolResponse
                    ? await __s.handleActiveToolCallFromAssistant(assistantMessage, toolResponse, requestToolUis, requestTools, activeToolDepth)
                    : false;
                if (!activeToolContinued) {
                    __s.resetActiveToolResultContext();
                    __s.activeToolHandoffPending.value = false;
                }
                const needsPostGenerationTurns = !wasCancelled && !generationFailed
                    && !toolResponse
                    && ((__s.settings.uiTemplateEnabled && generatedAssistantMessageId)
                        || __s.memorySettings.enabled);
                const hasCompletedTurns = !activeToolContinued && needsPostGenerationTurns && __s.buildConversationTurnSnapshot().turns.length > 0;

                if (hasCompletedTurns && __s.settings.uiTemplateEnabled && generatedAssistantMessageId && !__s.settings.uiTemplateMainModelAnalysis) {
                    nextTick(() => {
                        __s.updateUiTemplatesFromChat({ manual: false, targetMessageId: generatedAssistantMessageId });
                    });
                }

                // 记忆提取：在对话正常完成后异步提取记忆（用户取消时不触发）
                if (hasCompletedTurns && __s.memorySettings.enabled) {
                    nextTick(__s.startAutomaticMemoryPatrol);
                }
            }
        };
        __s.generateResponse = generateResponse;
    };
})();
