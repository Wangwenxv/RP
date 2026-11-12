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
    function openingEvents(snapshot) {
        if (snapshot.events.some(e => e.kind === 'narration.published' || (e.kind === 'player.input' && e.payload.channel === 'rp'))) return [];
        const C = window.RPHubActorContext, a = snapshot.definition.actors.find(a => a.actorId === 'suqixue' && a.enabled !== false);
        const raw = a && C.cardOf(a).first_mes;
        const c = snapshot.conversations.find(c => c.kind === 'rp');
        if (!raw || !c) return [];
        const text = C.resolveText(raw, snapshot, a);
        return [{ kind: 'narration.published', actorId: snapshot.definition.playerActorId, conversationId: c.conversationId,
            access: { principals: [] }, payload: { text, readerOnly: true, opening: true, coveredEventIds: [] }, source: { kind: 'card_opening', actorId: a.actorId } }];
    }
    async function ensureOpening(snapshot) {
        const events = openingEvents(snapshot); if (!events.length) return snapshot;
        return window.RPHubWorldStore.commit({ sessionId: snapshot.sessionId, branchId: snapshot.branchId,
            expectedRevision: snapshot.revision, idempotencyKey: 'suqixue-opening-v1', events });
    }
    window.RPHubWorldChat = Object.freeze({ pendingInputs, send, openingEvents, ensureOpening });
})();
