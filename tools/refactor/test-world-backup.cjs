const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { harness, definition, conversation, sent, read, commit } = require('./world-core-harness.cjs');
async function setup() {
    const h = harness();
    Object.assign(h.context, { Blob, TextDecoder, Uint32Array, Uint16Array, DataView, ArrayBuffer,
        Int8Array, Uint8ClampedArray, Int16Array, Int32Array, Float32Array, Float64Array });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../assets/js/backup-utils.js'), 'utf8'), h.context);
    let s = await h.S.create({ definition: definition(), storyTime: '2026-05-12T17:00:00',
        conversations: [conversation('private-q', ['player', 'qing'])] });
    s = await commit(h.S, s, [sent('secret', 'player', 'private-q', ['player', 'qing'], '准备惊喜')]);
    s = await commit(h.S, s, [read('q-read', 'qing', 'private-q', ['secret'])]);
    return { ...h, s, B: h.context.window.RPHubBackup };
}
test('整库备份包含世界、版本卡、观察、分支并恢复相同认知', async () => {
    const h = await setup(); await h.S.fork({ sessionId: h.s.sessionId, branchId: 'main', atSeq: 1, name: '未读前' });
    const entries = [['characters', []], ...(await h.S.exportSession(h.s.sessionId).then(pkg => [[h.S.key(h.s.sessionId), pkg.session]]))];
    entries[1][1].branches.main.actorStates.qing = { position: 'forged-cache' };
    const backup = await h.B.create(entries), restored = await h.B.inspect(backup);
    assert.equal(restored.summary.worlds, 1); assert.equal(restored.summary.worldBranches, 2);
    assert.equal(restored.summary.worldActors, 4); assert.equal(restored.summary.worldEvents, 3);
    const session = restored.entries[1][1], main = { ...session.branches.main, definition: session.definition };
    assert.notEqual(main.actorStates.qing.position, 'forged-cache');
    assert.equal(h.P.hasObserved(main, 'secret', 'qing'), true);
    assert.equal(h.P.hasObserved(main, 'secret', 'suqixue'), false);
    assert.equal(session.definition.actors.find(a => a.actorId === 'qing').cardHash.startsWith('sha256:'), true);
});
test('整库备份拒绝损坏的世界来源和不匹配的存储身份', async () => {
    const h = await setup(), pkg = await h.S.exportSession(h.s.sessionId);
    pkg.session.branches.main.events[1].payload.eventIds = ['does-not-exist'];
    await assert.rejects(h.B.create([['characters', []], [h.S.key(h.s.sessionId), pkg.session]]), /来源|引用|观察/);
    const valid = (await h.S.exportSession(h.s.sessionId)).session;
    await assert.rejects(h.B.create([['characters', []], ['world_session_v1:wrong', valid]]), /身份/);
});
test('整库导入在恢复前校验卡快照哈希', async () => {
    const h = await setup(), pkg = await h.S.exportSession(h.s.sessionId);
    pkg.session.definition.actors.find(a => a.actorId === 'qing').card.personality = '被篡改的内容';
    const backup = await h.B.create([['characters', []], [h.S.key(h.s.sessionId), pkg.session]]);
    await assert.rejects(h.B.inspect(backup), /角色卡校验/);
});
