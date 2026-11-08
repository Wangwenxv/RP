// 清理回归：真实微信/提要/清理模块 + 可控存储和晚到模型响应。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness() {
  const stored = new Map(), toasts = [], requests = [];
  let scope = 'branch-a', id = 0, fail = false;
  const get = async (key, target) => plain(stored.get(`${key}/${target}`) ?? null);
  const set = async (key, target, value) => stored.set(`${key}/${target}`, plain(value));
  const context = vm.createContext({
    window: { RPHubStorage: { setScopedStoredValues: async (target, entries) => {
      if (fail) throw new Error('模拟事务失败');
      for (const [key, value] of Object.entries(entries)) await set(key, target, value);
    } }, RPHubUtils: { parseCot: value => ({ main: value }) } },
    console: { ...console, error() {} }, AbortController, DOMException,
    ref: value => ({ value }), reactive: value => value,
    computed: getter => ({ get value() { return getter(); } }), watch() {},
    nextTick: async () => {}, requestAnimationFrame: fn => fn(), document: { getElementById: () => null },
    setTimeout: fn => setTimeout(fn, 0), clearTimeout, setInterval: () => 1, clearInterval() {},
    generateUUID: () => `id-${++id}`, getMainDb: () => ({}), initDB: async () => {},
    cloneForStorage: plain, prepareClassicMemoriesForRuntime: plain,
    getScopedStoredValue: get, setScopedStoredValue: set,
    getStoredValue: async () => null, setStoredValue: async () => {}
  });
  for (const file of ['built-in-content.js', 'wechat-time.js', 'wechat-protocol.js', 'app/25-wechat.js', 'app/26-recap.js', 'app/33-conversation-clear.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js', file), 'utf8'), context, { filename: file });
  }
  context.BUILTIN_PROMPTS = context.window.RPHubBuiltinContent.prompts;
  const state = {
    currentCharacter: { value: { uuid: 'a', name: '小A', first_mes: '新开场', wechatEnabled: true, wechatSpeed: 'fast' } },
    chatHistory: { value: [] }, classicMemories: { value: [] }, conversationRevision: 0,
    isConversationClearing: { value: false }, storyBranchSwitching: { value: false }, switchingCharacterIndex: { value: -1 },
    _classicMemoriesLoaded: true, _classicExtractionEpoch: 0,
    memorySettings: { enabled: false }, activeStoryBranchId: { value: 'main' },
    settings: { apiUrl: 'https://mock.local/v1', apiKey: 'k', model: 'mock' },
    user: { name: '玩家' }, userInput: { value: '' }, retryingClassicMemoryId: { value: '' },
    worldInfo: { value: [] }, presets: { value: [] }, pendingActiveWechatMessages: [],
    getCurrentStoryBranchScopeId: () => scope,
    showToast: (...args) => toasts.push(args), buildUserInfoPrompt: () => '', processRegex: text => text,
    createInitialChatHistory: char => [{ role: 'assistant', content: char.first_mes }],
    buildConversationTurnSnapshot: (history = state.chatHistory.value) => ({ turns: history.flatMap((item, index) =>
      item.role === 'user' ? [{ turn: Math.floor(index / 2) + 1, sourceIndexes: [index, index + 1].filter(i => i < history.length) }] : []) }),
    getPostprocessedChatMessages: history => history,
    requestTrackedChatCompletion: async options => { requests.push(options); return { content: '{"messages":[]}' }; },
    requestClassicMemoryCompletion: async () => '总结',
    stopGeneration() {}, waitForConversationIdle: async () => true,
    abortConversationBackgroundWork: () => { state._classicExtractionEpoch++; },
    debouncedSave: { cancel() {} }, chatHistorySaveQueue: Promise.resolve(),
    clearPendingChatImages() {}, clearPendingCardInteraction() {}, resetChatRenderWindow() {},
    clearStoryBranchTransientContext() {}, resetMemoryRecallFailure() {}, resetUiTemplateRuntimeState() {},
    pruneUiTemplateChangesFromTurn() {}, saveGlobalUiTemplateRuntimeForCharacter() {}, updateCurrentStoryBranchSummary() {},
    saveCharactersNow: async () => {}, saveData: async () => {}, saveStoryBranchesForCharacter: async () => {}, globalUiTemplates: { value: [] },
    trimClassicMemoriesToTurn: (items, turn) => items.filter(item => item.turn <= turn),
    stripDisabledImageGenContext: text => text, stripNextResponsePrompt: text => text, stripUiTemplateContextInjection: text => text
  };
  context.window.RPHubAppSections.wechat(state);
  context.window.RPHubAppSections.recap(state);
  context.window.RPHubAppSections.conversationClear(state);
  return { state, stored, toasts, requests, context, plan: context.window.RPHubConversationClear.planClear,
    setScope: value => { scope = value; }, failTransaction: () => { fail = true; } };
}
const history = () => [
  { id: 'u1', role: 'user', content: '保留RP1' }, { id: 'a1', role: 'assistant', content: '保留答复1' },
  { id: 'u2', role: 'user', content: '删除RP2' }, { id: 'a2', role: 'assistant', content: '删除答复2' }
];
const rp = (index, content) => ({ id: `rp-${index}`, channel: 'rp', rpIndex: index, role: index % 2 ? 'assistant' : 'user', content });
const wx = (id, content) => ({ id, channel: 'wechat', role: 'user', type: 'text', content });
const timeline = () => [rp(0, '保留RP1'), rp(1, '保留答复1'), wx('w1', '保留微信1'), rp(2, '删除RP2'), rp(3, '删除答复2'), wx('w2', '删除微信2')];

test('微信本段只清最后一段；上轮 RP 和更早微信都保留', () => {
  const h = harness(), plan = h.plan(history(), timeline(), 'wechat', 'segment');
  assert.deepEqual(plain(plan.history), history());
  assert.deepEqual(plain(plan.removed).map(item => item.id), ['w2']);
  assert.equal(plan.timeline.length, 5);
});
test('RP 本段保留前轮微信和 RP，截掉此后的 RP', () => {
  const h = harness(), plan = h.plan(history(), timeline().slice(0, -1), 'rp', 'segment');
  assert.deepEqual(plain(plan.history), history().slice(0, 2));
  assert.equal(plan.timeline.length, 3);
});
test('刚切入微信尚未发送时，本段为空，不能删除前轮 RP', () => {
  const h = harness(), plan = h.plan(history(), timeline().slice(0, -1), 'wechat', 'segment');
  assert.equal(plan.removed.length, 0);
  assert.equal(plan.history.length, 4);
});
test('清空全部同步删除旧 RP 镜像、微信、记忆和未加载提要', async () => {
  const h = harness(), s = h.state;
  s.chatHistory.value = history(); s.replaceWechatTimeline(timeline());
  s.classicMemories.value = [{ turn: 1, summary: '旧记忆', embeddingQ: 'AA' }];
  h.stored.set('story_recap/branch-a', { text: '磁盘旧提要', coversThroughTurn: 2 });
  h.stored.set('chat/branch-other', [{ content: '其它分支保留' }]);
  await s.openConversationClear('rp');
  assert.equal(await s.clearConversationContent('all'), true);
  assert.equal(s.chatHistory.value[0].content, '新开场');
  for (const key of ['classic_memories', 'wechat_timeline', 'wechat_media_tasks']) assert.deepEqual(h.stored.get(`${key}/branch-a`), []);
  assert.equal(h.stored.get('story_recap/branch-a'), null);
  assert.equal(h.stored.get('chat/branch-other')[0].content, '其它分支保留');
  await s.ensureWechatTimelineLoaded(true);
  await s.ensureStoryRecapLoaded(true);
  await s.runWechatGeneration();
  assert.equal(h.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(h.requests[0].messages), /删除RP2|保留答复1|旧记忆|磁盘旧提要|删除微信2/);
});
test('清掉已进入提要的微信本段会作废提要；较早 RP 记忆保留', async () => {
  const h = harness(), s = h.state;
  s.chatHistory.value = history(); s.replaceWechatTimeline(timeline());
  s.classicMemories.value = [{ turn: 1, summary: '前轮摘要' }];
  s.replaceStoryRecap({ text: '包含删除微信2', coversThroughTurn: 2, coversWechatCount: 2 });
  await s.openConversationClear('wechat');
  assert.equal(await s.clearConversationContent('segment'), true);
  assert.equal(s.chatHistory.value.length, 4);
  assert.equal(s.classicMemories.value.length, 1);
  assert.equal(s.storyRecap.value, null);
  await s.runWechatGeneration();
  assert.equal(h.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(h.requests[0].messages), /删除微信2/);
});
test('RP 本段清理裁剪对应总结，并保留前轮提要', async () => {
  const h = harness(), s = h.state;
  s.chatHistory.value = history(); s.replaceWechatTimeline(timeline().slice(0, -1));
  s.classicMemories.value = [{ turn: 1, summary: '保留记忆' }, { turn: 2, summary: '删除记忆' }];
  s.replaceStoryRecap({ text: '前轮提要', coversThroughTurn: 1, coversWechatCount: 1 });
  await s.openConversationClear('rp');
  assert.equal(await s.clearConversationContent('segment'), true);
  assert.equal(s.chatHistory.value.length, 2);
  assert.equal(s.classicMemories.value.length, 1);
  assert.equal(s.storyRecap.value.text, '前轮提要');
});
test('存储事务失败保留原聊天，且不显示成功', async () => {
  const h = harness(), s = h.state;
  s.chatHistory.value = history(); s.replaceWechatTimeline(timeline());
  await s.openConversationClear('rp'); h.failTransaction();
  assert.equal(await s.clearConversationContent('all'), false);
  assert.equal(s.chatHistory.value.length, 4);
  assert.equal(s.wechatTimeline.value.length, 6);
  assert.ok(h.toasts.some(([, kind]) => kind === 'error'));
  assert.ok(!h.toasts.some(([, kind]) => kind === 'success'));
});
test('打开菜单后切换分支不清理新的分支', async () => {
  const h = harness(), s = h.state;
  await s.openConversationClear('wechat'); h.setScope('branch-b');
  assert.equal(await s.clearConversationContent('all'), false);
  assert.equal(h.stored.has('chat/branch-b'), false);
});
test('晚到的提要请求即使忽略 abort 也不能复活清掉的剧情', async () => {
  const h = harness(), s = h.state, late = deferred(), started = deferred();
  s.chatHistory.value = history(); s.replaceWechatTimeline(timeline());
  s.requestClassicMemoryCompletion = async () => { started.resolve(); return late.promise; };
  const running = s.runStoryRecap(); await started.promise;
  await s.openConversationClear('wechat');
  assert.equal(await s.clearConversationContent('all'), true);
  late.resolve('过期提要：删除RP2'); await running;
  assert.equal(s.storyRecap.value, null);
  assert.equal(h.stored.get('story_recap/branch-a'), null);
});
test('内存未加载的提要也会被静默清除，随后重载仍为空', async () => {
  const h = harness(), s = h.state;
  h.stored.set('story_recap/branch-a', { text: '残留提要' });
  s.storyRecap.value = null;
  await s.clearStoryRecapSilently(); await s.ensureStoryRecapLoaded(true);
  assert.equal(s.storyRecap.value, null);
});
test('RP 变成空记录时，对账会删除所有过期 RP 镜像', () => {
  const h = harness(), s = h.state;
  s.replaceWechatTimeline(timeline());
  assert.equal(s.reconcileRpTimeline(), true);
  assert.deepEqual(plain(s.wechatTimeline.value).map(item => item.id), ['w1', 'w2']);
});
test('清空期间晚到的微信响应不能追加旧气泡，也不能覆盖空时间线', async () => {
  const h = harness(), s = h.state, late = deferred(), started = deferred();
  s.chatHistory.value = history(); s.replaceWechatTimeline(timeline());
  s.requestTrackedChatCompletion = async () => { started.resolve(); return late.promise; };
  const running = s.runWechatGeneration(); await started.promise;
  await s.openConversationClear('wechat'); await s.clearConversationContent('all');
  late.resolve({ content: '{"messages":[{"type":"text","content":"旧回复晚到"}]}' }); await running;
  assert.equal(s.wechatTimeline.value.length, 0);
  assert.deepEqual(h.stored.get('wechat_timeline/branch-a'), []);
});
test('清空作废正在读取的旧微信时间线与旧前情提要', async () => {
  const h = harness(), s = h.state, lateWx = deferred(), lateRecap = deferred();
  await s.ensureStoryRecapLoaded();
  h.context.getScopedStoredValue = (key) => key === 'wechat_timeline' ? lateWx.promise : lateRecap.promise;
  const wxLoad = s.ensureWechatTimelineLoaded(true), recapLoad = s.ensureStoryRecapLoaded(true);
  s.conversationRevision++;
  s.replaceWechatTimeline([]); await s.clearStoryRecapSilently();
  lateWx.resolve(timeline()); lateRecap.resolve({ text: '过期磁盘摘要' });
  await Promise.all([wxLoad, recapLoad]);
  assert.equal(s.wechatTimeline.value.length, 0);
  assert.equal(s.storyRecap.value, null);
});
test('微信关闭后清空全部仍会加载并清掉磁盘中的微信与提要', async () => {
  const h = harness(), s = h.state;
  s.chatHistory.value = history();
  h.stored.set('wechat_timeline/branch-a', timeline());
  h.stored.set('story_recap/branch-a', { text: '磁盘提要', coversThroughTurn: 2 });
  await s.openConversationClear('rp'); await s.clearConversationContent('all');
  assert.deepEqual(h.stored.get('wechat_timeline/branch-a'), []);
  assert.equal(h.stored.get('story_recap/branch-a'), null);
});
test('无法停止 RP 请求时不删除记录，允许稍后重试', async () => {
  const h = harness(), s = h.state;
  s.chatHistory.value = history(); s.replaceWechatTimeline(timeline());
  s.waitForConversationIdle = async () => false;
  await s.openConversationClear('rp');
  assert.equal(await s.clearConversationContent('all'), false);
  assert.equal(s.chatHistory.value.length, 4);
  assert.equal(s.isConversationClearing.value, false);
});
test('读取微信失败时拒绝打开清空菜单，不将失败误当空时间线', async () => {
  const h = harness(), s = h.state;
  h.context.getScopedStoredValue = async () => { throw new Error('存储读取失败'); };
  await s.openConversationClear('rp');
  assert.equal(s.showConversationClear.value, false);
  assert.ok(h.toasts.some(([message]) => message.includes('清空菜单未打开')));
});
test('渠道边界位于同一 RP 轮次中时，残留变量展示块不会留在磁盘', async () => {
  const h = harness(), s = h.state;
  s.chatHistory.value = history();
  s.chatHistory.value[1].uiTemplateBlocks = [{ content: '包含本段的旧变量进度' }];
  s.replaceWechatTimeline(timeline().slice(0, -1));
  s.buildConversationTurnSnapshot = () => ({ turns: [{ turn: 1, sourceIndexes: [0, 1, 2, 3] }] });
  await s.openConversationClear('rp'); await s.clearConversationContent('segment');
  assert.equal(h.stored.get('chat/branch-a')[1].uiTemplateBlocks, undefined);
});
