// A narrator publishes a reader view of accepted actions. It cannot grant observations or send messages.
(function () {
    function scenePacket(snapshot, turn) {
        const Context = window.RPHubActorContext;
        const ids = new Set(turn.sceneEventIds || []);
        const events = snapshot.events.filter(event => ids.has(event.eventId)
            && ['player.input', 'message.sent', 'action.committed', 'belief.adopted', 'actor.state_changed', 'world.fact_asserted'].includes(event.kind));
        return { storyTime: snapshot.storyTime, player: Context.actorOf(snapshot, snapshot.definition.playerActorId)?.name || '玩家',
            playerInput: turn.text, actors: (turn.completedActorIds || []).map(id => {
                const actor = Context.actorOf(snapshot, id);
                return { actorId: id, name: actor?.name, publicProfile: actor?.publicProfile || '',
                    state: Context.sceneContext(snapshot, id), decision: turn.actorResults?.[id]?.proposal?.decision || 'unknown' };
            }), acceptedEvents: events.map(event => ({ eventId: event.eventId, actorId: event.actorId,
                name: Context.actorOf(snapshot, event.actorId)?.name || event.actorId, kind: event.kind,
                conversationId: event.conversationId, payload: event.payload, storyTime: event.storyTime,
                playerCharacterObserved: window.RPHubWorldProjections.hasObserved(snapshot, event.eventId, snapshot.definition.playerActorId) })),
            unansweredActions: (snapshot.pendingActions || []).filter(action => action.turnId === turn.turnId && action.status === 'pending')
                .map(action => ({ actorId: action.actorId, type: action.type, dueAt: action.dueAt, reason: action.reason || null,
                    status: 'not_performed' })),
            priorNarration: snapshot.events.filter(event => event.kind === 'narration.published').slice(-3).map(event => event.payload.text) };
    }
    async function narrate({ snapshot, turn, apiConfig, signal, budget, modelRunner, onUsage }) {
        const packet = scenePacket(snapshot, turn);
        // A neutral player premise and an empty NPC proposal are not permission to invent a scene.
        if (!packet.acceptedEvents.some(e => e.actorId !== snapshot.definition.playerActorId)) {
            const actorsText = packet.actors.map(a => {
                const position = a.state.ownState.position || a.state.ownState.location;
                const placeId = typeof position === 'string' ? position : position?.placeId;
                const map = snapshot.definition.map?.data || snapshot.definition.map;
                const place = map?.places?.find(p => p.id === placeId)?.name;
                return `【${a.name}】\n${place ? `${a.name}仍在${place}，` : `${a.name}`}暂时没有新的举动。`;
            }).join('\n\n') || '暂时没有新的角色行动，等待你继续推进。';
            const text = (turn.inputMode === 'author_premise' ? turn.text + '\n\n' : '') + actorsText;
            return { text, coveredEventIds: packet.acceptedEvents.map(e => e.eventId), packet };
        }
        const messages = [{ role: 'system', content:
            '你是 RP 场景叙述器。根据已接受的各人物行动组织自然中文剧情，保留人物台词与实际选择。\n' +
            '可以切换 NPC 镜头；读者看到秘密不代表玩家角色知情。标为 playerCharacterObserved=false 的事件不能让玩家自动作知情反应。\n' +
            '不得替玩家做选择、发送消息、移动、答应邀请、补写已读。不得把未决行动/打算写为已经完成，不添加关键通信、告知、约定、到达或新知情人。\n' +
            'actors.state 是本轮确定状态，优先于先前旁白。没有接受的move/departed/arrived，不改变人物地点或写出步行路线。没有NPC新动作时维持现状，不用景物补出新的行动。\n' +
            '逐人检查acceptedEvents：某人物本轮没有已接受的新动作，就不能为其补写洗漱、关机、购物等动作。unansweredActions只表示尚未执行的计划，禁止写成已发生；先前旁白也不能证明这些计划完成。\n' +
            '关系亲密不能覆盖已接受的保密/告知决定。角色主观说法不自动成为客观事实。遇到需要玩家回应的地方自然停下。\n' +
            '输出正文即可，不输出分析或 JSON；环境和修辞可以润色，重要行为只能取自 acceptedEvents。' },
            { role: 'user', content: JSON.stringify(packet) }];
        const result = await window.RPHubActorRuntime.request({ purpose: 'narrator', messages, apiConfig, signal,
            budget, modelRunner, onUsage });
        let text = typeof result === 'string' ? result : result?.content;
        if (typeof text !== 'string') throw new Error('叙述模型未返回正文');
        text = text.replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, '').trim();
        if (!text || text.length > 30000) throw new Error('叙述正文为空或超过长度限制');
        return { text, coveredEventIds: packet.acceptedEvents.map(event => event.eventId), packet };
    }
    window.RPHubSceneNarrator = Object.freeze({ scenePacket, narrate });
})();
