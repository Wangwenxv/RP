// Deterministic projections of accepted events. Display is not observation.
(function () {
    const M = () => window.RPHubWorldModel;
    const EVIDENCE_KINDS = new Set(['player.input', 'message.sent', 'action.committed', 'world.fact_asserted', 'world.fact_corrected', 'belief.adopted']);
    const canAccess = (snapshot, event, actorId) => !!event && snapshot.definition.actors.some(a => a.actorId === actorId)
        && Array.isArray(event.access?.principals) && event.access.principals.includes(actorId);
    const knownEventIds = (snapshot, actorId) => {
        const known = new Set();
        for (const event of snapshot.events) {
            if (EVIDENCE_KINDS.has(event.kind) && event.actorId === actorId && canAccess(snapshot, event, actorId)) known.add(event.eventId);
            if (event.actorId === actorId && ['message.read', 'observation.acquired'].includes(event.kind)) {
                for (const eventId of event.payload.eventIds || []) {
                    const source = snapshot.events.find(e => e.eventId === eventId);
                    if (canAccess(snapshot, source, actorId) && EVIDENCE_KINDS.has(source.kind)) known.add(eventId);
                }
            }
        }
        return known;
    };
    const hasObserved = (snapshot, eventId, actorId) => knownEventIds(snapshot, actorId).has(eventId);
    const observedEvents = (snapshot, actorId) => {
        const known = knownEventIds(snapshot, actorId);
        return snapshot.events.filter(e => known.has(e.eventId));
    };
    const conversationMessages = (snapshot, conversationId, actorId, options = {}) => {
        const known = options.observedOnly ? knownEventIds(snapshot, actorId) : null;
        return snapshot.events.filter(e => e.kind === 'message.sent' && e.conversationId === conversationId
            && canAccess(snapshot, e, actorId) && (!known || known.has(e.eventId))).map(e => ({ ...e,
            senderActorId: e.actorId, senderName: snapshot.definition.actors.find(a => a.actorId === e.actorId)?.name || e.actorId,
            text: M().eventText(e), observed: hasObserved(snapshot, e.eventId, actorId) }));
    };
    const readCursor = (snapshot, conversationId, actorId) => {
        const known = knownEventIds(snapshot, actorId);
        return snapshot.events.filter(e => e.kind === 'message.sent' && e.conversationId === conversationId && known.has(e.eventId))
            .reduce((n, e) => Math.max(n, e.seq), 0);
    };
    const upsertConversation = (list, conversation) => {
        const i = list.findIndex(c => c.conversationId === conversation.conversationId);
        if (i === -1) list.push(conversation); else list[i] = conversation;
    };
    const applyEvent = (snapshot, event) => {
        const p = event.payload;
        if (event.kind === 'conversation.created') upsertConversation(snapshot.conversations, M().normalizeConversation(p.conversation, snapshot.definition, event.seq));
        if (event.kind === 'conversation.member_joined' || event.kind === 'conversation.member_left') {
            const c = snapshot.conversations.find(c => c.conversationId === event.conversationId);
            if (!c) M().fail('成员事件引用不存在的会话');
            const target = p.actorId || event.actorId;
            if (event.kind.endsWith('joined')) {
                if (!snapshot.definition.actors.some(a => a.actorId === target)) M().fail('入群人物无效');
                if (M().activeMembers(c, event.seq).includes(target)) M().fail('人物已经是会话成员');
                c.memberships.push({ actorId: target, joinedAtSeq: event.seq });
                if (!c.participantActorIds.includes(target)) c.participantActorIds.push(target);
            } else {
                const membership = [...c.memberships].reverse().find(m => m.actorId === target && m.leftAtSeq == null);
                if (!membership) M().fail('退群人物当前不在会话');
                membership.leftAtSeq = event.seq;
                c.participantActorIds = c.participantActorIds.filter(a => a !== target);
            }
        }
        if (event.kind === 'actor.state_changed') snapshot.actorStates[event.actorId] = { ...(snapshot.actorStates[event.actorId] || {}), ...M().clone(p.state || {}) };
        if (event.kind === 'turn.updated' && !(snapshot.parentBranchId && event.seq <= snapshot.forkAtSeq)
            && (!p.turn?.branchId || p.turn.branchId === snapshot.branchId)) snapshot.turns[p.turnId || event.turnId] = M().clone(p.turn);
        if (event.kind === 'pending.replaced') snapshot.pendingActions = M().clone(p.pendingActions || []);
        if (event.kind === 'pending.created' || event.kind === 'pending.updated') {
            const task = M().clone(p.action || p.pendingAction);
            if (!task) M().fail('待办事件无效');
            const i = snapshot.pendingActions.findIndex(a => (a.actionId || a.pendingActionId) === (task.actionId || task.pendingActionId));
            if (i < 0) snapshot.pendingActions.push(task); else snapshot.pendingActions[i] = task;
        }
        if (event.kind === 'pending.completed') snapshot.pendingActions = snapshot.pendingActions.filter(a => (a.actionId || a.pendingActionId) !== (p.actionId || p.pendingActionId));
        if (event.kind === 'world.clock_advanced') snapshot.storyTime = p.storyTime;
        if (event.kind === 'action.committed' && p.state) snapshot.actorStates[event.actorId] = { ...(snapshot.actorStates[event.actorId] || {}), ...M().clone(p.state) };
        return snapshot;
    };
    const replay = (snapshot, options = {}) => {
        const throughSeq = options.throughSeq == null ? snapshot.events.length : options.throughSeq;
        if (!Number.isSafeInteger(throughSeq) || throughSeq < 0 || throughSeq > snapshot.events.length) M().fail('检查点序列无效');
        const result = M().clone(snapshot), base = snapshot.baseState || {};
        result.events = [];
        result.conversations = M().clone(base.conversations || []);
        result.actorStates = M().clone(base.actorStates || {});
        result.turns = M().clone(base.turns || {});
        result.pendingActions = M().clone(base.pendingActions || []);
        result.storyTime = base.storyTime || snapshot.storyTime;
        for (const event of snapshot.events.slice(0, throughSeq)) { applyEvent(result, event); result.events.push(M().clone(event)); }
        return result;
    };
    window.RPHubWorldProjections = Object.freeze({ EVIDENCE_KINDS, canAccess, knownEventIds, hasObserved,
        observedEvents, conversationMessages, readCursor, applyEvent, replay });
})();
