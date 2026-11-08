const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..'), read = name => fs.readFileSync(path.join(ROOT, 'assets/js', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function harness() {
  let scopeId = 'branch-a', reads = 0;
  const c = vm.createContext({ window: {}, console, DOMException, AbortController,
    stripUiTemplateUpdateBlock: text => text.replace(/<ui_template_updates>[\s\S]*?<\/ui_template_updates>/g, '') });
  for (const file of ['built-in-content.js', 'wechat-time.js', 'wechat-protocol.js', 'wechat-media.js', 'history-retrieval.js']) vm.runInContext(read(file), c);
  c.window.RPHubUtils = { parseCot: text => ({ main: text.replace(/<cot>[\s\S]*?<\/cot>/g, '') }) };
  const s = { settings: { historyRetrievalEnabled: true }, memorySettings: { enabled: true },
    currentCharacter: { value: { uuid: 'char-a', name: '苏祈雪', wechatEnabled: true } }, user: { name: '陈璃' },
    conversationRevision: 0, wechatMediaEpoch: 0, chatHistory: { value: [] }, wechatTimeline: { value: [] },
    classicMemories: { value: [{ summary: '仅概要，缺少钥匙细节' }] }, storyRecap: { value: null },
    getCurrentStoryBranchScopeId: () => scopeId,
    getEnabledActiveTools: () => [], buildActiveToolDefinitions: () => [], parseNativeActiveToolCall: () => ({ oldParser: true }),
    shouldRequireActiveToolCall: tools => tools.length > 0, getActiveToolInvocationReminder: () => '旧工具提醒', buildActiveToolSystemPrompt: () => '',
    ensureWechatTimelineLoaded: async () => { reads++; }, yieldToUi: async () => {},
    stripDisabledImageGenContext: text => text, stripNextResponsePrompt: text => text, stripUiTemplateContextInjection: text => text,
    wechatImageRecordText: c.window.RPHubWeChatMedia.imageRecordText,
    buildConversationTurnSnapshot: history => ({ turns: Array.from({ length: Math.ceil(history.length / 2) }, (_, index) => ({ turn: index + 1, sourceIndexes: [index * 2, index * 2 + 1] })) }) };
  vm.runInContext(read('app/34-history-retrieval.js'), c); c.window.RPHubAppSections.historyRetrieval(s);
  const call = (name, args) => ({ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  return { c, s, call, reads: () => reads, scope: value => { scopeId = value; },
    search: (query, budget, signal) => s.executeHistoryRetrievalTool(call('tool_search_history', { query }), signal, budget),
    read: (args, budget, signal) => s.executeHistoryRetrievalTool(call('tool_read_history', args), signal, budget) };
}
function seed(h) {
  h.s.chatHistory.value = [{ id: 'u1', role: 'user', content: '钥匙只是暂借，我没有答应留宿。' },
    { id: 'a1', role: 'assistant', content: '她把蓝色钥匙放到桌上，约好周五归还。' }];
  h.s.wechatTimeline.value = [{ channel: 'rp', rpIndex: 0, rpMsgId: 'u1' }, { channel: 'rp', rpIndex: 1, rpMsgId: 'a1' },
    { id: 'w1', channel: 'wechat', role: 'assistant', type: 'text', content: '钥匙周五晚上还就行。', storyAt: h.c.window.RPHubWeChatTime.parse('2025-03-11 22:50') }];
}
test('检索保存的完整原文，保留玩家否定、渠道、轮次及时间，不搜索生成的总结或重复镜像', async () => {
  const h = harness(); seed(h); const result = await h.search('钥匙');
  assert.equal(result.totalMatches, 3); assert.equal(result.results.length, 3);
  assert.ok(result.results.some(item => item.source === '玩家原输入' && /没有答应/.test(item.excerpt)));
  assert.ok(result.results.some(item => item.channel === 'wechat' && item.time === '2025-03-11 22:50'));
  assert.equal(new Set(result.results.map(item => item.recordId)).size, 3);
  assert.equal((await h.search('仅概要')).status, 'empty'); assert.equal(h.reads(), 2);
});
test('长正文尾部关键词仍可命中，字符起止精确，可按命中范围继续读回', async () => {
  const h = harness(); h.s.chatHistory.value = [{ id: 'long', role: 'assistant', content: '前文。'.repeat(2500) + '银色发夹放在第三层抽屉。' }];
  const found = await h.search('银色发夹'), hit = found.results[0];
  assert.ok(hit.startChar > 5000); assert.equal(hit.excerpt, h.s.chatHistory.value[0].content.slice(hit.startChar, hit.endChar));
  const result = await h.read({ recordId: hit.recordId, startChar: hit.startChar, length: 1800 });
  assert.match(result.text, /第三层抽屉/); assert.equal(result.totalChars, h.s.chatHistory.value[0].content.length);
});
test('缺失证据明确 empty，不断言从未发生；直接伪造原文ID无法读取', async () => {
  const h = harness(); seed(h); const result = await h.search('戒指');
  assert.equal(result.status, 'empty'); assert.match(result.notice, /不证明事情从未发生/);
  await assert.rejects(h.read({ recordId: 'rp:a1' }), /未由本轮搜索返回/);
});

test('Unicode前缀不改变命中字符位置，英文关键词忽略ASCII大小写', async () => {
  const h = harness(); h.s.chatHistory.value = [{ id: 'unicode', role: 'assistant', content: 'İ'.repeat(300) + 'KEY-731 放在抽屉。' }];
  const found = await h.search('key-731'), hit = found.results[0];
  assert.equal(hit.startChar, 200); assert.match(hit.excerpt, /KEY-731/);
  assert.equal(hit.excerpt, h.s.chatHistory.value[0].content.slice(hit.startChar, hit.endChar));
});
test('RP和微信都能按渠道检索；实际图片只取描述，文件只保留引用，COT和变量不回灌', async () => {
  const h = harness(); seed(h);
  h.s.chatHistory.value[1].content += '<cot>隐藏推测</cot><ui_template_updates>隐藏变量</ui_template_updates>';
  h.s.chatHistory.value[1].toolCalls = [{ resultText: '历史工具检查区独有文本' }];
  h.s.wechatTimeline.value.push({ id: 'p1', channel: 'wechat', role: 'assistant', type: 'image', content: '', media: { descriptionOnly: true, caption: '路灯下的台阶' } });
  h.s.wechatTimeline.value.push({ id: 'f1', channel: 'wechat', role: 'user', type: 'document', content: 'file-bytes-secret' });
  const r = await h.s.executeHistoryRetrievalTool(h.call('tool_search_history', { query: '钥匙', channel: 'rp' }));
  assert.ok(r.results.every(item => item.channel === 'rp')); assert.equal(r.totalMatches, 2);
  assert.equal((await h.search('隐藏推测 隐藏变量 file-bytes-secret 历史工具检查区独有文本')).status, 'empty');
  assert.match(JSON.stringify(await h.search('路灯')), /画面描述.*无实际像素/);
});
test('搜索后编辑或删除原文不能读取旧快照，新轮次没有上轮读取授权', async () => {
  const h = harness(); seed(h); await h.search('钥匙');
  h.s.chatHistory.value[1].content = '她已经收回钥匙。';
  await assert.rejects(h.read({ recordId: 'rp:a1' }), /原文已编辑/);
  h.s.resetHistoryRetrievalBudget(); await assert.rejects(h.read({ recordId: 'rp:u1' }), /未由本轮搜索返回/);
  h.s.resetHistoryRetrievalBudget(); await h.search('钥匙'); h.s.chatHistory.value = [];
  await assert.rejects(h.read({ recordId: 'rp:u1' }), /原文已编辑\/删除/);
  const other = harness(); seed(other); await other.search('钥匙'); const oldBudget = other.s.historyRetrievalBudget;
  other.s.clearStoryBranchTransientContext(); assert.equal(oldBudget.records.size, 0);
  await assert.rejects(other.read({ recordId: 'rp:u1' }), /未由本轮搜索返回/);
});
test('清空、切分支或同分支切走再切回时旧检索授权作废', async () => {
  for (const change of [h => h.s.conversationRevision++, h => h.scope('branch-b'), h => h.s.wechatMediaEpoch++, h => h.s.currentCharacter.value.uuid = 'char-b']) {
    const h = harness(); seed(h); await h.search('钥匙'); change(h);
    await assert.rejects(h.read({ recordId: 'rp:a1' }), error => error.name === 'AbortError');
  }
});
test('异步载入/搜索中途切分支或中止，不返回旧原文，也不授予ID', async () => {
  const h = harness(); seed(h); const budget = h.s.createHistoryRetrievalBudget();
  h.s.yieldToUi = async () => { h.scope('other'); };
  await assert.rejects(h.search('钥匙', budget), error => error.name === 'AbortError'); assert.equal(budget.records.size, 0);
  const other = harness(); seed(other); const controller = new AbortController(); controller.abort();
  await assert.rejects(other.search('钥匙', undefined, controller.signal), error => error.name === 'AbortError');
});
test('同轮重复、调用次数和实际结果字符预算有界；超额结果不授予原文ID', async () => {
  const h = harness(); seed(h); await h.search('钥匙'); await assert.rejects(h.search('钥匙'), /已经取得/);
  await h.search('周五'); await h.search('留宿'); await assert.rejects(h.search('归还'), /最多四次/);
  const budget = h.s.createHistoryRetrievalBudget(); budget.used = 11999;
  await assert.rejects(h.search('钥匙', budget), /12000 字符预算/); assert.equal(budget.records.size, 0);
});
test('参数拒绝跨角色字段、非法渠道/范围和未知工具；关闭检索保留旧工具，按需工具不被强制调用', async () => {
  const h = harness(); seed(h); const tools = h.s.getEnabledActiveTools();
  assert.equal(tools.length, 2); assert.equal(h.s.shouldRequireActiveToolCall(tools), false);
  assert.equal(h.s.buildActiveToolDefinitions(tools).length, 2);
  assert.equal(h.s.parseNativeActiveToolCall(h.call('tool_other', {}), []).oldParser, true);
  for (const raw of [{ query: '钥匙', scopeId: 'other' }, { query: '钥匙', channel: 'other' }, { query: '' }])
    await assert.rejects(h.s.executeHistoryRetrievalTool(h.call('tool_search_history', raw), undefined, h.s.createHistoryRetrievalBudget()));
  h.s.settings.historyRetrievalEnabled = false; assert.equal(h.s.getEnabledActiveTools().length, 0);
  await assert.rejects(h.search('钥匙'), /已关闭/);
});
test('微信关闭后仍严格载入当前分支；读取失败不能把旧内存当成当前原文', async () => {
  const h = harness(); seed(h); h.s.currentCharacter.value.wechatEnabled = false;
  h.s.ensureWechatTimelineLoaded = async (force, strict) => { assert.equal(strict, true); throw new Error('磁盘读取失败'); };
  await assert.rejects(h.search('钥匙'), /磁盘读取失败/);
});
