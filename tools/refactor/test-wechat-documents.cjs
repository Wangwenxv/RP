const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(ROOT, 'assets/js', name), 'utf8');
const file = (text, name = '小说.txt') => Object.assign(new Blob([text]), { name });
const call = (name, args) => ({ id: 'call', type: 'function', function: { name, arguments: JSON.stringify(args) } });
function harness(respond = async () => ({ content: '{"messages":[]}' })) {
  const stored = new Map(), requests = [], toasts = []; let scope = 'branch-a', id = 0;
  const storage = { getStoredValue: async key => structuredClone(stored.get(key)), setStoredValue: async (key, value) => stored.set(key, structuredClone(value)), deleteStoredValue: async key => stored.delete(key) };
  const context = vm.createContext({ window: { location: { href: 'http://local/' }, RPHubStorage: storage }, console, Blob, TextDecoder, DOMException, AbortController, URL, crypto: webcrypto,
    ref: value => ({ value }), reactive: value => value, computed: getter => ({ get value() { return getter(); } }), watch() {}, nextTick: async () => {}, requestAnimationFrame: fn => fn(), document: { getElementById: () => null },
    setTimeout: fn => setTimeout(fn, 0), clearTimeout, setInterval: () => 1, clearInterval() {}, generateUUID: () => `msg-${++id}`, getMainDb: () => ({}), initDB: async () => {}, cloneForStorage: value => JSON.parse(JSON.stringify(value)),
    setScopedStoredValue: async (key, scopeId, value) => stored.set(`${key}/${scopeId}`, structuredClone(value)), getScopedStoredValue: async (key, scopeId) => structuredClone(stored.get(`${key}/${scopeId}`) || []) });
  const s = { currentCharacter: { value: { uuid: 'char-a', name: '林晚', wechatEnabled: true, wechatSpeed: 'fast' } }, chatHistory: { value: [] }, classicMemories: { value: [] }, storyRecap: { value: null }, memorySettings: { enabled: false }, activeStoryBranchId: { value: 'a' },
    settings: { apiUrl: 'https://mock.local', apiKey: 'fixture', model: 'mock' }, user: { name: '用户' }, worldInfo: { value: [] }, presets: { value: [] }, getCurrentStoryBranchScopeId: () => scope,
    buildUserInfoPrompt: () => '用户', processRegex: text => text, showToast: (...args) => toasts.push(args), wechatMediaEpoch: 0,
    confirmAction: (_, fn) => fn(), requestTrackedChatCompletion: async options => { requests.push(structuredClone({ ...options, signal: undefined })); return respond(options, requests.length); } };
  for (const name of ['built-in-content.js', 'wechat-media.js', 'wechat-document-search.js', 'wechat-documents.js', 'wechat-time.js', 'wechat-protocol.js', 'app/25-wechat.js', 'app/29-wechat-documents.js']) vm.runInContext(read(name), context);
  context.window.RPHubAppSections.wechat(s); context.window.RPHubAppSections.wechatDocuments(s);
  return { s, stored, storage, requests, toasts, D: context.window.RPHubWeChatDocuments, lib: context.window.RPHubWeChatDocuments.createLibrary(storage),
    switchScope() { scope = 'branch-b'; s.wechatMediaEpoch++; s.invalidateWechatDocuments(); },
    async upload(text, name) { await s.handleWechatDocumentSelection({ target: { files: [file(text, name)], value: 'file' } }); s.wechatBurstMode.value = true; await s.sendWechatMessage(); return s.wechatTimeline.value.at(-1); },
    async send(text) { s.wechatInput.value = text; s.wechatBurstMode.value = false; await s.sendWechatMessage(); } };
}
test('百万字文本增量分块、正文保真，原 Blob 独立存储', async () => {
  const h = harness(); const text = '第一章 夜雨\n' + '甲乙丙丁🙂\n'.repeat(150000);
  const doc = await h.lib.save(file(text), { ownerId: 'a', scopeId: 's' });
  assert.ok(doc.chunkCount > 400);
  assert.equal(doc.chars, text.length);
  let actual = '';
  for (let i = 0; i < doc.chunkCount; i++) { const part = await h.lib.chunk(doc.id, i); assert.ok(part.text.length <= 2400); assert.equal(part.offset, actual.length); actual += part.text; }
  assert.equal(actual, text); assert.equal(await (await h.lib.blob(doc.id)).text(), text);
  assert.ok(JSON.stringify(await h.lib.list()).length < 1000);
});
test('UTF-16 BOM 和 GB18030 中文解码，不支持/空白二进制与超额文件明确失败', async () => {
  const h = harness();
  const utf16 = Object.assign(new Blob([Buffer.from('\ufeff你好，世界', 'utf16le')]), { name: 'utf16.txt' });
  const doc = await h.lib.save(utf16, {}); assert.equal((await h.lib.chunk(doc.id, 0)).text, '你好，世界');
  const gb = Object.assign(new Blob([Buffer.from([0xc4, 0xe3, 0xba, 0xc3])]), { name: 'gbk.txt' });
  assert.equal((await h.lib.chunk((await h.lib.save(gb, {})).id, 0)).text, '你好');
  await assert.rejects(h.lib.save(file('x', 'x.pdf'), {}), /纯文本/);
  await assert.rejects(h.lib.save(file('', 'x.txt'), {}), /不能为空/);
  await assert.rejects(h.lib.save(file('abc\u0000xyz'), {}), /二进制/);
  await assert.rejects(h.lib.save({ name: 'big.txt', size: 21 * 1024 * 1024 }, {}), /20 MiB/);
});
test('跨块关键词搜索、标题目录与翻页位置', async () => {
  const h = harness(); const text = 'x'.repeat(2398) + '翡翠钥匙\n第二章 远行\n' + '海边'.repeat(4000);
  const doc = await h.lib.save(file(text), {});
  const result = await h.lib.search(doc, '翡翠钥匙');
  assert.equal(result.scanned, doc.chunkCount); assert.ok(result.hits.some(hit => hit.excerpt.includes('翡翠钥匙')));
  const toc = await h.lib.toc(doc.id); assert.ok(toc.entries.some(entry => entry.title.includes('第二章')));
  const first = await h.lib.read(doc, 0); assert.equal(first.chunks.length, 2); assert.equal(first.next, 2);
  await assert.rejects(h.lib.read(doc, 999), /超出/);
});
test('导入中止与落库失败会回滚所有分块', async () => {
  const h = harness(), controller = new AbortController();
  await assert.rejects(h.lib.save(file('内容'.repeat(10000)), {}, controller.signal, () => controller.abort()), /取消/);
  assert.equal(h.stored.size, 0);
  const set = h.storage.setStoredValue; h.storage.setStoredValue = async (key, value) => { if (key.includes('_blob_')) throw new Error('quota'); return set(key, value); };
  await assert.rejects(h.lib.save(file('内容'.repeat(3000)), {}), /quota/); assert.equal(h.stored.size, 0);
});
test('纯文件发送、历史/RP/提要只带引用，工具结果只进入本轮', async () => {
  let msg;
  const h = harness(async (_options, n) => n === 1 ? { content: '', toolCalls: [call('tool_search_document', { messageId: msg.id, query: '翡翠钥匙' })] } : { content: '{"messages":[{"type":"text","content":"我找到那把钥匙了"}]}' });
  msg = await h.upload('第一章\n翡翠钥匙在旧仓库\n' + '背景'.repeat(3000));
  assert.equal(msg.type, 'document'); assert.equal(msg.content, ''); assert.equal(h.s.wechatUnansweredCount.value, 1);
  assert.ok(!JSON.stringify(h.s.wechatTimeline.value).includes('旧仓库'));
  await h.send('钥匙在哪里');
  assert.ok(!JSON.stringify(h.requests[0]).includes('旧仓库')); assert.ok(JSON.stringify(h.requests[1]).includes('旧仓库'));
  assert.equal(h.requests[0].tools.length, 4);
  assert.ok(!JSON.stringify(h.s.appendWechatDigestToMessages([])).includes('旧仓库'));
  await h.send('好'); assert.ok(!JSON.stringify(h.requests.at(-1)).includes('旧仓库'));
});
test('无法用资源 ID、其他角色或分支读取附件；关闭清理待发送文件', async () => {
  const h = harness(), msg = await h.upload('私密内容');
  await assert.rejects(h.s.executeWechatDocumentTool(call('tool_read_document', { messageId: msg.document.id }), undefined, { used: 0 }), /当前角色/);
  h.switchScope();
  await assert.rejects(h.s.executeWechatDocumentTool(call('tool_read_document', { messageId: msg.id }), undefined, { used: 0 }), /不属于/);
  const pending = harness(); await pending.s.handleWechatDocumentSelection({ target: { files: [file('未发送')] } });
  assert.equal((await pending.lib.list()).length, 1); await pending.s.removeWechatPendingDocument(); assert.equal((await pending.lib.list()).length, 0);
});
test('隔离读者只有本批正文与笔记，最多六批，可续读直到全文覆盖', async () => {
  const h = harness(async () => ({ content: '人物小林取得钥匙，接着离开仓库。来源块0。' }));
  const msg = await h.upload('第一章\n' + '隔离读者正文\n'.repeat(12000));
  h.s.currentCharacter.value.description = '秘密角色设定';
  const first = await h.s.executeWechatDocumentTool(call('tool_document_reader', { messageId: msg.id }), undefined, { used: 0 });
  assert.ok(first.content.includes('已顺序阅读 24/')); assert.ok(first.content.includes('尚未读完')); assert.equal(h.requests.length, 6);
  for (const options of h.requests) { assert.equal(options.tools, undefined); assert.ok(!JSON.stringify(options).includes('秘密角色设定')); assert.ok(JSON.stringify(options.messages).length < 15000); assert.equal(options.maxTokens, 2400); }
  let last = first;
  for (let i = 0; i < 10 && last.content.includes('尚未读完'); i++) last = await h.s.executeWechatDocumentTool(call('tool_document_reader', { messageId: msg.id }), undefined, { used: 0 });
  assert.ok(last.content.includes('已覆盖全文')); assert.equal(h.s.wechatTimeline.value.length, 1);
});
test('读者失败不推进该批，重试继续；中止不会写阅读笔记', async () => {
  let count = 0; const h = harness(async () => { if (++count === 2) throw new Error('provider down'); return { content: '已读笔记' }; });
  const msg = await h.upload('文本'.repeat(20000));
  await assert.rejects(h.s.executeWechatDocumentTool(call('tool_document_reader', { messageId: msg.id }), undefined, { used: 0 }), /provider down/);
  assert.equal((await h.lib.reader(msg.document.id)).next, 4);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.s.executeWechatDocumentTool(call('tool_document_reader', { messageId: msg.id }), controller.signal, { used: 0 }), /取消/);
  assert.equal((await h.lib.reader(msg.document.id)).next, 4);
});

test('阅读状态统计主模型与读者请求，失败只保留成功批次，不写进聊天记录', async () => {
  let msg, batch = 0;
  const snapshots = [];
  const h = harness(async options => {
    snapshots.push(structuredClone(h.s.wechatActivity.value));
    if (options.messages[0].content.includes('你是隔离的文档读者')) {
      if (++batch === 2) throw new Error('reader failed');
      return { content: '读完第一批' };
    }
    if (!options.messages.some(item => item.role === 'tool')) return { content: '', toolCalls: [call('tool_document_reader', { messageId: msg.id })] };
    return { content: '{"messages":[]}' };
  });
  msg = await h.upload('第一章\n' + '原文'.repeat(20000));
  await h.send('读一下');
  assert.equal(snapshots[0].title, '正在等待模型回复');
  assert.equal(snapshots[0].modelRequests, 1);
  assert.equal(snapshots[1].completed, 0);
  assert.equal(snapshots[1].modelRequests, 2);
  assert.equal(snapshots[2].completed, 4);
  assert.equal(snapshots[2].modelRequests, 3);
  assert.equal(snapshots[3].title, '正在整理回复');
  assert.equal(snapshots[3].modelRequests, 4);
  assert.equal(snapshots[3].toolCalls, 1);
  assert.match(snapshots[3].notice, /失败/);
  assert.equal((await h.lib.reader(msg.document.id)).next, 4);
  assert.equal(h.s.wechatActivity.value, null);
  assert.ok(!JSON.stringify(h.s.wechatTimeline.value).includes('modelRequests'));
});

test('旧读者状态回调和晚到结果不能覆盖停止后新请求的状态', async () => {
  let msg, releaseOld, releaseNew, oldReport;
  const h = harness(async options => {
    if (options.messages[0].content.includes('你是隔离的文档读者')) return new Promise(resolve => { releaseOld = resolve; });
    if (h.requests.length === 1) return { content: '', toolCalls: [call('tool_document_reader', { messageId: msg.id })] };
    return new Promise(resolve => { releaseNew = resolve; });
  });
  const execute = h.s.executeWechatDocumentTool;
  h.s.executeWechatDocumentTool = (call, signal, budget, report) => { oldReport = report; return execute(call, signal, budget, report); };
  msg = await h.upload('正文'.repeat(8000));
  const old = h.send('开始读');
  while (!releaseOld) await new Promise(resolve => setImmediate(resolve));
  h.s.stopWechatGeneration();
  assert.equal(h.s.wechatActivity.value, null);
  const fresh = h.send('先别读了');
  while (!releaseNew) await new Promise(resolve => setImmediate(resolve));
  const before = structuredClone(h.s.wechatActivity.value);
  oldReport({ title: '旧请求', completed: 999, modelRequest: true });
  releaseOld({ content: '晚到笔记' }); await old;
  assert.deepEqual(structuredClone(h.s.wechatActivity.value), before);
  assert.equal((await h.lib.reader(msg.document.id)).next, 0);
  releaseNew({ content: '{"messages":[]}' }); await fresh;
  assert.equal(h.s.wechatActivity.value, null);
});

test('历史文件离开最近消息窗口与附件清单后，仍能列出并读取原文', async () => {
  const h = harness(), first = await h.upload('隐藏在旧附件里的翡翠钥匙');
  for (let i = 0; i < 9; i++) await h.upload(`其他文件${i}`, `文件${i}.txt`);
  for (let i = 0; i < 40; i++) h.s.pushWechatItem({ channel: 'wechat', role: 'user', type: 'text', content: `近况${i}` });
  assert.ok(!h.s.buildWechatDocumentPrompt().includes(`#${first.id}｜`));
  const list = await h.s.executeWechatDocumentTool(call('tool_list_documents', {}), undefined, { used: 0 });
  assert.ok(list.content.includes(first.id));
  const found = await h.s.executeWechatDocumentTool(call('tool_search_document', { messageId: first.id, query: '翡翠钥匙' }), undefined, { used: 0 });
  assert.ok(found.content.includes('隐藏在旧附件里'));
});
test('资料预算、参数守卫和按 owner 回收原文', async () => {
  const h = harness(), msg = await h.upload('内容'.repeat(8000));
  const budget = { used: 15500 }; const value = await h.s.executeWechatDocumentTool(call('tool_read_document', { messageId: msg.id }), undefined, budget);
  assert.ok(value.content.includes('预算')); assert.ok(budget.used <= 16000);
  await assert.rejects(h.s.executeWechatDocumentTool(call('tool_read_document', { messageId: msg.id, start: -1 }), undefined, { used: 0 }), /非负/);
  await assert.rejects(h.s.executeWechatDocumentTool(call('tool_read_document', { messageId: msg.id, url: 'https://evil' }), undefined, { used: 0 }), /未知/);
  await h.lib.save(file('另一个角色'), { ownerId: 'char-b', scopeId: 'branch-b' });
  await h.s.deleteWechatDocumentOwner('char-a'); assert.equal((await h.lib.list()).length, 1); assert.ok(!(await h.lib.get(msg.document.id)));
});
test('恶意或超额工具调用不会变成成功/沉默回复', async () => {
  const h = harness(async () => ({ content: '', toolCalls: [call('tool_list_documents', {})] }));
  await h.upload('文本'); await h.send('继续');
  assert.ok(h.toasts.some(item => String(item[0]).includes('上限'))); assert.equal(h.requests.length, 5);
  assert.ok(!h.s.wechatTimeline.value.some(item => item.replyDecision === 'silent'));
});
test('移除文件消息回收资源并调整摘要边界；清空仅回收当前分支', async () => {
  const h = harness(), msg = await h.upload('正文'), adjusted = [];
  h.s.adjustRecapWechatCoverageAfterDelete = async at => adjusted.push(at);
  await h.s.removeWechatDocument(msg);
  assert.equal(h.s.wechatTimeline.value.length, 0); assert.equal(await h.lib.get(msg.document.id), null); assert.deepEqual(adjusted, [0]);
  await h.upload('当前分支'); await h.lib.save(file('另一分支'), { ownerId: 'char-a', scopeId: 'branch-b' });
  let action; h.s.confirmAction = (_, fn) => { action = fn; };
  h.s.clearWechatTimeline(); await action();
  assert.equal((await h.lib.list()).length, 1); assert.equal((await h.lib.list())[0].scopeId, 'branch-b');
});
test('章节目录通过工具可用；scope 在读者请求中变化时不存笔记', async () => {
  let release; const h = harness(async () => new Promise(resolve => { release = resolve; }));
  const msg = await h.upload('第一章 开始\n内容\n第二章 后来\n后文');
  const outline = await h.s.executeWechatDocumentTool(call('tool_read_document', { messageId: msg.id, mode: 'outline' }), undefined, { used: 0 });
  assert.ok(outline.content.includes('第二章 后来'));
  const pending = h.s.executeWechatDocumentTool(call('tool_document_reader', { messageId: msg.id }), undefined, { used: 0 });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  h.switchScope(); release({ content: '晚到的笔记' }); await assert.rejects(pending, /会话已变化/);
  assert.equal((await h.lib.reader(msg.document.id)).next, 0);
});
test('拖入单文件复用附件流程，嵌套进出不会闪烁，文本拖拽保留原生行为', async () => {
  const h = harness(); let prevented = 0;
  const event = { dataTransfer: { types: ['Files'], files: [file('小说正文')], dropEffect: '' }, preventDefault() { prevented++; } };
  h.s.handleWechatDragEnter(event); h.s.handleWechatDragEnter(event); h.s.handleWechatDragLeave(event);
  assert.equal(h.s.wechatAttachmentDragging.value, true);
  h.s.handleWechatDragOver(event); assert.equal(event.dataTransfer.dropEffect, 'copy');
  await h.s.handleWechatDrop(event);
  assert.equal(h.s.wechatAttachmentDragging.value, false); assert.ok(h.s.wechatPendingDocument.value);
  assert.equal(h.s.wechatTimeline.value.length, 0); assert.equal(h.requests.length, 0);
  const prior = prevented; await h.s.handleWechatDrop({ dataTransfer: { types: ['text/plain'] }, preventDefault() { prevented++; } });
  assert.equal(prevented, prior);
});
test('多文件/生成中拒绝拖入，MIME 缺失的图片按扩展名路由，scope 切换清掉拖拽态', async () => {
  const h = harness();
  const event = { dataTransfer: { types: ['Files'], files: [file('a'), file('b')] }, preventDefault() {} };
  await h.s.handleWechatDrop(event); assert.ok(h.toasts.some(item => item[0].includes('一次'))); assert.equal(h.s.wechatPendingDocument.value, null);
  h.s.isWechatGenerating.value = true; event.dataTransfer.files = [file('a')];
  await h.s.handleWechatDrop(event); assert.equal(h.s.wechatPendingDocument.value, null);
  h.s.handleWechatDragOver(event); assert.equal(event.dataTransfer.dropEffect, 'none'); h.s.isWechatGenerating.value = false;
  let images = 0; h.s.handleWechatImageSelection = async () => { images++; };
  event.dataTransfer.files = [file('pixels', 'photo.png')]; await h.s.handleWechatDrop(event); assert.equal(images, 1);
  h.s.handleWechatDragEnter(event); h.switchScope(); assert.equal(h.s.wechatAttachmentDragging.value, false);
});
test('中文输入法确认和 Shift Enter 不发送，普通 Enter 发送', async () => {
  const h = harness(); let sends = 0, prevented = 0;
  h.s.sendWechatMessage = async () => { sends++; };
  const event = { key: 'Enter', preventDefault() { prevented++; } };
  await h.s.handleWechatComposerKeydown({ ...event, isComposing: true });
  await h.s.handleWechatComposerKeydown({ ...event, keyCode: 229 });
  await h.s.handleWechatComposerKeydown({ ...event, shiftKey: true });
  assert.equal(sends, 0); assert.equal(prevented, 0);
  await h.s.handleWechatComposerKeydown(event); assert.equal(sends, 1); assert.equal(prevented, 1);
});

// ---- grep 式检索 ----
const filler = '平静的日子就这样过去。'.repeat(60);
const grepText = '第一章 线索\n他摸到青铜钥匙，转身进了仓库。\n' + filler
  + '她梦见一把钥匙，醒来只剩窗外的雨。\n' + filler
  + '仓库的尽头有一道门。\n';
const search = async (h, args) => (await h.s.executeWechatDocumentTool(call('tool_search_document', args), undefined, { used: 0 })).content;

test('grep 语法：引号短语、+必含、-排除、~邻近各自生效', async () => {
  const h = harness(), msg = await h.upload(grepText);
  const phrase = await search(h, { messageId: msg.id, query: '"青铜钥匙"' });
  assert.ok(phrase.includes('青铜钥匙')); assert.ok(!phrase.includes('梦见'));
  const both = await search(h, { messageId: msg.id, query: '+钥匙 +仓库' });
  assert.ok(both.includes('青铜钥匙')); assert.ok(!both.includes('梦见'));
  assert.match(both, /命中 [123] 段/);
  const excluded = await search(h, { messageId: msg.id, query: '钥匙 -梦' });
  assert.ok(excluded.includes('青铜钥匙')); assert.ok(!excluded.includes('醒来只剩'));
  const near = await search(h, { messageId: msg.id, query: '钥匙 ~6 仓库' });
  assert.ok(/青铜钥匙.{0,20}仓库/.test(near));
  const loose = await search(h, { messageId: msg.id, query: '钥匙' });
  assert.match(loose, /钥匙 2 次\/1 段/);
  assert.match(loose, /命中 2 段/);
});

test('正则检索可用，词频/出现次数与未出现诊断都回传模型', async () => {
  const h = harness(), msg = await h.upload(grepText);
  const regex = await search(h, { messageId: msg.id, query: '/(摸到|梦见).{0,6}钥匙/' });
  assert.ok(regex.includes('青铜钥匙')); assert.ok(regex.includes('梦见'));
  const absent = await search(h, { messageId: msg.id, query: '地下室' });
  assert.ok(absent.includes('未出现：地下室')); assert.ok(absent.includes('没有命中'));
  await assert.rejects(search(h, { messageId: msg.id, query: '/钥匙(/' }), /正则表达式无效/);
  await assert.rejects(search(h, { messageId: msg.id, query: '/钥匙(' }), /缺少结束的/);
  await assert.rejects(search(h, { messageId: msg.id, query: '/钥匙/x' }), /不支持的正则标记/);
});

test('命中摘录与字符范围精确对应原文，跨块也能读回', async () => {
  const h = harness(), text = 'x'.repeat(2380) + '翡翠钥匙在旧仓库\n' + '海边'.repeat(4000);
  const msg = await h.upload(text), doc = await h.lib.get(msg.document.id);
  const result = await h.lib.search(doc, '翡翠钥匙');
  assert.equal(result.hits.length, 1);
  const hit = result.hits[0];
  assert.equal(hit.excerpt, text.slice(hit.offset, hit.end));
  assert.equal(doc.chunkCount, result.scanned);
  const near = await h.lib.search(doc, '钥匙 ~6 仓库');
  assert.equal(near.hits[0].excerpt, text.slice(near.hits[0].offset, near.hits[0].end));
  const boundary = await h.lib.search(doc, '"钥匙在旧"');
  assert.equal(boundary.hits[0].excerpt, text.slice(boundary.hits[0].offset, boundary.hits[0].end));
});

test('省略 messageId 时一次搜索最近附件，结果显示文件名并可排序', async () => {
  const h = harness();
  const first = await h.upload('甲文件里写着翡翠钥匙', '甲.txt');
  const second = await h.upload('乙文件里也提到翡翠钥匙和仓库', '乙.txt');
  const output = await search(h, { query: '翡翠钥匙' });
  assert.ok(output.includes('甲.txt')); assert.ok(output.includes('乙.txt'));
  // 多附件命中必须带消息 ID，否则模型无法接着 read。
  assert.ok(output.includes(`#${first.id}｜甲.txt`)); assert.ok(output.includes(`#${second.id}｜乙.txt`));
  assert.match(output, /搜索 2 个附件/);
  assert.ok(!output.includes('只能读取当前角色'));
});

test('startChunk/endChunk 限定章节范围，startChar 读回命中位置', async () => {
  const h = harness(), text = '开头钥匙\n' + '填充。'.repeat(1000) + '\n结尾钥匙\n';
  const msg = await h.upload(text);
  const doc = await h.lib.get(msg.document.id);
  const whole = await h.s.executeWechatDocumentTool(call('tool_search_document', { messageId: msg.id, query: '钥匙' }), undefined, { used: 0 });
  assert.match(whole.content, /2 次\/2 段/);
  const later = await h.s.executeWechatDocumentTool(call('tool_search_document', { messageId: msg.id, query: '钥匙', startChunk: 1 }), undefined, { used: 0 });
  assert.match(later.content, /1 次\/1 段/);
  assert.match(later.content, /扫描范围/);
  const empty = await h.s.executeWechatDocumentTool(call('tool_search_document', { messageId: msg.id, query: '开头', startChunk: 1 }), undefined, { used: 0 });
  assert.ok(empty.content.includes('没有命中'));
  const read = await h.s.executeWechatDocumentTool(call('tool_read_document', { messageId: msg.id, startChar: text.length - 6 }), undefined, { used: 0 });
  assert.match(read.content, new RegExp(`定位到块 ${doc.chunkCount - 1}`));
  assert.ok(read.content.includes('结尾钥匙'));
});

test('参数守卫：搜索词数量、表达式长度、limit、范围与缺少关键词都明确报错', async () => {
  const h = harness(), msg = await h.upload('文本');
  const args = { messageId: msg.id };
  await assert.rejects(search(h, { ...args, query: 'a b c d e f g h i' }), /最多 8 个/);
  await assert.rejects(search(h, { ...args, query: 'a'.repeat(301) }), /300 字符/);
  await assert.rejects(search(h, { ...args, query: '文本', limit: 9 }), /limit/);
  await assert.rejects(search(h, { ...args, query: '文本', limit: 0 }), /limit/);
  await assert.rejects(search(h, { ...args, query: '文本', startChunk: 3, endChunk: 1 }), /不能大于/);
  await assert.rejects(search(h, { ...args, query: '文本', startChunk: -1 }), /startChunk/);
  await assert.rejects(search(h, { ...args, query: '  ' }), /1–300/);
  await assert.rejects(search(h, { ...args, query: '文本', regex: 'x' }), /未知/);
  const bare = harness();
  await assert.rejects(bare.s.executeWechatDocumentTool(call('tool_search_document', { query: '文本' }), undefined, { used: 0 }), /没有可搜索的附件/);
});

test('中文标点分隔、case:on 区分大小写，列表显示读者进度与目录条数', async () => {
  const h = harness(), msg = await h.upload('第一章 开始\nAlpha 计划与钥匙，仓库在下面\n');
  const split = await search(h, { messageId: msg.id, query: '钥匙，仓库' });
  assert.match(split, /钥匙 1 次\/1 段/); assert.match(split, /仓库 1 次\/1 段/);
  const sensitive = await h.s.executeWechatDocumentTool(call('tool_search_document', { messageId: msg.id, query: 'case:on alpha' }), undefined, { used: 0 });
  assert.ok(sensitive.content.includes('没有命中'));
  const insensitive = await h.s.executeWechatDocumentTool(call('tool_search_document', { messageId: msg.id, query: 'alpha' }), undefined, { used: 0 });
  assert.ok(insensitive.content.includes('Alpha'));
  await h.s.executeWechatDocumentTool(call('tool_document_reader', { messageId: msg.id }), undefined, { used: 0 });
  const list = await h.s.executeWechatDocumentTool(call('tool_list_documents', {}), undefined, { used: 0 });
  assert.match(list.content, /已整理 1\/1 块/); assert.match(list.content, /目录 1 条/);
});
