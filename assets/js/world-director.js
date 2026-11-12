// Translate explicitly authored scene facts into scoped state. This reader never
// receives private dialogue and never grants an NPC the full author paragraph.
(function () {
    async function interpret({ snapshot, text, apiConfig, signal, budget, modelRunner, onUsage }) {
        const M = window.RPHubWorldModel, Runtime = window.RPHubActorRuntime;
        const map = snapshot.definition.map?.data || snapshot.definition.map;
        const actors = snapshot.definition.actors.map(a => ({ actorId: a.actorId, name: a.name }));
        const messages = [{ role: 'system', content:
            '你是场景前提解析器，只提取作者已经明确写下的事实，不续写、不做人物选择。返回 JSON：' +
            '{"updates":[{"actorId":"人物ID","quote":"原文连续片段","phoneAccess":"blocked|available","activity":"明确发生的活动","placeId":"已明确在/到达的地图地点ID"}]}。可省略字段；没有明确状态变化返回updates=[]。\n' +
            '不带姓名的“我/关闭手机/出门/回到”默认是玩家。只更新句中真正做动作的人，提到别人不等于别人做了动作。\n' +
            '“去/前往”是出发，不是到达，不填placeId；“打算/计划/等下/帮我”不证明完成，不提取。\n' +
            'placeId必须来自地图，只有明确已到达/身处才填写。夜晚到来不表示所有人手机关闭。不得传播生日惊喜等秘密到未被明确知会的人。\n' +
            'quote必须逐字复制原文连续片段，且真正说明这个人的变化。不能修改时间、关系、人设或读取私聊。' },
            { role: 'user', content: JSON.stringify({ text, playerActorId: snapshot.definition.playerActorId, actors,
                places: (map?.places || []).map(p => ({ placeId: p.id, name: p.name, aliases: p.aliases || [] })) }) }];
        const result = await Runtime.request({ purpose: 'director', messages, apiConfig, signal, budget, modelRunner, onUsage });
        const parsed = Runtime.parseJson(result?.content ?? result);
        if (!Array.isArray(parsed.updates) || parsed.updates.length > actors.length) throw new Error('场景解析未返回有效人物状态');
        const changes = {}, facts = [];
        for (const update of parsed.updates) {
            const a = actors.find(a => a.actorId === update.actorId);
            if (!a || typeof update.quote !== 'string' || !update.quote.trim() || !text.includes(update.quote)) throw new Error('场景状态没有有效的原文来源');
            if (a.actorId !== snapshot.definition.playerActorId && !update.quote.includes(a.name)) throw new Error('作者状态没有明确指定该人物');
            const state = { ...(snapshot.actorStates[a.actorId] || {}) }, words = [];
            if (update.phoneAccess !== undefined) {
                if (!['blocked', 'available'].includes(update.phoneAccess)) throw new Error('场景手机状态无效');
                state.phoneAccess = update.phoneAccess; state.phoneRestrictedUntil = null;
                words.push(update.phoneAccess === 'blocked' ? '暂时不查看手机' : '可以查看手机');
            }
            if (update.activity !== undefined) {
                if (typeof update.activity !== 'string' || update.activity.length > 120) throw new Error('场景活动描述无效');
                state.activity = update.activity; words.push(update.activity);
            }
            if (update.placeId !== undefined) {
                const place = map?.places?.find(p => p.id === update.placeId);
                if (!place) throw new Error('场景引用了不存在的地图地点');
                state.position = { status: 'confirmed', placeId: place.id, source: 'player_author', storyTime: snapshot.storyTime };
                words.push('已在' + place.name);
            }
            if (!words.length) continue;
            state.source = 'player_author'; state.updatedAt = snapshot.storyTime;
            changes[a.actorId] = state;
            facts.push({ actorId: a.actorId, text: a.name + '：' + words.join('；') });
        }
        return { changes, facts };
    }
    window.RPHubWorldDirector = Object.freeze({ interpret });
})();
