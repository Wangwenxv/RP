const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
function harness() {
    const context = vm.createContext({ window: { RPHubUtils: { parseCot: content => ({ main: content }) } }, Blob, btoa, atob, Uint8Array, console });
    for (const file of ['built-in-content.js', 'data-services.js', 'branch-chat-utils.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js', file), 'utf8'), context);
    const data = new Map();
    const storage = { getStoredValue: async key => structuredClone(data.get(key)) };
    return { B: context.window.RPHubBranchChat, data, storage };
}
function fixture(data) {
    data.set('wechat_media_index', [{ id: 'media-photo', ownerId: 'source', scopeId: 'source', album: true }]);
    data.set('wechat_media_blob_media-photo', new Blob(['PHOTO'], { type: 'image/png' }));
    data.set('wechat_media_thumb_media-photo', new Blob(['THUMB'], { type: 'image/webp' }));
    data.set('wechat_voice_index', [{ id: 'voice-audio', ownerId: 'source', scopeId: 'source__branch__alt' }]);
    data.set('wechat_voice_blob_voice-audio', new Blob(['AUDIO'], { type: 'audio/wav' }));
    data.set('wechat_document_index', [{ id: 'doc-text', ownerId: 'source', scopeId: 'source__branch__alt', chunkCount: 2 }]);
    data.set('wechat_document_blob_doc-text', new Blob(['完整原文'], { type: 'text/plain' }));
    data.set('wechat_document_toc_doc-text', { entries: [{ title: '标题', offset: 0 }] });
    data.set('wechat_document_reader_doc-text', { next: 2, summary: '读者笔记', batches: 2 });
    data.set('wechat_document_chunk_doc-text_0', { index: 0, offset: 0, text: '完整' });
    data.set('wechat_document_chunk_doc-text_1', { index: 1, offset: 2, text: '原文' });
    return [
        { branchId: 'main', messages: [{ id: 'rp-1', role: 'assistant', content: 'RP 原文' }],
            classicMemories: [{ id: 'memory-1', summary: '原分支总结', sourceAssistantIds: ['rp-1'], embedding: [0.2, 0.8] }],
            storyRecap: { text: '原分支提要', coversThroughTurn: 1, coversWechatCount: 1 }, wechatTimeline: [
            { id: 'mirror', channel: 'rp', rpMsgId: 'rp-1', rpIndex: 0, role: 'assistant', content: 'RP 原文' },
            { id: 'wx-photo', channel: 'wechat', type: 'image', role: 'user', content: 'media-photo 原样文本', media: { assetId: 'media-photo', caption: '图片' }, ts: 123, storyAt: '2026-11-09T12:00:00' },
            { id: 'wx-empty', channel: 'wechat', type: 'silence', role: 'system', content: '', silence: { kind: 'read' } }
        ] },
        { branchId: 'alt', messages: [], wechatTimeline: [
            { id: 'wx-voice', channel: 'wechat', type: 'voice', role: 'assistant', content: '语音', media: { assetId: 'voice-audio' } },
            { id: 'wx-doc', channel: 'wechat', type: 'document', role: 'user', content: '', document: { id: 'doc-text', name: '原文.txt' } },
            { id: 'wx-photo-2', channel: 'wechat', type: 'image', role: 'assistant', media: { assetId: 'media-photo' } },
            { id: 'wx-described', channel: 'wechat', type: 'image', role: 'assistant', media: { description: '窗外的雨', source: 'description' } }
        ] }
    ];
}
test('all branches round-trip RP, WeChat, time, silence, described images and actual attachment bytes', async () => {
    const { B, data, storage } = harness(), branches = fixture(data);
    const resources = await B.collectResources(branches, 'source', storage);
    assert.equal(resources.length, 3);
    const records = JSON.parse(JSON.stringify([...branches, ...resources]));
    const parsed = B.parse(records, 2, new Set(['main', 'alt']));
    let id = 0;
    const prepared = await B.prepareResources(parsed, 'destination', storage, () => `new-${++id}`);
    const writes = new Map(prepared.entries);
    const main = prepared.chats.get('main'), alt = prepared.chats.get('alt');
    assert.equal(main.messages[0].id, 'rp-1');
    assert.equal(main.wechatTimeline[0].rpMsgId, 'rp-1');
    assert.equal(main.classicMemories[0].summary, '原分支总结');
    assert.equal(main.classicMemories[0].sourceAssistantIds[0], 'rp-1');
    assert.equal(main.classicMemories[0].embedding[1], 0.8);
    assert.equal(main.storyRecap.text, '原分支提要');
    assert.equal(main.wechatTimeline[1].content, 'media-photo 原样文本');
    assert.equal(main.wechatTimeline[1].storyAt, '2026-11-09T12:00:00');
    assert.equal(main.wechatTimeline[2].silence.kind, 'read');
    assert.equal(alt.wechatTimeline[3].media.description, '窗外的雨');
    const imageId = main.wechatTimeline[1].media.assetId;
    assert.notEqual(imageId, 'media-photo');
    assert.equal(imageId, alt.wechatTimeline[2].media.assetId);
    assert.equal(await writes.get(`wechat_media_blob_${imageId}`).text(), 'PHOTO');
    assert.equal(writes.get(`wechat_media_blob_${imageId}`).type, 'image/png');
    assert.equal(await writes.get(`wechat_media_thumb_${imageId}`).text(), 'THUMB');
    const voiceId = alt.wechatTimeline[0].media.assetId, docId = alt.wechatTimeline[1].document.id;
    assert.equal(await writes.get(`wechat_voice_blob_${voiceId}`).text(), 'AUDIO');
    assert.equal(writes.get('wechat_voice_index').at(-1).scopeId, 'destination__branch__alt');
    assert.equal(await writes.get(`wechat_document_blob_${docId}`).text(), '完整原文');
    assert.equal(writes.get(`wechat_document_chunk_${docId}_1`).text, '原文');
    assert.equal(writes.get(`wechat_document_reader_${docId}`).summary, '读者笔记');
    assert.equal(writes.get('wechat_document_index').at(-1).ownerId, 'destination');
    assert.equal(data.get('wechat_document_index')[0].id, 'doc-text');
    assert.equal(writes.get('wechat_document_index')[0].id, 'doc-text');
});
test('version 1 RP branch exports remain readable without fabricated WeChat data', () => {
    const { B } = harness();
    const parsed = B.parse([{ branchId: 'main', messages: [{ role: 'user', content: '旧 RP' }] }], 1, new Set(['main']));
    assert.equal(parsed.chats.get('main').messages[0].content, '旧 RP');
    assert.equal(parsed.resources.length, 0);
    assert.equal(parsed.chats.get('main').wechatTimeline.length, 0);
});
test('version 2 rejects missing timeline, missing/unknown/duplicate branches and malformed messages', () => {
    const { B } = harness(), valid = { branchId: 'main', messages: [], wechatTimeline: [] }, ids = new Set(['main']);
    for (const records of [[{ branchId: 'main', messages: [] }], [], [valid, valid], [{ ...valid, branchId: 'unknown' }], [{ ...valid, messages: [null] }],
        [{ ...valid, wechatTimeline: [{ channel: 'unknown' }] }], [{ ...valid, classicMemories: {} }], [{ ...valid, storyRecap: [] }]]) {
        assert.throws(() => B.parse(records, 2, ids));
    }
});
test('attachment validation rejects missing, truncated, duplicate or injected resource parts', async () => {
    const { B, data, storage } = harness(), branches = fixture(data);
    const resources = await B.collectResources(branches, 'source', storage), ids = new Set(['main', 'alt']);
    assert.throws(() => B.parse(branches, 2, ids), /缺少聊天附件/);
    for (const mutate of [
        records => records.at(-1).entries.pop(),
        records => records.at(-1).entries.push(['settings', { encoding: 'json', data: {} }]),
        records => records.at(-1).entries[0][1].bytes++,
        records => records.at(-1).entries[0][1].data = '$invalid',
        records => records.push(records.at(-1)),
        records => records.at(-1).kind = '__proto__'
    ]) {
        const records = JSON.parse(JSON.stringify([...branches, ...resources])); mutate(records);
        assert.throws(() => B.parse(records, 2, ids));
    }
});
test('a missing local original prevents silently producing an incomplete export', async () => {
    const { B, data, storage } = harness(), branches = fixture(data);
    data.delete('wechat_voice_blob_voice-audio');
    await assert.rejects(B.collectResources(branches, 'source', storage), /已丢失/);
});
test('bundled photos keep their built-in reference without requiring a local Blob', async () => {
    const { B, storage } = harness(), builtins = [{ id: 'builtin-photo' }];
    const branches = [{ branchId: 'main', messages: [], wechatTimeline: [{ channel: 'wechat', type: 'image', media: { assetId: 'builtin-photo' } }] }];
    assert.equal((await B.collectResources(branches, 'source', storage, builtins)).length, 0);
    assert.equal(B.parse(branches, 2, new Set(['main']), builtins).chats.size, 1);
});
