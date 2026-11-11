// Stateless model execution. All calls, including repair and tool continuation, consume a turn budget.
(function () {
    const Context = () => window.RPHubActorContext;
    function abortCheck(signal) {
        if (signal?.aborted) throw Object.assign(new Error('世界回合已停止'), { name: 'AbortError' });
    }
    function parseJson(value) {
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        let text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        // Native reasoning is never saved as an action or displayed as dialogue.
        text = text.replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, '').trim();
        try { return JSON.parse(text); } catch (_) { throw new Error('角色模型未返回有效的 JSON 提案'); }
    }
    function validateProposal(value, context, kind) {
        const original = parseJson(value);
        let proposal = original;
        if (Array.isArray(original.messages)) {
            if (original.messages.some(item => item.type && item.type !== 'text')) throw new Error('世界微信当前只支持文本提案');
            proposal = { decision: original.messages.length ? 'reply' : 'silent',
                actions: original.messages.map(item => ({ kind: 'reply', text: item.content })),
                referencedEvidenceIds: [], needsPlayerResponse: false };
        }
        if (!['reply', 'silent', 'wait', 'act'].includes(proposal.decision)
            || !Array.isArray(proposal.actions) || proposal.actions.length > 6) throw new Error('角色决策或动作格式错误');
        if (proposal.actorId !== undefined && proposal.actorId !== context.actorId) throw new Error('模型不能改变绑定的角色身份');
        const ids = proposal.referencedEvidenceIds || [];
        if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => !context.evidenceIds.includes(id))) throw new Error('提案引用了未观察或不存在的来源');
        if (proposal.decision === 'silent' && proposal.actions.length) throw new Error('沉默决策不能附带已完成动作');
        let bubbles = 0;
        const actions = proposal.actions.map(action => {
            if (!action || typeof action !== 'object' || !['reply', 'tell', 'speak', 'act', 'move', 'wait', 'remember'].includes(action.kind)) throw new Error('未知角色动作类型');
            if (action.actorId !== undefined && action.actorId !== context.actorId) throw new Error('动作不属于当前角色');
            if (action.kind === 'reply' && ++bubbles > 3) throw new Error('一批微信最多三个气泡');
            if (kind === 'wechat' && ['speak', 'act'].includes(action.kind)) throw new Error('微信回复不能替代线下场景动作');
            if (['reply', 'tell', 'speak', 'act', 'remember'].includes(action.kind)
                && (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 5000)) throw new Error('角色动作需要有效短文本');
            if (action.kind === 'tell' && !context.allowedTargetActorIds.includes(action.targetActorId)) throw new Error('角色无法联系尚未认识的目标');
            if (action.channel !== undefined && !['dm', 'in_person'].includes(action.channel)) throw new Error('未知告知渠道');
            if (action.delayMinutes !== undefined && (!Number.isInteger(action.delayMinutes) || action.delayMinutes < 0 || action.delayMinutes > 10080)) throw new Error('延后时间须为0到10080剧情分钟');
            if (action.kind === 'move' && (typeof action.placeId !== 'string' || !action.placeId)) throw new Error('移动需要目标地点');
            const clean = { kind: kind === 'rp' && action.kind === 'reply' ? 'speak' : action.kind };
            for (const key of ['text', 'targetActorId', 'channel', 'placeId', 'delayMinutes', 'mode']) if (action[key] !== undefined) clean[key] = action[key];
            return clean;
        });
        return { decision: proposal.decision, actions, referencedEvidenceIds: [...ids], needsPlayerResponse: proposal.needsPlayerResponse === true };
    }
    function budgetCheck(budget) {
        if (budget.callsUsed >= budget.maxCalls) throw Object.assign(new Error('本回合模型调用预算已用尽，未决步骤已保留'), { name: 'WorldBudgetError' });
        budget.callsUsed++;
    }
    async function request({ purpose, actorId, messages, tools, apiConfig = {}, signal, budget, modelRunner, onUsage }) {
        abortCheck(signal); budgetCheck(budget);
        const started = Date.now();
        let result;
        try {
            if (modelRunner) result = await modelRunner({ purpose, actorId, messages, tools, apiConfig, signal,
                callNumber: budget.callsUsed });
            else {
                if (!apiConfig.apiUrl || !apiConfig.model) throw new Error('请先配置聊天模型的接口地址和模型名称');
                result = await window.RPHubApiClient.requestChatCompletion({
                    url: window.RPHubApiUtils.buildApiEndpoint(apiConfig.apiUrl, 'chat/completions'),
                    apiKey: apiConfig.apiKey, model: apiConfig.model, temperature: apiConfig.temperature ?? 0.7,
                    maxTokens: apiConfig.maxTokens || (purpose === 'narrator' ? 1800 : 1000),
                    timeoutMs: apiConfig.timeoutMs || 90000, messages, tools, signal, stream: false,
                    logRequest: !!apiConfig.logRequest, requestType: `world-${purpose}/${actorId || 'scene'}`,
                    onUsage: (usage, metadata) => onUsage?.({ purpose, actorId, usage, ...metadata }) });
            }
            abortCheck(signal);
            if (modelRunner) onUsage?.({ purpose, actorId, usage: result?.usage || null, durationMs: Date.now() - started });
            return result;
        } catch (error) { abortCheck(signal); throw error; }
    }
    async function runActor({ snapshot, actorId, conversationId, kind, stimulus, apiConfig, signal, budget,
        modelRunner, onUsage, maxCharacters }) {
        const context = Context().compile({ snapshot, actorId, conversationId, kind, stimulus, maxCharacters });
        const boundTools = Context().createTools(snapshot, actorId, conversationId);
        const messages = context.messages.map(item => ({ ...item }));
        let repaired = false;
        for (;;) {
            const result = await request({ purpose: 'actor', actorId, messages, tools: boundTools.definitions,
                apiConfig, signal, budget, modelRunner, onUsage });
            const calls = result?.toolCalls;
            if (Array.isArray(calls) && calls.length) {
                if (calls.length > 4) throw new Error('一次最多四个角色读取工具');
                messages.push(result.assistantMessage || { role: 'assistant', content: result.content || null,
                    tool_calls: calls.map(({ index, ...call }) => call) });
                for (const call of calls) {
                    abortCheck(signal);
                    let output;
                    try { output = boundTools.execute(call.function.name, parseJson(call.function.arguments)); }
                    catch (_) { output = { status: 'invalid_arguments' }; }
                    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
                }
                continue;
            }
            try {
                const proposal = validateProposal(result?.content !== undefined ? result.content : result, context, kind);
                return { proposal, contextBudget: context.budget };
            } catch (error) {
                if (repaired || budget.callsUsed >= budget.maxCalls) throw error;
                repaired = true;
                messages.push({ role: 'assistant', content: typeof result?.content === 'string' ? result.content : JSON.stringify(result) },
                    { role: 'user', content: `提案校验失败：${error.message}。请只返回符合协议、只控制本角色的 JSON。` });
            }
        }
    }
    window.RPHubActorRuntime = Object.freeze({ abortCheck, parseJson, validateProposal, request, runActor });
})();
