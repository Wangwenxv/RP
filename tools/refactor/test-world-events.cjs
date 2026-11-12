const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, definition, conversation, sent, read, commit, plain } = require('./world-core-harness.cjs');
test('同一个世界的两条私聊隔离已读知识，苏祈雪未知生日惊喜', async () => {
  const { S, P } = harness();
  let s = await S.create({ definition: definition(), conversations: [conversation('su-dm', ['player', 'suqixue']), conversation('qing-dm', ['player', 'qing'])] });
  s = await commit(S, s, [sent('plan', 'player', 'su-dm', ['player', 'suqixue'], '今晚和卿打球，下课不用等我'), read('su-read', 'suqixue', 'su-dm', ['plan'])]);
  s = await commit(S, s, [sent('cancel', 'player', 'qing-dm', ['player', 'qing'], '取消打球，准备生日惊喜，请保密'), read('qing-read', 'qing', 'qing-dm', ['cancel'])]);
  assert.deepEqual(P.observedEvents(s, 'suqixue').map(e => e.eventId), ['plan']);
  assert.deepEqual(P.observedEvents(s, 'qing').map(e => e.eventId), ['cancel']);
  assert.equal(P.canAccess(s, s.events.find(e => e.eventId === 'cancel'), 'suqixue'), false);
  assert.equal(JSON.stringify(P.observedEvents(s, 'suqixue')).includes('生日惊喜'), false);
});
test('群消息访问资格不自动变成观察，发送者与已读游标可靠', async () => {
  const { S, P } = harness(); let s = await S.create({ definition: definition(), conversations: [conversation('group', ['player', 'suqixue', 'qing', 'linwan'], 'group')] });
  s = await commit(S, s, [sent('hello', 'player', 'group', ['player', 'suqixue', 'qing', 'linwan'], '哈喽')]);
  assert.equal(P.conversationMessages(s, 'group', 'qing').length, 1);
  assert.equal(P.conversationMessages(s, 'group', 'qing', { observedOnly: true }).length, 0);
  s = await commit(S, s, [read('q-read', 'qing', 'group', ['hello']), sent('q-msg', 'qing', 'group', ['player', 'suqixue', 'qing', 'linwan'], '咋了')]);
  s = await commit(S, s, [read('l-read', 'linwan', 'group', ['hello', 'q-msg']), sent('l-msg', 'linwan', 'group', ['player', 'suqixue', 'qing', 'linwan'], '对啊，卿也不知道')]);
  assert.equal(P.hasObserved(s, 'q-msg', 'linwan'), true);
  assert.equal(P.hasObserved(s, 'l-msg', 'suqixue'), false);
  assert.deepEqual(P.conversationMessages(s, 'group', 'player').map(e => e.senderActorId), ['player', 'qing', 'linwan']);
  assert.equal(P.readCursor(s, 'group', 'suqixue'), 0);
});
test('禁止伪造观察、错会话、越权来源和未知人物', async () => {
  const { S } = harness(); let s = await S.create({ definition: definition(), conversations: [conversation('qing-dm', ['player', 'qing']), conversation('su-dm', ['player', 'suqixue'])] });
  s = await commit(S, s, [sent('secret', 'player', 'qing-dm', ['player', 'qing'], '秘密')]);
  await assert.rejects(commit(S, s, [read('evil', 'suqixue', 'qing-dm', ['secret'])]), /未授权/);
  await assert.rejects(commit(S, s, [read('wrong', 'qing', 'su-dm', ['secret'])]), /错误/);
  await assert.rejects(commit(S, s, [read('unknown', 'qing', 'qing-dm', ['unknown-source'])]), /不存在/);
  await assert.rejects(commit(S, s, [sent('fake', 'unknown-person', 'qing-dm', ['player', 'qing'], '伪造')]), /人物/);
  assert.equal((await S.load(s.sessionId)).events.length, 1);
});
test('新增群成员不获得入群前消息；退出后消息不获权限', async () => {
  const { S, P } = harness(); let s = await S.create({ definition: definition(), conversations: [conversation('g', ['player', 'qing'], 'group')] });
  s = await commit(S, s, [sent('old', 'player', 'g', ['player', 'qing'], '旧事')]);
  s = await commit(S, s, [{ kind: 'conversation.member_joined', actorId: 'linwan', conversationId: 'g', access: { principals: [] }, payload: { actorId: 'linwan' } }]);
  s = await commit(S, s, [sent('new', 'player', 'g', ['player', 'qing', 'linwan'], '新事')]);
  assert.equal(P.conversationMessages(s, 'g', 'linwan').length, 1);
  await assert.rejects(commit(S, s, [read('old-read', 'linwan', 'g', ['old'])]), /未授权/);
  s = await commit(S, s, [{ kind: 'conversation.member_left', actorId: 'linwan', conversationId: 'g', access: { principals: [] }, payload: { actorId: 'linwan' } }]);
  await assert.rejects(commit(S, s, [sent('forbidden', 'player', 'g', ['player', 'qing', 'linwan'], '退出后')]), /成员资格/);
});
test('NPC叙述对真人展示不授予玩家角色知识，意图不等于告知', async () => {
  const { S, P } = harness(); let s = await S.create({ definition: definition(), conversations: [conversation('npc-dm', ['linwan', 'suqixue'])] });
  s = await commit(S, s, [{ eventId: 'intent', kind: 'belief.adopted', actorId: 'linwan', access: { principals: ['linwan'] }, payload: { text: '考虑告诉苏祈雪' } },
    { eventId: 'narrator', kind: 'narration.published', actorId: 'player', access: { principals: [] }, payload: { text: '林晚想了想那个秘密。', eventIds: ['intent'] } }]);
  assert.equal(P.hasObserved(s, 'intent', 'suqixue'), false);
  assert.equal(P.observedEvents(s, 'player').length, 0);
  s = await commit(S, s, [sent('told', 'linwan', 'npc-dm', ['linwan', 'suqixue'], '他在准备惊喜'), read('heard', 'suqixue', 'npc-dm', ['told'])]);
  assert.equal(P.hasObserved(s, 'told', 'suqixue'), true);
  assert.equal(P.hasObserved(s, 'told', 'player'), false);
});
test('固定卡快照、明确卿槽位与冲突预检保留原文', async () => {
  const { S, M } = harness(), def = definition(), original = plain(def);
  const s = await S.create({ definition: def }); def.actors[1].card.personality = '篡改';
  assert.equal(s.definition.actors[1].card.personality, original.actors[1].card.personality);
  assert.match(s.definition.actors[1].cardHash, /^sha256:/);
  assert.equal(s.definition.actors[3].bindings.user, 'qing');
  assert.equal(M.preflightCard({ name: '林晚', personality: '毕业一年，恋人是{{user}}' }, { bindings: { user: 'qing' } }).ok, false);
  assert.equal(M.preflightCard({ name: '甲', personality: '和{{user}}交往' }).conflicts[0].code, 'unresolved-user');
  assert.throws(() => M.normalizeDefinition({ ...original, actors: [...original.actors, original.actors[1]] }), /重复/);
});
test('地图问句不是位置变化；剧情钟只有显式推进事件改变', async () => {
  const { S } = harness(); let s = await S.create({ definition: definition(), conversations: [conversation('dm', ['player', 'qing'])] });
  const before = s.storyTime;
  s = await commit(S, s, [sent('question', 'player', 'dm', ['player', 'qing'], '图书馆怎么走？')]);
  assert.equal(s.storyTime, before); assert.equal(s.actorStates.player.position, undefined);
  await assert.rejects(commit(S, s, [], { storyTime: '2026-05-11T17:00:00' }), /倒退/);
  s = await commit(S, s, [], { storyTime: '2026-05-12T18:00:00' });
  assert.equal(s.storyTime, '2026-05-12T18:00:00');
});
