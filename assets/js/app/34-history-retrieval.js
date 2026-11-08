// RP and WeChat share a scoped, transient search/read capability for retained original history.
(function () {
    window.RPHubAppSections = window.RPHubAppSections || {};
    window.RPHubAppSections.historyRetrieval = function (__s) {
        const H = window.RPHubHistoryRetrieval;
        const names = new Set(H.definitions.map(tool => tool.function.name));
        const scope = () => __s.getCurrentStoryBranchScopeId();
        const available = () => __s.settings.historyRetrievalEnabled !== false && !!__s.currentCharacter.value?.uuid
            && (!!String(__s.storyRecap?.value?.text || '').trim()
                || (__s.memorySettings.enabled && __s.classicMemories.value.some(memory => String(memory.summary || '').trim()))
                || (__s.wechatTimeline?.value || []).filter(item => item.channel === 'wechat').length > 30);
        __s.historyRetrievalTools = () => available() ? H.definitions : [];
        __s.createHistoryRetrievalBudget = () => ({ scopeId: scope(), characterId: __s.currentCharacter.value?.uuid, revision: __s.conversationRevision,
            mediaEpoch: __s.wechatMediaEpoch, calls: 0, used: 0, seen: new Set(), records: new Map() });
        __s.resetHistoryRetrievalBudget = () => { __s.historyRetrievalBudget = __s.createHistoryRetrievalBudget(); };
        const clearTransient = __s.clearStoryBranchTransientContext;
        __s.clearStoryBranchTransientContext = () => {
            clearTransient?.();
            __s.historyRetrievalBudget?.records.clear();
            __s.resetHistoryRetrievalBudget();
        };
        __s.buildHistoryRetrievalPrompt = () => available()
            ? '【压缩后的原文检索】前情提要/记忆只是概要。提到具体旧事而当前上下文缺少依据、措辞有分歧时，可先 tool_search_history 找具体关键词，再 tool_read_history 按返回 ID 和命中字符位置核对。足够明确时直接承接，不为普通聊天凑工具。最多四次检索/读取，共 12000 字符结果，仅留本轮。关键词可能漏掉同义词，可换具体关键词；没找到就说无法确认，不编造所谓回忆。' + H.evidenceRule : '';
        const cleanRp = message => {
            let text = window.RPHubUtils.parseCot(String(message.content || '')).main;
            text = __s.stripDisabledImageGenContext(__s.stripNextResponsePrompt(__s.stripUiTemplateContextInjection(text)));
            text = stripUiTemplateUpdateBlock(text);
            if (message.role === 'user') text = __s.appendMessageImageDescriptions?.(message, text) || text;
            return text.replace(/data:image\/[^\s"'<>)]+/g, '[图片像素未附带]').trim();
        };
        const collect = () => {
            const records = [], rpByIndex = new Map(), rpById = new Map();
            const turnByIndex = new Map();
            (__s.buildConversationTurnSnapshot(__s.chatHistory.value, { includeSystem: false }).turns || []).forEach(turn =>
                (turn.sourceIndexes || []).forEach(index => turnByIndex.set(index, turn.turn)));
            __s.chatHistory.value.forEach((message, index) => {
                if (!message || !['user', 'assistant'].includes(message.role)) return;
                const text = cleanRp(message); if (!text) return;
                const record = { recordId: `rp:${message.id || 'index-' + index}`, channel: 'rp', role: message.role,
                    speaker: message.role === 'user' ? __s.user.name : __s.currentCharacter.value.name,
                    type: 'text', turn: turnByIndex.get(index), text, order: index, message };
                rpByIndex.set(index, record); if (message.id) rpById.set(message.id, record);
            });
            const emitted = new Set();
            for (const item of (__s.wechatTimeline?.value || [])) {
                if (item.channel === 'rp') {
                    const record = rpById.get(item.rpMsgId) || rpByIndex.get(item.rpIndex);
                    if (record && !emitted.has(record)) { record.order = records.length; records.push(record); emitted.add(record); }
                    continue;
                }
                if (item.channel !== 'wechat' || !['user', 'assistant'].includes(item.role) || !item.id) continue;
                let text = item.type === 'image' ? (__s.wechatImageRecordText?.(item) || '[图片]')
                    : item.type === 'document' ? (__s.wechatDocumentRecordText?.(item) || '[文件：原件需用文件工具读取]')
                    : item.type === 'voice' ? (__s.wechatVoiceRecordText?.(item) || `[语音] ${item.content}`)
                    : item.type === 'sticker' ? `[表情] ${item.content}` : String(item.content || '');
                if (item.replyDecision === 'silent') text += `\n【内部未回复状态，不是发送内容】${window.RPHubWeChatProtocol.describeSilence(item.replySilence)}`;
                const time = window.RPHubWeChatTime.itemTime(item);
                records.push({ recordId: `wechat:${item.id}`, channel: 'wechat', role: item.role,
                    speaker: item.role === 'user' ? __s.user.name : (__s.currentCharacter.value.wechatPeerName || __s.currentCharacter.value.name),
                    type: item.type, time: window.RPHubWeChatTime.valid(time) ? window.RPHubWeChatTime.format(time) : undefined,
                    text, order: records.length });
            }
            for (const record of rpByIndex.values()) if (!emitted.has(record)) { record.order = records.length; records.push(record); }
            return records;
        };
        __s.executeHistoryRetrievalTool = async (call, signal, budget = __s.historyRetrievalBudget) => {
            if (!budget) budget = __s.historyRetrievalBudget = __s.createHistoryRetrievalBudget();
            const check = () => {
                if (signal?.aborted || budget.scopeId !== scope() || budget.characterId !== __s.currentCharacter.value?.uuid || budget.revision !== __s.conversationRevision || budget.mediaEpoch !== __s.wechatMediaEpoch || __s.isConversationClearing?.value) throw new DOMException('会话已变化，旧检索作废', 'AbortError');
                if (!available()) throw new Error('本轮原文检索已关闭或没有可检索的压缩历史');
            };
            check();
            if (++budget.calls > 4) throw new Error('本轮原文检索/读取最多四次');
            const args = H.normalize(call.function.name, JSON.parse(call.function.arguments));
            const key = call.function.name + JSON.stringify(args);
            if (budget.seen.has(key)) throw new Error('本轮已经取得该检索结果，请用已有结果或换更具体的关键词/范围');
            budget.seen.add(key);
            // Read the current scope even if its WeChat switch was disabled after earlier chats.
            await __s.ensureWechatTimelineLoaded?.(false, true);
            check();
            const records = collect();
            let result, grants = [];
            if (call.function.name === 'tool_search_history') {
                const found = await H.search(records, args, check, __s.yieldToUi || (async () => {}));
                grants = found.hits.map(hit => hit.record);
                result = { status: found.hits.length ? 'ok' : 'empty', query: args.query, totalMatches: found.totalMatches,
                    results: found.hits.map(hit => hit.value), notice: H.evidenceRule };
            } else {
                const record = records.find(item => item.recordId === args.recordId);
                if (!record || budget.records.get(args.recordId) !== record.text) throw new Error('此 ID 未由本轮搜索返回，或原文已编辑/删除；请重新搜索当前记录');
                if (args.startChar >= record.text.length) throw new Error('起点超出原文，请按 totalChars 选择范围');
                const endChar = Math.min(record.text.length, args.startChar + args.length);
                result = { status: 'ok', ...H.metadata(record), startChar: args.startChar, endChar,
                    text: record.text.slice(args.startChar, endChar), hasMore: endChar < record.text.length, notice: H.evidenceRule };
            }
            check();
            const serialized = JSON.stringify(result);
            if (budget.used + serialized.length > 12000) throw new Error('本轮原文检索结果达到 12000 字符预算，请下一轮再核对');
            budget.used += serialized.length;
            grants.forEach(record => budget.records.set(record.recordId, record.text));
            return result;
        };
        const enabled = __s.getEnabledActiveTools;
        __s.getEnabledActiveTools = () => [...enabled(), ...__s.historyRetrievalTools().map(def => ({ id: def.function.name,
            callName: def.function.name, name: def.function.name === 'tool_search_history' ? '检索历史原文' : '读取历史原文',
            type: 'history_retrieval', enabled: true, description: def.function.description }))];
        const definitions = __s.buildActiveToolDefinitions;
        __s.buildActiveToolDefinitions = tools => [...definitions(tools.filter(tool => !names.has(tool.callName))),
            ...H.definitions.filter(def => tools.some(tool => tool.callName === def.function.name))];
        const parse = __s.parseNativeActiveToolCall;
        __s.parseNativeActiveToolCall = (call, tools) => {
            if (!names.has(call.function.name)) return parse(call, tools);
            const tool = tools.find(item => item.callName === call.function.name), result = { tool, callLabel: call.function.name, raw: call.function.arguments, reason: '', query: '' };
            try { if (!tool) throw new Error('原文检索未启用'); const args = H.normalize(call.function.name, JSON.parse(call.function.arguments)); result.query = args.query || `${args.recordId} / ${args.startChar}`; }
            catch (error) { result.error = error.message; }
            return result;
        };
        const requireCall = __s.shouldRequireActiveToolCall;
        __s.shouldRequireActiveToolCall = tools => requireCall(tools.filter(tool => !names.has(tool.callName)));
        const reminder = __s.getActiveToolInvocationReminder;
        __s.getActiveToolInvocationReminder = tools => {
            const others = tools.filter(tool => !names.has(tool.callName));
            return others.length ? reminder(others) : '旧事细节缺少依据时按需检索原文；依据充分时直接继续，不强制调用。';
        };
        const prompt = __s.buildActiveToolSystemPrompt;
        __s.buildActiveToolSystemPrompt = tools => [prompt(tools.filter(tool => !names.has(tool.callName))),
            tools.some(tool => names.has(tool.callName)) ? __s.buildHistoryRetrievalPrompt() : ''].filter(Boolean).join('\n');
    };
})();
