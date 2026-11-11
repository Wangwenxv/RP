const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./world-engine-harness.cjs');
const fs = require('node:fs'), path = require('node:path');
test('两条私聊共享世界但苏祈雪无法检索卿的生日秘密', async () => {
    const h = await harness();
    await h.run({ kind: 'wechat', conversationId: 'dm-player-suqixue', text: '今晚和卿打球，下课不用等我' });
    await h.run({ kind: 'wechat', conversationId: 'dm-player-qing', text: '不打球了，为祈雪准备生日惊喜，秘密词ALPHA-SECRET' });
    const C = h.context.window.RPHubActorContext;
    const su = C.compile({ snapshot: h.snapshot, actorId: 'suqixue', conversationId: 'dm-player-suqixue', stimulus: '继续' });
    const q = C.compile({ snapshot: h.snapshot, actorId: 'qing', conversationId: 'dm-player-qing', stimulus: '继续' });
    assert.doesNotMatch(JSON.stringify(su), /ALPHA-SECRET|不打球了/);
    assert.match(JSON.stringify(q), /ALPHA-SECRET|不打球了/);
    assert.equal(C.searchMemory(h.snapshot, 'suqixue', 'ALPHA-SECRET').count, 0);
    const secret = h.snapshot.events.find(e => e.kind === 'message.sent' && /ALPHA/.test(e.payload.text));
    assert.equal(C.readEvidence(h.snapshot, 'suqixue', secret.eventId).status, 'unavailable');
    const tools = C.createTools(h.snapshot, 'suqixue', 'dm-player-suqixue');
    assert.equal(tools.execute('search_my_memory', { query: 'ALPHA-SECRET', actorId: 'qing' }).status, 'invalid_arguments');
});
test('群未读原文不能进入角色上下文；位置不会推断手机状态', async () => {
    const h = await harness({ actorStates: { suqixue: { phoneAccess: 'blocked', position: 'classroom' } } });
    await h.run({ kind: 'wechat', conversationId: 'group', text: '未读词UNREAD' });
    const C = h.context.window.RPHubActorContext;
    assert.doesNotMatch(JSON.stringify(C.compile({ snapshot: h.snapshot, actorId: 'suqixue', conversationId: 'group' })), /UNREAD/);
    assert.equal(h.requests.filter(r => r.actorId === 'suqixue').length, 0);
    assert.equal(h.Engine.canReadPhone(h.snapshot, 'qing'), true);
});
test('林晚恋人占位符绑定卿；卡片范例不进入事件历史', async () => {
    const h = await harness();
    const C = h.context.window.RPHubActorContext, actor = h.snapshot.definition.actors.find(a => a.actorId === 'linwan');
    assert.equal(C.resolveText('我与{{user}}恋爱，{{char}}是我', h.snapshot, actor), '我与卿恋爱，林晚是我');
    assert.equal(C.searchMemory(h.snapshot, 'linwan', '风格例句').count, 0);
    assert.equal(C.getKnownPerson(h.snapshot, 'linwan', 'suqixue', 'group').card, undefined);
});
test('地图工具检索公共快递地点，路线始终从绑定人物位置出发', async () => {
    const map = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../worlds/jiangnan-south-campus.json'), 'utf8'));
    const ownPlace = map.places.find(p => /13栋/.test(p.name));
    assert.ok(ownPlace);
    const h = await harness({ definition: { map }, actorStates: { qing: { phoneAccess: 'available', position: ownPlace.id },
        suqixue: { position: 'OTHER-ACTOR-POSITION-SECRET' } } });
    const C = h.context.window.RPHubActorContext, tools = C.createTools(h.snapshot, 'qing', 'dm-player-qing');
    const search = tools.execute('get_scene_context', { operation: 'search', query: '快递' });
    assert.equal(search.status, 'ok'); assert.ok(search.results.length);
    const route = tools.execute('get_scene_context', { operation: 'route', to: search.results[0].id });
    assert.equal(route.status, 'ok'); assert.ok(route.duration.typicalMinutes > 0);
    assert.equal(route.from, ownPlace.name);
    assert.doesNotMatch(JSON.stringify(route), /OTHER-ACTOR-POSITION-SECRET/);
    assert.equal(tools.execute('get_scene_context', { operation: 'route', from: 'suqixue', to: 'library' }).status, 'invalid_arguments');
    const packet = C.compile({ snapshot: h.snapshot, actorId: 'qing', conversationId: 'dm-player-qing', stimulus: '去取快递' });
    assert.match(JSON.stringify(packet.packet.geography), /快递/);
    assert.doesNotMatch(JSON.stringify(packet.messages), /OTHER-ACTOR-POSITION-SECRET/);
});
test('上下文硬预算按实际序列化messages计数，无关世界书留待按需读取', async () => {
    const h = await harness(), C = h.context.window.RPHubActorContext;
    const card = h.snapshot.definition.actors.find(a => a.actorId === 'qing').card;
    card.character_book.entries.push({ entryId: 'unrelated', comment: '完全无关', content: '\\"'.repeat(2000), keys: ['毫无关系'] });
    const packet = C.compile({ snapshot: h.snapshot, actorId: 'qing', conversationId: 'dm-player-qing', stimulus: '哈喽', maxCharacters: 2600 });
    assert.ok(JSON.stringify(packet.messages).length <= 2600);
    assert.equal(packet.budget.characters, JSON.stringify(packet.messages).length);
    assert.equal(packet.packet.cardReferences.some(e => e.entryId === 'unrelated'), false);
    assert.equal(C.readEvidence(h.snapshot, 'qing', 'unrelated').status, 'ok');
    assert.throws(() => C.compile({ snapshot: h.snapshot, actorId: 'qing', maxCharacters: 300 }), /必需人设/);
});
