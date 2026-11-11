const test = require('node:test'), assert = require('node:assert/strict');
const { harness } = require('./world-engine-harness.cjs');
const reply = text => ({ decision: 'reply', actions: [{ kind: 'reply', text }], referencedEvidenceIds: [] });
test('连发两条先落盘，不调用模型；请求回复不重复玩家气泡，沉默也结清待回应', async () => {
    const h = await harness(), Chat = h.context.window.RPHubWorldChat;
    const args = { sessionId: h.snapshot.sessionId, branchId: 'main', conversationId: 'dm-player-qing' };
    await Chat.send({ ...args, text: '今晚取消打球' });
    const before = await Chat.send({ ...args, text: '我要准备生日惊喜，请保密' });
    assert.equal(h.requests.length, 0); assert.equal(Chat.pendingInputs(before, args.conversationId).length, 2);
    await h.run({ kind: 'wechat', conversationId: args.conversationId, replyOnly: true }, request => {
        assert.match(JSON.stringify(request.messages), /取消打球/);
        assert.match(JSON.stringify(request.messages), /生日惊喜/);
        return reply('ok，保密');
    });
    assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent' && e.actorId === 'player').length, 2);
    assert.equal(Chat.pendingInputs(h.snapshot, args.conversationId).length, 0);
    const forked = await h.Store.fork({ sessionId: h.snapshot.sessionId, branchId: 'main', atSeq: h.snapshot.events.length });
    assert.equal(Chat.pendingInputs(forked, args.conversationId).length, 0);
    await Chat.send({ ...args, text: '好' });
    await h.run({ kind: 'wechat', conversationId: args.conversationId, replyOnly: true }, () => ({ decision: 'silent', actions: [] }));
    assert.equal(Chat.pendingInputs(h.snapshot, args.conversationId).length, 0);
});
test('自动人物总结跨微信/RP召回，秘密不进入苏祈雪记忆；分支与导入保留权限', async () => {
    const h = await harness(), C = h.context.window.RPHubActorContext, W = h.context.window.RPHubWorldMemory;
    await h.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: 'QING_ONLY_秘密：今晚取消打球', apiConfig: { memoryEnabled: true } }, r => {
        if (r.purpose === 'memory') {
            assert.equal(r.actorId, 'qing'); return { content: '玩家私下通知卿取消打球，并请卿保守 QING_ONLY_秘密。' };
        }
        return reply('ok，保密');
    });
    assert.equal(W.records(h.snapshot, 'qing').length, 1);
    assert.equal(W.records(h.snapshot, 'suqixue').length, 0);
    const q = C.compile({ snapshot: h.snapshot, actorId: 'qing', kind: 'rp', stimulus: '今晚安排' });
    const s = C.compile({ snapshot: h.snapshot, actorId: 'suqixue', kind: 'rp', stimulus: '今晚安排' });
    assert.match(JSON.stringify(q.packet.memories), /取消打球/);
    assert.doesNotMatch(JSON.stringify(s), /QING_ONLY/);
    const copy = await h.Store.importSession(await h.Store.exportSession(h.snapshot.sessionId));
    assert.equal(W.records(copy, 'qing').length, 1);
    const reset = await h.Store.fork({ sessionId: h.snapshot.sessionId, branchId: 'main', atSeq: 0 });
    assert.equal(W.records(reset, 'qing').length, 0);
    const secret = h.snapshot.events.find(e => e.kind === 'message.sent' && e.actorId === 'player');
    await assert.rejects(h.update({}, [{ kind: 'memory.summarized', actorId: 'suqixue', access: { principals: ['suqixue'] },
        payload: { summary: '禁止借总结泄密', sourceEventIds: [secret.eventId] } }]), /未观察/);
});
test('总结失败不阻塞已完成回复，也不吞掉未总结原文', async () => {
    const h = await harness();
    await h.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: '今天去图书馆', apiConfig: { memoryEnabled: true } }, r => {
        if (r.purpose === 'memory') throw new Error('总结服务暂不可用');
        return reply('好');
    });
    const turn = Object.values(h.snapshot.turns).at(-1);
    assert.equal(turn.status, 'complete'); assert.match(turn.memoryWarning, /暂不可用/);
    assert.ok(h.context.window.RPHubWorldMemory.material(h.snapshot, 'qing').length);
    await h.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: '还有空座位吗' }, () => reply('有'));
});
test('苏祈雪开场白只种一次，读者旁白不赋予全员记忆', async () => {
    const h = await harness(), Chat = h.context.window.RPHubWorldChat;
    const definition = JSON.parse(JSON.stringify(h.snapshot.definition));
    definition.actors.find(a => a.actorId === 'suqixue').card.first_mes = '三月六点半，语心湖边路灯亮起来。';
    for (const a of definition.actors) delete a.cardHash;
    const copy = await h.Store.create({ definition, storyTime: h.snapshot.storyTime, conversations: h.snapshot.conversations });
    const opened = await Chat.ensureOpening(copy), again = await Chat.ensureOpening(opened);
    assert.equal(again.events.filter(e => e.payload.opening).length, 1);
    assert.equal(h.context.window.RPHubActorContext.observed(again, 'qing').length, 0);
    h.Store.validateSession((await h.Store.exportSession(again.sessionId)).session);
});
