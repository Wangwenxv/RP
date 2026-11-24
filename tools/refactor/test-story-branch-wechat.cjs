const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./story-branch-harness.cjs');
const wx = (id, content) => ({ id, channel: 'wechat', role: 'user', type: 'text', content });
const timeline = () => [
    { id: 'r0', channel: 'rp', rpIndex: 0, rpMsgId: 'opening', role: 'assistant', content: '开场' },
    wx('before', '分叉之前'),
    { id: 'r1', channel: 'rp', rpIndex: 1, rpMsgId: 'u1', role: 'user', content: 'RP1' },
    { id: 'r2', channel: 'rp', rpIndex: 2, rpMsgId: 'a1', role: 'assistant', content: '答复1' },
    wx('future', '分叉之后')
];

test('历史分叉继承锚点之前的微信，同一剧情时刻的未来消息仍排除', async () => {
    const h = harness(), source = timeline().map(item => ({ ...item, storyAt: 123456 }));
    h.s.replaceWechatTimeline(source); await h.s.saveWechatTimelineNow();
    await h.s.createStoryBranch(2);
    const scope = h.s.getCurrentStoryBranchScopeId();
    assert.notEqual(h.s.activeStoryBranchId.value, 'main', JSON.stringify(h.toasts));
    assert.deepEqual(h.stored.get('wechat_timeline/' + scope), source.slice(0, 4));
    assert.deepEqual(h.stored.get('wechat_timeline/fixture-char'), source);
    await h.notify();
    assert.ok(!h.s.wechatTimeline.value.some(item => item.id === 'future'));
});

test('从当前状态创建分支复制全部微信，之后两边独立保存', async () => {
    const h = harness(), source = timeline();
    h.s.replaceWechatTimeline(source); h.s.scheduleWechatSave();
    await h.s.createStoryBranch();
    const scope = h.s.getCurrentStoryBranchScopeId();
    assert.notEqual(h.s.activeStoryBranchId.value, 'main', JSON.stringify(h.toasts));
    assert.deepEqual(h.stored.get('wechat_timeline/' + scope), source);
    await h.notify(); h.s.wechatTimeline.value.push(wx('child', '子分支新增'));
    await h.s.saveWechatTimelineNow();
    await h.s.switchStoryBranch('main'); await h.notify();
    assert.ok(!h.s.wechatTimeline.value.some(item => item.id === 'child'));
    assert.ok(h.stored.get('wechat_timeline/' + scope).some(item => item.id === 'child'));
});

test('切分支前强制保存待落盘微信，原有分支仍独立恢复', async () => {
    const h = harness();
    h.s.replaceWechatTimeline([wx('pending', '待保存')]); h.s.scheduleWechatSave();
    await h.s.switchStoryBranch('other'); await h.notify(); await h.flushTimers();
    assert.equal(h.stored.get('wechat_timeline/fixture-char')[0].content, '待保存');
    assert.equal(h.s.wechatTimeline.value.length, 0);
    await h.s.switchStoryBranch('main'); await h.notify();
    assert.equal(h.s.wechatTimeline.value[0].content, '待保存');
});

test('无法定位历史锚点时保留原分支，避免继承未来记录', async () => {
    const h = harness();
    h.s.replaceWechatTimeline([wx('unknown', '没有RP锚点')]);
    await h.s.createStoryBranch(2);
    assert.equal(h.s.activeStoryBranchId.value, 'main');
    assert.equal(h.s.storyBranches.value.length, 2);
    assert.ok(h.toasts.some(args => /锚点/.test(args[0])));
});

test('语音与文档副本获得目标scope，图像引用共享；历史回档不复制未来阅读进度', async () => {
    const h = harness(), B = h.context.window.RPHubBranchChat;
    h.stored.set('wechat_voice_index', [{ id: 'voice-original', ownerId: 'fixture-char', scopeId: 'fixture-char' }]);
    h.stored.set('wechat_voice_blob_voice-original', new Blob(['audio']));
    h.stored.set('wechat_document_index', [{ id: 'doc-original', ownerId: 'fixture-char', scopeId: 'fixture-char', chunkCount: 1 }]);
    h.stored.set('wechat_document_blob_doc-original', new Blob(['text']));
    h.stored.set('wechat_document_toc_doc-original', []);
    h.stored.set('wechat_document_chunk_doc-original_0', { text: '正文' });
    h.stored.set('wechat_document_reader_doc-original', { summary: '后来才读到的内容', next: 1 });
    const source = [
        { type: 'voice', media: { assetId: 'voice-original' } },
        { type: 'document', document: { id: 'doc-original' } },
        { type: 'image', media: { assetId: 'shared-image' } }
    ];
    let id = 0;
    const prepared = await B.prepareForkResources(source, 'fixture-char', 'fixture-char', 'target-scope', h.context.window.RPHubStorage, () => 'fork-' + ++id, false);
    await h.context.window.RPHubStorage.setStoredValues(prepared.entries);
    assert.equal(prepared.timeline[0].media.assetId, 'fork-1');
    assert.equal(prepared.timeline[1].document.id, 'fork-2');
    assert.equal(prepared.timeline[2].media.assetId, 'shared-image');
    assert.equal(h.stored.get('wechat_voice_index')[1].scopeId, 'target-scope');
    assert.equal(h.stored.has('wechat_document_reader_fork-2'), false);
    assert.ok(h.stored.get('wechat_voice_blob_fork-1') instanceof Blob);
    assert.equal(source[0].media.assetId, 'voice-original');
    await B.cleanupForkResources('target-scope', h.context.window.RPHubStorage);
    assert.equal(h.stored.get('wechat_voice_index').length, 1);
    assert.equal(h.stored.has('wechat_voice_blob_fork-1'), false);
    assert.ok(h.stored.has('wechat_voice_blob_voice-original'));
});

test('创建后保存失败回滚微信与新附件，不改父分支', async () => {
    const h = harness();
    h.s.replaceWechatTimeline(timeline()); await h.s.saveWechatTimelineNow();
    h.s.saveCharactersNow = async () => { throw new Error('模拟保存失败'); };
    await h.s.createStoryBranch(2);
    assert.equal(h.s.activeStoryBranchId.value, 'main');
    assert.equal(h.s.storyBranches.value.length, 2);
    assert.ok(![...h.stored.keys()].some(key => key.startsWith('wechat_timeline/') && key.includes('__branch__fixture-')));
    assert.equal(h.stored.get('wechat_timeline/fixture-char').length, 5);
});
