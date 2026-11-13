// World adapters for the shared WeChat protocol. Sending a burst never calls a model.
(function () {
    const pendingInputs = (snapshot, conversationId) => {
        const settled = new Set();
        // Forks deliberately clear resumable turns, but completed historical batches remain settled.
        const turns = new Map(snapshot.events.filter(e => e.kind === 'turn.updated').map(e => [e.payload.turnId, e.payload.turn]));
        for (const turn of turns.values()) if (turn.status === 'complete' && turn.conversationId === conversationId) {
            (turn.inputMessageIds || []).forEach(id => settled.add(id));
            snapshot.events.filter(e => e.kind === 'message.sent' && e.turnId === turn.turnId && e.actorId === snapshot.definition.playerActorId).forEach(e => settled.add(e.eventId));
        }
        return snapshot.events.filter(e => e.kind === 'message.sent' && e.conversationId === conversationId
            && e.actorId === snapshot.definition.playerActorId && !settled.has(e.eventId));
    };
    async function send({ sessionId, branchId, conversationId, text, storyTime }) {
        const S = window.RPHubWorldStore, M = window.RPHubWorldModel;
        const snapshot = await S.load(sessionId, branchId), c = snapshot.conversations.find(c => c.conversationId === conversationId);
        const members = M.activeMembers(c, snapshot.events.length + 1), player = snapshot.definition.playerActorId;
        text = String(text || '').trim();
        if (!c || c.kind === 'rp' || !members.includes(player)) throw new Error('玩家不能在这个会话发送微信');
        if (!text || text.length > 30000) throw new Error('请输入不超过30000字的微信消息');
        return S.commit({ sessionId, branchId: snapshot.branchId, expectedRevision: snapshot.revision,
            idempotencyKey: M.id('wechat-send'), patch: storyTime ? { storyTime } : {}, events: [{ kind: 'message.sent', actorId: player, conversationId,
                access: { principals: members }, payload: { text, type: 'text' }, source: { kind: 'player_input' } }] });
    }
    function openingSource(snapshot) {
        const C = window.RPHubActorContext, definition = snapshot.definition;
        if (typeof definition.openingText === 'string') return { text: definition.openingText.trim(), actorId: null };
        const eligible = definition.actors.filter(a => a.actorId !== definition.playerActorId && a.enabled !== false && String(C.cardOf(a).first_mes || '').trim());
        const a = eligible.find(a => a.actorId === 'suqixue') || eligible[0];
        return { text: a ? C.resolveText(C.cardOf(a).first_mes, snapshot, a).trim() : '', actorId: a?.actorId || null };
    }
    function openingEvents(snapshot) {
        if (snapshot.events.some(e => e.kind === 'narration.published' || (e.kind === 'player.input' && e.payload.channel === 'rp'))) return [];
        const opening = openingSource(snapshot);
        const c = snapshot.conversations.find(c => c.kind === 'rp');
        if (!opening.text || !c) return [];
        return [{ kind: 'narration.published', actorId: snapshot.definition.playerActorId, conversationId: c.conversationId,
            access: { principals: [] }, payload: { text: opening.text, readerOnly: true, opening: true, coveredEventIds: [] },
            source: { kind: opening.actorId ? 'card_opening' : 'world_opening', ...(opening.actorId ? { actorId: opening.actorId } : {}) } }];
    }
    async function ensureOpening(snapshot) {
        const events = openingEvents(snapshot); if (!events.length) return snapshot;
        return window.RPHubWorldStore.commit({ sessionId: snapshot.sessionId, branchId: snapshot.branchId,
            expectedRevision: snapshot.revision, idempotencyKey: 'world-opening-v2:' + snapshot.definition.revision, events });
    }
    window.RPHubWorldChat = Object.freeze({ pendingInputs, send, openingSource, openingEvents, ensureOpening });
})();
