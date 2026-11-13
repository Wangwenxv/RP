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
    const h = await harness({ actorStates: { qing: { phoneAccess: 'available', position: 'dorm' } }, definition: { map: { places: [{ id: 'library', name: '图书馆' }] } } });
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
test('人物无限读取在两轮后关闭工具，故障不转成剧情沉默', async () => {
    const h = await harness();
    await assert.rejects(h.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: '你好' }, () => ({ content: null,
        toolCalls: [{ id: 'lookup', type: 'function', function: { name: 'get_scene_context', arguments: '{}' } }] })), /读取已完成/);
    assert.equal(h.requests.length, 3);
    assert.equal(turnOf(h).status, 'failed');
    assert.equal(turnOf(h).actorResults.qing, undefined);
});

test('两轮资料读取后仍能提交最终提案，为其他人物与旁白保留预算', async () => {
    const h = await harness(); let reads = 0;
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '继续自己的场景' }, r => {
        if (r.purpose === 'narrator') return { content: '卿继续整理书桌。' };
        if (reads++ < 2) {
            assert.ok(r.tools.length);
            return { toolCalls: [{ id: 'lookup-' + reads, type: 'function', function: { name: 'get_scene_context', arguments: '{}' } }] };
        }
        assert.deepEqual(Array.from(r.tools, t => t.function.name), ['tool_wechat']); assert.match(r.messages.at(-1).content, /读取已结束/);
        return { decision: 'act', actions: [{ kind: 'act', text: '整理书桌。' }] };
    });
    assert.equal(turnOf(h).status, 'complete'); assert.equal(h.requests.length, 4);
});

test('本轮活动实时报告并持久化模型、工具、失败和 token 计数', async () => {
    const h = await harness(), reports = []; let actorCalls = 0;
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '先查场景，再继续。',
        apiConfig: { model: 'fixture-main', memoryEnabled: false, onActivity: (event, snapshot, turnId) => reports.push({ event, snapshot, turnId }) } }, request => {
        if (request.purpose === 'narrator') return { content: '卿看过场景资料，继续整理书桌。', usage: { prompt_tokens: 30, completion_tokens: 12 } };
        if (!actorCalls++) return { toolCalls: [{ id: 'scene', type: 'function', function: { name: 'get_scene_context', arguments: '{}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 3 } };
        return { ...reply('继续整理书桌。'), usage: { prompt_tokens: 20, completion_tokens: 7 } };
    });
    const activity = turnOf(h).activity;
    assert.equal(activity.modelRequests, 3); assert.equal(activity.toolCalls, 1); assert.equal(activity.failedRequests, 0);
    assert.equal(activity.usageReports, 3); assert.equal(activity.promptTokens, 60); assert.equal(activity.completionTokens, 22);
    assert.equal(activity.phases.find(p => p.purpose === 'actor' && p.actorId === 'qing').requests, 2);
    assert.equal(activity.phases.find(p => p.purpose === 'actor' && p.actorId === 'qing').tools, 1);
    assert.equal(activity.phases.find(p => p.purpose === 'narrator').requests, 1);
    assert.ok(activity.elapsedMs >= 0); assert.ok(reports.some(r => r.event.type === 'tool-start' && r.event.toolName === 'get_scene_context'));
    assert.ok(reports.every(r => r.turnId === turnOf(h).turnId));
    const failed = await harness(), failures = [];
    await assert.rejects(failed.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: '失败计数',
        apiConfig: { model: 'fixture-main', onActivity: (event, snapshot) => failures.push({ event, snapshot }) } }, () => { throw new Error('fixture failed'); }), /fixture failed/);
    assert.equal(turnOf(failed).activity.modelRequests, 1); assert.equal(turnOf(failed).activity.failedRequests, 1);
    assert.ok(failures.some(r => r.event.type === 'request-end' && r.event.outcome === 'failed' && r.snapshot.failedRequests === 1));
});

test('到期act计划唤醒本人重新决定一次，过去计划不自动成为已完成动作', async () => {
    const h = await harness();
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '独处' }, () => ({ decision: 'act',
        actions: [{ kind: 'act', text: '稍后整理书桌。', delayMinutes: 10 }] }));
    const taskId = h.snapshot.pendingActions[0].pendingActionId;
    assert.equal(h.snapshot.events.filter(e => e.kind === 'action.committed').length, 0);
    let reviewed = 0;
    await h.run({ kind: 'advance', storyTime: '2026-05-12T17:10:00' }, r => {
        if (r.purpose === 'narrator') return { content: '卿改变了计划。' };
        const packet = JSON.parse(r.messages[1].content);
        if (r.actorId === 'qing' && packet.ownPendingActions.some(t => t.pendingActionId === taskId)) reviewed++;
        return silent();
    });
    assert.equal(reviewed, 1); assert.equal(h.snapshot.pendingActions[0].status, 'complete');
    await h.run({ kind: 'advance', storyTime: '2026-05-12T17:20:00' }, r => {
        if (r.purpose === 'narrator') return { content: '保持现状。' };
        assert.equal(JSON.parse(r.messages[1].content).ownPendingActions.some(t => t.pendingActionId === taskId), false);
        return silent();
    });
    assert.equal(h.snapshot.events.filter(e => e.kind === 'action.committed' && /整理书桌/.test(e.payload.text)).length, 0);
});

test('不存在的移动地点须修复，不生成永远无法结算的路线待办', async () => {
    const h = await harness({ definition: { map: { places: [{ id: 'library', name: '图书馆' }] } } });
    await assert.rejects(h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '继续' }, () =>
        ({ decision: 'act', actions: [{ kind: 'move', placeId: 'made-up-room' }] })), /公共地图/);
    assert.equal(h.snapshot.pendingActions.length, 0);
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
        if (request.purpose === 'director') return { updates: [] };
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
    assert.equal(sent.body.model, 'fixture-model'); assert.equal(sent.body.stream, true);
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


test('连发中途调时不调用模型，两条时间分别保留并告知五分钟未回应', async () => {
    const h = await harness(), Chat = h.context.window.RPHubWorldChat;
    await Chat.send({ sessionId: h.snapshot.sessionId, branchId: 'main', conversationId: 'dm-player-qing', text: '老！婆！', storyTime: '2026-05-12T17:00:00' });
    const s = await h.Store.load(h.snapshot.sessionId);
    await h.Store.commit({ sessionId: s.sessionId, branchId: 'main', expectedRevision: s.revision, idempotencyKey: 'burst-clock', patch: { storyTime: '2026-05-12T17:05:00' } });
    await Chat.send({ sessionId: s.sessionId, branchId: 'main', conversationId: 'dm-player-qing', text: '喂喂喂，老婆人呢？' });
    assert.equal(h.requests.length, 0);
    await h.run({ kind: 'wechat', conversationId: 'dm-player-qing', replyOnly: true }, r => {
        const packet = JSON.parse(r.messages[1].content);
        assert.equal(packet.conversationTiming.unansweredMinutes, 5);
        const messages = packet.observations.filter(e => e.kind === 'message.sent');
        assert.deepEqual(messages.map(e => e.storyTime), ['2026-05-12T17:00:00', '2026-05-12T17:05:00']);
        return reply('刚才没看手机，五分钟而已。');
    });
    assert.equal(h.requests.length, 1);
    assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent' && e.actorId === 'player').length, 2);
});
test('全世界RP镜头独立行动，卿先告知林晚再移动，未告知者不知道生日秘密', async () => {
    const h = await harness({ definition: { map: { places: [{ id: 'a109', name: 'A109' }] } }, actorStates: { qing: { position: 'dorm' }, linwan: { position: 'library' } } });
    h.context.window.RPHubGeography.route = () => ({ status: 'ok', duration: { typicalMinutes: 15 } });
    await h.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: '秘密：今晚给苏祈雪办生日惊喜，叫上林晚。' }, () => reply('收到，保密。'));
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing', 'linwan', 'suqixue'], witnessActorIds: [], text: '卿继续自己的场景，玩家出门买蛋糕。', inputMode: 'author_premise', apiConfig: { maxWorldCalls: 18 } }, r => {
        if (r.purpose === 'director') return { updates: [] };
        if (r.purpose === 'narrator') return { content: '卿联系林晚，两人各自出发。苏祈雪尚不知情。' };
        const packet = JSON.parse(r.messages[1].content);
        if (r.actorId === 'qing') return { decision: 'act', actions: [{ kind: 'tell', targetActorId: 'linwan', channel: 'dm', text: '今晚在A109给祈雪生日惊喜，先保密，过来布置。' }, { kind: 'move', placeId: 'a109' }] };
        if (r.actorId === 'linwan') {
            assert.match(JSON.stringify(packet.observations), /给祈雪生日惊喜/); assert.equal(packet.kind, 'rp');
            return { decision: 'act', actions: [{ kind: 'move', placeId: 'a109' }] };
        }
        assert.doesNotMatch(JSON.stringify(packet), /生日惊喜/);
        return silent();
    });
    assert.equal(h.snapshot.actorStates.qing.position.status, 'travelling');
    assert.equal(h.snapshot.actorStates.linwan.position.status, 'travelling');
    assert.equal(h.context.window.RPHubActorContext.searchMemory(h.snapshot, 'suqixue', '生日惊喜').count, 0);
});
test('同轮再次收到消息后的行动和待办独立保存，叙述重试不重复人物步骤', async () => {
    const h = await harness();
    let qingCalls = 0;
    await assert.rejects(h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing', 'linwan'],
        witnessActorIds: [], text: '各自继续安排', apiConfig: { maxWorldCalls: 18 } }, r => {
        if (r.purpose === 'narrator') throw new Error('模拟叙述网络中断');
        if (r.actorId === 'linwan') return { decision: 'act', actions: [
            { kind: 'tell', targetActorId: 'qing', channel: 'dm', text: '收到，带上彩灯。' }
        ] };
        qingCalls++;
        if (qingCalls === 1) return { decision: 'act', actions: [
            { kind: 'tell', targetActorId: 'linwan', channel: 'dm', text: '来A109布置生日惊喜。' },
            { kind: 'wait', text: '等十分钟检查布置', delayMinutes: 10 }
        ] };
        assert.match(JSON.stringify(JSON.parse(r.messages[1].content).observations), /带上彩灯/);
        return { decision: 'act', actions: [
            { kind: 'act', text: '收到回复后把彩灯加入布置清单。', state: { activity: '整理布置清单' } },
            { kind: 'wait', text: '等二十分钟检查彩灯', delayMinutes: 20 }
        ] };
    }), /模拟叙述网络中断/);
    assert.equal(qingCalls, 2);
    const actionCount = () => h.snapshot.events.filter(e => e.kind === 'action.committed' && /加入布置清单/.test(e.payload.text)).length;
    assert.equal(actionCount(), 1);
    assert.equal(h.snapshot.actorStates.qing.activity, '整理布置清单');
    const tasks = h.snapshot.pendingActions.filter(t => t.actorId === 'qing');
    assert.equal(tasks.length, 2);
    assert.equal(new Set(tasks.map(t => t.pendingActionId)).size, 2);
    assert.deepEqual(Array.from(tasks, t => t.dueAt), ['2026-05-12T17:10:00', '2026-05-12T17:20:00']);
    await h.retry(turnOf(h).turnId, r => {
        assert.equal(r.purpose, 'narrator');
        assert.match(r.messages[1].content, /加入布置清单/);
        return { content: '卿和林晚已确认布置安排。' };
    });
    assert.equal(actionCount(), 1);
    assert.equal(turnOf(h).status, 'complete');
});

test('作者关闭手机只修改明确的玩家状态，各NPC不能读取整段作者输入', async () => {
    const h = await harness();
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing', 'linwan', 'suqixue'], witnessActorIds: [], text: '关闭手机，夜晚悄悄到来。', inputMode: 'author_premise' }, r => {
        if (r.purpose === 'director') return { updates: [{ actorId: 'player', quote: '关闭手机', phoneAccess: 'blocked', activity: '独处' }] };
        if (r.purpose === 'narrator') return { content: '夜晚到来，玩家关上手机。' };
        assert.doesNotMatch(JSON.stringify(JSON.parse(r.messages[1].content).observations), /关闭手机/);
        return silent();
    });
    assert.equal(h.snapshot.actorStates.player.phoneAccess, 'blocked');
    assert.equal(h.snapshot.actorStates.qing.phoneAccess, 'available');
    assert.equal(h.context.window.RPHubWorldProjections.observedEvents(h.snapshot, 'suqixue').some(e => /关闭手机/.test(e.payload.text)), false);
});
test('作者状态解析拒绝无来源和错误人物，不覆盖已有状态', async () => {
    const h = await harness();
    await assert.rejects(h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], witnessActorIds: [], text: '关闭手机。', inputMode: 'author_premise' }, () =>
        ({ updates: [{ actorId: 'suqixue', quote: '关闭手机', phoneAccess: 'blocked' }] })), /没有明确指定/);
    assert.equal(h.snapshot.actorStates.suqixue.phoneAccess, 'available');
});
test('NPC实际收起手机同步自己的状态，act状态不能越过已有地点', async () => {
    const h = await harness({ actorStates: { qing: { position: 'dorm' } } });
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '独处' }, r => r.purpose === 'narrator' ? { content: '卿收起手机。' } :
        { decision: 'act', actions: [{ kind: 'act', text: '卿收起手机，专心复习。', state: { phoneAccess: 'blocked', activity: '复习' } }] });
    assert.equal(h.snapshot.actorStates.qing.phoneAccess, 'blocked');
    const context = h.context.window.RPHubActorContext.compile({ snapshot: h.snapshot, actorId: 'qing', kind: 'rp' });
    assert.throws(() => h.context.window.RPHubActorRuntime.validateProposal({ decision: 'act', actions: [{ kind: 'act', text: '已到图书馆', state: { position: 'library' } }] }, context, 'rp'), /已有位置/);
});
test('修改后的RP输入可重新回应一次，保留见证范围且不重复玩家输入', async () => {
    const h = await harness();
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '去打球。' }, () => silent());
    const e = h.snapshot.events.find(e => e.kind === 'player.input');
    const revised = await h.Store.reviseRecord({ sessionId: h.snapshot.sessionId, branchId: 'main', expectedRevision: h.snapshot.revision, eventId: e.eventId, text: '不打球了。' });
    const options = { sessionId: revised.sessionId, branchId: revised.branchId, kind: 'rp', conversationId: 'rp-main', existingInputEventId: e.eventId,
        modelRunner: r => { assert.equal(r.actorId, 'qing'); assert.match(JSON.stringify(r.messages), /不打球了/); assert.doesNotMatch(JSON.stringify(r.messages), /去打球。/); return silent(); } };
    const result = await h.Engine.runTurn(options);
    assert.equal(result.events.filter(e => e.kind === 'player.input').length, 1);
    await assert.rejects(h.Engine.runTurn(options), /只能继续尚未重新回应/);
});

test('作者输入修订后继续所有原场景人物，同时仍无全文见证人', async () => {
    const h = await harness();
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing', 'linwan', 'suqixue'], witnessActorIds: [],
        inputMode: 'author_premise', text: '关上窗户。' }, r => r.purpose === 'director' ? { updates: [] } : silent());
    const input = h.snapshot.events.find(e => e.kind === 'player.input');
    const revised = await h.Store.reviseRecord({ sessionId: h.snapshot.sessionId, branchId: h.snapshot.branchId,
        expectedRevision: h.snapshot.revision, eventId: input.eventId, text: '打开窗户。' });
    const seen = [];
    await h.Engine.runTurn({ sessionId: revised.sessionId, branchId: revised.branchId, kind: 'rp', conversationId: 'rp-main',
        existingInputEventId: input.eventId, modelRunner: r => {
            if (r.purpose === 'director') return { updates: [] };
            seen.push(r.actorId); assert.doesNotMatch(JSON.stringify(r.messages), /打开窗户/); return silent();
        } });
    assert.deepEqual(seen.sort(), ['linwan', 'qing', 'suqixue']);
});

test('旁白不获得尚未实施的延后动作正文，只有待办元数据', async () => {
    const h = await harness();
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '独处' }, r => {
        if (r.purpose === 'narrator') {
            const packet = JSON.parse(r.messages[1].content);
            assert.doesNotMatch(JSON.stringify(packet), /以后才洗脸/);
            assert.equal(packet.unansweredActions[0].status, 'not_performed');
            return { content: '卿把书放回书架。' };
        }
        return { decision: 'act', actions: [{ kind: 'act', text: '把书放回书架。' },
            { kind: 'act', text: '以后才洗脸。', delayMinutes: 45 }] };
    });
});

test('NPC主动私聊玩家复用原联系人，不创建第二个同名私聊', async () => {
    const h = await harness();
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '继续卿自己的场景。' }, r =>
        r.purpose === 'narrator' ? { content: '卿问玩家到了没有。' } : { decision: 'act', actions: [
            { kind: 'tell', targetActorId: 'player', channel: 'dm', text: '布置好了，你到了没？' }
        ] });
    assert.equal(h.snapshot.conversations.filter(c => c.kind === 'dm' && c.participantActorIds.includes('qing')
        && c.participantActorIds.includes('player')).length, 1);
    const sent = h.snapshot.events.find(e => e.kind === 'message.sent' && e.actorId === 'qing');
    assert.equal(sent.conversationId, 'dm-player-qing');
    assert.deepEqual(Array.from(sent.access.principals).sort(), ['player', 'qing']);
});

const wxCall = (id, args) => ({ id, type: 'function', function: { name: 'tool_wechat', arguments: JSON.stringify(args) } });

test('世界RP原生微信联系玩家只接受一次，直接提交并停在玩家回应点', async () => {
    const h = await harness();
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing', 'linwan'], text: '卿继续准备生日。' }, r => {
        if (r.purpose === 'narrator') return { content: '卿发来微信，等待玩家回应。' };
        assert.equal(r.actorId, 'qing');
        const tool = r.tools.find(t => t.function.name === 'tool_wechat');
        assert.ok(tool); assert.equal(tool.function.parameters.additionalProperties, false);
        return { toolCalls: [wxCall('wx-1', { content: '蛋糕拿到了吗？\n我在109。' }), wxCall('wx-2', { content: '收到，那你快来。' })] };
    });
    const messages = h.snapshot.events.filter(e => e.kind === 'message.sent');
    assert.equal(messages.length, 1); assert.equal(messages[0].actorId, 'qing');
    assert.equal(messages[0].conversationId, 'dm-player-qing'); assert.match(messages[0].payload.text, /\n我在109/);
    assert.deepEqual(Array.from(messages[0].access.principals).sort(), ['player', 'qing']);
    assert.equal(h.requests.filter(r => r.purpose === 'actor').length, 1);
    assert.equal(turnOf(h).responsePoint, true); assert.equal(turnOf(h).status, 'complete');
    const receipts = turnOf(h).actorResults.qing.wechatToolReceipts;
    assert.equal(receipts[0].queued, true); assert.equal(receipts[0].delivered, false);
    assert.equal(receipts[1].status, 'invalid_arguments');
});

test('原生微信可联系已知NPC，收件人依自己的上下文回应而不向玩家泄露', async () => {
    const h = await harness();
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], witnessActorIds: [], text: '各自继续' }, r => {
        if (r.purpose === 'narrator') return { content: '卿和林晚私下确认生日准备。' };
        if (r.actorId === 'qing') return { toolCalls: [wxCall('to-lin', { targetActorId: 'linwan', content: '秘密：在A109布置生日惊喜。' })] };
        assert.equal(r.actorId, 'linwan'); assert.match(JSON.stringify(r.messages), /在A109布置生日惊喜/);
        assert.doesNotMatch(JSON.stringify(r.messages), /SU_PRIVATE_CARD_ONLY/);
        return { decision: 'act', actions: [{ kind: 'remember', text: '收到卿的安排，先保密。' }] };
    });
    const event = h.snapshot.events.find(e => e.kind === 'message.sent');
    const P = h.context.window.RPHubWorldProjections;
    assert.equal(P.hasObserved(h.snapshot, event.eventId, 'linwan'), true);
    assert.equal(P.hasObserved(h.snapshot, event.eventId, 'player'), false);
    assert.equal(P.hasObserved(h.snapshot, event.eventId, 'suqixue'), false);
    assert.equal(turnOf(h).responsePoint, undefined);
});

test('原生微信拒绝冒用发送者、JSON气泡列表及未知收件人，未修正前不落消息', async () => {
    for (const args of [{ content: '你好', senderActorId: 'player' }, { content: '{"messages":[{"content":"我到了"}]}' },
        { content: '你好', targetActorId: 'stranger' }]) {
        const h = await harness(); let attempts = 0;
        await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '继续' }, r => {
            if (r.purpose === 'narrator') return { content: '卿保持现状。' };
            if (!attempts++) return { toolCalls: [wxCall('invalid', args)] };
            assert.match(r.messages.at(-1).content, /invalid_arguments/);
            return silent();
        });
        assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent').length, 0);
    }
});

test('手机不可用时不提供发送工具，伪造调用不能产生消息', async () => {
    const h = await harness({ actorStates: { qing: { phoneAccess: 'blocked' } } }); let attempts = 0;
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '卿独处' }, r => {
        assert.equal(r.tools.some(t => t.function.name === 'tool_wechat'), false);
        if (!attempts++) return { toolCalls: [wxCall('blocked', { content: '我能发消息了' })] };
        assert.match(r.messages.at(-1).content, /无法使用手机/); return silent();
    });
    assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent').length, 0);
});

test('两轮查资料后仍可原生联系玩家，微信不占用第三轮读取预算', async () => {
    const h = await harness(); let calls = 0;
    await h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '查完路线再联系我' }, r => {
        if (r.purpose === 'narrator') return { content: '卿查完路线后给玩家发微信。' };
        if (calls++ < 2) return { toolCalls: [{ id: 'read-' + calls, type: 'function', function: { name: 'get_scene_context', arguments: '{}' } }] };
        assert.deepEqual(Array.from(r.tools, t => t.function.name), ['tool_wechat']);
        return { toolCalls: [wxCall('send-after-reads', { content: '路线看好了，你在哪？' })] };
    });
    assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent').length, 1);
    assert.equal(h.requests.filter(r => r.purpose === 'actor').length, 3);
});

test('原生发送落盘后旁白失败，恢复只重写旁白且不重复发送', async () => {
    const h = await harness();
    await assert.rejects(h.run({ kind: 'rp', conversationId: 'rp-main', actorIds: ['qing'], text: '继续' }, r => {
        if (r.purpose === 'narrator') throw new Error('旁白断线');
        return { toolCalls: [wxCall('sent-before-failure', { content: '拿到快递了吗？' })] };
    }), /旁白断线/);
    await h.retry(turnOf(h).turnId, r => { assert.equal(r.purpose, 'narrator'); return { content: '卿已发出微信，等玩家回复。' }; });
    assert.equal(h.snapshot.events.filter(e => e.kind === 'message.sent').length, 1);
    assert.equal(turnOf(h).status, 'complete');
});
