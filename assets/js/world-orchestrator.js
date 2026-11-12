// Bounded, player-driven world turns. Generated proposals never write directly to the store.
(function () {
    const locks = new Set();
    const clone = value => JSON.parse(JSON.stringify(value));
    const Core = () => window.RPHubWorldModel;
    const Store = () => window.RPHubWorldStore;
    const Context = () => window.RPHubActorContext;
    const Projection = () => window.RPHubWorldProjections;
    const Runtime = () => window.RPHubActorRuntime;
    const uuid = () => window.RPHubUtils?.generateUUID?.() || `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const actor = (snapshot, id) => Context().actorOf(snapshot, id);
    const canSimulate = (snapshot, id) => actor(snapshot, id)?.enabled !== false && !!actor(snapshot, id)?.card;
    function canReadPhone(snapshot, actorId) {
        const state = snapshot.actorStates?.[actorId] || {};
        const phone = typeof state.phoneAccess === 'object' ? state.phoneAccess.value || state.phoneAccess.status : state.phoneAccess;
        if (phone === 'blocked' && state.phoneRestrictedUntil && timeNumber(state.phoneRestrictedUntil) <= timeNumber(snapshot.storyTime)) return true;
        return !['unavailable', 'blocked', 'off', 'no_power', 'confiscated', 'put_away', '收起', '没电', '禁止使用'].includes(phone)
            && state.canReadMessages !== false;
    }
    function timeNumber(value) {
        if (window.RPHubWeChatTime?.parse) return window.RPHubWeChatTime.parse(value) ?? NaN;
        return Date.parse(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:\d\d$/.test(String(value)) ? '' : 'Z'));
    }
    function advanceTime(value, minutes) {
        const date = new Date(timeNumber(value) + minutes * 60000);
        return date.toISOString().slice(0, 19);
    }
    const access = principals => ({ principals: [...new Set(principals)] });
    function eventDraft(turn, snapshot, kind, actorId, conversationId, payload, principals, causes = []) {
        return { kind, actorId, ...(conversationId ? { conversationId } : {}), turnId: turn.turnId,
            storyTime: snapshot.storyTime, access: access(principals), payload, causedBy: [...new Set(causes)],
            source: { kind: kind === 'player.input' && payload.inputMode === 'author_premise' ? 'player_author'
                : kind === 'player.input' || (kind === 'message.sent' && actorId === snapshot.definition.playerActorId)
                ? 'player_input' : ['message.sent', 'action.committed', 'belief.adopted', 'narration.published'].includes(kind)
                    ? 'npc_generated' : 'program', runId: `${turn.turnId}:${actorId}` } };
    }
    function conversationOf(snapshot, id) { return snapshot.conversations.find(item => item.conversationId === id); }
    function participants(snapshot, conversation) {
        const nextSeq = (snapshot.events.at(-1)?.seq || 0) + 1;
        return conversation.participantActorIds.filter(id => !conversation.memberships?.length
            || conversation.memberships.some(member => member.actorId === id && (member.joinedAtSeq || 0) <= nextSeq
                && (member.leftAtSeq === undefined || member.leftAtSeq === null || nextSeq < member.leftAtSeq)));
    }
    function candidateOrder(snapshot, ids, text) {
        const playerId = snapshot.definition.playerActorId;
        const unique = [...new Set(ids)].filter(id => id !== playerId && actor(snapshot, id)?.enabled !== false && actor(snapshot, id)?.card);
        const offset = snapshot.events.length % (unique.length || 1);
        return unique.map((id, index) => ({ id, score: (String(text).includes(actor(snapshot, id).name) ? 100 : 0)
            + (canReadPhone(snapshot, id) ? 10 : 0) - (snapshot.actorStates?.[id]?.replyOrder ?? ((index + offset) % unique.length)) }))
            .sort((a, b) => b.score - a.score).map(item => item.id);
    }
    function unreadMessages(snapshot, actorId, conversationId) {
        return snapshot.events.filter(event => event.kind === 'message.sent'
            && (!conversationId || event.conversationId === conversationId)
            && Projection().canAccess(snapshot, event, actorId)
            && !Projection().hasObserved(snapshot, event.eventId, actorId));
    }
    function deriveSceneIds(snapshot, turnId) {
        const savedInput = snapshot.turns?.[turnId]?.existingInputEventId;
        return snapshot.events.filter(event => (event.turnId === turnId || event.eventId === savedInput)
            && ['player.input', 'message.sent', 'action.committed', 'belief.adopted', 'actor.state_changed', 'world.fact_asserted'].includes(event.kind))
            .map(event => event.eventId);
    }
    function routeMove(snapshot, actorId, placeId, mode) {
        const map = snapshot.definition.map?.data || snapshot.definition.map;
        const current = snapshot.actorStates?.[actorId]?.position || snapshot.actorStates?.[actorId]?.location;
        const from = current?.placeId || (typeof current === 'string' ? current : null);
        if (!map || !from || !window.RPHubGeography) return null;
        try {
            const result = window.RPHubGeography.route(map, from, placeId, { mode: mode === 'bike' ? 'bike' : 'walk' });
            if (result.status !== 'ok') return null;
            const minutes = result.minutes ?? result.durationMinutes ?? result.totalMinutes ?? result.duration?.typicalMinutes;
            return Number.isFinite(minutes) && minutes >= 0 ? { from, minutes: Math.ceil(minutes), result } : null;
        } catch (_) { return null; }
    }
    async function execute(options, retry) {
        const { sessionId, branchId, signal, onUpdate, apiConfig, modelRunner } = options;
        const lockKey = JSON.stringify([sessionId, branchId]);
        if (locks.has(lockKey)) throw new Error('这个世界分支正在生成，请先等待或停止当前回合');
        locks.add(lockKey);
        let snapshot, turn, budget;
        const maxSteps = Number(apiConfig?.maxWorldCalls) > 6 ? 6 : 3;
        const usage = [];
        const publish = () => { try { onUpdate?.(clone(snapshot)); } catch (_) { } };
        async function commit(key, events = [], patch = {}, checkSignal = true) {
            if (checkSignal) Runtime().abortCheck(signal);
            snapshot = await Store().commit({ sessionId, branchId: snapshot.branchId,
                expectedRevision: snapshot.revision, idempotencyKey: key, events, patch });
            publish();
            return snapshot;
        }
        function saveTurn(status) {
            if (status) turn.status = status;
            turn.callsUsed = budget.callsUsed;
            turn.usage = [...(turn.usage || []), ...usage.splice(0)];
            turn.sceneEventIds = deriveSceneIds(snapshot, turn.turnId);
            return { turns: { [turn.turnId]: clone(turn) } };
        }
        function enqueueReaction(target, conversationId, depth, inPerson = false, sceneParticipantActorIds = []) {
            if (target === snapshot.definition.playerActorId || !canSimulate(snapshot, target) || depth > 2) return;
            const waiting = turn.queue.slice(turn.stepIndex + 1).find(item => item.actorId === target);
            if (waiting) { Object.assign(waiting, { conversationId, depth, inPerson, sceneParticipantActorIds, ownScene: false }); return; }
            if (turn.queue.length >= maxSteps || turn.queue.filter(item => item.actorId === target).length >= 2) return;
            turn.queue.push({ actorId: target, conversationId, depth, inPerson, sceneParticipantActorIds, revisit: true });
        }
        try {
            Runtime().abortCheck(signal);
            snapshot = await Store().load(sessionId, branchId);
            if (!snapshot) throw new Error('世界分支不存在');
            if (!retry && options.turnId && snapshot.turns?.[options.turnId]) {
                if (snapshot.turns[options.turnId].status === 'complete') return snapshot;
                throw new Error('这次玩家输入已保存，请使用重试继续未完成的回合');
            }
            if (retry) {
                const found = snapshot.turns?.[options.turnId];
                if (!found || found.status === 'complete') return snapshot;
                if ((found.sessionId && found.sessionId !== sessionId) || (found.branchId && found.branchId !== snapshot.branchId)) throw new Error('不能在另一条世界分支恢复旧回合');
                const checkpoint = [...snapshot.events].reverse().find(event => event.kind === 'turn.updated' && event.payload.turnId === options.turnId)?.seq || 0;
                const suffix = snapshot.events.filter(event => event.seq > checkpoint);
                const readOnlySuffix = suffix.every(event => event.actorId === snapshot.definition.playerActorId
                    && ['message.read', 'observation.acquired'].includes(event.kind));
                if (!readOnlySuffix) throw new Error('世界已在失败后发生变化，请停止旧回合再创建新的回合；旧提案不能换版本重贴');
                turn = clone(found);
                // A user retry is a new bounded attempt, while cumulative calls remain auditable.
                turn.totalCalls = (turn.totalCalls || 0) + (turn.callsUsed || 0);
                budget = { callsUsed: 0, maxCalls: Math.max(6, Math.min(18, Number(apiConfig?.maxWorldCalls) || 6)) };
                turn.status = 'running'; delete turn.error; delete turn.resumeRevision;
                await commit(`${turn.turnId}:retry:${turn.retryCount = (turn.retryCount || 0) + 1}`, [], saveTurn());
            } else {
                const unfinished = Object.values(snapshot.turns || {}).find(item => ['running', 'narrating', 'failed'].includes(item.status));
                if (unfinished) throw new Error('有尚未完成的世界回合，请先重试或停止它，再发送新的输入');
                const kind = options.kind || 'wechat';
                if (!['wechat', 'rp', 'advance'].includes(kind)) throw new Error('未知世界回合类型');
                const pendingInputs = window.RPHubWorldChat?.pendingInputs(snapshot, options.conversationId) || [];
                const savedInput = options.existingInputEventId ? snapshot.events.find(e => e.eventId === options.existingInputEventId) : null;
                if (options.existingInputEventId && (kind !== 'rp' || !savedInput || savedInput.kind !== 'player.input'
                    || savedInput.actorId !== snapshot.definition.playerActorId || savedInput.payload.channel !== 'rp'
                    || savedInput.conversationId !== options.conversationId
                    || snapshot.events.some(e => e.kind === 'turn.updated' && e.seq > savedInput.seq))) throw new Error('只能继续尚未重新回应的 RP 输入');
                const text = savedInput ? savedInput.payload.text : options.replyOnly ? pendingInputs.map(e => e.payload.text).join('\n') : String(options.text || '').trim();
                if (!text && kind !== 'advance') throw new Error('请先输入消息或剧情');
                if (text.length > 30000) throw new Error('玩家本轮输入过长');
                if (options.storyTime && (!Number.isFinite(timeNumber(options.storyTime))
                    || timeNumber(options.storyTime) < timeNumber(snapshot.storyTime))) throw new Error('剧情时间不能无效或倒退；回到过去请使用世界分支');
                const conversation = conversationOf(snapshot, options.conversationId);
                if (kind === 'wechat' && (!conversation || conversation.kind === 'rp'
                    || !participants(snapshot, conversation).includes(snapshot.definition.playerActorId))) throw new Error('玩家不能在这个会话发送微信');
                const selected = kind === 'wechat' ? participants(snapshot, conversation)
                    : savedInput ? savedInput.access.principals.filter(id => id !== snapshot.definition.playerActorId) : (options.actorIds || []);
                if (selected.some(id => !actor(snapshot, id))) throw new Error('本轮人物不存在');
                const ordered = kind === 'advance' ? [] : candidateOrder(snapshot, selected, text).slice(0, 3);
                turn = { turnId: options.turnId || uuid(), sessionId, branchId: snapshot.branchId, kind, text, conversationId: options.conversationId || null,
                    witnessActorIds: kind === 'rp' ? [...new Set(savedInput ? selected : options.witnessActorIds || selected)] : [],
                    status: 'running', queue: ordered.map(id => ({ actorId: id, conversationId: options.conversationId || null, depth: 0 })),
                    stepIndex: 0, completedActorIds: [], actorResults: {}, callsUsed: 0, totalCalls: 0,
                    sceneEventIds: [], usage: [], retryCount: 0, inputMode: savedInput?.payload.inputMode || options.inputMode || 'player_action',
                    existingInputEventId: savedInput?.eventId || null, previousStoryTime: snapshot.storyTime,
                    inputMessageIds: pendingInputs.map(e => e.eventId) };
                budget = { callsUsed: 0, maxCalls: Math.max(6, Math.min(18, Number(apiConfig?.maxWorldCalls) || 6)) };
                const inputPrincipals = kind === 'wechat' ? participants(snapshot, conversation)
                    : [snapshot.definition.playerActorId, ...turn.witnessActorIds];
                const newTime = options.storyTime || snapshot.storyTime;
                const atSnapshot = { ...snapshot, storyTime: newTime };
                const events = savedInput || options.replyOnly || kind === 'advance' ? [] : [eventDraft(turn, atSnapshot, 'player.input', snapshot.definition.playerActorId,
                    options.conversationId || null, { text, channel: kind, inputMode: turn.inputMode }, inputPrincipals)];
                if (kind === 'wechat' && !options.replyOnly) events.push(eventDraft(turn, atSnapshot, 'message.sent', snapshot.definition.playerActorId,
                    options.conversationId, { text, type: 'text' }, inputPrincipals));
                if (kind === 'rp') {
                    const input = savedInput || events.find(e => e.kind === 'player.input');
                    if (!input.eventId) input.eventId = Core().id('event');
                    for (const id of turn.witnessActorIds.filter(id => !Projection().hasObserved(snapshot, input.eventId, id)))
                        events.push(eventDraft(turn, atSnapshot, 'observation.acquired', id, options.conversationId,
                            { eventIds: [input.eventId] }, [id], [input.eventId]));
                }
                await commit(`${turn.turnId}:input`, events, { ...saveTurn(), storyTime: newTime });
            }
            if (turn.kind === 'rp' && turn.inputMode === 'author_premise' && !turn.directorApplied && window.RPHubWorldDirector) {
                const beforeRevision = snapshot.revision;
                const result = await window.RPHubWorldDirector.interpret({ snapshot, text: turn.text, apiConfig, signal, budget, modelRunner,
                    onUsage: record => usage.push(record) });
                if ((await Store().load(sessionId, snapshot.branchId)).revision !== beforeRevision) throw new Error('世界在场景解析期间发生变化');
                const input = snapshot.events.find(e => e.turnId === turn.turnId && e.kind === 'player.input')
                    || snapshot.events.find(e => e.eventId === turn.existingInputEventId);
                turn.directorApplied = true;
                const facts = result.facts.map(f => eventDraft(turn, snapshot, 'world.fact_asserted', f.actorId, null,
                    { text: f.text, evidenceStatus: 'author_premise' }, [f.actorId], input ? [input.eventId] : []));
                await commit(`${turn.turnId}:director`, facts, { ...saveTurn(), actorStates: result.changes });
            }
            // No timer executes this section. Only a player invocation settles due actions.
            const released = {};
            for (const [id, state] of Object.entries(snapshot.actorStates || {})) {
                if (state.phoneAccess === 'blocked' && state.phoneRestrictedUntil
                    && timeNumber(state.phoneRestrictedUntil) <= timeNumber(snapshot.storyTime))
                    released[id] = { ...clone(state), phoneAccess: 'available', phoneRestrictedUntil: null,
                        source: 'known_restriction_expired', updatedAt: snapshot.storyTime };
            }
            if (Object.keys(released).length) await commit(`${turn.turnId}:phone-release`, [], { ...saveTurn(), actorStates: released });
            const pending = clone(snapshot.pendingActions || []);
            let pendingChanged = false;
            for (const task of pending) {
                if (task.status !== 'pending' || !task.dueAt || timeNumber(task.dueAt) > timeNumber(snapshot.storyTime)) continue;
                if (task.type === 'move' && task.routeVerified) {
                    const state = clone(snapshot.actorStates?.[task.actorId] || {});
                    state.position = { status: 'confirmed', placeId: task.placeId, source: task.pendingActionId, storyTime: snapshot.storyTime };
                    task.status = 'complete'; pendingChanged = true;
                    await commit(`${turn.turnId}:due:${task.pendingActionId}`, [eventDraft(turn, snapshot, 'action.committed',
                        task.actorId, null, { type: 'arrived', text: `${actor(snapshot, task.actorId).name}到达${task.placeId}`, placeId: task.placeId },
                        [task.actorId], task.sourceEvidenceIds || [])], { actorStates: { [task.actorId]: state } });
                } else if (['reply', 'tell', 'wait'].includes(task.type) && canSimulate(snapshot, task.actorId) && turn.queue.length < maxSteps) {
                    if (!turn.queue.some(item => item.actorId === task.actorId)) turn.queue.push({ actorId: task.actorId,
                        conversationId: task.conversationId || null, depth: 0, pendingActionId: task.pendingActionId });
                    task.status = 'rescheduled'; pendingChanged = true;
                }
            }
            if (pendingChanged) await commit(`${turn.turnId}:settle-pending`, [], { ...saveTurn(), pendingActions: pending });
            if (turn.kind === 'advance') {
                const ids = candidateOrder(snapshot, snapshot.definition.actors.filter(item => item.actorId !== snapshot.definition.playerActorId)
                    .filter(item => canReadPhone(snapshot, item.actorId) && unreadMessages(snapshot, item.actorId).length).map(item => item.actorId), '');
                for (const id of ids) if (turn.queue.length < maxSteps && !turn.queue.some(item => item.actorId === id))
                    turn.queue.push({ actorId: id, conversationId: unreadMessages(snapshot, id).at(-1)?.conversationId, depth: 0 });
                const ownScenes = candidateOrder(snapshot, snapshot.definition.actors.filter(item => canSimulate(snapshot, item.actorId))
                    .map(item => item.actorId), '');
                for (const id of ownScenes) if (turn.queue.length < maxSteps && !turn.queue.some(item => item.actorId === id && item.ownScene))
                    turn.queue.push({ actorId: id, conversationId: null, depth: 0, ownScene: true, revisit: turn.queue.some(item => item.actorId === id) });
                await commit(`${turn.turnId}:advance-queue`, [], saveTurn());
            }
            while (turn.stepIndex < turn.queue.length) {
                Runtime().abortCheck(signal);
                const stepIndex = turn.stepIndex, step = turn.queue[stepIndex];
                if (turn.completedActorIds.includes(step.actorId) && !step.revisit) { turn.stepIndex++; continue; }
                const isWechat = turn.kind === 'wechat' || (turn.kind === 'advance' && !!step.conversationId
                    && conversationOf(snapshot, step.conversationId)?.kind !== 'rp' && !step.inPerson);
                if (isWechat && !canReadPhone(snapshot, step.actorId)) {
                    turn.actorResults[step.actorId] = { status: 'unread', reason: 'known_phone_restriction' };
                    turn.completedActorIds.push(step.actorId); turn.stepIndex++;
                    await commit(`${turn.turnId}:step:${stepIndex}:${step.actorId}:unread`, [], saveTurn());
                    continue;
                }
                const rpPhone = turn.kind === 'rp' && step.conversationId && conversationOf(snapshot, step.conversationId)?.kind !== 'rp'
                    && canReadPhone(snapshot, step.actorId);
                const unread = isWechat || rpPhone ? unreadMessages(snapshot, step.actorId, step.conversationId) : [];
                const rpInputs = !isWechat ? snapshot.events.filter(event => event.turnId === turn.turnId && event.kind === 'player.input'
                    && Projection().canAccess(snapshot, event, step.actorId)
                    && !Projection().hasObserved(snapshot, event.eventId, step.actorId)) : [];
                const toRead = [...unread, ...rpInputs];
                if (toRead.length) {
                    const groups = new Map();
                    for (const event of toRead) {
                        const key = `${event.kind === 'message.sent' ? 'message.read' : 'observation.acquired'}|${event.conversationId || ''}`;
                        if (!groups.has(key)) groups.set(key, { kind: event.kind === 'message.sent' ? 'message.read' : 'observation.acquired',
                            conversationId: event.conversationId, events: [] });
                        groups.get(key).events.push(event);
                    }
                    const readEvents = [...groups.values()].map(group => eventDraft(turn, snapshot, group.kind, step.actorId,
                        group.conversationId, { eventIds: group.events.map(event => event.eventId) }, [step.actorId], group.events.map(event => event.eventId)));
                    await commit(`${turn.turnId}:read:${step.actorId}:${snapshot.revision}`, readEvents, saveTurn());
                }
                const stimulus = isWechat ? Context().observed(snapshot, step.actorId).filter(event => event.conversationId === step.conversationId)
                    .slice(-5).map(event => `${actor(snapshot, event.actorId)?.name || event.actorId}: ${Context().textOf(event)}`).join('\n')
                    : (turn.witnessActorIds.includes(step.actorId) ? `${turn.inputMode === 'author_premise' ? '【作者剧情前提】' : '【玩家明确输入】'}\n${turn.text}`
                        : turn.kind === 'advance' ? `世界时间从 ${turn.previousStoryTime || snapshot.storyTime} 推进到 ${snapshot.storyTime}。根据你实际获知的信息与当前状态继续自己的生活；你可以保持现状，不必强行行动。`
                            : '根据你实际获知的信息，继续自己的场景。');
                const beforeRevision = snapshot.revision;
                const result = await Runtime().runActor({ snapshot, actorId: step.actorId, conversationId: step.conversationId,
                    kind: isWechat ? 'wechat' : 'rp', stimulus, apiConfig, signal, budget, modelRunner,
                    onUsage: record => usage.push(record), maxCharacters: apiConfig?.contextBudget || undefined });
                Runtime().abortCheck(signal);
                // Re-read only to reject a stale proposal, never to rebase and submit it.
                const current = await Store().load(sessionId, snapshot.branchId);
                if (current.revision !== beforeRevision) throw Object.assign(new Error('世界分支已变化，旧角色提案已丢弃'), { name: 'WorldConflictError' });
                const proposal = result.proposal, events = [], changes = {}, newConversations = [], tasks = clone(snapshot.pendingActions || []);
                const cause = proposal.referencedEvidenceIds.filter(id => snapshot.events.some(event => event.eventId === id));
                const c = conversationOf(snapshot, step.conversationId);
                const visibleParticipants = step.ownScene || (turn.kind === 'advance' && !isWechat && !step.inPerson)
                    || (turn.kind === 'rp' && step.depth === 0 && !turn.witnessActorIds.includes(step.actorId)) ? [step.actorId]
                    : isWechat && c ? participants(snapshot, c)
                    : step.depth > 0 ? [...new Set([step.actorId, ...(step.sceneParticipantActorIds || [])])]
                        : [...new Set([snapshot.definition.playerActorId, ...turn.witnessActorIds, step.actorId])];
                if (proposal.decision === 'silent' && proposal.silence) events.push(eventDraft(turn, snapshot, 'belief.adopted', step.actorId, null,
                    { type: 'silence', text: window.RPHubWeChatProtocol.describeSilence(proposal.silence), silence: proposal.silence,
                        evidenceStatus: 'subjective_state' }, [step.actorId], cause));
                for (const [index, action] of proposal.actions.entries()) {
                    if (action.delayMinutes > 0 || action.kind === 'wait') {
                        tasks.push({ pendingActionId: `${turn.turnId}:${stepIndex}:${step.actorId}:${index}`, actorId: step.actorId,
                            type: action.kind, status: 'pending', dueAt: action.delayMinutes ? advanceTime(snapshot.storyTime, action.delayMinutes) : null,
                            ...action, conversationId: step.conversationId, sourceEvidenceIds: cause, turnId: turn.turnId });
                        continue;
                    }
                    if (action.kind === 'reply') {
                        if (!c || !visibleParticipants.includes(step.actorId)) throw new Error('回复者不属于这个会话');
                        events.push(eventDraft(turn, snapshot, 'message.sent', step.actorId, c.conversationId,
                            { text: action.text, type: 'text' }, visibleParticipants, cause));
                    } else if (action.kind === 'tell') {
                        const target = action.targetActorId;
                        if (action.channel !== 'in_person' && !canReadPhone(snapshot, step.actorId)) {
                            tasks.push({ pendingActionId: `${turn.turnId}:${stepIndex}:${step.actorId}:${index}`, actorId: step.actorId,
                                type: 'tell', status: 'pending', dueAt: snapshot.actorStates?.[step.actorId]?.phoneRestrictedUntil || null,
                                ...action, sourceEvidenceIds: cause, reason: 'sender_phone_restriction', turnId: turn.turnId });
                            continue;
                        }
                        if (action.channel === 'in_person') {
                            const a = snapshot.actorStates?.[step.actorId]?.position, b = snapshot.actorStates?.[target]?.position;
                            const ap = typeof a === 'string' ? a : a?.placeId, bp = typeof b === 'string' ? b : b?.placeId;
                            if (!ap || ap !== bp || a?.status === 'travelling' || b?.status === 'travelling') {
                                tasks.push({ pendingActionId: `${turn.turnId}:${stepIndex}:${step.actorId}:${index}`, actorId: step.actorId,
                                    type: 'tell', status: 'pending', dueAt: null, ...action, sourceEvidenceIds: cause,
                                    reason: 'no_confirmed_meeting', turnId: turn.turnId });
                                continue;
                            }
                            events.push(eventDraft(turn, snapshot, 'action.committed', step.actorId, null,
                                { type: 'tell', text: action.text, targetActorId: target, channel: 'in_person' }, [step.actorId, target], cause));
                            enqueueReaction(target, null, step.depth + 1, true, [step.actorId, target]);
                        } else {
                            const conversationId = `dm:${[step.actorId, target].sort().join(':')}`;
                            if (!conversationOf(snapshot, conversationId) && !newConversations.some(item => item.conversationId === conversationId))
                                newConversations.push({ conversationId, kind: 'dm', name: `${actor(snapshot, step.actorId).name} · ${actor(snapshot, target).name}`,
                                    participantActorIds: [step.actorId, target], memberships: [step.actorId, target].map(actorId => ({ actorId, joinedAtSeq: 0 })) });
                            events.push(eventDraft(turn, snapshot, 'message.sent', step.actorId, conversationId,
                                { text: action.text, type: 'text', targetActorId: target }, [step.actorId, target], cause));
                            enqueueReaction(target, conversationId, step.depth + 1);
                        }
                    } else if (action.kind === 'move') {
                        const route = routeMove({ ...snapshot, actorStates: { ...snapshot.actorStates, ...changes } }, step.actorId, action.placeId, action.mode);
                        const task = { pendingActionId: `${turn.turnId}:${stepIndex}:${step.actorId}:${index}`, actorId: step.actorId,
                            type: 'move', status: 'pending', placeId: action.placeId, sourceEvidenceIds: cause, turnId: turn.turnId,
                            routeVerified: !!route, dueAt: route ? advanceTime(snapshot.storyTime, route.minutes) : null,
                            ...(route ? { from: route.from, routeMinutes: route.minutes } : { reason: 'unknown_route_or_position' }) };
                        tasks.push(task);
                        if (route) {
                            const state = clone(changes[step.actorId] || snapshot.actorStates?.[step.actorId] || {});
                            state.position = { status: 'travelling', placeId: route.from, to: action.placeId, arrivalTime: task.dueAt };
                            changes[step.actorId] = state;
                            events.push(eventDraft(turn, snapshot, 'action.committed', step.actorId, null,
                                { type: 'departed', text: action.text || `前往${action.placeId}`, to: action.placeId, routeMinutes: route.minutes }, [step.actorId], cause));
                        }
                    } else {
                        if (action.state) changes[step.actorId] = { ...clone(changes[step.actorId] || snapshot.actorStates?.[step.actorId] || {}),
                            ...clone(action.state), source: 'npc_action', updatedAt: snapshot.storyTime };
                        const event = eventDraft(turn, snapshot, action.kind === 'remember' ? 'belief.adopted' : 'action.committed', step.actorId,
                            null, { type: action.kind, text: action.text, ...(action.state ? { state: changes[step.actorId] } : {}), evidenceStatus: action.kind === 'remember' ? 'subjective_intent' : 'npc_action' },
                            action.kind === 'remember' ? [step.actorId] : visibleParticipants, cause);
                        event.eventId = Core().id('event'); events.push(event);
                        if (['speak', 'act'].includes(action.kind)) for (const observer of visibleParticipants.filter(id => id !== step.actorId))
                            events.push(eventDraft(turn, snapshot, 'observation.acquired', observer, null,
                                { eventIds: [event.eventId] }, [observer], [event.eventId]));
                    }
                }
                turn.actorResults[step.actorId] = { status: proposal.decision, proposal, contextBudget: result.contextBudget };
                if (!turn.completedActorIds.includes(step.actorId)) turn.completedActorIds.push(step.actorId);
                turn.stepIndex++;
                // Scope commits and tasks to the queue step: an actor can react twice in one turn.
                // Retrying a saved step still uses the same key and cannot duplicate its actions.
                await commit(`${turn.turnId}:step:${stepIndex}:${step.actorId}:accepted`, events,
                    { ...saveTurn(), ...(newConversations.length ? { conversations: newConversations } : {}),
                        actorStates: changes, pendingActions: tasks });
                // In-person tell is already heard; add only the actual utterance to the recipient's observation.
                const tells = snapshot.events.filter(event => event.turnId === turn.turnId && event.actorId === step.actorId
                    && event.kind === 'action.committed' && event.payload.type === 'tell' && event.payload.channel === 'in_person');
                for (const tell of tells) {
                    const target = tell.payload.targetActorId;
                    if (!Projection().hasObserved(snapshot, tell.eventId, target)) await commit(`${tell.eventId}:heard`, [eventDraft(turn, snapshot,
                        'observation.acquired', target, null, { eventIds: [tell.eventId] }, [target], [tell.eventId])], saveTurn());
                }
                if (proposal.needsPlayerResponse) {
                    turn.responsePoint = true;
                    // Remaining decisions stay pending instead of inventing the player's answer.
                    break;
                }
            }
            turn.sceneEventIds = deriveSceneIds(snapshot, turn.turnId);
            if (['rp', 'advance'].includes(turn.kind) && !turn.narrationPublished) {
                await commit(`${turn.turnId}:ready-narration:${snapshot.revision}`, [], saveTurn('narrating'));
                const beforeRevision = snapshot.revision;
                const narration = await window.RPHubSceneNarrator.narrate({ snapshot, turn, apiConfig, signal, budget,
                    modelRunner, onUsage: record => usage.push(record) });
                Runtime().abortCheck(signal);
                if ((await Store().load(sessionId, snapshot.branchId)).revision !== beforeRevision) throw Object.assign(new Error('世界已变化，叙述草稿已丢弃'), { name: 'WorldConflictError' });
                const event = eventDraft(turn, snapshot, 'narration.published', snapshot.definition.playerActorId, turn.conversationId,
                    { text: narration.text, coveredEventIds: narration.coveredEventIds, readerOnly: true }, [], narration.coveredEventIds);
                turn.narrationPublished = true;
                await commit(`${turn.turnId}:narration`, [event], saveTurn('complete'));
            } else await commit(`${turn.turnId}:complete`, [], saveTurn('complete'));
            // Memory failure must never undo dialogue or leave a completed turn blocking the composer.
            if (apiConfig?.memoryEnabled && window.RPHubWorldMemory) {
                const ids = snapshot.definition.actors.filter(a => a.enabled !== false && a.actorId !== snapshot.definition.playerActorId)
                    .map(a => a.actorId).sort((a, b) => (window.RPHubWorldMemory.records(snapshot, a).at(-1)?.seq || 0)
                        - (window.RPHubWorldMemory.records(snapshot, b).at(-1)?.seq || 0));
                for (const actorId of ids) {
                    if (signal?.aborted || budget.callsUsed >= budget.maxCalls) break;
                    try {
                        const draft = await window.RPHubWorldMemory.summarize({ snapshot, actorId, apiConfig, signal, budget, modelRunner,
                            onUsage: record => usage.push(record) });
                        if (draft) await commit(`${turn.turnId}:memory:${actorId}`, [draft], saveTurn('complete'));
                    } catch (e) {
                        if (e.name === 'AbortError') break;
                        turn.memoryWarning = e.message;
                        await commit(`${turn.turnId}:memory-warning:${actorId}`, [], saveTurn('complete'), false);
                    }
                }
            }
            return snapshot;
        } catch (error) {
            if (snapshot && turn && budget && turn.status !== 'complete') {
                turn.error = { name: error.name || 'Error', message: error.message };
                turn.status = error.name === 'AbortError' ? 'paused' : 'failed';
                turn.callsUsed = budget.callsUsed;
                turn.sceneEventIds = deriveSceneIds(snapshot, turn.turnId);
                turn.usage = [...(turn.usage || []), ...usage];
                // The revision after this commit is the only safe version for an explicit retry.
                turn.resumeRevision = snapshot.revision + 1;
                try { await commit(`${turn.turnId}:failure:${turn.retryCount || 0}:${snapshot.revision}`, [],
                    { turns: { [turn.turnId]: turn } }, false); } catch (_) { /* Conflict must not overwrite a newer branch. */ }
            }
            throw error;
        } finally { locks.delete(lockKey); }
    }
    const runTurn = options => execute(options, false);
    const retryTurn = options => execute(options, true);
    const cancelTurn = async ({ sessionId, branchId, turnId }) => {
        const snapshot = await Store().load(sessionId, branchId), turn = snapshot.turns?.[turnId];
        if (!turn || ['complete', 'cancelled'].includes(turn.status)) return snapshot;
        return Store().commit({ sessionId, branchId: snapshot.branchId, expectedRevision: snapshot.revision,
            idempotencyKey: `${turnId}:user-cancel:${snapshot.revision}`, patch: { turns: { [turnId]: { ...clone(turn), status: 'cancelled' } } } });
    };
    window.RPHubWorldOrchestrator = Object.freeze({ runTurn, retryTurn, cancelTurn, canReadPhone, candidateOrder, unreadMessages, routeMove });
})();
