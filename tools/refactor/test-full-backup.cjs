const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const context = vm.createContext({ window: {}, Blob, TextEncoder, TextDecoder, Uint8Array, Uint32Array, Uint16Array, DataView,
  ArrayBuffer, Date, setTimeout, Int8Array, Uint8ClampedArray, Int16Array, Int32Array, Float32Array, Float64Array });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../assets/js/backup-utils.js'), 'utf8'), context);
const B = context.window.RPHubBackup;
const plain = value => JSON.parse(JSON.stringify(value));
const seed = () => [
  ['characters', [{ uuid: 'a', name: '甲', wechatEnabled: true }, { uuid: 'b', name: '乙' }]],
  ['settings', { apiUrl: 'https://mock.local', apiKey: 'private-api-token', apiProviderKeys: { custom: 'provider-secret' }, imageGenKey: 'image-secret', modelSlots: [{ config: { apiKey: 'slot-secret', model: 'test' } }] }],
  ['chat_a', [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你也好', imageUrl: 'https://mock.local/img?token=image-secret' }]],
  ['chat_a__branch__alt', [{ role: 'assistant', content: '另一个剧情' }]],
  ['branches_a', { activeBranchId: 'main', branches: [{ id: 'main' }, { id: 'alt' }] }],
  ['classic_memories_a', [{ summary: '总结', embeddingQ: 'AQI=', sourceAssistantIds: ['a1'] }]],
  ['wechat_timeline_a', [{ channel: 'wechat', type: 'image', mediaId: 'img-1', storyAt: '2026-01-01T12:00:00' }, { channel: 'rp' }]],
  ['wechat_media_index', [{ id: 'img-1', ownerId: 'a', scopeId: 'a' }]],
  ['wechat_media_blob_img-1', new Blob([new Uint8Array([0, 1, 2, 255])], { type: 'image/png' })],
  ['wechat_voice_blob_voice-1', new Blob(['voice bytes'], { type: 'audio/wav' })],
  ['wechat_document_blob_doc-1', new Blob(['文档原文\n第二行'], { type: 'text/plain' })],
  ['wechat_document_chunk_doc-1_0', { offset: 0, text: '文档原文\n第二行' }],
  ['wechat_document_reader_doc-1', { next: 12, summary: '已经读到第二行' }],
  ['story_recap_a', { summary: '前情提要', rpTurnCount: 1 }],
  ['geographyMaps', [{ world: { id: 'map', name: '自建地图' }, imageData: 'data:image/png;base64,AA==' }]],
  ['workshop_characters', JSON.stringify([{ id: 'draft', name: '工坊草稿', desc: '尚未加入RP的角色' }])],
  ['novel_library', { books: [{ id: 'novel', title: '已保存的小说', chapters: [{ content: '小说原文' }] }] }],
  ['future-data', { nested: [new Blob(['nested']), new Uint16Array([1, 65535]), undefined], when: new Date('2026-01-01Z') }]
];
const browser = { local: { 'rphub-appearance': 'dark', unrelated: 'do not include' },
  session: { rphub_wechat_voice_key: 'voice-secret', rphub_wechat_voice_service: 'https://voice.local' } };
test('多角色、多分支、记忆、提要、地图、图片/语音/文档原件完整往返', async () => {
  const entries = seed(), file = await B.create(entries, { credentials: true, browser });
  const restored = await B.inspect(file), data = new Map(restored.entries);
  assert.deepEqual(plain(data.get('characters')), entries[0][1]);
  assert.equal(data.get('settings').apiKey, 'private-api-token');
  assert.equal(data.get('chat_a__branch__alt')[0].content, '另一个剧情');
  assert.deepEqual([...new Uint8Array(await data.get('wechat_media_blob_img-1').arrayBuffer())], [0, 1, 2, 255]);
  assert.equal(data.get('wechat_media_blob_img-1').type, 'image/png');
  assert.equal(await data.get('wechat_document_blob_doc-1').text(), '文档原文\n第二行');
  assert.equal(data.get('wechat_document_reader_doc-1').summary, '已经读到第二行');
  assert.equal(await data.get('future-data').nested[0].text(), 'nested');
  assert.deepEqual([...data.get('future-data').nested[1]], [1, 65535]);
  assert.equal(data.get('future-data').nested[2], undefined);
  assert.equal(data.get('future-data').when.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.deepEqual(plain(restored.summary), { characters: 2, branches: 2, rp: 3, wechat: 1, memories: 1, images: 1, voices: 1, documents: 1, maps: 1, workshop: 1, novels: 1, entries: entries.length });
  assert.equal(restored.browser.local.unrelated, undefined); assert.equal(restored.browser.session.rphub_wechat_voice_key, 'voice-secret');
});
test('默认移除配置密钥、槽位密钥、带密钥URL，原数据库和附件不改写', async () => {
  const entries = seed(); entries.push(['story-custom-fields', { secret: '角色秘密', password: '剧情中的密码' }]);
  const file = await B.create(entries, { browser }), restored = await B.inspect(file), data = new Map(restored.entries);
  const text = await file.text();
  for (const key of ['private-api-token', 'provider-secret', 'image-secret', 'slot-secret', 'voice-secret']) assert.ok(!text.includes(key));
  assert.equal(data.get('settings').apiKey, undefined);
  assert.equal(data.get('settings').modelSlots[0].config.model, 'test');
  assert.equal(data.get('chat_a')[1].imageUrl, 'https://mock.local/img?token=');
  assert.equal(restored.browser.session.rphub_wechat_voice_key, undefined);
  assert.equal(entries[1][1].apiKey, 'private-api-token');
  assert.deepEqual(plain(data.get('story-custom-fields')), { secret: '角色秘密', password: '剧情中的密码' });
  assert.equal(await data.get('wechat_document_blob_doc-1').text(), '文档原文\n第二行');
});
test('只接受完整备份格式，拒绝聊天JSONL、截断文件和目录损坏', async () => {
  await assert.rejects(B.inspect(new Blob(['{"messages":[]}'.repeat(3)])), /完整备份|导出全部内容/);
  const file = await B.create(seed());
  await assert.rejects(B.inspect(file.slice(0, file.size - 1)), /完整|长度/);
  const bytes = new Uint8Array(await file.arrayBuffer()); bytes[30] ^= 1;
  await assert.rejects(B.inspect(new Blob([bytes])), /目录校验失败/);
});
test('附件损坏拒绝恢复，避免只导入文字却丢失媒体', async () => {
  const file = await B.create(seed());
  const bytes = new Uint8Array(await file.arrayBuffer()); bytes[bytes.length - 1] ^= 1;
  await assert.rejects(B.inspect(new Blob([bytes])), /校验失败/);
});
test('导出拒绝重复键、无效全局设置、循环引用和不支持的对象', async () => {
  await assert.rejects(B.create([['characters', []], ['characters', []]]), /重复/);
  await assert.rejects(B.create([['characters', []], ['settings', 'bad']]), /设置无效/);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(B.create([['characters', []], ['cycle', cyclic]]), /循环/);
  await assert.rejects(B.create([['characters', []], ['map', new Map([['a', 1]])]]), /不支持/);
});
test('文件自称有密钥也可选择移除，嵌套URL同步移除', async () => {
  const restored = await B.inspect(await B.create(seed(), { credentials: true, browser }));
  const clean = B.removeCredentials(restored.entries, restored.browser), settings = new Map(clean).get('settings');
  assert.equal(settings.apiKey, undefined); assert.equal(settings.modelSlots[0].config.apiKey, undefined);
  assert.equal(new Map(clean).get('chat_a')[1].imageUrl, 'https://mock.local/img?token=');
});
