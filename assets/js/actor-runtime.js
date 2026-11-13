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
        if (original.actorId !== undefined && original.actorId !== context.actorId) throw new Error('模型不能改变绑定的角色身份');
        let proposal = original;
        if (Array.isArray(original.messages)) {
            if (original.messages.some(item => item.type && !['text', 'image_request'].includes(item.type))) throw new Error('世界微信支持文字和生图请求');
            const parsed = window.RPHubWeChatProtocol?.parseReplyResult(JSON.stringify(original));
            const messages = parsed ? parsed.messages : original.messages;
            if (original.messages.length && !messages.length) throw new Error('微信模型未返回有效的文字消息');
            proposal = { decision: original.messages.length ? 'reply' : 'silent',
                actions: messages.map(item => item.type === 'image_request' ? { kind: 'reply', image: item.media } : { kind: 'reply', text: item.content }),
                silence: parsed?.silence,
                referencedEvidenceIds: [], needsPlayerResponse: false };
        }
        if (!['reply', 'silent', 'wait', 'act'].includes(proposal.decision)
            || !Array.isArray(proposal.actions) || proposal.actions.length > 6) throw new Error('角色决策或动作格式错误');
        if (proposal.actorId !== undefined && proposal.actorId !== context.actorId) throw new Error('模型不能改变绑定的角色身份');
        const rawIds = proposal.referencedEvidenceIds || [];
        if (!Array.isArray(rawIds) || rawIds.length > 20) throw new Error('来源引用应为最多20个ID的数组');
        const ids = rawIds.map(id => context.evidenceIds.includes(id) ? id : context.evidenceAliases?.[String(id)] || id);
        if (ids.some(id => !context.evidenceIds.includes(id))) throw new Error('提案引用了未观察或不存在的来源，请复制提供的evidenceId/entryId，或省略非必要引用并返回空数组');
        if (proposal.decision === 'silent' && proposal.actions.length) throw new Error('沉默决策不能附带已完成动作');
        let bubbles = 0, images = 0, establishedPlace = context.currentPlaceId || null;
        const actions = proposal.actions.map(action => {
            if (!action || typeof action !== 'object' || !['reply', 'tell', 'speak', 'act', 'move', 'wait', 'remember'].includes(action.kind)) throw new Error('未知角色动作类型');
            if (action.actorId !== undefined && action.actorId !== context.actorId) throw new Error('动作不属于当前角色');
            if (action.kind === 'reply' && ++bubbles > (window.RPHubWeChatProtocol?.MAX_MESSAGES || 6)) throw new Error('一批微信最多六个气泡');
            if (kind === 'wechat' && ['speak', 'act'].includes(action.kind)) throw new Error('微信回复不能替代线下场景动作');
            if (!action.image && ['reply', 'tell', 'speak', 'act', 'remember'].includes(action.kind)
                && (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 5000)) throw new Error('角色动作需要有效短文本');
            if (action.kind === 'act' && /前往|走向|走到|来到|到达|往.{1,40}走|去.{1,20}(?:吃饭|打球)/.test(action.text)
                && !/打算|计划|想要|准备(?:去|前往)|考虑|尚未/.test(action.text)) {
                const targets = context.movementTargets?.(action.text) || [];
                if (targets.length) throw new Error(`跨地图地点移动必须用move，不能写进act。候选目的地：${JSON.stringify(targets)}；程序验证路线后才确认出发。`);
            }
            if (action.kind === 'tell' && !context.allowedTargetActorIds.includes(action.targetActorId)) throw new Error('角色无法联系尚未认识的目标');
            if (action.channel !== undefined && !['dm', 'in_person'].includes(action.channel)) throw new Error('未知告知渠道');
            if (action.delayMinutes !== undefined && (!Number.isInteger(action.delayMinutes) || action.delayMinutes < 0 || action.delayMinutes > 10080)) throw new Error('延后时间须为0到10080剧情分钟');
            if (action.kind === 'move' && (typeof action.placeId !== 'string' || !action.placeId)) throw new Error('移动需要目标地点');
            if (action.kind === 'move' && !context.mapPlaceIds.includes(action.placeId)) throw new Error('移动目标必须使用公共地图中的地点ID，请查询地点后重试');
            const clean = { kind: kind === 'rp' && action.kind === 'reply' ? 'speak' : action.kind };
            if (action.image) {
                if (!context.imageGenerationEnabled || ++images > 1) throw new Error('生图尚未配置或一轮超过一张图片');
                if (!['reply', 'tell'].includes(clean.kind) || action.channel === 'in_person' || action.text || action.delayMinutes > 0) throw new Error('图片须为一条立即发送的微信，不能混入文字、线下动作或延后发送');
                clean.image = window.RPHubWeChatMedia.normalizeIntent(action.image);
                if (clean.image.mode !== 'generate') throw new Error('世界微信请使用 generate 和画面提示词');
            }
            for (const key of ['text', 'targetActorId', 'channel', 'placeId', 'delayMinutes', 'mode']) if (action[key] !== undefined) clean[key] = action[key];
            if (action.state !== undefined) {
                if (action.kind !== 'act' || !action.state || typeof action.state !== 'object' || Array.isArray(action.state)
                    || Object.keys(action.state).some(key => !['phoneAccess', 'activity', 'position'].includes(key))) throw new Error('状态只能随本人的已完成 act 动作更新');
                const state = {};
                if (action.state.phoneAccess !== undefined) {
                    if (!['available', 'blocked'].includes(action.state.phoneAccess)) throw new Error('手机状态无效');
                    state.phoneAccess = action.state.phoneAccess;
                    state.phoneRestrictedUntil = null;
                }
                if (action.state.activity !== undefined) {
                    if (typeof action.state.activity !== 'string' || action.state.activity.length > 120) throw new Error('活动描述无效');
                    state.activity = action.state.activity;
                }
                if (action.state.position !== undefined) {
                    const placeId = typeof action.state.position === 'string' ? action.state.position : action.state.position?.placeId;
                    if (establishedPlace || !context.mapPlaceIds.includes(placeId)) throw new Error('已有位置不能通过状态修改跨地点移动；请使用 move');
                    state.position = { status: 'confirmed', placeId, source: 'npc_scene_start' };
                    establishedPlace = placeId;
                }
                clean.state = state;
            }
            return clean;
        });
        return { decision: proposal.decision, actions, referencedEvidenceIds: [...ids], needsPlayerResponse: proposal.needsPlayerResponse === true,
            ...(proposal.silence ? { silence: proposal.silence } : {}) };
    }
    function budgetCheck(budget) {
        if (budget.callsUsed >= budget.maxCalls) throw Object.assign(new Error('本回合模型调用预算已用尽，未决步骤已保留'), { name: 'WorldBudgetError' });
        budget.callsUsed++;
    }
    // Operational counters contain no prompts, replies or reasoning.
    function createActivityTracker(previous = {}) {
        const started = Date.now(), elapsed = previous.elapsedMs || 0;
        const stats = { modelRequests: 0, toolCalls: 0, failedRequests: 0, promptTokens: 0, completionTokens: 0,
            usageReports: 0, elapsedMs: 0, phases: [], ...JSON.parse(JSON.stringify(previous)) };
        return {
            report(event) {
                const { purpose = 'actor', actorId = null, model = '' } = event;
                let phase = stats.phases.find(p => p.purpose === purpose && p.actorId === actorId && p.model === model);
                if (!phase) { phase = { purpose, actorId, model, requests: 0, tools: 0, failed: 0 }; stats.phases.push(phase); }
                if (event.type === 'request-start') { stats.modelRequests++; phase.requests++; }
                if (event.type === 'tool-start') { stats.toolCalls++; phase.tools++; }
                if (event.type === 'request-end') {
                    if (event.outcome === 'failed') { stats.failedRequests++; phase.failed++; }
                    if (event.usage) {
                        stats.usageReports++;
                        stats.promptTokens += Number(event.usage.prompt_tokens ?? event.usage.input_tokens) || 0;
                        stats.completionTokens += Number(event.usage.completion_tokens ?? event.usage.output_tokens) || 0;
                    }
                }
            },
            snapshot() { return JSON.parse(JSON.stringify({ ...stats, elapsedMs: elapsed + Date.now() - started })); }
        };
    }
    const reportActivity = (config, event) => { try { config?.onActivity?.(event); } catch (_) { /* UI reporting cannot fail a model request. */ } };
    async function request({ purpose, actorId, messages, tools, apiConfig = {}, signal, budget, modelRunner, onUsage }) {
        abortCheck(signal); budgetCheck(budget);
        apiConfig.onPhase?.(purpose, actorId);
        const started = Date.now();
        const metadata = { purpose, actorId: actorId || null, model: apiConfig.model || '' };
        reportActivity(apiConfig, { type: 'request-start', ...metadata });
        let result, receivedUsage = null, outcome = 'failed';
        try {
            if (modelRunner) result = await modelRunner({ purpose, actorId, messages, tools, apiConfig, signal,
                callNumber: budget.callsUsed });
            else {
                if (!apiConfig.apiUrl || !apiConfig.model) throw new Error('请先配置聊天模型的接口地址和模型名称');
                result = await window.RPHubApiClient.requestChatCompletion({
                    url: window.RPHubApiUtils.buildApiEndpoint(apiConfig.apiUrl, 'chat/completions'),
                    apiKey: apiConfig.apiKey, model: apiConfig.model, temperature: apiConfig.temperature ?? 0.7,
                    ...(apiConfig.maxTokens ? { maxTokens: apiConfig.maxTokens } : {}),
                    reasoningEffort: apiConfig.reasoningEffort,
                    timeoutMs: apiConfig.timeoutMs || 120000, messages, tools, signal, stream: apiConfig.stream !== false,
                    logRequest: !!apiConfig.logRequest, requestType: `world-${purpose}/${actorId || 'scene'}`,
                    onUsage: (usage, metadata) => { receivedUsage = usage; onUsage?.({ purpose, actorId, usage, ...metadata });
                        apiConfig.onUsage?.(usage, { ...metadata, model: apiConfig.model, purpose, actorId }); } });
            }
            abortCheck(signal);
            if (!modelRunner && !result?.content?.trim() && !result?.toolCalls?.length) {
                throw new Error(result?.finishReason === 'length' ? '模型输出额度耗尽且未返回正文，请提高输出额度或降低推理深度' : '模型返回了空正文，请检查接口和模型配置');
            }
            if (modelRunner) onUsage?.({ purpose, actorId, usage: result?.usage || null, durationMs: Date.now() - started });
            outcome = 'complete';
            return result;
        } catch (error) { if (signal?.aborted) outcome = 'stopped'; abortCheck(signal); throw error; }
        finally { reportActivity(apiConfig, { type: 'request-end', ...metadata, outcome, durationMs: Date.now() - started,
            usage: receivedUsage || result?.usage || null }); }
    }
    async function runActor({ snapshot, actorId, conversationId, kind, stimulus, apiConfig, signal, budget,
        modelRunner, onUsage, maxCharacters }) {
        const context = Context().compile({ snapshot, actorId, conversationId, kind, stimulus, maxCharacters });
        context.imageGenerationEnabled = window.RPHubImageGeneration?.ready(apiConfig?.imageConfig) === true;
        const boundTools = Context().createTools(snapshot, actorId, conversationId);
        const wechatTool = kind === 'rp' && window.RPHubWorldOrchestrator.canReadPhone(snapshot, actorId)
            ? { type: 'function', function: { name: 'tool_wechat',
                description: '以当前绑定角色身份发一条真实微信。content 是本人纯文本短消息，不能含发送者或JSON消息列表。targetActorId 省略时联系玩家，也可选择已认识的NPC。每次人物决策仅接收一次发送，成功后不再工具续写；联系玩家时等待玩家回答，联系NPC时由收件人独立回应。消息在世界提交成功后才算发送，不虚构已读、回复或约定。',
                parameters: { type: 'object', properties: { content: { type: 'string', maxLength: window.RPHubWeChatProtocol.MAX_CONTENT_LEN },
                    ...(context.imageGenerationEnabled ? { image: { type: 'object', properties: { mode: { type: 'string', enum: ['generate'] },
                        prompt: { type: 'string', maxLength: 1500 }, description: { type: 'string', maxLength: 240 }, usage: { type: 'string', enum: ['scene_photo', 'album_photo', 'reference', 'drawing'] } }, required: ['mode', 'prompt'], additionalProperties: false } } : {}),
                    targetActorId: { type: 'string', enum: context.allowedTargetActorIds } }, anyOf: [{ required: ['content'] }, ...(context.imageGenerationEnabled ? [{ required: ['image'] }] : [])], additionalProperties: false } } }
            : null;
        const messages = context.messages.map(item => ({ ...item }));
        if (context.imageGenerationEnabled) messages[0].content += '\n【微信生图】' + window.RPHubImageGeneration.prompt
            + (kind === 'rp' ? 'RP中图片通过tool_wechat的image参数发送（与content二选一），不要返回messages。' : '');
        let repaired = false, toolRounds = 0;
        for (;;) {
            const offeredTools = [...(toolRounds < 2 ? boundTools.definitions : []), ...(wechatTool ? [wechatTool] : [])];
            const result = await request({ purpose: 'actor', actorId, messages, tools: offeredTools.length ? offeredTools : undefined,
                apiConfig, signal, budget, modelRunner, onUsage });
            const calls = result?.toolCalls;
            if (Array.isArray(calls) && calls.length) {
                if (calls.length > 4) throw new Error('一次最多四个角色工具调用');
                let outgoing = null;
                const receipts = [];
                messages.push(result.assistantMessage || { role: 'assistant', content: result.content || null,
                    tool_calls: calls.map(({ index, ...call }) => call) });
                for (const call of calls) {
                    abortCheck(signal);
                    let output;
                    if ((call.function.name === 'tool_wechat' && wechatTool) || (toolRounds < 2 && boundTools.definitions.some(t => t.function.name === call.function.name)))
                        reportActivity(apiConfig, { type: 'tool-start', purpose: 'actor', actorId, model: apiConfig?.model || '', toolName: call.function.name });
                    if (call.function.name === 'tool_wechat') {
                        try {
                            if (!wechatTool) throw new Error('当前场景未提供微信发送工具或本人无法使用手机');
                            if (outgoing) throw new Error('本次人物决策已发起一次微信联系，请等待收件人回应');
                            const args = parseJson(call.function.arguments);
                            if (Object.keys(args).some(key => !['content', 'image', 'targetActorId'].includes(key))) throw new Error('微信工具不能指定发送者、消息列表或未知字段');
                            const target = args.targetActorId === undefined ? snapshot.definition.playerActorId : args.targetActorId;
                            if (args.image && args.content !== undefined) throw new Error('image 与 content 二选一');
                            const body = args.image ? { image: args.image } : { text: window.RPHubWeChatProtocol.normalizeActiveText(args.content) };
                            outgoing = validateProposal({ decision: 'act', actions: [{ kind: 'tell', channel: 'dm', targetActorId: target, ...body }],
                                referencedEvidenceIds: [], needsPlayerResponse: target === snapshot.definition.playerActorId }, context, 'rp');
                            output = { queued: true, delivered: false, senderActorId: actorId, recipientActorId: target,
                                awaitingPlayer: outgoing.needsPlayerResponse };
                        } catch (error) { output = { status: 'invalid_arguments', error: error.message }; }
                        receipts.push({ callId: call.id, name: 'tool_wechat', ...output });
                    } else {
                        if (toolRounds >= 2) output = { status: 'budget_exhausted', error: '人物读取已完成，请返回最终行动提案' };
                        else try { output = boundTools.execute(call.function.name, parseJson(call.function.arguments)); }
                        catch (_) { output = { status: 'invalid_arguments' }; }
                    }
                    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
                }
                // Sending is a final proposal, never an extra model turn that could invent a reply.
                // The orchestrator still owns the atomic, revision-checked store commit.
                if (outgoing) return { proposal: outgoing, contextBudget: context.budget, wechatToolReceipts: receipts };
                if (toolRounds >= 2) throw new Error('人物读取已完成；请返回最终行动提案或有效的微信发送');
                toolRounds++;
                if (toolRounds === 2) messages.push({ role: 'user', content: '本次资料读取已结束。请根据已获得的资料返回最终JSON，或调用仍提供的微信发送工具；未知项保持未知，可以等待或保留意见，不再查询资料。' });
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
    window.RPHubActorRuntime = Object.freeze({ abortCheck, parseJson, validateProposal, request, runActor, createActivityTracker });
})();
