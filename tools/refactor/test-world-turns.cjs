const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./world-engine-harness.cjs');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const reply = text => ({ decision: 'reply', actions: [{ kind: 'reply', text }], referencedEvidenceIds: [] });
const silent = () => ({ decision: 'silent', actions: [], referencedEvidenceIds: [] });
const turnOf = h => Object.values(h.snapshot.turns).at(-1);
test('群聊依次提交真实发言人，林晚读到卿之后才接话', async () => {
    const h = await harness({ actorStates: { suqixue: { phoneAccess: 'blocked' } } });
    await h.run({ kind: 'wechat', conversationId: 'group', text: '哈喽' }, request => {
        if (request.actorId === 'qing') return { decision: 'reply', actions: [{ kind: 'reply', text: '咋了' }, { kind: 'reply', text: '突然哈什么喽' }] };
        assert.equal(request.actorId, 'linwan');
        assert.match(JSON.stringify(request.messages), /突然哈什么喽/);
        return reply('对啊，咋了，卿也不知道');
    });
    const messages = h.snapshot.events.filter(e => e.kind === 'message.sent');
    assert.deepEqual(Array.from(messages, e => e.actorId), ['player', 'qing', 'qing', 'linwan']);
    assert.equal(turnOf(h).status, 'complete');
});
test('群聊半成功失败可重试，已成功的卿不再调用或发送', async () => {
    const h = await harness({ actorStates: { suqixue: { phoneAccess: 'blocked' } } });
    await assert.rejects(h.run({ kind: 'wechat', conversationId: 'group', text: '哈喽' }, request => {
        if (request.actorId === 'qing') return reply('咋了');
        throw new Error('模拟林晚超时');
    }), /模拟林晚超时/);
    const turn = turnOf(h);
    assert.equal(turn.status, 'failed');
    assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent' && e.actorId === 'qing').length, 1);
    await h.retry(turn.turnId, request => { assert.equal(request.actorId, 'linwan'); return reply('我也在'); });
    assert.equal(h.requests.filter(r => r.actorId === 'qing').length, 1);
    assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent' && e.actorId === 'qing').length, 1);
    assert.equal(turnOf(h).status, 'complete');
});
test('林晚实际告知后苏祈雪才有知情反应，NPC镜头不授予玩家角色知识', async () => {
    const h = await harness();
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['linwan'], text: '帮我准备祈雪生日礼物，原始保密请求：别告诉苏祈雪' }, request => {
        if (request.purpose === 'narrator') return { content: '林晚给苏祈雪发了消息。苏祈雪知道惊喜，但决定先装作不知情。' };
        if (request.actorId === 'linwan') return { decision: 'act', actions: [{ kind: 'tell', targetActorId: 'suqixue', channel: 'dm', text: '玩家在给你准备生日礼物。' }] };
        assert.equal(request.actorId, 'suqixue');
        assert.match(JSON.stringify(request.messages), /玩家在给你准备生日礼物/);
        assert.doesNotMatch(JSON.stringify(request.messages), /原始保密请求/);
        return { decision: 'act', actions: [{ kind: 'remember', text: '我知道礼物计划，先装作不知道。' }] };
    });
    const P = h.context.window.RPHubWorldProjections;
    const told = h.snapshot.events.find(e => e.kind === 'message.sent' && e.actorId === 'linwan');
    assert.equal(P.hasObserved(h.snapshot, told.eventId, 'suqixue'), true);
    assert.equal(P.hasObserved(h.snapshot, told.eventId, 'player'), false);
    const narrator = h.snapshot.events.find(e => e.kind === 'narration.published');
    assert.equal(narrator.conversationId, 'rp-main');
    assert.equal(P.hasObserved(h.snapshot, narrator.eventId, 'player'), false);
});
test('叙述失败的重试仅重写正文，已提交告知不重复执行', async () => {
    const h = await harness();
    await assert.rejects(h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['linwan'], text: '给林晚看礼物计划' }, request => {
        if (request.purpose === 'narrator') throw new Error('叙述超时');
        if (request.actorId === 'linwan') return { decision: 'act', actions: [{ kind: 'tell', targetActorId: 'suqixue', channel: 'dm', text: '他在准备礼物' }] };
        return silent();
    }), /叙述超时/);
    const turnId = turnOf(h).turnId;
    await h.retry(turnId, request => { assert.equal(request.purpose, 'narrator'); return { content: '苏祈雪看过消息，收起手机。' }; });
    assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent' && e.actorId === 'linwan').length, 1);
    assert.equal(h.requests.filter(r => r.purpose === 'actor').length, 2);
    assert.equal(h.snapshot.events.filter(e => e.kind === 'narration.published').length, 1);
});
test('想告知但没有确认会面只进入待办，不令苏祈雪知情', async () => {
    const h = await harness();
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['linwan'], text: '我准备秘密礼物' }, request =>
        request.purpose === 'narrator' ? { content: '林晚想找个机会聊一聊。' } :
            { decision: 'act', actions: [{ kind: 'tell', targetActorId: 'suqixue', channel: 'in_person', text: '他在准备礼物' }] });
    assert.equal(h.requests.filter(r => r.actorId === 'suqixue').length, 0);
    assert.equal(h.snapshot.pendingActions.filter(t => t.type === 'tell' && t.reason === 'no_confirmed_meeting').length, 1);
    assert.equal(h.context.window.RPHubActorContext.searchMemory(h.snapshot, 'suqixue', '秘密礼物').count, 0);
});
test('确认同地的当面告知不受手机关闭限制，但只传播实际台词', async () => {
    const h = await harness({ actorStates: { linwan: { position: 'library', phoneAccess: 'available' },
        suqixue: { position: 'library', phoneAccess: 'blocked' } } });
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['linwan'], text: '秘密SOURCE-ONE' }, request => {
        if (request.purpose === 'narrator') return { content: '林晚轻声说了礼物的事。' };
        if (request.actorId === 'linwan') return { decision: 'act', actions: [{ kind: 'tell', targetActorId: 'suqixue', channel: 'in_person', text: '给你准备了礼物。' }] };
        assert.equal(request.actorId, 'suqixue');
        assert.match(JSON.stringify(request.messages), /给你准备了礼物/);
        assert.doesNotMatch(JSON.stringify(request.messages), /SOURCE-ONE/);
        return { decision: 'act', actions: [{ kind: 'remember', text: '我知道有礼物了' }] };
    });
    assert.equal(h.requests.filter(r => r.actorId === 'suqixue').length, 1);
});
test('相同玩家turnId重复提交不重调用模型或重复输入', async () => {
    const h = await harness();
    const args = { kind: 'wechat', conversationId: 'dm-player-qing', text: '消息', turnId: 'same-input' };
    await h.run(args); const count = h.requests.length, events = h.snapshot.events.length;
    await h.run(args);
    assert.equal(h.requests.length, count); assert.equal(h.snapshot.events.length, events);
});
test('停止后晚到结果被拒绝，技术停止不写成角色沉默', async () => {
    const h = await harness(), controller = new AbortController();
    await assert.rejects(h.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: '等等', signal: controller.signal }, () => {
        controller.abort(); return reply('晚到回复');
    }), /停止/);
    assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent' && e.actorId === 'qing').length, 0);
    assert.equal(turnOf(h).status, 'paused');
    assert.equal(turnOf(h).actorResults.qing, undefined);
});
test('并发版本变化丢弃旧草案，不给旧草案换revision重贴', async () => {
    const h = await harness();
    await assert.rejects(h.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: '你好' }, async () => {
        await h.update({ actorStates: { qing: { phoneAccess: 'blocked' } } });
        return reply('不应落库');
    }), /已变化/);
    assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent' && e.actorId === 'qing').length, 0);
    assert.equal(h.snapshot.actorStates.qing.phoneAccess, 'blocked');
});
test('已记录的手机限制仅在玩家推进到截止时间后释放并读群消息', async () => {
    const h = await harness({ actorStates: { suqixue: { phoneAccess: 'blocked', phoneRestrictedUntil: '2026-05-12T18:00:00' } } });
    await h.run({ kind: 'wechat', conversationId: 'group', text: '晚读消息' }, () => silent());
    assert.equal(h.requests.filter(r => r.actorId === 'suqixue').length, 0);
    await h.run({ kind: 'advance', storyTime: '2026-05-12T18:00:00' }, () => silent());
    assert.equal(h.snapshot.actorStates.suqixue.phoneAccess, 'available');
    assert.equal(h.context.window.RPHubActorContext.searchMemory(h.snapshot, 'suqixue', '晚读消息').count, 1);
});
test('有35分钟路线的移动先出发，玩家推进到到达时刻才到达', async () => {
    const h = await harness({ actorStates: { qing: { phoneAccess: 'available', position: 'dorm' } }, definition: { map: { places: [] } } });
    h.context.window.RPHubGeography.route = () => ({ status: 'ok', duration: { typicalMinutes: 35 } });
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '卿准备去图书馆' }, request =>
        request.purpose === 'narrator' ? { content: '卿出发前往图书馆。' } : { decision: 'act', actions: [{ kind: 'move', placeId: 'library' }] });
    assert.equal(h.snapshot.actorStates.qing.position.status, 'travelling');
    await h.run({ kind: 'advance', storyTime: '2026-05-12T17:20:00' });
    assert.equal(h.snapshot.actorStates.qing.position.status, 'travelling');
    await h.run({ kind: 'advance', storyTime: '2026-05-12T17:35:00' });
    assert.equal(h.snapshot.actorStates.qing.position.placeId, 'library');
    assert.equal(h.snapshot.actorStates.qing.position.status, 'confirmed');
});
test('无限读取工具被全回合6调用预算截停，故障不转成剧情沉默', async () => {
    const h = await harness();
    await assert.rejects(h.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: '你好' }, () => ({ content: null,
        toolCalls: [{ id: 'lookup', type: 'function', function: { name: 'get_scene_context', arguments: '{}' } }] })), /预算/);
    assert.equal(h.requests.length, 6);
    assert.equal(turnOf(h).status, 'failed');
    assert.equal(turnOf(h).actorResults.qing, undefined);
});
test('RP台词只给在场者观察，未在场者连原文ID也不可读取', async () => {
    const h = await harness();
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['linwan', 'qing'], text: '我和林晚、卿在一起' }, request => {
        if (request.purpose === 'narrator') return { content: '他们在聊计划。' };
        return { decision: 'act', actions: [{ kind: 'speak', text: `${request.actorId}说：在场词PRESENT` }] };
    });
    const C = h.context.window.RPHubActorContext, P = h.context.window.RPHubWorldProjections;
    const speech = h.snapshot.events.find(e => e.kind === 'action.committed' && e.actorId === 'linwan');
    assert.equal(P.hasObserved(h.snapshot, speech.eventId, 'player'), true);
    assert.equal(P.hasObserved(h.snapshot, speech.eventId, 'qing'), true);
    assert.equal(C.readEvidence(h.snapshot, 'suqixue', speech.eventId).status, 'unavailable');
});
test('RP不会自动读取收起手机时的微信，玩家线下输入仍可被观察', async () => {
    const h = await harness({ actorStates: { suqixue: { phoneAccess: 'blocked' } } });
    await h.run({ kind: 'wechat', conversationId: 'dm-player-suqixue', text: '微信未读词PHONE-SECRET' });
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['suqixue'], text: '线下问她今天好吗' }, request => {
        if (request.purpose === 'narrator') return { content: '她点了点头。' };
        assert.doesNotMatch(JSON.stringify(request.messages), /PHONE-SECRET/);
        assert.match(JSON.stringify(request.messages), /线下问她今天好吗/);
        return { decision: 'act', actions: [{ kind: 'speak', text: '还好。' }] };
    });
    assert.equal(h.context.window.RPHubActorContext.searchMemory(h.snapshot, 'suqixue', 'PHONE-SECRET').count, 0);
});
test('失败后仅玩家读到已保存的卿回复，仍能只重试林晚', async () => {
    const h = await harness({ actorStates: { suqixue: { phoneAccess: 'blocked' } } });
    await assert.rejects(h.run({ kind: 'wechat', conversationId: 'group', text: '大家好' }, request => {
        if (request.actorId === 'qing') return reply('你好');
        throw new Error('失败');
    }), /失败/);
    const turnId = turnOf(h).turnId, saved = h.snapshot.events.find(e => e.kind === 'message.sent' && e.actorId === 'qing');
    await h.update({}, [{ kind: 'message.read', actorId: 'player', conversationId: 'group',
        payload: { eventIds: [saved.eventId] }, access: { principals: ['player'] }, causedBy: [saved.eventId] }]);
    await h.retry(turnId, request => { assert.equal(request.actorId, 'linwan'); return reply('你好呀'); });
    assert.equal(h.requests.filter(r => r.actorId === 'qing').length, 1);
    assert.equal(turnOf(h).status, 'complete');
});
test('失败后改变NPC状态拒绝旧回合，明确停止才可提交新输入', async () => {
    const h = await harness();
    await assert.rejects(h.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: '第一条' }, () => { throw new Error('失败'); }), /失败/);
    const turnId = turnOf(h).turnId;
    await assert.rejects(h.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: '第二条' }), /尚未完成/);
    await h.update({ actorStates: { qing: { phoneAccess: 'blocked' } } });
    await assert.rejects(h.retry(turnId, () => reply('旧回复')), /发生变化/);
    await h.Engine.cancelTurn({ sessionId: h.snapshot.sessionId, branchId: h.snapshot.branchId, turnId });
    await h.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: '明确停止后的新消息' });
    assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent' && e.payload.text === '第二条').length, 0);
    assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent' && e.payload.text === '明确停止后的新消息').length, 1);
});
test('RP上课收起手机者的私聊告知成为待办，不能当作已发送', async () => {
    const h = await harness({ actorStates: { linwan: { phoneAccess: 'blocked', phoneRestrictedUntil: '2026-05-12T18:00:00' } } });
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['linwan'], text: '告诉林晚礼物的事' }, request =>
        request.purpose === 'narrator' ? { content: '林晚想晚点发消息。' } :
            { decision: 'act', actions: [{ kind: 'tell', targetActorId: 'suqixue', channel: 'dm', text: '玩家准备了礼物' }] });
    assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent' && e.actorId === 'linwan').length, 0);
    assert.equal(h.snapshot.pendingActions.filter(t => t.reason === 'sender_phone_restriction').length, 1);
    assert.equal(h.requests.filter(r => r.actorId === 'suqixue').length, 0);
});
test('作者剧情前提有独立来源，不能伪装成玩家亲口台词', async () => {
    const h = await harness();
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['linwan'], text: '林晚知道有礼物但玩家没有说出口', inputMode: 'author_premise' }, request => {
        if (request.purpose === 'narrator') return { content: '林晚心里留了个念头。' };
        const packet = JSON.parse(request.messages[1].content);
        assert.equal(packet.observations.find(e => /没有说出口/.test(e.text)).evidenceStatus, 'author_premise');
        assert.match(packet.stimulus, /作者剧情前提/);
        return silent();
    });
    const input = h.snapshot.events.find(e => e.kind === 'player.input');
    assert.equal(input.source.kind, 'player_author');
    assert.equal(h.context.window.RPHubActorContext.searchMemory(h.snapshot, 'suqixue', '没有说出口').count, 0);
});
test('告知未适配/未启用NPC只保存待收消息，不调用缺卡人物模型', async () => {
    const h = await harness();
    // Definition snapshots are immutable in production; here the fixture starts disabled before execution.
    const pkg = await h.Store.exportSession(h.snapshot.sessionId);
    pkg.session.definition.actors.find(a => a.actorId === 'suqixue').enabled = false;
    await h.context.window.RPHubStorage.updateStoredValue(h.Store.key(h.snapshot.sessionId), () => pkg.session);
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['linwan'], text: '生日礼物的事' }, request =>
        request.purpose === 'narrator' ? { content: '林晚发送了消息，尚未收到回复。' } :
            { decision: 'act', actions: [{ kind: 'tell', targetActorId: 'suqixue', channel: 'dm', text: '有礼物' }] });
    assert.equal(h.requests.filter(r => r.actorId === 'suqixue').length, 0);
    const sent = h.snapshot.events.find(e => e.kind === 'message.sent' && e.actorId === 'linwan');
    assert.ok(sent);
    assert.equal(h.context.window.RPHubWorldProjections.hasObserved(h.snapshot, sent.eventId, 'suqixue'), false);
});
test('实际API传输复用共享客户端，发送具名独立上下文、工具schema并记录usage', async () => {
    const h = await harness(); let sent;
    for (const file of ['built-in-content.js', 'core-utils.js', 'api-utils.js']) vm.runInContext(
        fs.readFileSync(path.resolve(__dirname, '../../assets/js', file), 'utf8'), h.context, { filename: file });
    h.context.fetch = async (url, options) => {
        sent = { url, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply('收到')) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const snapshot = await h.Engine.runTurn({ sessionId: h.snapshot.sessionId, branchId: h.snapshot.branchId,
        kind: 'wechat', conversationId: 'dm-player-qing', text: '你好', apiConfig: { apiUrl: 'https://fixture.invalid', apiKey: 'fixture', model: 'fixture-model', logRequest: false } });
    assert.equal(sent.url, 'https://fixture.invalid/v1/chat/completions');
    assert.equal(sent.body.model, 'fixture-model'); assert.equal(sent.body.stream, false);
    assert.match(sent.body.messages[0].content, /actorId=qing/);
    assert.ok(sent.body.tools.some(tool => tool.function.name === 'search_my_memory'));
    assert.equal(sent.body.tools.some(tool => tool.function.name === 'tool_grep'), false);
    assert.equal(Object.values(snapshot.turns).at(-1).usage[0].usage.total_tokens, 15);
});
test('格式修复最多一次且计入预算，连续非法提案不写成角色回复', async () => {
    const h = await harness();
    await assert.rejects(h.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: '格式测试' }, () => ({ content: '{坏JSON}' })), /有效的 JSON/);
    assert.equal(h.requests.length, 2); assert.equal(turnOf(h).callsUsed, 2);
    assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent' && e.actorId === 'qing').length, 0);
});
