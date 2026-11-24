const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(ROOT, 'assets/js', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const visualCheckReply = options => ({ content: JSON.stringify({
  observations: options.messages.at(-1).content.filter(part => part.type === 'text').map(part => ({
    imageId: /^【核对图片 #([^｜]+)｜/.exec(part.text)[1], details: '可见深色长发、浅色外套；照明较暗。'
  })), differences: ['照片的光线、机位与造型不同，可能由拍摄条件或换装造成。'], uncertainties: ['画面不足以确认人物身份。']
}) });
function harness(respond = async () => ({ content: '{"messages":[]}' })) {
  const stored = new Map(), requests = [], toasts = [];
  let scope = 'branch-a', id = 0;
  const storage = {
    getStoredValue: async key => stored.get(key),
    setStoredValue: async (key, value) => { stored.set(key, structuredClone(value)); },
    deleteStoredValue: async key => stored.delete(key)
  };
  const context = vm.createContext({
    window: { location: { href: 'http://local/' }, RPHubStorage: storage }, console, Blob, DOMException, AbortController, URL, crypto: webcrypto, navigator: { onLine: false },
    ref: value => ({ value }), reactive: value => value, computed: getter => ({ get value() { return getter(); } }), watch() {},
    nextTick: async () => {}, requestAnimationFrame: fn => fn(), document: { getElementById: () => null },
    setTimeout: fn => setTimeout(fn, 0), clearTimeout, setInterval: () => 1, clearInterval() {},
    generateUUID: () => `message-${++id}`, getMainDb: () => ({}), initDB: async () => {}, cloneForStorage: plain,
    setScopedStoredValue: async (key, scopeId, value) => stored.set(`${key}/${scopeId}`, structuredClone(value)),
    getScopedStoredValue: async (key, scopeId) => structuredClone(stored.get(`${key}/${scopeId}`) || [])
  });
  // Use the same worldbook matcher as RP, without replacing the in-memory test storage.
  vm.runInContext(read('built-in-content.js'), context);
  vm.runInContext(read('core-utils.js'), context);
  context.window.RPHubUtils = { generateUUID: context.generateUUID };
  vm.runInContext(read('data-services.js'), context);
  context.window.RPHubStorage = storage;
  vm.runInContext(read('wechat-media.js'), context);
  vm.runInContext(read('image-generation.js'), context);
  const original = context.window.RPHubWeChatMedia;
  const images = new Map([['builtin-salad', { id: 'builtin-salad', caption: '一碗沙拉', title: '沙拉', captionSource: 'curated' }]]);
  let readCount = 0;
  const library = {
    list: async () => [...images.values()], candidates: async () => [...images.values()], get: async id => images.get(id),
    read: async id => { readCount++; if (!images.has(id)) throw new Error('资源不存在'); return new Blob(['pixels']); },
    save: async (image, info) => { const item = { ...image, ...info, id: `asset-${++id}` }; images.set(item.id, item); return item; }
  };
  context.window.RPHubWeChatMedia = { ...original, createLibrary: () => library, blobToDataURL: async () => 'data:image/png;base64,REAL_PIXELS',
    rasterize: async () => ({ blob: new Blob(['pixels']), thumb: new Blob(['thumb']), width: 100, height: 100 }),
    draw: async intent => ({ caption: `手绘纸条：${intent.text}`, captionSource: 'renderer', blob: new Blob(['drawing']) }) };
  const s = {
    currentCharacter: { value: { uuid: 'char-a', name: '小A', wechatEnabled: true, wechatSpeed: 'fast' } }, chatHistory: { value: [] },
    classicMemories: { value: [] }, storyRecap: { value: null }, memorySettings: { enabled: false }, activeStoryBranchId: { value: 'branch-a' },
    settings: { apiUrl: 'https://mock.local', apiKey: 'k', model: 'mock' }, user: { name: '用户' }, worldInfo: { value: [] }, presets: { value: [] },
    getCurrentStoryBranchScopeId: () => scope, buildUserInfoPrompt: () => '用户', processRegex: text => text, scrollChatToBottom: async () => {},
    showToast: (...args) => toasts.push(args),
    requestTrackedChatCompletion: async options => {
      requests.push(structuredClone({ ...options, signal: undefined }));
      return ['微信独立画面核对', '微信画面观察'].includes(options.requestLabel) ? visualCheckReply(options)
        : respond(options, requests.filter(request => !['微信独立画面核对', '微信画面观察'].includes(request.requestLabel)).length);
    }
  };
  vm.runInContext(read('wechat-time.js'), context);
  vm.runInContext(read('wechat-protocol.js'), context);
  vm.runInContext(read('app/25-wechat.js'), context); context.window.RPHubAppSections.wechat(s);
  vm.runInContext(read('app/27-wechat-media.js'), context); context.window.RPHubAppSections.wechatMedia(s);
  return { s, original, protocol: context.window.RPHubWeChatProtocol, stored, requests, toasts, images, context, library,
    get reads() { return readCount; }, setScope(value) { scope = value; },
    async send(text) { s.wechatInput.value = text; await s.sendWechatMessage(); } };
}

const referencePixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=';
const characterRef = id => ({ id, name: id, kind: 'character', description: '角色外貌参考，非现场记录', dataUrl: referencePixel });

test('七图子问题保留原话和图片顺序，不带人设或主模型的改写问题', async () => {
  for (const separate of [false, true]) {
    const h = harness();
    if (separate) h.s.settings.visionModel = 'dedicated-vision';
    h.s.currentCharacter.value.imageReferences = ['a', 'b', 'c'].map(characterRef);
    h.s.currentCharacter.value.wechatPersona = '人设哨兵，所有照片必须承认';
    const original = '下面几张照片，哪张好看？\n原话保留：不要替我改写问题。';
    h.s.wechatTimeline.value = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: 'photo-' + i, channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,test-' + i })),
      { id: 'question', channel: 'wechat', role: 'user', type: 'text', content: original }
    ];
    const budget = h.s.createWechatReferenceBudget();
    const call = { function: { arguments: '{"question":"主模型改写的问题：这些全是自己"}' } };
    const result = await h.s.executeWechatReferenceTool(call, undefined, budget);
    assert.equal(h.requests.length, 1);
    const request = h.requests[0];
    assert.match(request.messages[1].content, /前3张.*后4张/);
    assert.equal(request.messages[1].content.split('【玩家本轮原话】\n')[1], original);
    assert.doesNotMatch(JSON.stringify(request.messages), /人设哨兵|主模型改写的问题/);
    const ids = request.messages.at(-1).content.filter(p => p.type === 'text').map(p => /#([^｜]+)/.exec(p.text)[1]);
    assert.deepEqual(ids, ['reference:a', 'reference:b', 'reference:c', 'photo-0', 'photo-1', 'photo-2', 'photo-3']);
    assert.equal(request.messages.at(-1).content.filter(p => p.type === 'image_url').length, 7);
    assert.equal(result.attachment, undefined);
    assert.match(result.content, /独立视觉比对/);
    await h.s.executeWechatReferenceTool(call, undefined, budget);
    assert.equal(h.requests.length, 1, '同轮相同请求使用缓存');
  }
});

test('历史有图片的普通聊天不注入外貌规则，风景新图不自动请求人物参考', async () => {
  const h = harness(); h.s.currentCharacter.value.imageReferences = [characterRef('a')];
  h.s.wechatTimeline.value = photoBatch(1);
  await h.send('今天作业写完了吗');
  assert.equal(h.requests.length, 1);
  assert.doesNotMatch(h.requests[0].messages[0].content, /可查看的角色资料|外貌与造型|认出本人/);
  h.requests.length = 0;
  h.s.wechatPendingImage.value = 'data:image/png;base64,landscape'; await h.send('风景怎么样');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].requestLabel, '微信回复');
});

test('两种查看工具规范化#消息ID，仍拒绝其他会话和重复前缀', async () => {
  const h = harness(); h.s.currentCharacter.value.imageReferences = [characterRef('a')];
  h.s.wechatTimeline.value = [{ id: 'old', channel: 'wechat', role: 'assistant', type: 'image', media: { assetId: 'builtin-salad' } }];
  const viewed = await h.s.executeWechatImageTool({ function: { name: 'tool_view_image', arguments: '{"messageIds":["#old","old"],"question":"画面"}' } });
  assert.equal(viewed.attachment.content.filter(p => p.type === 'image_url').length, 1);
  const compared = await h.s.executeWechatReferenceTool({ function: { arguments: '{"messageIds":["#old"],"question":"照片人物"}' } });
  assert.match(compared.content, /独立视觉比对/);
  await assert.rejects(h.s.executeWechatImageTool({ function: { name: 'tool_view_image', arguments: '{"messageId":"##old","question":"画面"}' } }), /当前会话/);
  await assert.rejects(h.s.executeWechatReferenceTool({ function: { arguments: '{"messageId":"other-branch","question":"画面"}' } }), /当前会话/);
});

test('参考图不能给same，错误结果不会保存为视觉依据', async () => {
  const h = harness(); h.s.currentCharacter.value.imageReferences = [characterRef('a')];
  h.s.wechatTimeline.value = [{ id: 'new', channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,new' }];
  h.s.requestTrackedChatCompletion = async options => {
    const parsed = JSON.parse(visualCheckReply(options).content);
    parsed.observations.find(i => i.imageId.startsWith('reference:')).verdict = 'same';
    return { content: JSON.stringify(parsed) };
  };
  const result = await h.s.executeWechatReferenceTool({ function: { arguments: '{"question":"比对"}' } });
  assert.match(result.content, /本轮核对失败/);
  assert.equal(h.s.wechatTimeline.value[0].media?.visualEvidence, undefined);
});

test('子问题只返回待判断图即可，不强制重述参考图', async () => {
  const h = harness(); h.s.currentCharacter.value.imageReferences = ['a', 'b', 'c'].map(characterRef);
  h.s.wechatTimeline.value = [{ id: 'new', channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,new' }];
  h.s.requestTrackedChatCompletion = async () => ({ content: JSON.stringify({ observations: [{ imageId: 'new', verdict: 'same', details: '可见人物与参考相符' }], differences: [], uncertainties: [] }) });
  const result = await h.s.executeWechatReferenceTool({ function: { arguments: '{"question":"比对照片"}' } });
  assert.match(result.content, /独立视觉比对/);
  assert.doesNotMatch(result.content, /本轮核对失败/);
  assert.equal(h.s.wechatTimeline.value[0].media.visualEvidence.verdict, 'same');
});

test('视觉判断随照片保存，改换身份参考后不再当作当前依据', async () => {
  const h = harness(); h.s.currentCharacter.value.imageReferences = [characterRef('a')];
  h.s.wechatTimeline.value = [{ id: 'new', channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,new' }];
  await h.s.executeWechatReferenceTool({ function: { arguments: '{"question":"比对"}' } });
  const photo = h.s.wechatTimeline.value[0];
  assert.equal(photo.media.visualEvidence.verdict, 'uncertain');
  assert.match(h.s.wechatImageRecordText(photo), /此前视觉判断/);
  assert.doesNotMatch(h.s.wechatImageRecordText(photo), /reference:a|base64/);
  h.s.currentCharacter.value.imageReferences = [characterRef('b')];
  assert.doesNotMatch(h.s.wechatImageRecordText(photo), /此前视觉判断/);
});

test('单轮批量查看12张旧图不截断，重复ID去重且下次查看不读像素', async () => {
  const h = harness(), budget = h.s.createWechatReferenceBudget();
  h.s.wechatTimeline.value = Array.from({ length: 12 }, (_, i) => ({ id: 'old-' + i, channel: 'wechat', role: 'assistant', type: 'image', media: { assetId: 'builtin-salad' } }));
  const ids = h.s.wechatTimeline.value.map(item => item.id);
  const call = { function: { name: 'tool_view_image', arguments: JSON.stringify({ messageIds: [...ids, ids[0]], question: '逐张描述画面' }) } };
  const first = await h.s.executeWechatImageTool(call, undefined, () => {}, budget);
  assert.equal(first.attachment.content.filter(part => part.type === 'image_url').length, 12);
  assert.equal(h.reads, 12);
  const second = await h.s.executeWechatImageTool(call, undefined, () => {}, budget);
  assert.equal(second.attachment, undefined); assert.equal(h.reads, 12);
  const invalid = { function: { name: 'tool_view_image', arguments: JSON.stringify({ messageIds: [...ids, 'other-branch'], question: '画面' }) } };
  await assert.rejects(h.s.executeWechatImageTool(invalid, undefined, () => {}, budget), /当前会话/);
  assert.equal(h.reads, 12, '整批ID先校验，不读取另一个分支或部分有效图');
});

test('默认一次取完三张人物参考，地点须明确指定，完整图片复用仅记录来源', async () => {
  const h = harness(), budget = h.s.createWechatReferenceBudget();
  h.s.currentCharacter.value.imageReferences = [...['a', 'b', 'c'].map(characterRef), { ...characterRef('room'), kind: 'scene' }];
  budget.imagePixels.set('known-image', referencePixel); budget.imagePixels.set('different-image', 'data:image/png;base64,different');
  const result = await h.s.executeWechatReferenceTool({ function: { arguments: '{"question":"描述参考画面与图片复用来源"}' } }, undefined, budget);
  assert.equal(result.attachment.content.filter(part => part.type === 'image_url').length, 3);
  assert.match(result.content, /图片复用来源.*known-image/);
  assert.doesNotMatch(result.content, /different-image|#room/);
  assert.match(result.content, /不代表不是本人/);
  assert.equal(h.s.wechatImageTools().find(tool => tool.function.name === 'tool_view_character_reference').function.parameters.properties.referenceIds.maxItems, undefined);
});

test('12轮共36次工具调用能到最终回复，重复加载复用且旧图只读一次', async () => {
  const h = harness(async (_options, count) => count <= 12 ? { content: '', toolCalls: [
    { id: 'load-' + count, type: 'function', function: { name: 'tool_load_image_sending', arguments: '{}' } },
    ...[0, 1].map(i => ({ id: `view-${count}-${i}`, type: 'function', function: { name: 'tool_view_image', arguments: '{"messageId":"old","question":"画面颜色"}' } }))
  ] } : { content: '{"messages":[{"type":"text","content":"查看完成"}]}' });
  let pixelReads = 0;
  const read = h.library.read;
  h.library.read = (id, thumbnail) => { if (!thumbnail) pixelReads++; return read(id, thumbnail); };
  h.s.wechatTimeline.value = [{ id: 'old', channel: 'wechat', role: 'assistant', type: 'image', media: { assetId: 'builtin-salad' } }];
  await h.send('在干嘛');
  assert.equal(h.requests.length, 13); assert.equal(pixelReads, 1); assert.equal(h.toasts.length, 0);
  assert.equal(h.requests.at(-1).messages.filter(message => message.role === 'tool').length, 36);
  assert.equal(h.s.wechatTimeline.value.at(-1).content, '查看完成');
});

test('工具持续续写可在第十轮停止，待回复消息保留且晚到最终回复不发送', async () => {
  const h = harness(async (_options, count) => {
    if (count === 10) { h.s.wechatAbortController.abort(); return { content: '{"messages":[{"type":"text","content":"晚到结果"}]}' }; }
    return { content: '', toolCalls: [{ id: 'load-' + count, type: 'function', function: { name: 'tool_load_image_sending', arguments: '{}' } }] };
  });
  await h.send('普通聊天');
  assert.equal(h.requests.length, 10);
  assert.ok(h.s.wechatTimeline.value.every(item => item.role === 'user'));
  assert.equal(h.s.wechatUnansweredCount.value, 1);
});

const photoBatch = (count = 4) => [
  ...Array.from({ length: count }, (_, i) => ({ id: 'batch-' + i, channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,photo-' + i,
    media: { caption: '旧描述' + i } })),
  { id: 'batch-answer', channel: 'wechat', role: 'assistant', type: 'text', content: '逐张描述过了' }
];

test('四图追问按需独立比对，完整原话和参考在前的顺序保留', async () => {
  const h = harness(async (options, count) => count === 1 && h.s.wechatTimeline.value.at(-1).content === '这4张，哪张是你自己？'
    ? { content: '', toolCalls: [{ id: 'reference', type: 'function', function: { name: 'tool_view_character_reference', arguments: '{"question":"判断四张照片"}' } }] }
    : { content: '{"messages":[{"type":"text","content":"看到了"}]}' });
  h.s.currentCharacter.value.imageReferences = ['a', 'b'].map(characterRef);
  h.s.wechatTimeline.value = photoBatch();
  const question = '这4张，哪张是你自己？';
  await h.send(question);
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[0].requestLabel, '微信回复');
  const verification = h.requests[1];
  assert.equal(verification.requestLabel, '微信独立画面核对');
  assert.ok(verification.messages[1].content.endsWith(question));
  assert.ok(verification.messages[1].content.includes(question));
  assert.match(verification.messages[1].content, /前2张.*后4张/);
  const labels = verification.messages.at(-1).content.filter(part => part.type === 'text');
  assert.deepEqual(labels.map(part => /#([^｜]+)/.exec(part.text)[1]), ['reference:a', 'reference:b', 'batch-0', 'batch-1', 'batch-2', 'batch-3']);
  assert.equal(h.requests[2].messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url').length, 4);
  assert.doesNotMatch(JSON.stringify(h.s.wechatTimeline.value), /独立画面核对资料/);
  h.requests.length = 0; await h.send('今天怎么样');
  assert.equal(h.requests.length, 1); assert.doesNotMatch(JSON.stringify(h.requests), /image_url|追问旧图/);
});

test('中文数量和逐张追问可取最近整组，数量不符不截断、不串不同批次', async () => {
  const h = harness();
  for (const phrase of ['这四张照片有哪些区别', '上面的照片呢', '第一张的眉眼看得清吗', '这几张呢']) {
    h.s.wechatTimeline.value = [...photoBatch(), { channel: 'wechat', role: 'user', type: 'text', content: phrase }];
    assert.equal(h.s.getWechatFollowupImages().length, 4, phrase);
  }
  for (const [batch, phrase] of [[photoBatch(), '这3张'], [photoBatch(), '这五张'], [photoBatch(), '今天怎么样']]) {
    h.s.wechatTimeline.value = [...batch, { channel: 'wechat', role: 'user', type: 'text', content: phrase }];
    assert.equal(h.s.getWechatFollowupImages().length, 0, phrase);
  }
  h.s.wechatTimeline.value = [...photoBatch(), ...photoBatch(2), { channel: 'wechat', role: 'user', type: 'text', content: '这4张' }];
  assert.equal(h.s.getWechatFollowupImages().length, 0);
});

test('超过四张的旧图追问保留完整批次与原编号，支持多位数量和第五张之后的指代', async () => {
  const h = harness();
  for (const [count, phrases] of [
    [5, ['这5张', '这五张照片', '第五张的衣服', '这几张']],
    [12, ['那12张', '这十二张照片', '第十二张', '第12张']],
    [50, ['这50张', '这五十张', '上面的照片']]
  ]) {
    for (const phrase of phrases) {
      h.s.wechatTimeline.value = [...photoBatch(count), { channel: 'wechat', role: 'user', type: 'text', content: phrase }];
      assert.deepEqual(plain(h.s.getWechatFollowupImages()).map(item => item.id), Array.from({ length: count }, (_, i) => 'batch-' + i), phrase);
    }
  }
  h.s.wechatTimeline.value = [...photoBatch(6), { channel: 'wechat', role: 'user', type: 'text', content: '这六张照片' }];
  await h.s.runWechatGeneration();
  const labels = h.requests[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(part => part.type === 'text' && part.text.startsWith('【本轮追问旧图')).map(part => part.text);
  assert.equal(labels.length, 6);
  assert.match(labels[5], /#batch-5｜第6张，共6张/);
});

test('追问照片不跨RP段、半小时或48条记录，描述卡不被略过重编号，新图优先', async () => {
  const h = harness(), time = Date.UTC(2025, 2, 11, 18, 30);
  const pending = { channel: 'wechat', role: 'user', type: 'text', content: '这4张', storyAt: time };
  const original = photoBatch();
  for (const history of [
    [...original, { channel: 'rp', role: 'assistant', type: 'text' }],
    original.map(item => ({ ...item, storyAt: time - 31 * 60000 })),
    [...original, ...Array.from({ length: 49 }, () => ({ channel: 'wechat', role: 'assistant', type: 'text' }))],
    original.map((item, i) => i === 2 ? { ...item, media: { descriptionOnly: true } } : item)
  ]) {
    h.s.wechatTimeline.value = [...history, pending];
    assert.equal(h.s.getWechatFollowupImages().length, 0);
  }
  h.s.wechatTimeline.value = [...original, pending, { id: 'new', channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,new' }];
  assert.equal(h.s.getWechatFollowupImages().length, 0);
});

test('已附整组追问照片共享去重预算，参考查看不再次附图', async () => {
  const h = harness(), budget = h.s.createWechatReferenceBudget(); h.s.currentCharacter.value.imageReferences = [characterRef('a')];
  h.s.wechatTimeline.value = [...photoBatch(), { channel: 'wechat', role: 'user', type: 'text', content: '这4张' }];
  await h.s.buildWechatVisualMessages([], undefined, budget);
  const viewed = await h.s.executeWechatImageTool({ function: { name: 'tool_view_image', arguments: '{"messageId":"batch-0","question":"眼睛形状"}' } }, undefined, () => {}, budget);
  assert.ok(!viewed.attachment); assert.equal(h.reads, 0);
  const compared = await h.s.executeWechatReferenceTool({ function: { arguments: '{"question":"可见妆容","messageId":"batch-0"}' } }, undefined, budget);
  assert.equal(compared.attachment, undefined);
  assert.match(compared.content, /独立视觉比对/);
});

test('追问组中资源丢失保留原编号，拒绝不完整核对；切分支丢弃晚到像素', async () => {
  const h = harness(); h.s.currentCharacter.value.imageReferences = [characterRef('a')];
  const batch = photoBatch(); batch[1] = { ...batch[1], content: '', media: { assetId: 'missing' } };
  h.s.wechatTimeline.value = [...batch, { channel: 'wechat', role: 'user', type: 'text', content: '这4张' }];
  const budget = h.s.createWechatReferenceBudget(), visual = await h.s.buildWechatVisualMessages([], undefined, budget);
  assert.equal(visual.at(-1).content.filter(part => part.type === 'image_url').length, 3);
  assert.match(JSON.stringify(visual), /第2张无法核对|第3张，共4张/);
  const checked = await h.s.checkWechatVisualContext(visual, undefined, budget, undefined, { mode: 'compare' });
  assert.match(checked.at(-1).content, /本轮核对失败/); assert.equal(h.requests.length, 0);
  const switched = harness(); switched.s.wechatTimeline.value = [...photoBatch(1), { channel: 'wechat', role: 'user', type: 'text', content: '这张' }];
  switched.s.wechatTimeline.value[0].media = { assetId: 'builtin-salad' }; switched.s.wechatTimeline.value[0].content = '';
  switched.library.read = async () => { switched.setScope('branch-b'); return new Blob(['late']); };
  await assert.rejects(switched.s.buildWechatVisualMessages([]), { name: 'AbortError' });
});

test('本人生成记录保留来源事实，用户上传、他人或历史缺标记不能冒充本人证据', () => {
  const h = harness(), generated = { id: 'selfie', role: 'assistant', media: { source: 'generate', selfPortrait: true, captionSource: 'generation_prompt', caption: '校园自拍' } };
  assert.match(h.original.imageRecordText(generated), /角色以本人入镜生成并发送.*来源已知.*生成意图/);
  for (const item of [ { ...generated, role: 'user' }, { ...generated, media: { ...generated.media, source: 'upload' } },
    { ...generated, media: { ...generated.media, selfPortrait: false } }, { ...generated, media: { ...generated.media, selfPortrait: undefined } } ]) {
    assert.doesNotMatch(h.original.imageRecordText(item), /来源已知/);
  }
});

test('独立视觉模型先只观察本轮图片，普通画面不预读人物参考', async () => {
  const h = harness(async () => ({ content: '{"messages":[{"type":"text","content":"看到了"}]}' }));
  h.s.settings.visionModel = 'dedicated-vision';
  h.s.currentCharacter.value.imageReferences = ['a', 'b', 'c'].map(id => ({ ...characterRef(id), dataUrl: undefined, src: 'card/' + id + '.jpg' }));
  h.s.currentCharacter.value.wechatPersona = '私密预设哨兵';
  const original = h.context.window.RPHubWeChatMedia.rasterize;
  let reads = 0;
  h.context.window.RPHubWeChatMedia.rasterize = async src => { reads++; return original(src); };
  h.s.wechatPendingImage.value = 'data:image/png;base64,test'; await h.send('这片风景怎么样');
  assert.equal(h.requests.length, 2);
  const observation = h.requests[0];
  assert.equal(observation.requestLabel, '微信画面观察');
  assert.equal(observation.model, 'dedicated-vision');
  assert.equal(observation.tools, undefined);
  assert.equal(observation.messages.at(-1).content.filter(p => p.type === 'image_url').length, 1);
  assert.doesNotMatch(JSON.stringify(observation), /私密预设哨兵|reference:a|目标人物的参考图/);
  assert.ok(observation.messages[1].content.includes('这片风景怎么样'));
  assert.equal(reads, 1, '只进行上传转码，不读取人物参考');
  h.requests.length = 0; await h.send('好呀');
  assert.equal(h.requests.length, 1); assert.doesNotMatch(JSON.stringify(h.requests), /image_url|微信画面观察/);
});

test('核对结论按图返回 verdict，非法取值按核对失败处理，超时放宽到长核对', async () => {
  for (const verdict of ['same', 'likely', 'uncertain', 'different', 'baseline', 'not_applicable', 'stranger', undefined]) {
    const h = harness(); h.s.currentCharacter.value.imageReferences = [characterRef('a')];
    h.s.wechatTimeline.value = [{ id: 'new', channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,user' }];
    h.s.requestTrackedChatCompletion = async options => {
      h.requests.push(options);
      const parsed = JSON.parse(visualCheckReply(options).content);
      if (verdict !== undefined) parsed.observations.find(item => item.imageId === 'new').verdict = verdict;
      return { content: JSON.stringify(parsed), finishReason: 'stop' };
    };
    const visual = await h.s.buildWechatVisualMessages([]);
    const checked = await h.s.checkWechatVisualContext(visual, undefined, h.s.createWechatReferenceBudget(), undefined, { mode: 'compare' });
    assert.equal(h.requests[0].timeoutMs, 240000);
    if (verdict === undefined) assert.match(checked.at(-1).content, /独立画面核对资料/);
    else if (['same', 'likely', 'uncertain', 'different', 'not_applicable'].includes(verdict)) assert.match(checked.at(-1).content, new RegExp(`"verdict":"${verdict}"`));
    else assert.match(checked.at(-1).content, /本轮核对失败/);
  }
});

test('非人物图片不进入身份框架：全部 not_applicable 时只发画面规则', async () => {
  const h = harness(); h.s.currentCharacter.value.imageReferences = [characterRef('a')];
  h.s.wechatTimeline.value = [{ id: 'new', channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,scenery' }];
  h.s.requestTrackedChatCompletion = async options => {
    h.requests.push(options);
    const parsed = JSON.parse(visualCheckReply(options).content);
    parsed.observations.forEach(item => { item.verdict = item.imageId === 'new' ? 'not_applicable' : 'baseline'; });
    return { content: JSON.stringify(parsed), finishReason: 'stop' };
  };
  const visual = await h.s.buildWechatVisualMessages([]);
  const checked = await h.s.checkWechatVisualContext(visual, undefined, h.s.createWechatReferenceBudget(), undefined, { mode: 'compare' });
  const payload = checked.map(message => message.content).join('\n');
  assert.match(payload, /本轮画面资料/);
  assert.doesNotMatch(payload, /长相基准|承认为本人/);
});

test('同模型也先独立核对，整批四张新图均覆盖，结果缓存仅用于本轮且参考共享预算', async () => {
  const h = harness(); h.s.currentCharacter.value.imageReferences = [characterRef('a'), characterRef('b'), characterRef('c')];
  h.s.wechatTimeline.value = Array.from({ length: 4 }, (_, i) => ({ id: 'new-' + i, channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,user' }));
  const budget = h.s.createWechatReferenceBudget(), signal = new AbortController().signal;
  const visual = await h.s.buildWechatVisualMessages([], signal, budget);
  const checked = await h.s.checkWechatVisualContext(visual, signal, budget, undefined, { mode: 'compare' });
  await h.s.checkWechatVisualContext(visual, signal, budget, undefined, { mode: 'compare' });
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].model, h.s.settings.model);
  assert.equal(JSON.parse(checked.at(-1).content.split('\n')[1]).observations.length, 7);
  const viewed = await h.s.executeWechatReferenceTool({ function: { arguments: '{"referenceIds":["c"],"question":"看造型"}' } }, signal, budget);
  assert.equal(viewed.attachment, undefined);
  assert.equal(h.requests.length, 2, '显式选择不同参考集合独立核对，像素仍复用');
});

test('画面核对调试记录实际通过校验的资料，关闭时不记录，缓存不重复打印', async () => {
  const h = harness(), logs = [];
  h.context.console = { info: line => logs.push(line) };
  h.s.currentCharacter.value.imageReferences = [characterRef('a')];
  h.s.wechatTimeline.value = [{ id: 'new', channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,private-pixels' }];
  const visual = await h.s.buildWechatVisualMessages([]);
  await h.s.checkWechatVisualContext(visual, undefined, h.s.createWechatReferenceBudget(), undefined, { mode: 'compare' });
  assert.equal(logs.length, 0);
  h.s.settings.debugModelRequests = true;
  const budget = h.s.createWechatReferenceBudget();
  const checked = await h.s.checkWechatVisualContext(visual, undefined, budget, undefined, { mode: 'compare' });
  await h.s.checkWechatVisualContext(visual, undefined, budget, undefined, { mode: 'compare' });
  assert.equal(logs.length, 1);
  const evidence = JSON.parse(logs[0].slice('[微信画面核对结果] '.length));
  assert.equal(evidence.status, 'accepted');
  assert.equal(evidence.model, 'mock');
  assert.deepEqual(evidence.observations, JSON.parse(checked.at(-1).content.split('\n')[1]).observations);
  assert.doesNotMatch(logs[0], /data:image|base64|private-pixels/);
  h.context.console.info = () => { throw new Error('debug hook'); };
  await h.s.checkWechatVisualContext(visual, undefined, h.s.createWechatReferenceBudget(), undefined, { mode: 'compare' });
});

test('真实模型回传的展示编号与参考图原ID可精确归一化，仍拒绝重复或未知编号', async () => {
  for (const variant of ['display-marker', 'reference-id', 'reference-marker', 'duplicate', 'unknown', 'double-marker']) {
    const h = harness(); h.s.currentCharacter.value.imageReferences = [characterRef('a')];
    h.s.wechatTimeline.value = [{ id: 'new', channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,user' }];
    h.s.requestTrackedChatCompletion = async options => {
      const parsed = JSON.parse(visualCheckReply(options).content);
      parsed.observations.forEach(item => { item.imageId = '#' + item.imageId; });
      if (variant === 'reference-id') parsed.observations[0].imageId = 'a';
      if (variant === 'reference-marker') parsed.observations[0].imageId = '#a';
      if (variant === 'duplicate') parsed.observations[0].imageId = 'new';
      if (variant === 'unknown') parsed.observations[0].imageId = '#reference:missing';
      if (variant === 'double-marker') parsed.observations[0].imageId = '##new';
      return { content: '```json\n' + JSON.stringify(parsed) + '\n```', finishReason: 'stop' };
    };
    const visual = await h.s.buildWechatVisualMessages([]);
    const checked = await h.s.checkWechatVisualContext(visual, undefined, h.s.createWechatReferenceBudget(), undefined, { mode: 'compare' });
    if (['display-marker', 'reference-id', 'reference-marker'].includes(variant)) {
      const parsed = JSON.parse(checked.at(-1).content.split('\n')[1]);
      assert.deepEqual(parsed.observations.map(item => item.imageId), ['reference:a', 'new']);
    } else assert.match(checked.at(-1).content, /本轮核对失败/);
  }
});

test('核对拒绝漏图、重复ID、身份结论字段、截断及网络错误，普通回复保留不确定且不重试', async () => {
  for (const variant of ['missing', 'duplicate', 'identity', 'length', 'network']) {
    const h = harness(); h.s.currentCharacter.value.imageReferences = [characterRef('a')];
    const logs = []; h.context.console = { info: line => logs.push(line) }; h.s.settings.debugModelRequests = true;
    h.s.wechatTimeline.value = [{ id: 'new', channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,user' }];
    h.s.requestTrackedChatCompletion = async options => {
      h.requests.push(options); if (variant === 'network') throw new Error('HTTP 503');
      const parsed = JSON.parse(visualCheckReply(options).content);
      if (variant === 'missing') parsed.observations.pop();
      if (variant === 'duplicate') parsed.observations[0].imageId = 'new';
      if (variant === 'identity') parsed.samePerson = true;
      return { content: JSON.stringify(parsed), finishReason: variant === 'length' ? 'length' : 'stop' };
    };
    const signal = new AbortController().signal, budget = h.s.createWechatReferenceBudget();
    const visual = await h.s.buildWechatVisualMessages([], signal, budget);
    const checked = await h.s.checkWechatVisualContext(visual, signal, budget, undefined, { mode: 'compare' });
    assert.equal(h.requests.length, 1); assert.match(checked.at(-1).content, /本轮核对失败/);
    assert.doesNotMatch(checked.at(-1).content, /samePerson|独立画面核对资料/);
    const evidence = logs.map(line => JSON.parse(line.slice('[微信画面核对结果] '.length)));
    assert.equal(evidence.at(-1).status, 'failed');
    if (variant !== 'network') {
      assert.equal(evidence[0].status, 'rejected');
      assert.deepEqual(evidence[0].expectedImageIds, ['reference:a', 'new']);
      assert.ok(evidence[0].rawContent.includes('observations'));
    }
  }
});

test('参考读取失败不发识图请求；识图期间停止、切分支、切角色或编辑使晚到结果失效', async () => {
  const failed = harness(); failed.s.currentCharacter.value.imageReferences = [{ ...characterRef('a'), dataUrl: undefined, src: 'missing.jpg' }];
  failed.s.wechatTimeline.value = [{ id: 'new', channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,user' }];
  failed.context.window.RPHubWeChatMedia.rasterize = async () => { throw new Error('参考打不开'); };
  const visual = await failed.s.buildWechatVisualMessages([]);
  const checked = await failed.s.checkWechatVisualContext(visual, undefined, failed.s.createWechatReferenceBudget(), undefined, { mode: 'compare' });
  assert.equal(failed.requests.length, 0); assert.match(checked.at(-1).content, /本轮核对失败/);
  for (const change of ['stop', 'branch', 'character', 'revision']) {
    const h = harness(); h.s.currentCharacter.value.imageReferences = [characterRef('a')];
    const logs = []; h.context.console = { info: line => logs.push(line) }; h.s.settings.debugModelRequests = true;
    h.s.wechatTimeline.value = [{ id: 'new', channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,user' }];
    let release; const controller = new AbortController();
    h.s.requestTrackedChatCompletion = options => new Promise(resolve => { release = () => resolve(visualCheckReply(options)); });
    const budget = h.s.createWechatReferenceBudget(), input = await h.s.buildWechatVisualMessages([], controller.signal, budget);
    const pending = h.s.checkWechatVisualContext(input, controller.signal, budget, undefined, { mode: 'compare' });
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    if (change === 'stop') controller.abort();
    if (change === 'branch') h.setScope('branch-b');
    if (change === 'character') h.s.currentCharacter.value.uuid = 'char-b';
    if (change === 'revision') h.s.conversationRevision = (h.s.conversationRevision || 0) + 1;
    release(); await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(budget.visualCheck, null);
    assert.equal(logs.length, 0, '取消或切会话后不记录晚到的核对结果');
  }
});

test('新图与最近场景图一起提供给主聊天，无需预先身份比对', async () => {
  const h = harness(), time = Date.UTC(2025, 2, 11, 18, 40);
  h.s.wechatTimeline.value = [
    { id: 'old', channel: 'wechat', role: 'assistant', type: 'image', storyAt: time, media: { assetId: 'builtin-salad', source: 'generate', usage: 'scene_photo' } },
    { id: 'new', channel: 'wechat', role: 'user', type: 'image', storyAt: time, content: 'data:image/png;base64,new' }
  ];
  await h.s.runWechatGeneration();
  assert.equal(h.requests.length, 1);
  const pixels = h.requests[0].messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url');
  assert.equal(pixels.length, 2);
  assert.match(JSON.stringify(h.requests[0]), /本轮对照旧图/);
  h.requests.length = 0; await h.send('好的');
  assert.equal(h.requests.length, 1); assert.doesNotMatch(JSON.stringify(h.requests), /image_url|本轮对照旧图/);
});

test('照片对照不跨RP段、不跨半小时、不使用参考旧图或描述卡片，最多一张', async () => {
  const h = harness(), time = Date.UTC(2025, 2, 11, 18, 40);
  const old = { id: 'old', channel: 'wechat', role: 'assistant', type: 'image', storyAt: time,
    media: { assetId: 'builtin-salad', source: 'generate', usage: 'scene_photo' } };
  const fresh = { id: 'new', channel: 'wechat', role: 'user', type: 'image', storyAt: time, content: 'data:image/png;base64,user' };
  for (const history of [
    [{ ...old, storyAt: time - 31 * 60000 }],
    [old, { channel: 'rp', role: 'assistant', content: '到了另一个场景' }],
    [{ ...old, media: { ...old.media, usage: 'reference', source: 'album' } }],
    [{ ...old, media: { ...old.media, usage: 'reference', selfPortrait: true } }],
    [{ ...old, media: { ...old.media, descriptionOnly: true } }]
  ]) {
    h.s.wechatTimeline.value = [...history, fresh];
    assert.equal(h.s.getWechatComparisonImages().length, 0);
  }
  h.s.wechatTimeline.value = [old, { ...old, id: 'latest' }, fresh];
  assert.deepEqual(plain(h.s.getWechatComparisonImages()).map(item => item.id), ['latest']);
  h.s.wechatTimeline.value = [{ ...old, media: { ...old.media, usage: 'reference' } }, fresh];
  assert.equal(h.s.getWechatComparisonImages()[0].id, 'old', '旧生成图的默认参考用途仍可临时对照，不改写旧记录');
  assert.equal(h.original.normalizeIntent({ mode: 'generate', prompt: '自拍' }).usage, 'scene_photo');
  assert.equal(h.original.normalizeIntent({ mode: 'album', assetId: 'photo' }).usage, 'reference');
});

test('已附对照图查看工具不重复读取，参考工具也不重复附旧图', async () => {
  const h = harness(), budget = h.s.createWechatReferenceBudget();
  h.s.currentCharacter.value.imageReferences = [characterRef('a')];
  h.s.wechatTimeline.value = [
    { id: 'old', channel: 'wechat', role: 'assistant', type: 'image', media: { assetId: 'builtin-salad' } },
    { id: 'new', channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,user' }
  ];
  await h.s.buildWechatVisualMessages([], undefined, budget); const reads = h.reads;
  const result = await h.s.executeWechatImageTool({ function: { name: 'tool_view_image', arguments: '{"messageId":"old","question":"衣着"}' } }, undefined, () => {}, budget);
  assert.ok(!result.attachment); assert.equal(h.reads, reads);
  const ref = await h.s.executeWechatReferenceTool({ function: { arguments: '{"question":"发型","messageId":"old"}' } }, undefined, budget);
  assert.equal(ref.attachment, undefined);
  assert.match(ref.content, /独立视觉比对/);
});

test('旧场景资源丢失保留新图并说明无法对照，切换角色丢弃晚到结果', async () => {
  const h = harness();
  h.s.wechatTimeline.value = [
    { id: 'old', channel: 'wechat', role: 'assistant', type: 'image', media: { assetId: 'missing' } },
    { id: 'new', channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,user' }
  ];
  const messages = await h.s.buildWechatVisualMessages([]);
  assert.equal(messages[0].content.filter(p => p.type === 'image_url').length, 1);
  assert.match(JSON.stringify(messages), /读取失败/);
  h.library.read = async () => { h.s.currentCharacter.value.uuid = 'another'; return new Blob(['pixels']); };
  await assert.rejects(h.s.buildWechatVisualMessages([]), { name: 'AbortError' });
});
test('按需参考比对只向子请求发送参考像素，主聊天收到依据', async () => {
  const h = harness(async options => h.s.wechatTimeline.value.filter(i => i.role === 'user' && i.type === 'text').at(-1)?.content === '核对照片' && !options.messages.some(m => m.role === 'tool')
    ? { content: '', toolCalls: [{ id: 'ref-call', type: 'function', function: { name: 'tool_view_character_reference', arguments: '{"question":"比较照片"}' } }] }
    : { content: '{"messages":[{"type":"text","content":"看到了"}]}' });
  h.s.currentCharacter.value.imageReferences = ['front', 'side', 'third'].map(characterRef);
  h.s.wechatPendingImage.value = 'data:image/png;base64,test'; await h.send('核对照片');
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[0].requestLabel, '微信回复');
  assert.equal(h.requests[1].requestLabel, '微信独立画面核对');
  assert.ok(JSON.stringify(h.requests[1]).includes(referencePixel));
  const continuation = JSON.stringify(h.requests[2].messages);
  assert.ok(!continuation.includes(referencePixel));
  assert.match(continuation, /独立视觉比对|本轮新图/);
  assert.equal(h.requests[2].messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url').length, 1);
  h.requests.length = 0; await h.send('好呀');
  assert.equal(h.requests.length, 1); assert.doesNotMatch(JSON.stringify(h.requests), /image_url|REAL_PIXELS/);
});

test('参考图按当前卡隔离、第三张允许追加、同轮重复不重读或附图', async () => {
  const h = harness(); h.s.currentCharacter.value.imageReferences = [characterRef('a'), characterRef('b'), characterRef('c')];
  const budget = h.s.createWechatReferenceBudget(), call = ids => ({ function: { name: 'tool_view_character_reference', arguments: JSON.stringify({ referenceIds: ids, question: '发型' }) } });
  const result = await h.s.executeWechatReferenceTool(call(['a', 'b']), undefined, budget);
  assert.ok(result.attachment);
  assert.ok(!(await h.s.executeWechatReferenceTool(call(['a', 'b']), undefined, budget)).attachment);
  assert.equal((await h.s.executeWechatReferenceTool(call(['c']), undefined, budget)).attachment.content.filter(part => part.type === 'image_url').length, 1);
  await assert.rejects(h.s.executeWechatReferenceTool(call(['other-role']), undefined, h.s.createWechatReferenceBudget()), /当前角色卡/);
  const missing = call(['a']); missing.function.arguments = JSON.stringify({ question: '头发', messageId: 'other-branch' });
  await assert.rejects(h.s.executeWechatReferenceTool(missing), /当前会话/);
});
test('独立视觉模型一次收到角色参考和待核对照片，聊天只收到短结果', async () => {
  const h = harness(async () => ({ content: '照片呈现较年幼的外观，发型与设定存在差异，不能验证身份。' }));
  h.s.settings.visionModel = 'vision'; h.s.currentCharacter.value.imageReferences = [characterRef('a')];
  h.s.wechatTimeline.value = [{ id: 'target', channel: 'wechat', role: 'user', type: 'image', media: { assetId: 'builtin-salad' } }];
  const result = await h.s.executeWechatReferenceTool({ function: { name: 'tool_view_character_reference', arguments: JSON.stringify({ question: '外貌与设定是否相容', messageId: 'target' }) } });
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].model, 'vision');
  assert.match(JSON.stringify(h.requests[0].messages), /待判断图/);
  assert.ok(!result.attachment); assert.ok(!result.content.includes('base64')); assert.match(result.content, /独立视觉比对/);
});

test('同轮重排或重叠参考选择不重复读取附图，独立视觉问题分别回答', async () => {
  const h = harness(), G = h.context.window.RPHubImageGeneration, reads = [];
  h.s.currentCharacter.value.imageReferences = [characterRef('a'), characterRef('b')];
  h.context.window.RPHubImageGeneration = { ...G, resolveReferences: async refs => { reads.push(...refs.map(ref => ref.id)); return refs; } };
  const call = (ids, question = '发型') => ({ function: { name: 'tool_view_character_reference', arguments: JSON.stringify({ referenceIds: ids, question }) } });
  const budget = h.s.createWechatReferenceBudget();
  await h.s.executeWechatReferenceTool(call(['a']), undefined, budget);
  const second = await h.s.executeWechatReferenceTool(call(['b', 'a']), undefined, budget);
  assert.equal(second.attachment.content.filter(part => part.type === 'image_url').length, 1);
  assert.ok(!(await h.s.executeWechatReferenceTool(call(['a', 'b']), undefined, budget)).attachment);
  assert.deepEqual(reads, ['a', 'b']);
  h.s.settings.visionModel = 'vision';
  const visionBudget = h.s.createWechatReferenceBudget();
  await h.s.executeWechatReferenceTool(call(['a'], '发型'), undefined, visionBudget);
  await h.s.executeWechatReferenceTool(call(['a'], '服装'), undefined, visionBudget);
  assert.equal(h.requests.length, 2);
  assert.match(JSON.stringify(h.requests[1].messages), /问题：服装/);
  assert.deepEqual(reads, ['a', 'b', 'a']);
});

test('同模型的身份核对也用独立请求，主聊天取得结构化结果', async () => {
  const h = harness(); h.s.settings.visionModel = h.s.settings.model;
  h.s.currentCharacter.value.imageReferences = [characterRef('a'), characterRef('b')];
  h.s.wechatTimeline.value = [{ id: 'target', channel: 'wechat', role: 'assistant', type: 'image', media: { assetId: 'builtin-salad', caption: '旧图' } }];
  const result = await h.s.executeWechatReferenceTool({ function: { name: 'tool_view_character_reference', arguments: JSON.stringify({ referenceIds: ['a', 'b'], question: '核对外貌', messageId: 'target' }) } });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].messages.at(-1).content.filter(part => part.type === 'image_url').length, 3);
  assert.equal(result.attachment, undefined);
  assert.match(result.content, /独立视觉比对/);
  const viewed = await h.s.executeWechatImageTool({ function: { name: 'tool_view_image', arguments: '{"messageId":"target","question":"颜色"}' } });
  assert.ok(viewed.attachment); assert.equal(h.requests.length, 1);
});

test('新图已在本轮视觉输入时查看工具不重复读图或计费', async () => {
  const h = harness(); h.s.settings.visionModel = 'different-vision';
  h.s.wechatTimeline.value = [{ id: 'new', channel: 'wechat', role: 'user', type: 'image', media: { assetId: 'builtin-salad' } }];
  const result = await h.s.executeWechatImageTool({ function: { name: 'tool_view_image', arguments: '{"messageId":"new","question":"发型"}' } });
  assert.equal(h.requests.length, 0); assert.equal(h.reads, 0); assert.ok(!result.attachment);
  assert.match(result.content, /完整视觉附件已经提供/);
});

test('同模型独立核对加批量工具共三次请求，下一轮一请求且仅有描述', async () => {
  const h = harness(async (_options, count) => count === 1
    ? { content: '', toolCalls: [{ id: 'batch', type: 'function', function: { name: 'tool_view_character_reference', arguments: '{"referenceIds":["a","b"],"question":"核对发型"}' } }] }
    : { content: JSON.stringify({ messages: [{ type: 'text', content: '这张发型不对呀' }], image_descriptions: [{ messageId: h.s.wechatTimeline.value.find(item => item.type === 'image').id, caption: '围巾与长发的人物照片' }] }) });
  h.s.settings.visionModel = h.s.settings.model;
  h.s.currentCharacter.value.imageReferences = [characterRef('a'), characterRef('b')];
  h.s.wechatPendingImage.value = 'data:image/png;base64,test'; await h.send('照片像你吗');
  assert.equal(h.requests.length, 3); assert.ok(h.requests.every(request => request.model === h.s.settings.model));
  assert.equal(h.requests[2].messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url').length, 1);
  h.requests.length = 0;
  // This next turn needs no visual question or tool.
  h.s.requestTrackedChatCompletion = async options => { h.requests.push(structuredClone({ ...options, signal: undefined })); return { content: '{"messages":[]}' }; };
  await h.send('好，马上');
  assert.equal(h.requests.length, 1);
  assert.match(JSON.stringify(h.requests[0].messages), /围巾与长发的人物照片/);
  assert.doesNotMatch(JSON.stringify(h.requests[0].messages), /data:image|base64|工具返回的角色参考资料/);
});
test('读取参考图期间切角色或清空，晚到结果被丢弃', async () => {
  const h = harness(); h.s.currentCharacter.value.imageReferences = [characterRef('a')];
  const G = h.context.window.RPHubImageGeneration; let finish;
  h.context.window.RPHubImageGeneration = { ...G, resolveReferences: () => new Promise(resolve => { finish = resolve; }) };
  const pending = h.s.executeWechatReferenceTool({ function: { name: 'tool_view_character_reference', arguments: '{"question":"发型"}' } });
  h.s.currentCharacter.value = { uuid: 'other', name: '其他角色' }; finish([characterRef('a')]);
  await assert.rejects(pending, { name: 'AbortError' });
});
test('新图片意图不依赖 content，非法图/源码和多图不降级成文本', () => {
  const { protocol: p } = harness();
  const reply = p.parseReplyResult('{"messages":[{"type":"image_request","media":{"mode":"draw","template":"note","text":"晚安"}}]}');
  assert.equal(reply.messages[0].type, 'image_request');
  assert.equal(reply.silent, false);
  for (const raw of ['{"messages":[{"type":"image","content":"<svg>"}]}', '{"messages":[{"type":"image_request","media":{"mode":"draw","template":"script","text":"x"}}]}']) assert.throws(() => p.parseReplyResult(raw));
  assert.throws(() => p.normalizeMessages([{ type: 'image_request', media: { mode: 'album', assetId: 'a' } }, { type: 'image_request', media: { mode: 'album', assetId: 'b' } }]));
});

const textItem = (role, content, id = content) => ({ id, ts: 1, channel: 'wechat', role, type: 'text', content });
test('natural WeChat selfie transmits reference selection and format guide without pixels or old prompts in chat', async () => {
  const h = harness(async () => ({ content: JSON.stringify({ messages: [{ type: 'image_request', media: { mode: 'generate', selfPortrait: true, prompt: '她在教学楼里微笑着自拍。', description: '课后的自拍' } }] }) }));
  const G = h.context.window.RPHubImageGeneration;
  h.s.settings.wechatImageApi = { ...G.DEFAULTS, ...G.PRESETS.yeelo, apiKey: 'image-secret' };
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=';
  h.s.currentCharacter.value.imageReferences = [{ id: 'face', name: '本人', kind: 'character', dataUrl }];
  let actual;
  h.context.window.RPHubImageGeneration = { ...G, generate: async (config, prompt) => { actual = { config, prompt }; return new Blob(['pixels']); } };
  await h.send('可以给我拍张漂亮的自拍吗？');
  assert.ok(actual.prompt.includes('【本轮画面】她在教学楼里微笑着自拍。')); assert.equal(actual.config.referenceImages[0].dataUrl, dataUrl);
  assert.match(h.requests[0].messages[0].content, /生图格式：自然语言/);
  assert.doesNotMatch(JSON.stringify(h.requests), /iVBOR|image-secret|固定英文特征/);
  assert.doesNotMatch(JSON.stringify(h.s.wechatTimeline.value), /iVBOR|base64|referenceIds/);
  assert.equal(h.s.wechatTimeline.value.at(-1).media.source, 'generate');
  h.s.currentCharacter.value.imageReferences.push({ id: 'corridor', name: '教学楼走廊', kind: 'scene', dataUrl });
  const active = h.s.normalizeActiveWechatImage({ mode: 'generate', selfPortrait: true, referenceIds: ['corridor'], prompt: '她在这条走廊里自拍。' });
  await h.s.prepareWechatReplyMedia([{ type: 'image_request', media: active }], new AbortController().signal);
  assert.equal(actual.config.referenceImages.length, 2);
  assert.equal(actual.config.referenceImages[1].id, 'corridor');
});
const loadCall = (id = 'load') => ({ id, type: 'function', function: { name: 'tool_load_image_sending', arguments: '{}' } });

test('截图中的收尾上下文不加载相册，模型空回照常记录；新问题仍可回答', async () => {
  const h = harness(async (_options, count) => ({ content: count === 1
    ? '{"messages":[],"silence":{"reason":"topic_closed","summary":"叮嘱已说完，对方确认","awareness":"read"}}'
    : '{"messages":[{"type":"text","content":"七点呀"}]}' }));
  h.s.wechatTimeline.value = [textItem('assistant', '快去吃吧'), textItem('assistant', '吃完赶紧去'),
    textItem('user', '好滴'), textItem('assistant', '去吧'), textItem('assistant', '路上慢点')];
  let lookups = 0; h.library.candidates = async () => { lookups++; throw new Error('普通聊天不应读相册'); };
  await h.send('ok');
  const request = h.requests[0];
  assert.ok(request.messages[0].content.endsWith(h.protocol.REPLY_DECISION_REMINDER));
  assert.ok(request.messages[0].content.includes('不再用「去吧」「路上慢点」「乖」'));
  assert.ok(!request.messages[0].content.includes('【可选相册图片】'));
  assert.ok(!request.messages[0].content.includes('image_descriptions'));
  assert.deepEqual(request.tools.map(tool => tool.function.name), ['tool_load_image_sending']);
  assert.equal(lookups, 0); assert.equal(h.toasts.length, 0);
  assert.equal(h.s.wechatTimeline.value.at(-1).replySilence.reason, 'topic_closed');
  assert.equal(h.s.wechatTimeline.value.filter(item => item.role === 'assistant').length, 4);
  await h.send('好的，明天几点见？');
  assert.equal(h.s.wechatTimeline.value.at(-1).content, '七点呀');
});

test('RP、角色设定、旧图片和已空回轮次的关键词不会粘住发图说明', async () => {
  const h = harness();
  h.s.currentCharacter.value.description = '摄影师，爱发照片';
  h.s.wechatTimeline.value = [
    { id: 'rp', channel: 'rp', role: 'assistant', content: '在拍照片' },
    { id: 'old', channel: 'wechat', role: 'assistant', type: 'image', media: { assetId: 'builtin-salad', caption: '饭菜照片' } },
    { ...textItem('user', '照片呢'), replyDecision: 'silent', replySilence: { reason: 'busy' } }, textItem('user', '先忙吧')
  ];
  const prompt = await h.s.buildWechatMediaPrompt();
  assert.ok(!prompt.includes('【可选相册图片】'));
  assert.ok(!prompt.includes('image_descriptions'));
  assert.ok(prompt.includes('tool_view_image'), '旧图只保留轻量查看入口');
  assert.equal(h.reads, 0);
  h.setScope('branch-b'); h.s.invalidateWechatMedia(); h.s.wechatTimeline.value = [textItem('user', '你好')];
  assert.ok(!h.s.wechatImageTools().some(tool => tool.function.name === 'tool_view_image'));
});

test('本轮关键词与连发触发真实 RP 匹配器，下一轮确认立即卸载目录', async () => {
  const h = harness();
  for (const phrase of ['照片呢', '拍个照', '拍一张呗', '发张图', '画个爱心', '画张纸条', '来张自拍', 'send a PHOTO', 'draw a cat']) {
    h.s.wechatTimeline.value = [textItem('user', phrase)];
    assert.equal(h.s.resolveWechatMediaContext().sending, true, phrase);
  }
  h.s.wechatTimeline.value = [textItem('user', '拍个照'), textItem('user', '想看你吃的什么')];
  assert.equal(h.s.resolveWechatMediaContext().sending, true, '本轮连发不能只扫描最后气泡');
  const full = await h.s.buildWechatMediaPrompt();
  assert.ok(full.includes('builtin-salad')); assert.ok(!full.includes('"mode":"generate"'));
  assert.ok(!h.s.wechatImageTools().some(tool => tool.function.name === 'tool_load_image_sending'));
  h.s.wechatTimeline.value.push(textItem('assistant', '现在不方便拍'), textItem('user', '好滴'));
  const light = await h.s.buildWechatMediaPrompt();
  assert.ok(!light.includes('builtin-salad')); assert.ok(light.length < full.length / 4);
  assert.equal(h.s.resolveWechatMediaContext().sending, false);
  console.log(`图片提示正文：按需完整 ${full.length} 字符 / 普通聊天 ${light.length} 字符（不含工具 schema）`);
});

test('接受上一轮明确发图邀请会加载，普通道别的好不会；模型回复不被关键词裁掉', async () => {
  const h = harness(async () => ({ content: '{"messages":[{"type":"text","content":"那我等你"}]}' }));
  h.s.wechatTimeline.value = [textItem('assistant', '要不要看看照片？'), textItem('user', '好呀')];
  assert.equal(h.s.resolveWechatMediaContext().sending, true);
  h.s.wechatTimeline.value = [textItem('assistant', '路上慢点'), textItem('user', '好')];
  assert.equal(h.s.resolveWechatMediaContext().sending, false);
  h.s.wechatTimeline.value = [textItem('assistant', '忙完了来找我？')];
  await h.send('好的');
  assert.equal(h.s.wechatTimeline.value.at(-1).content, '那我等你');
});

test('用户新图无需关键词就保留视觉和描述写回，不加载发送目录', async () => {
  const h = harness(); h.s.wechatPendingImage.value = 'data:image/png;base64,user';
  await h.send('吃饭');
  const request = h.requests[0];
  assert.ok(request.messages[0].content.includes('image_descriptions'));
  assert.ok(!request.messages[0].content.includes('【可选相册图片】'));
  assert.ok(JSON.stringify(request.messages).includes('REAL_PIXELS'));
  assert.equal(h.s.wechatTimeline.value.at(-1).replyDecision, 'silent');
});

test('无关键词也能按需加载再自主发图，工具说明不落时间线且下一轮不重放', async () => {
  const h = harness(async (_options, count) => count === 1 ? { content: '', toolCalls: [loadCall()] }
    : { content: count === 2 ? '{"messages":[{"type":"image_request","media":{"mode":"album","assetId":"builtin-salad"}}]}' : '{"messages":[]}' });
  await h.send('在干嘛');
  assert.equal(h.requests.length, 2);
  assert.ok(!h.requests[0].messages[0].content.includes('【可选相册图片】'));
  assert.ok(h.requests[1].messages.some(message => message.role === 'tool' && message.content.includes('builtin-salad')));
  assert.ok(h.requests[1].tools?.some(tool => tool.function.name === 'tool_load_image_sending'));
  assert.equal(h.s.wechatTimeline.value.at(-1).type, 'image');
  assert.ok(h.s.wechatTimeline.value.every(item => item.role !== 'tool'));
  await h.send('好滴');
  assert.ok(!JSON.stringify(h.requests.at(-1).messages).includes('【可选相册图片】'));
  assert.ok(!JSON.stringify(h.requests.at(-1).messages).includes('data:image/'));
});

test('加载说明本身不发送消息，随后空回不产生图片任务或气泡', async () => {
  const h = harness(async (_options, count) => count === 1 ? { content: '', toolCalls: [loadCall()] } : { content: '{"messages":[]}' });
  await h.send('在干嘛');
  assert.equal(h.s.wechatTimeline.value.length, 1);
  assert.equal(h.s.wechatTimeline.value[0].replyDecision, 'silent');
  assert.equal(h.s.wechatMediaTasks.value.length, 0);
});

test('加载与多次看图持续续写，新图每次保留，所有工具回复先于视觉附件', async () => {
  const h = harness(async (_options, count) => {
    if (count === 1) return { content: '', toolCalls: [loadCall()] };
    if (count <= 3) return { content: '', toolCalls: [{ id: `view-${count}`, type: 'function', function: { name: 'tool_view_image', arguments: JSON.stringify({ messageId: h.s.wechatTimeline.value.find(item => item.type === 'image').id, question: '颜色' }) } }] };
    return { content: '{"messages":[]}' };
  });
  h.s.wechatPendingImage.value = 'data:image/png;base64,user'; await h.send('吃饭');
  assert.equal(h.requests.length, 4); assert.equal(h.toasts.length, 0);
  for (const request of h.requests) assert.ok(JSON.stringify(request.messages).includes('本轮新图'));
  assert.equal(h.requests.at(-1).messages.filter(item => item.role === 'tool').length, 3);
});

test('没有提供过的看图工具仍报错，不伪装成沉默', async () => {
  for (const kind of ['unoffered']) {
    const h = harness(async () => ({ content: '', toolCalls: kind === 'reload' ? [loadCall()]
      : [{ id: 'view', type: 'function', function: { name: 'tool_view_image', arguments: '{"messageId":"old","question":"颜色"}' } }] }));
    await h.send('在干嘛');
    assert.ok(h.toasts.some(item => /未提供|上限/.test(item[0])), kind);
    assert.equal(h.s.wechatTimeline.value.at(-1).replyDecision, undefined, kind);
    assert.equal(h.s.wechatUnansweredCount.value, 1, kind);
    assert.ok(h.requests.length <= 3);
  }
});

test('加载相册失败后工具明确报告，模型可继续普通回复', async () => {
  const h = harness(async (_options, count) => count === 1 ? { content: '', toolCalls: [loadCall()] } : { content: '{"messages":[{"type":"text","content":"在吃饭"}]}' });
  h.library.candidates = async () => { throw new Error('索引暂时不可读'); };
  await h.send('在干嘛');
  assert.ok(h.requests[1].messages.some(item => item.role === 'tool' && item.content.includes('发图能力加载失败')));
  assert.equal(h.s.wechatTimeline.value.at(-1).content, '在吃饭');
  assert.equal(h.reads, 0);
});

test('加载相册期间切 scope 后不续写、不发图、不标新会话沉默', async () => {
  const h = harness(async () => ({ content: '', toolCalls: [loadCall()] }));
  let done; h.library.candidates = () => new Promise(resolve => { done = resolve; });
  const pending = h.send('在干嘛'); while (!done) await new Promise(resolve => setTimeout(resolve, 1));
  h.s.stopWechatGeneration(); h.s.invalidateWechatMedia(); h.setScope('branch-b'); h.s.wechatTimeline.value = [];
  done([...h.images.values()]); await pending;
  assert.equal(h.requests.length, 1); assert.equal(h.s.wechatTimeline.value.length, 0); assert.equal(h.toasts.length, 0);
});

test('真实资源存储保持 Blob，时间线不内嵌字节，目录只包含相册', async () => {
  const h = harness(); const library = h.original.createLibrary(h.context.window.RPHubStorage);
  const blob = new Blob(['binary']); const thumb = new Blob(['thumb']);
  const item = await library.save({ blob, thumb, width: 10, height: 10 }, { caption: '测试图片', ownerId: 'char-a', scopeId: 'branch-a' });
  assert.ok(h.stored.get(`wechat_media_blob_${item.id}`) instanceof Blob);
  assert.equal(await (await library.read(item.id)).text(), 'binary');
  assert.equal((await library.list('char-a')).some(entry => entry.id === item.id), false);
  assert.ok(!JSON.stringify(h.stored.get('wechat_media_index')).includes('binary'));
});
test('只有图片/混合消息均成功发送；描述回到 RP，图片意图不落入记录', async () => {
  const h = harness(async () => ({ content: '{"messages":[{"type":"text","content":"给你看看"},{"type":"image_request","media":{"mode":"album","assetId":"builtin-salad","usage":"scene_photo"}}]}' }));
  await h.send('拍个照');
  const sent = h.s.wechatTimeline.value.filter(item => item.role === 'assistant');
  assert.equal(sent.length, 2); assert.equal(sent[1].type, 'image'); assert.equal(sent[1].content, ''); assert.equal(sent[1].media.caption, '一碗沙拉');
  assert.equal(h.s.wechatUnansweredCount.value, 0);
  const rp = h.s.appendWechatDigestToMessages([]);
  assert.ok(rp[0].content.includes('一碗沙拉')); assert.ok(!JSON.stringify(rp).includes('base64'));
  assert.equal(h.s.wechatMediaTasks.value.length, 0);
});
test('绘图成功后只保留画面记录，绘图参数不进入后续上下文', async () => {
  const h = harness(async (options, count) => ({ content: count === 1 ? '{"messages":[{"type":"image_request","media":{"mode":"draw","template":"note","text":"晚安"}}]}' : '{"messages":[]}' }));
  await h.send('画个晚安纸条'); await h.send('好的');
  const history = JSON.stringify(h.requests[1].messages.slice(1));
  assert.ok(history.includes('手绘纸条：晚安')); assert.ok(!history.includes('template')); assert.ok(!history.includes('base64'));
});
test('新图本轮完整输入，后续只给短描述', async () => {
  const h = harness(async (options, count) => {
    const marker = options.messages.flatMap(item => Array.isArray(item.content) ? item.content.filter(part => part.type === 'text').map(part => part.text) : []).find(text => text.includes('本轮新图'));
    const id = marker?.match(/#([^｜]+)/)?.[1];
    return { content: count === 1 ? JSON.stringify({ messages: [{ type: 'text', content: '沙拉看起来不错' }], image_descriptions: [{ messageId: id, caption: '一盘沙拉' }] }) : '{"messages":[]}' };
  });
  h.s.wechatPendingImage.value = 'data:image/png;base64,user'; await h.send('吃饭');
  assert.ok(JSON.stringify(h.requests[0].messages).includes('REAL_PIXELS'));
  const photo = h.s.wechatTimeline.value.find(item => item.type === 'image'); assert.equal(photo.content, ''); assert.equal(photo.media.caption, '一盘沙拉');
  await h.send('嗯'); assert.ok(!JSON.stringify(h.requests[1].messages).includes('data:image/')); assert.ok(JSON.stringify(h.requests[1].messages).includes('一盘沙拉'));
});
test('查看工具读取真实图片，当前聊天模型收到像素，不支持跨 scope ID', async () => {
  const h = harness(async (options, count) => count === 1 ? { content: '', toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'tool_view_image', arguments: JSON.stringify({ messageId: 'photo-a', question: '是什么颜色' }) } }] } : { content: '{"messages":[{"type":"text","content":"红色"}]}' });
  h.s.wechatTimeline.value = [{ id: 'photo-a', ts: 1, channel: 'wechat', role: 'assistant', type: 'image', content: '', media: { assetId: 'builtin-salad', caption: '沙拉' } }];
  await h.send('里面是什么颜色'); assert.equal(h.requests.length, 2);
  assert.ok(h.reads > 0); assert.ok(h.requests[1].messages.some(item => item.role === 'tool')); assert.ok(JSON.stringify(h.requests[1].messages).includes('REAL_PIXELS'));
  await assert.rejects(h.s.executeWechatImageTool({ function: { name: 'tool_view_image', arguments: '{"messageId":"other-scope-photo","question":"颜色"}' } }, new AbortController().signal));
});
test('无 Key 禁用生图；失败不发依赖文字、不伪空回，重试只补任务且去重', async () => {
  const h = harness(async () => ({ content: '{"messages":[{"type":"text","content":"给你看看"},{"type":"image_request","media":{"mode":"album","assetId":"missing"}}]}' }));
  await h.send('拍照'); assert.equal(h.s.wechatTimeline.value.length, 1); assert.equal(h.s.wechatUnansweredCount.value, 1);
  const task = h.s.wechatMediaTasks.value[0]; assert.equal(task.status, 'failed'); assert.equal(h.s.wechatTimeline.value[0].replyDecision, undefined);
  h.images.set('missing', { id: 'missing', caption: '找到的素材' }); await h.s.retryWechatMediaTask(task);
  assert.equal(h.s.wechatTimeline.value.filter(item => item.role === 'assistant').length, 2);
  task.delivered = 0; await h.s.retryWechatMediaTask(task); assert.equal(h.s.wechatTimeline.value.filter(item => item.role === 'assistant').length, 2);
  h.s.currentCharacter.value.wechatImageGenerationEnabled = true;
  await assert.rejects(h.s.prepareWechatReplyMedia([{ type: 'image_request', media: { mode: 'generate', prompt: 'cat' } }], new AbortController().signal), /没有开启/);
});
test('图片处理中止和切走后晚到不发送，旧请求不清空新请求状态', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const pending = h.send('拍照'); while (!resolve) await new Promise(done => setTimeout(done, 1));
  h.s.stopWechatGeneration(); h.s.invalidateWechatMedia(); h.setScope('branch-b'); h.s.wechatTimeline.value = [];
  resolve({ content: '{"messages":[{"type":"image_request","media":{"mode":"album","assetId":"builtin-salad"}}]}' }); await pending;
  assert.equal(h.s.wechatTimeline.value.length, 0); assert.equal(h.s.wechatMediaTasks.value.length, 0);
});
test('独立识图模型查看原图，主模型续写只收到客观细节', async () => {
  const h = harness(async options => options.model === 'vision'
    ? { content: '碗是白色的' }
    : options.messages.some(item => item.role === 'tool') ? { content: '{"messages":[{"type":"text","content":"白色碗"}]}' }
      : { content: '', toolCalls: [{ id: 'c', type: 'function', function: { name: 'tool_view_image', arguments: '{"messageId":"photo","question":"碗的颜色"}' } }] });
  h.s.settings.visionModel = 'vision';
  h.s.wechatTimeline.value = [{ id: 'photo', ts: 1, channel: 'wechat', role: 'assistant', type: 'image', media: { assetId: 'builtin-salad', caption: '沙拉' } }];
  await h.send('碗是什么颜色');
  assert.equal(h.requests.length, 3);
  assert.ok(JSON.stringify(h.requests.find(request => request.model === 'vision')).includes('REAL_PIXELS'));
  assert.ok(!JSON.stringify(h.requests.at(-1).messages).includes('data:image/'));
  assert.ok(JSON.stringify(h.requests.at(-1).messages).includes('碗是白色'));
});
test('新图经过工具续写后仍保留本轮完整画面', async () => {
  const h = harness(async options => options.messages.some(item => item.role === 'tool')
    ? { content: '{"messages":[]}' }
    : { content: '', toolCalls: [{ id: 'current', type: 'function', function: { name: 'tool_view_image', arguments: JSON.stringify({ messageId: h.s.wechatTimeline.value.find(item => item.type === 'image').id, question: '看一下' }) } }] });
  h.s.wechatPendingImage.value = 'data:image/png;base64,test'; await h.send('这张图');
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.at(-1).messages.some(message => Array.isArray(message.content) && message.content.some(part => part.text?.includes('本轮新图'))));
  assert.ok(JSON.stringify(h.requests.at(-1).messages).includes('REAL_PIXELS'));
});
test('超过四张的新图完整进入请求，每张描述落盘，正常回复后下一轮不重放像素', async () => {
  for (const count of [5, 12, 50]) {
    const h = harness(async () => ({ content: JSON.stringify({ messages: [{ type: 'text', content: '收到整组照片了' }],
      image_descriptions: Array.from({ length: count }, (_, i) => ({ messageId: 'photo-' + i, caption: '第' + (i + 1) + '张照片' })) }) }));
    h.s.wechatTimeline.value = Array.from({ length: count }, (_, i) => ({ id: 'photo-' + i, ts: i + 1, channel: 'wechat', role: 'user', type: 'image', media: { assetId: 'builtin-salad' } }));
    await h.s.runWechatGeneration();
    assert.equal(h.requests.length, 1);
    const parts = h.requests[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    assert.equal(parts.filter(part => part.type === 'image_url').length, count);
    assert.deepEqual(parts.filter(part => part.type === 'text' && part.text.startsWith('【本轮新图')).map(part => /#([^｜]+)/.exec(part.text)[1]),
      Array.from({ length: count }, (_, i) => 'photo-' + i));
    const saved = h.stored.get('wechat_timeline/branch-a').filter(item => item.type === 'image');
    assert.deepEqual(saved.map(item => item.media.caption), Array.from({ length: count }, (_, i) => '第' + (i + 1) + '张照片'));
    assert.equal(h.s.wechatUnansweredCount.value, 0);
    assert.equal(h.toasts.length, 0);
    await h.send('今天怎么样');
    assert.doesNotMatch(JSON.stringify(h.requests.at(-1).messages), /data:image|本轮新图/);
  }
});

test('六张新图在主聊天与工具续写中完整保留，不自动身份比对', async () => {
  const h = harness(async options => options.messages.some(item => item.role === 'tool')
    ? { content: '{"messages":[{"type":"text","content":"收到六张照片了"}]}' }
    : { content: '', toolCalls: [{ id: 'fifth', type: 'function', function: { name: 'tool_view_image', arguments: '{"messageId":"photo-4","question":"第五张的衣服"}' } }] });
  h.s.currentCharacter.value.imageReferences = ['a', 'b'].map(characterRef);
  const reads = [], readImage = h.library.read;
  h.library.read = async (id, thumbnail, signal) => { reads.push({ id, thumbnail }); return readImage(id, thumbnail, signal); };
  h.s.wechatTimeline.value = Array.from({ length: 6 }, (_, i) => ({ id: 'photo-' + i, channel: 'wechat', role: 'user', type: 'image', media: { assetId: 'builtin-salad' } }));
  await h.s.runWechatGeneration();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests.filter(r => r.requestLabel === '微信独立画面核对').length, 0);
  for (const request of h.requests) assert.equal(request.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url').length, 6);
  assert.match(h.requests.at(-1).messages.find(m => m.role === 'tool').content, /已经提供/);
  assert.equal(reads.filter(read => read.thumbnail === false).length, 6);
});

test('连发六张图片时先保存气泡，统一回复完整处理六张并写回全部描述', async () => {
  const h = harness(async options => {
    const ids = options.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(part => part.type === 'text' && part.text.startsWith('【本轮新图')).map(part => /#([^｜]+)/.exec(part.text)[1]);
    return { content: JSON.stringify({ messages: [{ type: 'text', content: '六张都收到了' }],
      image_descriptions: ids.map(messageId => ({ messageId, caption: '已查看照片' })) }) };
  });
  h.s.wechatBurstMode.value = true;
  for (let i = 0; i < 6; i++) {
    h.s.wechatPendingImage.value = referencePixel;
    await h.send('');
  }
  assert.equal(h.requests.length, 0);
  assert.equal(h.s.wechatUnansweredCount.value, 6);
  assert.equal(h.s.wechatTimeline.value.filter(item => item.type === 'image').length, 6);
  await h.s.requestWechatReplyNow();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url').length, 6);
  assert.equal(h.s.wechatUnansweredCount.value, 0);
  assert.ok(h.s.wechatTimeline.value.filter(item => item.type === 'image').every(item => item.media.caption === '已查看照片'));
});

test('六图描述不会覆盖旧图或已存说明，忽略无效条目与未知ID', () => {
  const h = harness();
  h.s.wechatTimeline.value = [
    { id: 'old', channel: 'wechat', role: 'user', type: 'image', media: { caption: '' } },
    ...Array.from({ length: 6 }, (_, i) => ({ id: 'new-' + i, channel: 'wechat', role: 'user', type: 'image', media: { caption: i === 0 ? '原说明' : '' } }))
  ];
  h.s.rememberWechatImageDescriptions(JSON.stringify({ image_descriptions: [
    null, { messageId: 'new-5', caption: null }, { messageId: 'old', caption: '猜测旧图' }, { messageId: 'unknown', caption: '未知图' },
    ...Array.from({ length: 6 }, (_, i) => ({ messageId: 'new-' + i, caption: '第' + (i + 1) + '张' }))
  ] }), new Set(Array.from({ length: 6 }, (_, i) => 'new-' + i)));
  assert.equal(h.s.wechatTimeline.value[0].media.caption, '');
  assert.equal(h.s.wechatTimeline.value[1].media.caption, '原说明');
  assert.deepEqual(h.s.wechatTimeline.value.slice(2).map(item => item.media.caption), ['第2张', '第3张', '第4张', '第5张', '第6张']);
});
test('资源索引保存失败会回收半成品 Blob，删除角色只清理其资源', async () => {
  const h = harness(); const storage = h.context.window.RPHubStorage;
  const library = h.original.createLibrary({ ...storage, setStoredValue: async (key, value) => { if (key === 'wechat_media_index') throw new Error('disk full'); await storage.setStoredValue(key, value); } });
  await assert.rejects(library.save({ blob: new Blob(['full']), thumb: new Blob(['tiny']), width: 10, height: 10 }, { ownerId: 'a' }), /disk full/);
  assert.equal(h.stored.size, 0);
  const good = h.original.createLibrary(storage);
  const first = await good.save({ blob: new Blob(['a']), thumb: new Blob(['a']), width: 1, height: 1 }, { ownerId: 'a' });
  const second = await good.save({ blob: new Blob(['b']), thumb: new Blob(['b']), width: 1, height: 1 }, { ownerId: 'b' });
  await good.purgeOwner('a'); assert.equal(await good.get(first.id), null); assert.ok(await good.get(second.id));
});
test('本轮描述不能覆盖未查看的旧图片', async () => {
  const h = harness(async () => ({ content: '{"messages":[],"image_descriptions":[{"messageId":"old-photo","caption":"猜测的红色花"}]}' }));
  h.s.wechatTimeline.value = [
    { id: 'old-photo', ts: 1, channel: 'wechat', role: 'user', type: 'image', media: { assetId: 'builtin-salad', caption: '' } },
    { id: 'answer', ts: 2, channel: 'wechat', role: 'assistant', type: 'text', content: '收到了' }
  ];
  await h.send('今天怎么样');
  assert.equal(h.s.wechatTimeline.value[0].media.caption, '');
  assert.ok(!JSON.stringify(h.requests[0].messages).includes('REAL_PIXELS'));
});
test('恢复任务文件已丢失时拒绝发送缓存资源和前置文字', async () => {
  const h = harness();
  const task = { id: 'restore', scopeId: 'branch-a', delivered: 0, status: 'failed', media: { assetId: 'deleted' }, messages: [{ type: 'text', content: '给你看看' }, { type: 'image_request', media: { mode: 'album', assetId: 'deleted' } }] };
  h.s.wechatMediaTasks.value.push(task);
  await h.s.retryWechatMediaTask(task);
  assert.equal(h.s.wechatTimeline.value.length, 0);
  assert.equal(task.status, 'failed');
  assert.ok(h.toasts.some(item => item[0].includes('资源不存在')));
});
test('并行查看调用先回复全部工具，再附像素，保留有效工具消息顺序', async () => {
  const h = harness(async (options, count) => count === 1
    ? { content: '', toolCalls: [1, 2].map(i => ({ id: 'call-' + i, type: 'function', function: { name: 'tool_view_image', arguments: '{"messageId":"photo","question":"核对颜色"}' } })) }
    : { content: '{"messages":[]}' });
  h.s.wechatTimeline.value = [{ id: 'photo', ts: 1, channel: 'wechat', role: 'assistant', type: 'image', media: { assetId: 'builtin-salad' } }];
  await h.send('核对一下');
  const messages = h.requests[1].messages;
  const i = messages.findIndex(item => item.tool_calls);
  assert.deepEqual(messages.slice(i + 1, i + 4).map(item => item.role), ['tool', 'tool', 'user']);
});
test('RP 主动微信仍拒绝 content 内的嵌套图片JSON，保留文字队列', () => {
  const h = harness(); h.s.pendingActiveWechatMessages = [];
  assert.throws(() => h.s.deliverActiveWechatMessage('{"messages":[{"type":"image_request","media":{"mode":"album","assetId":"builtin-salad"}}]}'), /content 必须是.*纯文本/);
  assert.equal(h.s.pendingActiveWechatMessages.length, 0);
  h.s.deliverActiveWechatMessage('下班了吗');
  assert.equal(h.s.pendingActiveWechatMessages[0], '下班了吗');
});

const described = description => ({ type: 'image_request', media: { mode: 'describe', description } });
test('描述型图片不要求 content 或额外图片API，保存为无像素图片而不是配文', async () => {
  const h = harness(async () => ({ content: JSON.stringify({ messages: [described('北苑宿舍楼下的路灯，灯下没有人物。')] }) }));
  await h.send('拍张照片给我看看');
  const item = h.s.wechatTimeline.value.at(-1);
  assert.equal(item.type, 'image'); assert.equal(item.content, '');
  assert.equal(item.media.descriptionOnly, true); assert.equal(item.media.assetId, undefined);
  assert.equal(item.media.captionSource, 'narrative'); assert.equal(h.reads, 0);
  assert.equal(h.requests.length, 1); assert.equal(h.s.wechatMediaTasks.value.length, 0);
  assert.equal(h.stored.get('wechat_timeline/branch-a').at(-1).media.caption, item.media.caption);
  assert.match(h.original.imageRecordText(item), /画面描述.*北苑.*无实际像素.*不是发送者的文字配文/);
});
test('相册资源不存在时有描述可兜底，描述不替代成功读取的实际照片', async () => {
  const h = harness(), signal = new AbortController().signal;
  const fallback = await h.s.prepareWechatReplyMedia([{ type: 'image_request', media: { mode: 'album', assetId: 'missing', description: '黑夜中一盏宿舍路灯。' } }], signal);
  assert.equal(fallback[0].media.descriptionOnly, true);
  const real = await h.s.prepareWechatReplyMedia([{ type: 'image_request', media: { mode: 'album', assetId: 'builtin-salad', description: '猜测画面' } }], signal);
  assert.equal(real[0].media.assetId, 'builtin-salad'); assert.equal(real[0].media.descriptionOnly, undefined);
  assert.equal(real[0].media.caption, '一碗沙拉');
});
test('未配置生图时不联网、不把生图失败降级成描述成功', async () => {
  const h = harness(), signal = new AbortController().signal;
  await assert.rejects(h.s.prepareWechatReplyMedia([{ type: 'image_request', media: { mode: 'generate', prompt: 'campus street lamp', description: '北苑楼下的路灯。' } }], signal), /没有开启/);
  assert.equal(h.requests.length, 0);
  await assert.rejects(h.s.prepareWechatReplyMedia([{ type: 'image_request', media: { mode: 'album', assetId: 'missing' } }], signal), /不在可用相册/);
});

function enableGeneration(h, generate = async () => new Blob(['generated pixels'])) {
  h.s.settings.wechatImageApi = { apiKey: 'fixture-image-key' };
  h.context.window.RPHubImageGeneration = { ...h.context.window.RPHubImageGeneration, generate };
}
const generated = () => ({ type: 'image_request', media: { mode: 'generate',
  prompt: 'young adult woman, shoulder-length soft hair tucked behind ears, phone selfie, campus corridor, evening light',
  description: '教学楼走廊里，齐肩头发别在耳后的女生自拍', usage: 'scene_photo' } });

test('本人外貌通过按需工具返回并拼入真实请求，饭菜不套脸，提示词不落历史', async () => {
  const identity = { prompt: 'slim oval face, dark brown almond eyes', description: '小A外貌', negative: 'anime' };
  const h = harness(async (_options, count) => count === 1 ? { toolCalls: [loadCall()] }
    : { content: JSON.stringify({ messages: [{ type: 'image_request', media: { mode: 'generate', selfPortrait: true, prompt: 'phone selfie, campus', description: '走廊里的自拍' } }] }) });
  h.s.currentCharacter.value.imageIdentity = identity;
  const calls = [];
  enableGeneration(h, async (config, prompt) => { calls.push({ config, prompt }); return new Blob(['pixels']); });
  await h.send('让我看看');
  const tool = h.requests[1].messages.find(m => m.role === 'tool');
  assert.ok(tool.content.includes(identity.prompt)); assert.match(tool.content, /"selfPortrait":true/);
  assert.equal(calls[0].prompt, identity.prompt + ', phone selfie, campus'); assert.equal(calls[0].config.negativePrompt, 'anime');
  assert.doesNotMatch(JSON.stringify(h.s.wechatTimeline.value), /slim oval face|negativePrompt|base64,/);
  assert.equal(h.s.wechatTimeline.value.find(item => item.type === 'image').media.selfPortrait, true, '仅保存生成意图的布尔元数据，不代表像素身份验证');
  await h.s.prepareWechatReplyMedia([{ type: 'image_request', media: { mode: 'generate', selfPortrait: false, prompt: 'chicken, rice', description: '饭菜' } }], new AbortController().signal);
  assert.equal(calls[1].prompt, 'chicken, rice'); assert.equal(calls[1].config.negativePrompt, undefined);
  assert.throws(() => h.original.normalizeIntent({ mode: 'generate', prompt: 'selfie', selfPortrait: 'true' }), /布尔值/);
  assert.throws(() => h.original.normalizeIntent({ mode: 'album', assetId: 'a', selfPortrait: true }), /布尔值/);
});

test('已有角色设置保存、禁用、清除外貌；主动发图schema接受本人标记', async () => {
  const h = harness(); let saves = 0;
  h.s.saveCharactersNow = async () => { saves++; };
  h.s.currentCharacter.value.imageIdentity = { prompt: 'oval face', description: '外貌', negative: 'anime', enabled: false };
  h.s.openWechatSettings();
  assert.equal(h.s.wechatSettingsDraft.imageIdentityEnabled, false);
  h.s.wechatSettingsDraft.imageIdentityPrompt = 'dark brown almond eyes';
  await h.s.saveWechatSettings(); h.s.openWechatSettings();
  assert.equal(h.s.wechatSettingsDraft.imageIdentityPrompt, 'dark brown almond eyes');
  assert.equal(h.s.currentCharacter.value.imageIdentity.enabled, false); assert.equal(saves, 1);
  h.s.wechatSettingsDraft.imageIdentityPrompt = '';
  await h.s.saveWechatSettings(); h.s.openWechatSettings();
  assert.equal(h.s.currentCharacter.value.imageIdentity, null); assert.equal(h.s.wechatSettingsDraft.imageIdentityPrompt, '');
  enableGeneration(h);
  const media = h.s.normalizeActiveWechatImage({ mode: 'generate', prompt: 'selfie', selfPortrait: true });
  assert.equal(media.selfPortrait, true);
  Object.assign(h.context, { ACTIVE_TOOL_WECHAT_TYPE: 'wechat_message' });
  vm.runInContext(read('app/14-tools-runtime.js'), h.context); h.context.window.RPHubAppSections.toolsRuntime(h.s);
  assert.equal(h.s.buildActiveToolDefinitions([{ type: 'wechat_message', callName: 'tool_wechat' }])[0].function.parameters.properties.image.properties.selfPortrait.type, 'boolean');
});

test('真实模型式的漏本人标记在付费前纠正一次；重漏有界失败且非本人明确false', async () => {
  for (const flag of [true, false, undefined]) {
    let paid = 0;
    const h = harness(async (_options, count) => ({ content: JSON.stringify({ messages: [
      { type: 'text', content: '拍给你' }, { type: 'image_request', media: { mode: 'generate', prompt: 'phone selfie, streetlights',
        description: '路灯旁的自拍', ...(count > 1 && flag !== undefined ? { selfPortrait: flag } : {}) } }
    ] }) }));
    h.s.currentCharacter.value.imageIdentity = { prompt: 'fixed almond eyes', negative: 'anime' };
    enableGeneration(h, async (_config, prompt) => { paid++; assert.equal(prompt.includes('fixed almond eyes'), flag === true); return new Blob(['pixels']); });
    await h.send('立刻拍张照');
    assert.equal(h.requests.length, 2);
    assert.equal(paid, flag === undefined ? 0 : 1);
    const correction = h.requests[1].messages.find(m => m.role === 'system' && m.content.includes('刚才的回复尚未发送'));
    assert.match(correction.content, /遗漏了selfPortrait/);
    if (flag === undefined) {
      assert.equal(h.s.wechatTimeline.value.filter(i => i.role === 'assistant').length, 0);
      assert.equal(h.s.wechatUnansweredCount.value, 1);
    }
    assert.throws(() => h.s.normalizeActiveWechatImage({ mode: 'generate', prompt: 'selfie' }), /必须填写selfPortrait/);
  }
});

test('生图开启时不提供描述发送格式，旧描述图片不改变当前能力；主动schema同步', async () => {
  const h = harness(); enableGeneration(h);
  h.s.wechatTimeline.value = [{ id: 'old', channel: 'wechat', role: 'assistant', type: 'image',
    media: { descriptionOnly: true, caption: '旧自拍', source: 'description' } }, textItem('user', '现在立刻拍张照给我!')];
  const prompt = await h.s.buildWechatMediaPrompt();
  assert.match(prompt, /本轮真实生图/); assert.match(prompt, /"mode":"generate"/);
  assert.doesNotMatch(prompt, /"mode":"describe"|描述兜底：/);
  assert.doesNotMatch(await h.s.buildActiveWechatImagePrompt('自拍'), /mode:"describe"/);
  assert.throws(() => h.s.normalizeActiveWechatImage({ mode: 'describe', description: '新自拍' }), /生图已开启/);
  Object.assign(h.context, { ACTIVE_TOOL_WECHAT_TYPE: 'wechat_message' });
  vm.runInContext(read('app/14-tools-runtime.js'), h.context); h.context.window.RPHubAppSections.toolsRuntime(h.s);
  const image = h.s.buildActiveToolDefinitions([{ type: 'wechat_message', callName: 'tool_wechat' }])[0].function.parameters.properties.image;
  assert.deepEqual(plain(image.properties.mode.enum), ['album', 'draw', 'generate']);
  assert.match(image.description, /用 generate/);
  h.s.currentCharacter.value.wechatImageGenerationEnabled = false;
  assert.match(await h.s.buildWechatMediaPrompt(), /"mode":"describe"/);
  assert.doesNotMatch(await h.s.buildWechatMediaPrompt(), /"mode":"generate"/);
});

test('模型误用描述时仅纠正一次，取得真实像素后才发整批消息；不重复付费', async () => {
  const h = harness(async (_options, count) => ({ content: JSON.stringify({ messages: [
    { type: 'text', content: '给你看看' }, count === 1 ? described('教学楼走廊的自拍') : generated()
  ] }) }));
  let images = 0; enableGeneration(h, async () => { images++; assert.equal(h.s.wechatTimeline.value.filter(i => i.role === 'assistant').length, 0); return new Blob(['pixels']); });
  await h.send('现在立刻拍张照给我!');
  assert.equal(h.requests.length, 2); assert.equal(images, 1);
  assert.match(h.requests[1].messages.at(-1).content, /尚未发送.*尚未调用生图/);
  assert.ok(!JSON.stringify(h.requests).includes('fixture-image-key'));
  const replies = h.s.wechatTimeline.value.filter(i => i.role === 'assistant');
  assert.equal(replies.length, 2); assert.equal(replies[1].type, 'image');
  assert.ok(replies[1].media.assetId); assert.equal(replies[1].media.source, 'generate');
  assert.ok(!replies[1].media.descriptionOnly); assert.equal(h.toasts.length, 0);
});

test('普通校园自拍的麦克风矛盾在付费前修正一次，重复矛盾不付费也不发送承诺', async () => {
  for (const fixed of [true, false]) {
    const bad = { location: '教学楼走廊', action: '下课后自拍', framing: '手机前置上半身', props: ['头戴麦克风'] };
    const h = harness(async (_options, count) => ({ content: JSON.stringify({ messages: [{ type: 'text', content: '给你看看' },
      { type: 'image_request', media: { mode: 'generate', selfPortrait: true, prompt: '教学楼里的自拍', scene: count > 1 && fixed ? { ...bad, props: ['手机'], avoid: ['头戴麦克风'] } : bad } }] }) }));
    let paid = 0; enableGeneration(h, async () => { paid++; assert.equal(h.s.wechatTimeline.value.filter(item => item.role === 'assistant').length, 0); return new Blob(['pixels']); });
    Object.assign(h.s.settings.wechatImageApi, h.context.window.RPHubImageGeneration.PRESETS.yeelo);
    await h.send('下课了，拍张普通的自拍给我');
    assert.equal(h.requests.length, 2); assert.equal(paid, fixed ? 1 : 0);
    assert.match(h.requests[1].messages.at(-1).content, /画面计划.*尚未付费/);
    assert.match(h.requests[1].messages.at(-1).content, /不编造演出或录制/);
    if (!fixed) { assert.equal(h.s.wechatTimeline.value.length, 1); assert.equal(h.s.wechatUnansweredCount.value, 1); }
  }
});

test('重复描述误用有界失败，不发前置承诺、不付费、不吞待回复消息', async () => {
  const h = harness(async () => ({ content: JSON.stringify({ messages: [{ type: 'text', content: '给你看看' }, described('自拍')] }) }));
  let images = 0; enableGeneration(h, async () => { images++; return new Blob(['pixels']); });
  await h.send('拍照');
  assert.equal(h.requests.length, 2); assert.equal(images, 0); assert.equal(h.s.wechatMediaTasks.value.length, 0);
  assert.equal(h.s.wechatTimeline.value.length, 1); assert.equal(h.s.wechatUnansweredCount.value, 1);
  assert.match(h.toasts[0][0], /仍未使用/);
});

test('开启生图不强迫拒绝或沉默的角色发图，生图接口失败不自动纠正或重付费', async () => {
  for (const messages of [[], [{ type: 'text', content: '现在不想拍' }]]) {
    const h = harness(async () => ({ content: JSON.stringify({ messages }) }));
    let images = 0; enableGeneration(h, async () => { images++; return new Blob(['pixels']); });
    await h.send('拍张照'); assert.equal(h.requests.length, 1); assert.equal(images, 0);
  }
  const h = harness(async () => ({ content: JSON.stringify({ messages: [{ type: 'text', content: '给你看看' }, generated()] }) }));
  let images = 0; enableGeneration(h, async () => { images++; throw new Error('HTTP 503'); });
  await h.send('拍照'); assert.equal(h.requests.length, 1); assert.equal(images, 1);
  assert.equal(h.s.wechatTimeline.value.length, 1); assert.equal(h.s.wechatMediaTasks.value[0].status, 'failed');
});

test('纠正请求返回期间切分支，不生图也不把消息送入新会话', async () => {
  let resolve;
  const h = harness(async (_options, count) => count === 1 ? { content: JSON.stringify({ messages: [described('自拍')] }) }
    : new Promise(done => { resolve = done; }));
  let images = 0; enableGeneration(h, async () => { images++; return new Blob(['pixels']); });
  const pending = h.send('自拍'); while (!resolve) await new Promise(done => setTimeout(done, 1));
  h.s.stopWechatGeneration(); h.s.invalidateWechatMedia(); h.setScope('branch-b'); h.s.wechatTimeline.value = [];
  resolve({ content: JSON.stringify({ messages: [generated()] }) }); await pending;
  assert.equal(images, 0); assert.equal(h.s.wechatTimeline.value.length, 0); assert.equal(h.s.wechatMediaTasks.value.length, 0);
});
test('描述型图片不暴露识图工具、不附像素；后续历史与RP回灌保留画面边界', async () => {
  const h = harness();
  h.s.replaceWechatTimeline([{ id: 'd1', channel: 'wechat', role: 'assistant', type: 'image', content: '', media: { descriptionOnly: true, caption: '北苑宿舍路灯', source: 'description', captionSource: 'narrative' } }]);
  assert.deepEqual(plain(h.s.wechatImageTools()).map(tool => tool.function.name), ['tool_load_image_sending']);
  await h.send('灯下有人吗？');
  assert.equal(h.reads, 0);
  const text = JSON.stringify(h.requests[0].messages);
  assert.match(text, /北苑宿舍路灯/); assert.match(text, /未描述的细节仍未知/); assert.doesNotMatch(text, /image_url|REAL_PIXELS/);
  const rp = h.s.appendWechatDigestToMessages([]);
  assert.match(JSON.stringify(rp), /画面描述.*北苑.*不是发送者的文字配文/);
  await assert.rejects(h.s.executeWechatImageTool({ function: { name: 'tool_view_image', arguments: '{"messageId":"d1","question":"灯下有人吗"}' } }, new AbortController().signal), /没有可供识图的像素/);
});
test('点击描述型图片展示全文而不读资源；导入的描述型用户图片不送识图', async () => {
  const h = harness(), item = { id: 'd1', channel: 'wechat', role: 'user', type: 'image', media: { descriptionOnly: true, caption: '完整画面说明' } };
  h.s.wechatTimeline.value = [item];
  await h.s.viewWechatImage(item);
  assert.equal(h.s.wechatImagePreview.value.descriptionOnly, true); assert.equal(h.s.wechatImagePreview.value.caption, '完整画面说明');
  assert.equal(h.s.getWechatFreshImages().length, 0); assert.equal(h.reads, 0);
});
test('描述型图片批次刷新后继续发送无需读取不存在的资源，仍按任务ID去重', async () => {
  const h = harness(), task = { id: 'restore-description', scopeId: 'branch-a', status: 'failed', delivered: 0,
    messages: [described('北苑的路灯')], media: { descriptionOnly: true, caption: '北苑的路灯', captionSource: 'narrative', source: 'description' } };
  h.s.wechatMediaTasks.value = [task]; await h.s.retryWechatMediaTask(task);
  assert.equal(h.reads, 0); assert.equal(h.s.wechatTimeline.value.filter(item => item.id === 'wx-restore-description-0').length, 1);
  assert.equal(h.s.wechatMediaTasks.value.length, 0);
});
test('刷新后丢失的实际资源使用原请求描述兜底，不重新生成图片', async () => {
  const h = harness(), task = { id: 'lost-photo', scopeId: 'branch-a', status: 'failed', delivered: 0,
    messages: [{ type: 'image_request', media: { mode: 'album', assetId: 'missing', description: '北苑楼下的路灯。' } }],
    media: { assetId: 'missing', caption: '旧资源说明', source: 'album' } };
  h.s.wechatMediaTasks.value = [task]; await h.s.retryWechatMediaTask(task);
  const item = h.s.wechatTimeline.value.at(-1);
  assert.equal(item.media.descriptionOnly, true); assert.equal(item.media.caption, '北苑楼下的路灯。');
  assert.equal(item.media.assetId, undefined); assert.equal(h.reads, 1); assert.equal(h.requests.length, 0);
  assert.equal(h.s.wechatMediaTasks.value.length, 0);
});
test('资源存储错误仍报错，不用描述掩盖磁盘问题', async () => {
  const h = harness();
  h.library.save = async () => { throw new DOMException('空间不足', 'QuotaExceededError'); };
  await assert.rejects(h.s.prepareWechatReplyMedia([{ type: 'image_request', media: { mode: 'draw', template: 'note', text: '晚安', description: '晚安纸条' } }], new AbortController().signal), error => error.name === 'QuotaExceededError');
  assert.equal(h.s.wechatTimeline.value.length, 0);
});
test('资源读取中止和切scope不会被描述兜底吞掉', async () => {
  const h = harness(), controller = new AbortController();
  h.library.read = async () => { controller.abort(); throw new DOMException('取消', 'AbortError'); };
  await assert.rejects(h.s.prepareWechatReplyMedia([{ type: 'image_request', media: { mode: 'album', assetId: 'builtin-salad', description: '兜底画面' } }], controller.signal), error => error.name === 'AbortError');
  assert.equal(h.s.wechatTimeline.value.length, 0);
});
test('描述参数守卫拒绝空描述、超长描述和未知主动图片字段', () => {
  const h = harness();
  for (const description of ['', ' '.repeat(5), '字'.repeat(241), 123]) assert.throws(() => h.original.normalizeIntent({ mode: 'describe', description }));
  assert.throws(() => h.s.normalizeActiveWechatImage({ mode: 'describe', description: '路灯', sender: '玩家' }), /发送者/);
  assert.throws(() => h.s.deliverActiveWechatMessage('配文', { mode: 'describe', description: '路灯' }), /二选一/);
});
test('RP主动照片通过独立image参数发送并交给玩家，仍只接受一次主动联系', async () => {
  const h = harness();
  const queued = h.s.deliverActiveWechatMessage('', { mode: 'describe', description: '北苑宿舍楼下的路灯，没有配文字。' });
  assert.equal(queued.awaitingPlayer, true); assert.equal(queued.delivered, false);
  assert.throws(() => h.s.deliverActiveWechatMessage('再补一句'), /等待玩家回应/);
  await h.s.flushActiveWechatMessages();
  const item = h.s.wechatTimeline.value.at(-1);
  assert.equal(item.type, 'image'); assert.equal(item.role, 'assistant'); assert.equal(item.content, '');
  assert.equal(item.media.descriptionOnly, true); assert.equal(h.reads, 0); assert.equal(h.requests.length, 0);
});
test('RP主动图片也能选实际相册，未配置时不能调用生图', async () => {
  const h = harness();
  const prompt = await h.s.buildActiveWechatImagePrompt('吃饭');
  assert.match(prompt, /builtin-salad/); assert.match(prompt, /新发生的分享必须通过工具/); assert.match(prompt, /不补造过去未记录/);
  assert.throws(() => h.s.normalizeActiveWechatImage({ mode: 'generate', prompt: 'x' }), /配置并开启微信生图/);
  h.s.deliverActiveWechatMessage('', { mode: 'album', assetId: 'builtin-salad', description: '沙拉' });
  await h.s.flushActiveWechatMessages();
  assert.equal(h.s.wechatTimeline.value.at(-1).media.assetId, 'builtin-salad');
});

test('图片资源准备与任务重试保留模型发送时间，不按请求耗时重算', async () => {
  const h = harness(async () => ({ content: JSON.stringify({ messages: [
    { type: 'image_request', media: { mode: 'album', assetId: 'builtin-salad' }, delayMinutes: 60 },
    { type: 'text', content: '晚饭', delayMinutes: 5 }
  ] }) }));
  const T = h.context.window.RPHubWeChatTime;
  h.s.wechatTimeDraft.value = '2023-08-01T18:00'; h.s.applyWechatSendTime();
  await h.send('看看照片');
  assert.deepEqual(plain(h.s.wechatTimeline.value.map(item => T.format(item.storyAt))), ['2023-08-01 18:00', '2023-08-01 19:00', '2023-08-01 19:05']);
  const retry = harness(async () => ({ content: JSON.stringify({ messages: [
    { type: 'image_request', media: { mode: 'album', assetId: 'later-found' }, delayMinutes: 60 },
    { type: 'text', content: '晚饭', delayMinutes: 5 }
  ] }) }));
  retry.s.wechatTimeDraft.value = '2023-08-01T18:00'; retry.s.applyWechatSendTime();
  await retry.send('看看照片');
  assert.equal(retry.s.wechatClockLabel.value, '2023-08-01 18:00', '准备失败不能提前跳时');
  const task = retry.s.wechatMediaTasks.value[0];
  assert.equal(task.messages[0].storyAt, T.parse('2023-08-01 19:00'));
  retry.images.set('later-found', { id: 'later-found', caption: '晚饭照片' });
  await retry.s.retryWechatMediaTask(task);
  assert.deepEqual(plain(retry.s.wechatTimeline.value.map(item => T.format(item.storyAt))), ['2023-08-01 18:00', '2023-08-01 19:00', '2023-08-01 19:05']);
});
test('缩略图最多四张并发，切会话后排队任务不读图、不保留 URL', async () => {
  const h = harness(); const releases = []; let active = 0, peak = 0, reads = 0;
  h.library.read = async () => {
    reads++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => releases.push(resolve)); active--;
    return new Blob(['thumb']);
  };
  h.s.wechatTimeline.value = Array.from({ length: 12 }, (_, i) => ({ channel: 'wechat', role: 'assistant', type: 'image', media: { assetId: 'thumb-' + i } }));
  h.s.loadVisibleWechatImages();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(peak, 4); assert.equal(reads, 4);
  h.s.invalidateWechatMedia(); h.setScope('branch-b');
  releases.forEach(resolve => resolve());
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(reads, 4); assert.equal(Object.keys(h.s.wechatMediaUrls).length, 0);
});
