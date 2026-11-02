// 运行：node --test tools/refactor/test-wechat-silence.cjs
// 直接加载真实经典 script；仅替换 Vue 容器、模型接口、存储与打字延时。
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const protocolSource = fs.readFileSync(path.join(ROOT, 'assets/js/wechat-protocol.js'), 'utf8');
const wechatSource = fs.readFileSync(path.join(ROOT, 'assets/js/app/25-wechat.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const defer = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function harness(respond = async () => ({ content: '{"messages":[]}' })) {
  const stored = new Map();
  const requests = [];
  const toasts = [];
  let uuid = 0;
  let scopeId = 'branch-a';
  const context = vm.createContext({
    window: {}, console, AbortController,
    ref: value => ({ value }), reactive: value => value,
    computed: getter => ({ get value() { return getter(); } }), watch() {},
    nextTick: async () => {}, requestAnimationFrame: callback => callback(),
    document: { getElementById: () => null },
    // 打字/防抖延时仍异步执行，但不用在测试里等数秒；ticker 无须真实计时。
    setTimeout: callback => setTimeout(callback, 0), clearTimeout,
    setInterval: () => 1, clearInterval() {},
    generateUUID: () => `message-${++uuid}`,
    getMainDb: () => ({}), initDB: async () => {}, cloneForStorage: plain,
    getScopedStoredValue: async (key, scope) => plain(stored.get(`${key}/${scope}`) || []),
    setScopedStoredValue: async (key, scope, value) => { stored.set(`${key}/${scope}`, plain(value)); }
  });
  vm.runInContext(protocolSource, context, { filename: 'wechat-protocol.js' });
  vm.runInContext(wechatSource, context, { filename: '25-wechat.js' });
  const state = {
    currentCharacter: { value: {
      uuid: 'character-a', name: '小A', personality: '内敛，嘴硬心软', description: '画室的插画师',
      wechatEnabled: true, wechatSpeed: 'fast', wechatRelation: '老同学', wechatScene: '深夜',
      wechatStickerRate: 'high'
    } },
    chatHistory: { value: [] }, classicMemories: { value: [] }, memorySettings: { enabled: false },
    storyRecap: { value: null }, activeStoryBranchId: { value: 'branch-a' },
    worldInfo: { value: [] }, presets: { value: [] }, user: { name: '阿伟' },
    getCurrentStoryBranchScopeId: () => scopeId,
    settings: { apiUrl: 'https://mock.local/v1', apiKey: 'test', model: 'mock-model' },
    buildUserInfoPrompt: () => '对方叫阿伟', processRegex: text => text,
    scrollChatToBottom: async () => {},
    showToast: (...args) => toasts.push(args),
    requestTrackedChatCompletion: async options => {
      requests.push(options);
      return respond(options, requests.length);
    }
  };
  context.window.RPHubAppSections.wechat(state);
  return {
    state, protocol: context.window.RPHubWeChatProtocol, stored, requests, toasts,
    setScope: value => { scopeId = value; },
    async send(content) { state.wechatInput.value = content; await state.sendWechatMessage(); }
  };
}

test('明确空回、代码块、思考块与前言：均不会变成文字或表情', () => {
  const { protocol: p } = harness();
  for (const raw of [
    '{"messages":[]}', '```json\n{"messages": []}\n```',
    '<think>话题已结束</think>{"messages":[]}', '结果：{"messages":[]}\n结束'
  ]) {
    assert.deepEqual(plain(p.parseReplyResult(raw)), { messages: [], silent: true });
    assert.deepEqual(plain(p.parseReply(raw)), []);
    for (const tier of ['off', 'low', 'normal', 'high']) {
      assert.deepEqual(plain(p.applyStickerPolicy(p.parseReply(raw), tier)), []);
    }
  }
});

test('空内容、错误结构、空字符串气泡、截断 JSON 不会冒充主动沉默或显示 JSON', () => {
  const { protocol: p } = harness();
  for (const raw of [
    '', '  ', '<thinking>只有思考</thinking>', '{}', '[]', '{"messages":null}',
    '{"messages":""}', '{"messages":[{"type":"text","content":" "}]}',
    '{"messages":[null]}', '{"messages":[', '```json\n{"messages":[', '结果：{"messages":['
  ]) {
    assert.deepEqual(plain(p.parseReplyResult(raw)), { messages: [], silent: false }, raw);
  }
});

test('普通 JSON、旧别名、纯文本、emoji、小作文与数量上限仍可解析', () => {
  const { protocol: p } = harness();
  assert.deepEqual(plain(p.parseReply('{"messages":[{"type":"text","content":"2"}]}')),
    [{ type: 'text', content: '2' }]);
  assert.equal(p.parseReply('{"msgs":["好"]}')[0].content, '好');
  assert.equal(p.parseReply('["嗯"]')[0].content, '嗯');
  assert.equal(p.parseReply('一\n二\n三').length, 3);
  assert.equal(p.parseReply('{"messages":[{"type":"text","content":"😂"}]}')[0].type, 'sticker');
  assert.equal(p.parseReply(JSON.stringify({ messages: ['好'.repeat(300)] }))[0].content.length, 300);
  assert.equal(p.parseReply(JSON.stringify({ messages: Array(20).fill('好') })).length, 6);
});

test('人格、关系、场景、记忆与收尾规则一起注入，旧至少两条要求已移除', () => {
  const { state: s, protocol: p } = harness();
  const prompt = s.buildWechatSystemPrompt();
  for (const text of ['内敛，嘴硬心软', '老同学', '深夜', '对方叫阿伟', p.REPLY_DECISION_RULE]) {
    assert.ok(prompt.includes(text));
  }
  assert.ok(!p.PROTOCOL.includes('就至少发 2 条消息'));
  const withMemory = p.buildSystemPrompt('人设', { extraRules: '旧规则', memory: '记忆', rpSummary: '剧情' });
  assert.ok(withMemory.indexOf(p.REPLY_DECISION_RULE) > withMemory.indexOf('旧规则'));
  assert.ok(withMemory.indexOf('【长期记忆】') > withMemory.indexOf(p.REPLY_DECISION_RULE));
  assert.ok(withMemory.endsWith('剧情'));
});

test('1+1 → 2 → 好的 → 空回 → 新问题：无空白气泡，状态与上下文正常接续', async () => {
  const h = harness(async (_options, n) => ({ content: n === 2 ? '{"messages":[]}'
    : JSON.stringify({ messages: [{ type: 'text', content: n === 1 ? '2' : '4' }] }) }));
  const s = h.state;
  await h.send('1+1=几？');
  assert.deepEqual(plain(s.wechatTimeline.value.map(i => i.content)), ['1+1=几？', '2']);
  await h.send('好的');
  assert.deepEqual(plain(s.wechatTimeline.value.map(i => i.content)), ['1+1=几？', '2', '好的']);
  assert.equal(s.wechatDisplayItems.value.filter(i => i.kind === 'message').length, 3);
  assert.equal(s.wechatTimeline.value.at(-1).replyDecision, 'silent');
  assert.equal(s.wechatUnansweredCount.value, 0);
  assert.equal(s.wechatTyping.value, false);
  assert.equal(s.isWechatGenerating.value, false);
  assert.equal(s.wechatStatusText.value, '');
  assert.equal(s.wechatAbortController, null);
  assert.equal(s.wechatStatusTimer, null);
  assert.equal(h.toasts.length, 0);
  await s.requestWechatReplyNow();
  assert.equal(h.requests.length, 2, '已经处理的空回不应重复请求');
  await s.closeWechat();
  await s.openWechat();
  assert.equal(s.wechatUnansweredCount.value, 0, '重新打开仍保留空回处理边界');
  assert.equal(s.wechatTimeline.value.at(-1).replyDecision, 'silent');
  await h.send('2+2=几？');
  assert.equal(s.wechatTimeline.value.at(-1).content, '4');
  const chat = h.requests.at(-1).messages.slice(1);
  assert.deepEqual(plain(chat), [
    { role: 'user', content: '1+1=几？' }, { role: 'assistant', content: '2' },
    { role: 'user', content: '好的\n2+2=几？' }
  ]);
  assert.ok(!JSON.stringify(chat).includes('replyDecision'));
  assert.equal(h.stored.get('wechat_timeline/branch-a').length, 5);
});

test('连发文字、图片、表情后空回：只标记最后用户消息，后续连发重新计数', async () => {
  const h = harness();
  const s = h.state;
  s.wechatBurstMode.value = true;
  await h.send('收到了');
  s.wechatPendingImage.value = 'data:image/png;base64,test';
  await h.send('给你看一下');
  await s.sendWechatSticker({ name: '挥手猫' });
  assert.equal(s.wechatUnansweredCount.value, 4);
  assert.equal(h.requests.length, 0);
  await s.requestWechatReplyNow();
  assert.equal(s.wechatUnansweredCount.value, 0);
  assert.equal(s.wechatTimeline.value.length, 4);
  assert.equal(s.wechatTimeline.value.filter(i => i.replyDecision === 'silent').length, 1);
  assert.equal(s.wechatTimeline.value.at(-1).content, '挥手猫');
  await h.send('还有一件事');
  assert.equal(s.wechatUnansweredCount.value, 1);
});

for (const [name, result] of [
  ['API 空内容', { content: '' }],
  ['思考但没有正文', { content: '<think>思考</think>' }],
  ['无效结构', { content: '{"messages":null}' }],
  ['空文字', { content: '{"messages":[{"content":""}]}' }],
  ['截断 JSON', { content: '{"messages":[' }],
  ['API 截断标记', { content: '{"messages":[]}', finishReason: 'length' }],
  ['API 拦截标记', { content: '{"messages":[]}', finishReason: 'content_filter' }]
]) {
  test(`${name}：报告失败、保留待处理计数、无伪空回，可重试`, async () => {
    const h = harness(async (_options, n) => n === 1 ? result : { content: '{"messages":[]}' });
    await h.send('好的');
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0][1], 'error');
    assert.equal(h.state.wechatUnansweredCount.value, 1);
    assert.equal(h.state.wechatTimeline.value.at(-1).replyDecision, undefined);
    assert.equal(h.state.isWechatGenerating.value, false);
    assert.equal(h.state.wechatTyping.value, false);
    assert.equal(h.state.wechatStatusTimer, null);
    await h.state.requestWechatReplyNow();
    assert.equal(h.state.wechatUnansweredCount.value, 0);
    assert.equal(h.state.wechatTimeline.value.length, 1);
  });
}

test('网络异常不会变成空回，用户消息仍可重试', async () => {
  const h = harness(async () => { throw new Error('network failed'); });
  await h.send('好的');
  assert.equal(h.state.wechatUnansweredCount.value, 1);
  assert.equal(h.state.wechatTimeline.value.at(-1).replyDecision, undefined);
  assert.ok(h.toasts[0][0].includes('network failed'));
});

test('中止后即使服务端晚到空回，也不标记用户消息、不报错', async () => {
  const started = defer();
  const response = defer();
  const h = harness(async () => { started.resolve(); return response.promise; });
  const running = h.send('好的');
  await started.promise;
  h.state.stopWechatGeneration();
  response.resolve({ content: '{"messages":[]}' });
  await running;
  assert.equal(h.state.wechatUnansweredCount.value, 1);
  assert.equal(h.state.wechatTimeline.value.at(-1).replyDecision, undefined);
  assert.equal(h.toasts.length, 0);
});

test('切分支后旧请求返回空回：不标记新分支、不向新 scope 写入旧消息', async () => {
  const started = defer();
  const response = defer();
  const h = harness(async () => { started.resolve(); return response.promise; });
  const running = h.send('好的');
  await started.promise;
  h.setScope('branch-b');
  h.state.wechatTimeline.value = [{ id: 'new-message', channel: 'wechat', role: 'user', content: '新分支' }];
  response.resolve({ content: '{"messages":[]}' });
  await running;
  assert.equal(h.state.wechatUnansweredCount.value, 1);
  assert.equal(h.state.wechatTimeline.value[0].replyDecision, undefined);
  assert.equal(h.stored.has('wechat_timeline/branch-b'), false);
  assert.equal(h.stored.get('wechat_timeline/branch-a')[0].content, '好的');
});

test('停止后开始新请求：旧请求结束不会清掉新请求的输入状态', async () => {
  const started = [defer(), defer()];
  const response = [defer(), defer()];
  const h = harness(async (_options, n) => { started[n - 1].resolve(); return response[n - 1].promise; });
  const first = h.send('好的');
  await started[0].promise;
  h.state.stopWechatGeneration();
  const second = h.send('新问题');
  await started[1].promise;
  const controller = h.state.wechatAbortController;
  response[0].resolve({ content: '{"messages":[]}' });
  await first;
  assert.equal(h.state.wechatAbortController, controller);
  assert.equal(h.state.isWechatGenerating.value, true);
  assert.equal(h.state.wechatTyping.value, true);
  response[1].resolve({ content: '{"messages":[{"content":"在"}]}' });
  await second;
  assert.equal(h.state.isWechatGenerating.value, false);
  assert.equal(h.state.wechatTimeline.value.at(-1).content, '在');
});

test('真实表情收尾仍为一条消息，不会被识别成沉默', async () => {
  const h = harness(async () => ({ content: '{"messages":[{"type":"sticker","content":"挥手猫"}]}' }));
  await h.send('晚安');
  assert.equal(h.state.wechatTimeline.value.at(-1).type, 'sticker');
  assert.equal(h.state.wechatTimeline.value.at(-1).content, '挥手猫');
  assert.equal(h.state.wechatTimeline.value[0].replyDecision, undefined);
  assert.equal(h.state.wechatUnansweredCount.value, 0);
});
