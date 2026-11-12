const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, definition, conversation, sent, read, commit, plain } = require('./world-core-harness.cjs');
test('不同存档相同卡与相同分支名不会串事件', async () => {
  const { S, P } = harness();
  const a = await S.create({ definition: definition(), conversations: [conversation('dm', ['player', 'qing'])] });
  const b = await S.create({ definition: definition(), conversations: [conversation('dm', ['player', 'qing'])] });
  const changed = await commit(S, a, [sent('msg', 'player', 'dm', ['player', 'qing'], 'A专有')]);
  assert.equal((await S.load(b.sessionId)).events.length, 0);
  assert.notEqual(changed.sessionId, b.sessionId); assert.equal((await S.list()).length, 2);
});
test('同幂等键重复提交至多一批，不因旧revision重复气泡', async () => {
  const { S } = harness(); const s = await S.create({ definition: definition(), conversations: [conversation('dm', ['player', 'qing'])] });
  const one = await commit(S, s, [sent('hello', 'player', 'dm', ['player', 'qing'], '你好')], {}, 'same');
  const two = await commit(S, s, [sent('duplicate', 'player', 'dm', ['player', 'qing'], '重复')], {}, 'same');
  assert.equal(two.events.length, 1); assert.equal(two.revision, one.revision);
  assert.deepEqual(plain(two.commitEventIds), ['hello']);
});
test('并发旧版本 CAS 只有一个成功，拒绝重贴旧草案', async () => {
  const { S } = harness(); const s = await S.create({ definition: definition(), conversations: [conversation('dm', ['player', 'qing'])] });
  const results = await Promise.allSettled([
    commit(S, s, [sent('a', 'player', 'dm', ['player', 'qing'], 'A')], {}, 'a'),
    commit(S, s, [sent('b', 'player', 'dm', ['player', 'qing'], 'B')], {}, 'b')
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'WORLD_CONFLICT');
  assert.equal((await S.load(s.sessionId)).events.length, 1);
});
test('无效批次整批回滚，合法输入不能部分落盘', async () => {
  const { S } = harness(); const s = await S.create({ definition: definition(), conversations: [conversation('dm', ['player', 'qing'])] });
  await assert.rejects(commit(S, s, [sent('okay', 'player', 'dm', ['player', 'qing'], '合法'), { kind: 'illegal', actorId: 'player', access: { principals: [] }, payload: {} }]), /未知/);
  const loaded = await S.load(s.sessionId); assert.equal(loaded.revision, 0); assert.equal(loaded.events.length, 0);
});
test('历史检查点分叉重放所有人知识、成员、位置和待办，保留原线', async () => {
  const { S, P } = harness(); let s = await S.create({ definition: definition(), conversations: [conversation('dm', ['player', 'qing'])] });
  s = await commit(S, s, [sent('before', 'player', 'dm', ['player', 'qing'], '去打球'), read('read-before', 'qing', 'dm', ['before'])], { actorStates: { qing: { position: 'court' } }, pendingActions: [{ actionId: 'wait', actorId: 'qing', type: 'wait' }] });
  const checkpoint = s.events.length;
  s = await commit(S, s, [sent('after', 'player', 'dm', ['player', 'qing'], '不打了'), read('read-after', 'qing', 'dm', ['after'])], { actorStates: { qing: { position: 'dorm' } }, pendingActions: [] });
  const forked = await S.fork({ sessionId: s.sessionId, branchId: 'main', atSeq: checkpoint, name: '重新决定' });
  assert.equal(P.hasObserved(forked, 'after', 'qing'), false);
  assert.equal(P.hasObserved(forked, 'before', 'qing'), true);
  assert.equal(forked.actorStates.qing.position, 'court'); assert.equal(forked.pendingActions.length, 1);
  assert.equal((await S.load(s.sessionId, 'main')).actorStates.qing.position, 'dorm');
  assert.deepEqual(plain(forked.turns), {});
  assert.equal(forked.events.every(e => e.branchId === forked.branchId), true);
});
test('世界包往返含卡/地图快照、世界分支与认知，原世界不覆盖', async () => {
  const { S, P } = harness(); let s = await S.create({ definition: definition(), conversations: [conversation('dm', ['player', 'qing'])] });
  s = await commit(S, s, [sent('seed', 'player', 'dm', ['player', 'qing'], '秘密'), read('read-seed', 'qing', 'dm', ['seed'])]);
  await S.fork({ sessionId: s.sessionId, branchId: 'main', atSeq: s.events.length, name: '副线' });
  const pkg = await S.exportSession(s.sessionId), imported = await S.importSession(pkg);
  assert.notEqual(imported.sessionId, s.sessionId); assert.equal(imported.branches.length, 2);
  assert.equal(P.hasObserved(imported, 'seed', 'qing'), true);
  assert.equal(P.hasObserved(imported, 'seed', 'suqixue'), false);
  assert.deepEqual(plain(imported.definition.map), plain(s.definition.map));
  assert.equal((await S.list()).length, 2);
  await assert.rejects(S.importSession(pkg, { asNew: false }), /已存在/);
});
test('世界包拒绝未知类型、错因果引用、循环分支与卡篡改', async () => {
  const { S } = harness(); let s = await S.create({ definition: definition(), conversations: [conversation('dm', ['player', 'qing'])] });
  s = await commit(S, s, [sent('seed', 'player', 'dm', ['player', 'qing'], '消息')]);
  const pkg = await S.exportSession(s.sessionId);
  let bad = plain(pkg); bad.session.branches.main.events[0].kind = 'unknown'; await assert.rejects(S.importSession(bad), /未知/);
  bad = plain(pkg); bad.session.branches.main.events[0].causedBy = ['absent']; await assert.rejects(S.importSession(bad), /因果/);
  bad = plain(pkg); bad.session.branches.main.parentBranchId = 'main'; bad.session.branches.main.forkAtSeq = 0; await assert.rejects(S.importSession(bad), /父节点/);
  bad = plain(pkg); bad.session.definition.actors[1].card.personality = '改掉人设'; await assert.rejects(S.importSession(bad), /卡校验/);
  assert.equal((await S.list()).length, 1);
});
test('刷新/读档/切分支不产生事件，新增会话与消息同事务可见', async () => {
  const { S } = harness(); let s = await S.create({ definition: definition() });
  s = await commit(S, s, [sent('first', 'player', 'dm', ['player', 'qing'], '第一句')], { conversations: [conversation('dm', ['player', 'qing'])] });
  assert.equal(s.events[0].kind, 'conversation.created'); assert.equal(s.events[1].eventId, 'first');
  const count = s.events.length; await S.load(s.sessionId); await S.list(); await S.selectBranch(s.sessionId, 'main');
  assert.equal((await S.load(s.sessionId)).events.length, count);
});
test('显式更卡复制完整世界及分支，旧卡快照不变，新卡就绪可启用', async () => {
  const { S, P } = harness(), def = definition();
  def.actors[3].enabled = false; def.actors[3].cardStatus = 'missing'; def.actors[3].card = { name: '林晚', personality: '' };
  let s = await S.create({ definition: def, conversations: [conversation('dm', ['player', 'qing'])] });
  s = await commit(S, s, [sent('history', 'player', 'dm', ['player', 'qing'], '取消打球'), read('read-history', 'qing', 'dm', ['history'])],
    { turns: { t: { turnId: 't', sessionId: s.sessionId, branchId: 'main', status: 'complete' } } });
  await S.fork({ sessionId: s.sessionId, branchId: 'main', atSeq: s.events.length, name: '副线' });
  const nextDef = plain(s.definition); nextDef.name = '江南大学（卡牌修订）';
  nextDef.actors[3] = { ...nextDef.actors[3], enabled: true, cardStatus: 'ready', card: { name: '林晚', personality: '大四，恋人是{{user}}，珍惜朋友。' } };
  const revised = await S.reviseDefinition({ sessionId: s.sessionId, definition: nextDef });
  assert.notEqual(revised.sessionId, s.sessionId); assert.equal(revised.branches.length, 2);
  assert.equal(revised.definition.revision, s.definition.revision + 1);
  assert.equal(revised.definition.actors[3].enabled, true); assert.equal(revised.definition.actors[3].bindings.user, 'qing');
  assert.equal(revised.definition.actors[3].cardRevision, s.definition.actors[3].cardRevision + 1);
  assert.equal((await S.load(s.sessionId, 'main')).definition.actors[3].card.personality, '');
  assert.equal(P.hasObserved(revised, 'history', 'qing'), true); assert.equal(P.hasObserved(revised, 'history', 'suqixue'), false);
  assert.equal(revised.events.every(e => e.sessionId === revised.sessionId), true);
  const main = await S.load(revised.sessionId, 'main'); assert.equal(main.turns.t.sessionId, revised.sessionId);
  const roundtrip = await S.importSession(await S.exportSession(revised.sessionId));
  assert.equal(roundtrip.definition.actors[3].card.personality, nextDef.actors[3].card.personality);
  assert.equal((await S.load(roundtrip.sessionId, 'main')).turns.t.sessionId, roundtrip.sessionId);
});
test('所有世界API拒绝启用冲突/缺卡，修订禁止改身份或删除人物', async () => {
  const { S } = harness(), base = definition();
  let broken = plain(base); broken.actors[3].card = { name: '林晚', personality: '毕业一年，校外同居' };
  await assert.rejects(S.create({ definition: broken }), /尚未适配/);
  broken.actors[3].enabled = false; const disabled = await S.create({ definition: broken });
  broken.actors[3].enabled = true; await assert.rejects(S.reviseDefinition({ sessionId: disabled.sessionId, definition: broken }), /尚未适配/);
  const s = await S.create({ definition: base });
  broken = plain(base); broken.playerActorId = 'qing'; await assert.rejects(S.reviseDefinition({ sessionId: s.sessionId, definition: broken }), /身份/);
  broken = plain(base); broken.actors.pop(); await assert.rejects(S.reviseDefinition({ sessionId: s.sessionId, definition: broken }), /人物/);
  broken = plain(base); broken.actors[1].card = { name: '苏祈雪', personality: '' }; await assert.rejects(S.create({ definition: broken }), /尚未适配/);
  const pkg = await S.exportSession(s.sessionId); pkg.session.definition.actors[3].card.personality = '毕业一年';
  await assert.rejects(S.importSession(pkg), /尚未适配/);
});
test('剧情时间校验严格拒绝非法日历日与未来/倒退事件', async () => {
  const { S, M } = harness();
  assert.equal(Number.isNaN(M.storyTimeNumber('2026-02-30T12:00:00')), true);
  await assert.rejects(S.create({ definition: definition(), storyTime: '2026-02-30T12:00:00' }), /无效/);
  const s = await S.create({ definition: definition(), conversations: [conversation('dm', ['player', 'qing'])] });
  await assert.rejects(commit(S, s, [{ ...sent('future', 'player', 'dm', ['player', 'qing'], '未来'), storyTime: '2026-05-12T18:00:00' }]), /边界/);
  await assert.rejects(commit(S, s, [], { storyTime: '2026-06-31T17:00:00' }), /无效/);
});
