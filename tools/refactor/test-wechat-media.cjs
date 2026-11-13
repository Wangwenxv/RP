const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(ROOT, 'assets/js', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
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
  context.window.RPHubUtils = { generateUUID: context.generateUUID };
  vm.runInContext(read('data-services.js'), context);
  context.window.RPHubStorage = storage;
  vm.runInContext(read('wechat-media.js'), context);
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
    requestTrackedChatCompletion: async options => { requests.push(structuredClone({ ...options, signal: undefined })); return respond(options, requests.length); }
  };
  vm.runInContext(read('wechat-time.js'), context);
  vm.runInContext(read('wechat-protocol.js'), context);
  vm.runInContext(read('app/25-wechat.js'), context); context.window.RPHubAppSections.wechat(s);
  vm.runInContext(read('app/27-wechat-media.js'), context); context.window.RPHubAppSections.wechatMedia(s);
  return { s, original, protocol: context.window.RPHubWeChatProtocol, stored, requests, toasts, images, context, library,
    get reads() { return readCount; }, setScope(value) { scope = value; },
    async send(text) { s.wechatInput.value = text; await s.sendWechatMessage(); } };
}
test('新图片意图不依赖 content，非法图/源码和多图不降级成文本', () => {
  const { protocol: p } = harness();
  const reply = p.parseReplyResult('{"messages":[{"type":"image_request","media":{"mode":"draw","template":"note","text":"晚安"}}]}');
  assert.equal(reply.messages[0].type, 'image_request');
  assert.equal(reply.silent, false);
  for (const raw of ['{"messages":[{"type":"image","content":"<svg>"}]}', '{"messages":[{"type":"image_request","media":{"mode":"draw","template":"script","text":"x"}}]}']) assert.throws(() => p.parseReplyResult(raw));
  assert.throws(() => p.normalizeMessages([{ type: 'image_request', media: { mode: 'album', assetId: 'a' } }, { type: 'image_request', media: { mode: 'album', assetId: 'b' } }]));
});

const textItem = (role, content, id = content) => ({ id, ts: 1, channel: 'wechat', role, type: 'text', content });
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
  assert.ok(!h.requests[1].tools?.some(tool => tool.function.name === 'tool_load_image_sending'));
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

test('加载与两次看图共用有界续写，新图每次保留，所有工具回复先于视觉附件', async () => {
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

test('没有加载过的看图工具、重复加载与超过两次查看都报错，不伪装成沉默', async () => {
  for (const kind of ['unoffered', 'reload', 'too-many-views']) {
    const h = harness(async () => ({ content: '', toolCalls: kind === 'reload' ? [loadCall()]
      : [{ id: 'view', type: 'function', function: { name: 'tool_view_image', arguments: '{"messageId":"old","question":"颜色"}' } }] }));
    if (kind === 'too-many-views') h.s.wechatTimeline.value = [{ id: 'old', channel: 'wechat', role: 'assistant', type: 'image', media: { assetId: 'builtin-salad' } }];
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
test('超过本轮视觉预算不悄悄丢图，不标空回', async () => {
  const h = harness();
  h.s.wechatTimeline.value = Array.from({ length: 5 }, (_, i) => ({ id: 'photo-' + i, ts: i + 1, channel: 'wechat', role: 'user', type: 'image', media: { assetId: 'builtin-salad' } }));
  await h.s.runWechatGeneration();
  assert.equal(h.requests.length, 0);
  assert.equal(h.s.wechatUnansweredCount.value, 5);
  assert.ok(h.toasts.some(item => item[0].includes('最多识别 4 张')));
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
  assert.deepEqual(messages.slice(i + 1, i + 5).map(item => item.role), ['tool', 'tool', 'user', 'user']);
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
