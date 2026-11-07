// 真实记忆模块 + API/存储替身：不使用个人数据或真实模型服务。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(ROOT, 'assets/js', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function harness() {
  let scope = 'main', serial = 0, now = 100000;
  const requests = [], toasts = [], saved = [], watchers = [];
  let respond = async options => ({ data: (Array.isArray(options.body.input) ? options.body.input : [options.body.input])
    .map((_, index) => ({ index, embedding: [1, 0] })) });
  class Clock extends Date { static now() { return now; } }
  const c = vm.createContext({ window: { RPHubBuiltinContent: { prompts: {} }, RPHubUtils: {} },
    Vue: { markRaw: value => value }, Date: Clock, AbortController, btoa, atob,
    console: { warn() {}, error() {} }, ref: value => ({ value }),
    watch: (get, callback) => watchers.push(callback), cloneForStorage: plain,
    parseCot: content => ({ main: content }), generateUUID: () => `memory-${++serial}`,
    getApiUsagePayload: data => data.usage,
    buildApiEndpoint: (url, endpoint) => `${url}/${endpoint}`,
    requestJson: async options => { requests.push(options); return respond(options); },
    BUILTIN_PROMPTS: { buildClassicSummarySystemPrompt: () => '总结', buildClassicSummaryFinalInstruction: () => '总结',
      buildClassicSecondarySummaryPrompt: () => '二次压缩' } });
  vm.runInContext(read('data-services.js'), c);
  Object.assign(c, c.window.RPHubMemoryUtils);
  const s = { currentCharacter: { value: { uuid: 'char', name: '测试角色' } }, activeStoryBranchId: { value: 'main' },
    memorySettings: { enabled: true, mode: 'enhanced', embeddingModel: 'vector-test', classicModel: 'summary-test', classicConcurrency: 1 },
    settings: { apiUrl: 'https://mock.local/v1', apiKey: 'fixture-secret' },
    classicMemories: { value: [] }, chatHistory: { value: [] }, isClassicBatchExtracting: { value: false },
    retryingClassicMemoryId: { value: '' }, memoryBackfillProgress: { value: {} }, isConversationBusy: { value: false },
    user: { name: '玩家' }, getCurrentStoryBranchScopeId: () => scope,
    MEMORY_MODE_ENHANCED: 'enhanced', SUMMARY_EMBEDDING_BATCH_SIZE: 16, SUMMARY_RECALL_MIN_SIMILARITY: 0.48,
    SUMMARY_RECALL_LIMIT: 10, CLASSIC_SECONDARY_KEEP_TURNS: 25, CLASSIC_SECONDARY_GROUP_SIZE: 5,
    normalizeClassicMemoryConcurrency: () => 1, recordApiUsage() {},
    createAbortReason: () => Object.assign(new Error('停止'), { name: 'AbortError' }), yieldToUi: async () => {},
    showToast: (...args) => toasts.push(args),
    saveClassicMemoriesNow: async (scopeId = scope, memories = s.classicMemories.value) => saved.push({ scopeId, memories: plain(memories) }),
    saveChatHistoryNow: async () => {}, isSecondaryClassicMemory: memory => memory.secondaryCompressed === true,
    stripNextResponsePrompt: text => text, stripUiTemplateContextInjection: text => text,
    appendMessageImageDescriptions: (_, text) => text,
    requestTrackedChatCompletion: async () => ({ content: '压缩后的总结' }) };
  const turns = () => Array.from({ length: s.chatHistory.value.length / 2 }, (_, index) => {
    const user = s.chatHistory.value[index * 2], assistant = s.chatHistory.value[index * 2 + 1];
    return { turn: index + 1, user: { ...user, _sourceIndexes: [index * 2] },
      assistant: { ...assistant, _sourceIndexes: [index * 2 + 1] }, sourceIndexes: [index * 2, index * 2 + 1] };
  });
  s.buildConversationTurnSnapshot = () => ({ turns: turns() });
  vm.runInContext(read('app/16-memory-extraction.js'), c); c.window.RPHubAppSections.memoryExtraction(s);
  function seed(count = 1, indexed = true) {
    s.chatHistory.value = [];
    s.classicMemories.value = [];
    for (let turn = 1; turn <= count; turn++) {
      s.chatHistory.value.push({ id: `u-${turn}`, role: 'user', content: `用户原文${turn}` },
        { id: `a-${turn}`, role: 'assistant', content: `角色原文${turn}` });
      const memory = { id: `m-${turn}`, turn, classicMemory: true, summary: `总结${turn}`, enabled: true,
        sourceUserText: `用户原文${turn}`, sourceUserIds: [`u-${turn}`], sourceAssistantIds: [`a-${turn}`] };
      if (indexed) Object.assign(memory, c.quantizeEmbeddingForStorage([1, 0]),
        { embeddingModel: 'vector-test', embeddingApiUrl: s.settings.apiUrl });
      s.classicMemories.value.push(memory);
    }
  }
  return { s, c, requests, saved, toasts, seed, respond: fn => { respond = fn; },
    advance: ms => { now += ms; }, scope: value => { scope = value; s.activeStoryBranchId.value = value; },
    batch: () => { vm.runInContext(read('app/19-memory-batch.js'), c); c.window.RPHubAppSections.memoryBatch(s); } };
}
test('基础模式和关闭记忆时不调用向量接口', async () => {
  const h = harness(); h.seed(); h.s.memorySettings.mode = 'classic';
  assert.deepEqual(plain(await h.s.selectEnhancedMemories()), []);
  h.s.memorySettings.mode = 'enhanced'; h.s.memorySettings.enabled = false;
  assert.deepEqual(plain(await h.s.selectEnhancedMemories()), []); assert.equal(h.requests.length, 0);
});
test('成功召回使用独立向量接口与15秒预算，低相似度不算报错', async () => {
  const h = harness(); h.seed();
  assert.equal((await h.s.selectEnhancedMemories())[0].id, 'm-1');
  assert.equal(h.requests[0].timeoutMs, 15000); assert.match(h.requests[0].url, /embeddings$/);
  assert.equal(h.requests[0].body.model, 'vector-test');
  h.respond(async () => ({ data: [{ index: 0, embedding: [0, 1] }] }));
  assert.equal((await h.s.selectEnhancedMemories()).length, 0);
  assert.equal(h.s.memoryRecallState.value.status, 'ready'); assert.equal(h.toasts.length, 0);
});
test('向量故障降级、冷却、去重提示和手动恢复，错误不泄露Key', async () => {
  const h = harness(); h.seed();
  h.respond(async () => { throw new Error('不支持模型 fixture-secret'); });
  await h.s.selectEnhancedMemories(); await h.s.selectEnhancedMemories();
  assert.equal(h.requests.length, 1); assert.equal(h.toasts.length, 1);
  assert.match(h.s.memoryRecallState.value.message, /不支持模型/);
  assert.ok(!h.s.memoryRecallState.value.message.includes('fixture-secret'));
  h.advance(60001); await h.s.selectEnhancedMemories(); assert.equal(h.requests.length, 2); assert.equal(h.toasts.length, 1);
  h.s.resetMemoryRecallFailure();
  h.respond(async () => ({ data: [{ embedding: [1, 0] }] }));
  assert.equal((await h.s.selectEnhancedMemories()).length, 1); assert.equal(h.s.memoryRecallState.value.status, 'ready');
});
test('配置变更不沿用冷却；旧请求失败不能污染新角色或分支', async () => {
  const h = harness(); h.seed(); h.respond(async () => { throw new Error('Failed to fetch'); });
  await h.s.selectEnhancedMemories(); assert.match(h.s.memoryRecallState.value.message, /跨域/);
  h.s.settings.apiKey = 'new-key'; await h.s.selectEnhancedMemories(); assert.equal(h.requests.length, 2);
  h.s.resetMemoryRecallFailure();
  let reject; h.respond(() => new Promise((_, r) => { reject = r; }));
  const pending = h.s.selectEnhancedMemories(); h.scope('other'); h.s.currentCharacter.value = { uuid: 'new-char' };
  h.s.resetMemoryRecallFailure(); reject(new Error('旧请求失败')); await pending;
  assert.equal(h.s.memoryRecallState.value.status, 'idle'); assert.equal(h.toasts.length, 2);
});
test('取消召回正常传播，冷却也不能吞掉已取消信号', async () => {
  const h = harness(); h.seed(); const controller = new AbortController();
  h.respond(async () => { controller.abort(); throw h.s.createAbortReason(); });
  await assert.rejects(h.s.selectEnhancedMemories(controller.signal), { name: 'AbortError' });
  assert.equal(h.toasts.length, 0);
  h.s.noteMemoryRecallFailure(new Error('故障'));
  await assert.rejects(h.s.selectEnhancedMemories(controller.signal), { name: 'AbortError' });
});
test('向量响应顺序正确映射；拒绝重复序号、空向量、非数值与零向量', async () => {
  const h = harness();
  h.respond(async () => ({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }));
  assert.deepEqual(plain(await h.s.requestMemoryEmbeddings(['a', 'b'])), [[1, 0], [0, 1]]);
  for (const data of [[{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }],
    [{ index: 0, embedding: [] }], [{ index: 0, embedding: ['1'] }], [{ index: 0, embedding: [0, 0] }]]) {
    h.respond(async () => ({ data }));
    await assert.rejects(h.s.requestMemoryEmbeddings(data.length === 2 ? ['a', 'b'] : ['a']));
  }
});
test('维度变化标记索引待重建，原总结保持完整', async () => {
  const h = harness(); h.seed(); h.respond(async () => ({ data: [{ index: 0, embedding: [1, 0, 0] }] }));
  assert.equal((await h.s.selectEnhancedMemories()).length, 0);
  assert.match(h.s.memoryRecallState.value.message, /维度/);
  assert.equal(h.s.getSummaryEmbeddingJobs(h.s.buildConversationTurnSnapshot()).length, 1);
  assert.equal(h.s.classicMemories.value[0].summary, '总结1');
});
test('向量请求中切换API配置，旧索引和旧召回结果都丢弃', async () => {
  const h = harness(); h.seed(1, false);
  h.respond(async () => { h.s.settings.apiKey = 'changed-key'; return { data: [{ index: 0, embedding: [1, 0] }] }; });
  assert.equal(await h.s.indexSummaryMemories(h.s.buildConversationTurnSnapshot()), 0);
  assert.equal(h.s.classicMemories.value[0].embeddingQ, undefined); assert.equal(h.saved.length, 0);
  h.seed();
  h.respond(async () => { h.scope('other'); return { data: [{ index: 0, embedding: [1, 0] }] }; });
  assert.equal((await h.s.selectEnhancedMemories()).length, 0); assert.equal(h.toasts.length, 0);
});
for (const model of ['', 'vector-test']) test(`向量${model ? '接口失败' : '未配置'}不阻断总结与二次压缩`, async () => {
  const h = harness(); h.seed(30, false); h.s.classicMemories.value = [];
  h.s.memorySettings.embeddingModel = model; h.respond(async () => { throw new Error('不支持 embeddings'); });
  h.batch(); await h.s.startClassicBatchMemoryExtraction({ manual: false });
  assert.equal(h.s.classicMemories.value.length, 26);
  const merged = h.s.classicMemories.value.find(memory => memory.secondaryCompressed);
  assert.equal(merged.sourceMemories.length, 5); assert.equal(merged.turnStart, 1); assert.equal(merged.turnEnd, 5);
  assert.equal(h.s.memoryBackfillProgress.value.status, 'error');
  assert.match(h.s.memoryBackfillProgress.value.message, /向量增强未完成/);
  assert.equal(h.requests.length, model ? 1 : 0);
  assert.equal(h.s.chatHistory.value[1].content, '角色原文1'); assert.ok(h.saved.length > 0);
});
test('基础补录只总结和二次压缩，失败向量不会让总结重试变成失败', async () => {
  const h = harness(); h.seed(1, false); h.s.memorySettings.mode = 'classic'; h.s.classicMemories.value = []; h.batch();
  await h.s.startClassicBatchMemoryExtraction({ manual: false }); assert.equal(h.requests.length, 0);
  assert.equal(h.s.memoryBackfillProgress.value.status, 'done');
  h.s.memorySettings.mode = 'enhanced'; h.respond(async () => { throw new Error('向量不可用'); });
  await h.s.retryClassicMemory(h.s.classicMemories.value[0]);
  assert.equal(h.s.classicMemories.value[0].summary, '压缩后的总结');
  assert.ok(h.toasts.some(([text, type]) => text.includes('已重新生成') && type === 'success'));
  assert.ok(!h.toasts.some(([text]) => text.startsWith('重试失败')));
});
test('手动补录解除冷却，只补缺失向量且保留二次压缩中的源总结', async () => {
  const h = harness(); h.seed(30, false); h.batch();
  h.respond(async () => { throw new Error('临时故障'); });
  await h.s.startClassicBatchMemoryExtraction({ manual: false });
  assert.equal(h.s.canRequestMemoryEmbeddings(), false);
  let summaryRequests = 0;
  h.s.requestTrackedChatCompletion = async () => { summaryRequests++; return { content: '不应再总结' }; };
  h.respond(async options => ({ data: options.body.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  await h.s.startClassicBatchMemoryExtraction({ manual: true });
  assert.equal(summaryRequests, 0); assert.equal(h.s.memoryBackfillProgress.value.status, 'done');
  assert.equal(h.s.memoryRecallState.value.status, 'ready');
  assert.equal(h.c.getSummarySources(h.s.classicMemories.value).filter(memory => h.s.hasCurrentSummaryEmbedding(memory)).length, 30);
  assert.equal(h.s.classicMemories.value.find(memory => memory.secondaryCompressed).sourceMemories[0].summary, '总结1');
});
