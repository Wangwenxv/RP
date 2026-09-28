/**
 * RP-Hub 应用模块 18 · 工具调用的 UI 呈现、状态机与时间线
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 5791–6105 行。
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
    window.RPHubAppSections.toolsUi = function (__s) {
        const syncNativeActiveToolUis = (message, calls, requestUis, tools, complete = false) => {
            if (!Array.isArray(message.toolCalls)) message.toolCalls = [];
            calls.forEach((call, position) => {
                const key = call.index ?? position;
                const parsed = __s.parseNativeActiveToolCall(call, tools);
                let ui = requestUis.get(key);
                if (!ui) {
                    ui = reactive(createActiveToolUi(parsed, 'receiving'));
                    requestUis.set(key, ui);
                    message.toolCalls.push(ui);
                }
                Object.assign(ui, {
                    toolId: parsed.tool?.id || '',
                    toolType: parsed.tool?.type || '',
                    name: parsed.tool?.name || call.function.name || '工具调用',
                    callName: call.function.name,
                    baseCallName: call.function.name,
                    query: parsed.query || (complete ? '无有效参数' : '正在接收工具参数…'),
                    raw: parsed.raw,
                    reason: parsed.reason,
                    status: complete ? 'queued' : 'receiving'
                });
            });
        };
        __s.syncNativeActiveToolUis = syncNativeActiveToolUis;
        const cleanActiveToolCallReason = (value) => String(value || '').trim();
        __s.cleanActiveToolCallReason = cleanActiveToolCallReason;
        const createActiveToolUi = (toolCall, initialStatus = 'queued') => ({
            id: generateUUID(),
            toolId: toolCall.tool?.id || '',
            toolType: toolCall.tool?.type || '',
            name: toolCall.tool?.name || '工具调用',
            callName: toolCall.callLabel || toolCall.tool?.callName || '',
            baseCallName: toolCall.tool?.callName || toolCall.callLabel || '',
            query: toolCall.query || '',
            raw: toolCall.raw,
            reason: cleanActiveToolCallReason(toolCall.reason),
            status: initialStatus,
            isOpen: false,
            reasoning: '',
            isReasoningOpen: false,
            resultCount: 0,
            resultText: '',
            error: ''
        });
        __s.createActiveToolUi = createActiveToolUi;
        const getActiveToolUiGroupKey = (toolCall) => {
            const baseCallName = __s.normalizeActiveToolBaseCallName(
                toolCall?.baseCallName
                || toolCall?.callName
                || ''
            );
            if (toolCall?.toolType === ACTIVE_TOOL_WEB_TYPE || baseCallName === 'tool_web') {
                return ACTIVE_TOOL_WEB_TYPE;
            }
            if (toolCall?.toolType === ACTIVE_TOOL_KEYWORD_TYPE || baseCallName === 'tool_grep') {
                return ACTIVE_TOOL_KEYWORD_TYPE;
            }
            if (toolCall?.toolType === ACTIVE_TOOL_RANDOM_TYPE || baseCallName === 'tool_random') {
                return ACTIVE_TOOL_RANDOM_TYPE;
            }
            return '';
        };
        __s.getActiveToolUiGroupKey = getActiveToolUiGroupKey;
        const getToolCallDisplayName = (toolCall) => {
            const groupKey = getActiveToolUiGroupKey(toolCall);
            if (groupKey === ACTIVE_TOOL_WEB_TYPE) return 'Tavily 联网搜索';
            if (groupKey === ACTIVE_TOOL_KEYWORD_TYPE) return '关键词检索';
            if (groupKey === ACTIVE_TOOL_RANDOM_TYPE) return '随机数生成';
            return toolCall?.name || '工具调用';
        };
        __s.getToolCallDisplayName = getToolCallDisplayName;
        const getToolCallModeText = (toolCall) => {
            const groupKey = getActiveToolUiGroupKey(toolCall);
            const query = String(toolCall?.query || '');

            if (groupKey === ACTIVE_TOOL_WEB_TYPE) {
                const hasUrl = __s.extractWebUrlsFromToolQuery(query).length > 0;
                return hasUrl ? '读取网页' : '联网搜索';
            }

            if (groupKey === ACTIVE_TOOL_KEYWORD_TYPE) {
                return '关键词检索';
            }
            if (groupKey === ACTIVE_TOOL_RANDOM_TYPE) return '生成随机数';
            return '工具调用';
        };
        __s.getToolCallModeText = getToolCallModeText;
        const TOOL_CALL_RUNNING_STATUSES = ['running', 'receiving', 'queued'];
        __s.TOOL_CALL_RUNNING_STATUSES = TOOL_CALL_RUNNING_STATUSES;
        const getToolCallEffectiveStatus = (toolCall) => (
            toolCall?.status === 'continuing' ? 'done' : (toolCall?.status || 'queued')
        );
        __s.getToolCallEffectiveStatus = getToolCallEffectiveStatus;
        const getCurrentThinkingToolCall = (message) => {
            const toolCalls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
            const runningToolCall = toolCalls.find(toolCall => TOOL_CALL_RUNNING_STATUSES.includes(getToolCallEffectiveStatus(toolCall)));
            if (runningToolCall) return runningToolCall;
            if (
                __s.activeToolContinuationMessageId.value === message?.id
                && !__s.activeToolContinuationHasResponse.value
                && (__s.isGenerating.value || __s.isRemoteGenerating.value || __s.activeToolContinuationPending.value)
            ) {
                return toolCalls.find(toolCall => toolCall?.id === __s.activeToolContinuationToolCallId.value) || null;
            }
            return null;
        };
        __s.getCurrentThinkingToolCall = getCurrentThinkingToolCall;
        const getToolCallReasoningParts = (toolCalls) => (Array.isArray(toolCalls) ? toolCalls : [])
            .map(item => String(item?.reasoning || '').trim())
            .filter(Boolean)
            .filter((text, index, items) => items.indexOf(text) === index);
        __s.getToolCallReasoningParts = getToolCallReasoningParts;
        const getAssistantReasoningText = (message) => {
            const parts = [];
            const seen = new Set();
            const appendPart = (value) => {
                const text = String(value || '').trim();
                if (!text || seen.has(text)) return;
                seen.add(text);
                parts.push(text);
            };

            appendPart(message?.reasoning);
            getToolCallReasoningParts(message?.toolCalls).forEach(appendPart);
            return parts.join('\n\n');
        };
        __s.getAssistantReasoningText = getAssistantReasoningText;
        const hasThinkingOrTools = (message) => {
            if (!message) return false;
            return !!(
                getAssistantReasoningText(message)
                || (Array.isArray(message.toolCalls) && message.toolCalls.length > 0)
                || (parseCot(message.content || '').cot)
            );
        };
        __s.hasThinkingOrTools = hasThinkingOrTools;
        const isMessageThinkingOrRunning = (message) => {
            const isLast = __s.chatHistory.value && __s.chatHistory.value[__s.chatHistory.value.length - 1] === message;
            if (isLast && __s.isThinking.value) return true;
            if (getCurrentThinkingToolCall(message)) return true;
            const cotInfo = parseCot(message.content || '');
            if (isLast && (__s.isGenerating.value || __s.isRemoteGenerating.value) && cotInfo.cot && !cotInfo.isFinished) {
                return true;
            }
            return false;
        };
        __s.isMessageThinkingOrRunning = isMessageThinkingOrRunning;
        const isThinkingSummaryOpen = (message) => {
            if (message?.isSummaryOpen !== undefined) return message.isSummaryOpen !== false;
            return isMessageThinkingOrRunning(message);
        };
        __s.isThinkingSummaryOpen = isThinkingSummaryOpen;
        const toggleThinkingSummary = (message) => {
            if (!message) return;
            message.isSummaryOpen = !isThinkingSummaryOpen(message);
            __s.saveChatHistoryNow();
        };
        __s.toggleThinkingSummary = toggleThinkingSummary;
        const markThinkingSummaryDetailOpened = (message, event) => {
            if (!message || !event?.target?.open) return;
            message.hasOpenedSummaryDetail = true;
            if (message.isSummaryOpen === undefined && isMessageThinkingOrRunning(message)) {
                message.isSummaryOpen = true;
            }
            __s.saveChatHistoryNow();
        };
        __s.markThinkingSummaryDetailOpened = markThinkingSummaryDetailOpened;
        const getToolCallStepText = (toolCall) => {
            const modeText = getToolCallModeText(toolCall);
            return `${modeText}: ${toolCall.query}`;
        };
        __s.getToolCallStepText = getToolCallStepText;
        const getTimelineCharCount = (text) => Array.from(String(text || '')).length;
        __s.getTimelineCharCount = getTimelineCharCount;
        const getTimelineSteps = (message) => {
            const steps = [];
            const isLastMessage = __s.chatHistory.value && __s.chatHistory.value[__s.chatHistory.value.length - 1] === message;
            const isGeneratingMessage = isLastMessage && (__s.isGenerating.value || __s.isRemoteGenerating.value);
            const cotInfo = parseCot(message.content || '');

            // 1. 初始原生思考
            const reasoningText = String(getAssistantReasoningText(message) || '').trim();
            if (reasoningText) {
                steps.push({
                    id: 'init-reasoning',
                    type: 'thinking',
                    text: reasoningText,
                    title: '原生思考',
                    charCount: getTimelineCharCount(reasoningText),
                    isLive: isLastMessage && __s.isThinking.value
                });
            }

            // 2. 工具调用列表
            if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
                message.toolCalls.forEach((toolCall, idx) => {
                    const status = getToolCallEffectiveStatus(toolCall);
                    const reason = cleanActiveToolCallReason(toolCall?.reason);
                    if (reason) {
                        steps.push({
                            id: `tool-reason-${toolCall.id || idx}`,
                            type: 'thinking',
                            text: reason,
                            title: reason,
                            isReason: true
                        });
                    }
                    steps.push({
                        id: `tool-call-${toolCall.id || idx}`,
                        type: 'tool',
                        toolCall: toolCall,
                        title: getToolCallDisplayName(toolCall),
                        text: getToolCallStepText(toolCall),
                        status
                    });
                });
            }

            // 3. 分析过程 (CoT)
            const cotText = String(cotInfo.rawCot || '').trim();
            if (cotText) {
                steps.push({
                    id: 'cot-reasoning',
                    type: 'thinking',
                    text: cotText,
                    title: '分析过程',
                    charCount: getTimelineCharCount(cotText),
                    isLive: isGeneratingMessage && !cotInfo.isFinished
                });
            }

            return steps;
        };
        __s.getTimelineSteps = getTimelineSteps;
        const handleActiveToolCallFromAssistant = async (assistantMessage, response, requestUis, requestTools, activeToolDepth) => {
            const toolAbort = new AbortController();
            __s.activeToolQueueAbortController = toolAbort;
            __s.activeToolQueueRunning.value = true;
            __s.activeToolHandoffPending.value = false;
            const toolUis = [...requestUis.values()];
            try {
                if (activeToolDepth >= ACTIVE_TOOL_MAX_AUTO_CONTINUE) throw new Error('已达到本轮工具调用次数上限');
                __s.activeToolMessages.push(response.assistantMessage);
                // 即使接口一次返回多个调用，也逐一配对结果；并发执行，按原始调用顺序追加。
                const records = await Promise.all(response.toolCalls.map(async (call, position) => {
                    const toolUi = requestUis.get(call.index ?? position);
                    const toolCall = __s.parseNativeActiveToolCall(call, requestTools);
                    let payload;
                    try {
                        if (toolAbort.signal.aborted) throw __s.createAbortReason();
                        if (position >= 5) throw new Error('单次最多执行 5 项工具调用');
                        if (toolCall.error) throw new Error(toolCall.error);
                        if (!__s.getEnabledActiveTools().some(tool => tool.callName === call.function.name)) throw new Error('该工具已关闭');
                        toolUi.status = 'running';
                        const isRandom = toolCall.tool.type === ACTIVE_TOOL_RANDOM_TYPE;
                        const results = isRandom
                            ? [__s.generateRandomNumberForTool(toolCall.min, toolCall.max)]
                            : __s.isWebActiveTool(toolCall.tool)
                                ? await __s.searchWebByTavilyForTool(toolCall.query, toolCall.tool, toolAbort.signal)
                                : __s.searchDialogueByKeywordForTool(toolCall.query, toolCall.tool.resultCount, { excludeMessageId: assistantMessage.id });
                        if (toolAbort.signal.aborted) throw __s.createAbortReason();
                        payload = {
                            status: results.length ? 'ok' : 'empty',
                            query: toolCall.query,
                            results,
                            ...(isRandom ? { operation: 'random' } : {}),
                            ...(results.tavilyMode ? { operation: results.tavilyMode } : {}),
                            ...(results.tavilyFailedResults?.length ? { failed_sources: results.tavilyFailedResults } : {})
                        };
                        toolUi.status = 'done';
                        toolUi.resultCount = results.length;
                    } catch (error) {
                        if (error.name === 'AbortError') throw error;
                        payload = { status: 'error', query: toolCall.query, error: error.message || '工具执行失败' };
                        toolUi.status = 'error';
                        toolUi.error = payload.error;
                    }
                    toolUi.resultText = JSON.stringify(payload, null, 2);
                    console.info('[工具调用]', { 工具: call.function.name, 状态: payload.status, 条数: toolUi.resultCount, ...(payload.error ? { 错误: payload.error } : {}) });
                    return { callId: call.id, payload };
                }));
                if (toolAbort.signal.aborted) throw __s.createAbortReason();
                records.forEach(record => __s.appendActiveToolResult(record.callId, record.payload));
                const continuationToolUi = toolUis[toolUis.length - 1];
                if (continuationToolUi.status !== 'error') continuationToolUi.status = 'continuing';
                __s.activeToolQueueRunning.value = false;
                __s.activeToolContinuationPending.value = true;
                await __s.saveChatHistoryNow();
                if (toolAbort.signal.aborted) throw __s.createAbortReason();
                await __s.generateResponse(Date.now(), {
                    activeToolDepth: activeToolDepth + 1,
                    continueAssistantMessageId: assistantMessage.id,
                    continuationToolCallId: continuationToolUi.id
                });
                if (continuationToolUi.status === 'continuing') continuationToolUi.status = 'done';
                return true;
            } catch (error) {
                if (error.name === 'AbortError') {
                    __s.markActiveToolInlineWorkCancelled();
                } else {
                    toolUis.filter(ui => TOOL_CALL_RUNNING_STATUSES.includes(ui.status)).forEach(ui => {
                        ui.status = 'error';
                        ui.error = error.message || '工具处理失败';
                    });
                    __s.appendAssistantResponseError(assistantMessage, error.message || '工具处理失败');
                }
                return false;
            } finally {
                if (__s.activeToolQueueAbortController === toolAbort) __s.activeToolQueueAbortController = null;
                __s.activeToolHandoffPending.value = false;
                __s.activeToolQueueRunning.value = false;
                __s.activeToolContinuationPending.value = false;
                await __s.saveChatHistoryNow();
            }
        };
        __s.handleActiveToolCallFromAssistant = handleActiveToolCallFromAssistant;
    };
})();
