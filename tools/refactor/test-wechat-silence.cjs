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
const withoutTime = value => String(value).replace(/【发送时间：[^】]*】\n/g, '');
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
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/built-in-content.js'), 'utf8'), context, { filename: 'built-in-content.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/wechat-time.js'), 'utf8'), context, { filename: 'wechat-time.js' });
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
    loadRpTools(tools) {
      Object.assign(context, {
        BUILTIN_PROMPTS: context.window.RPHubBuiltinContent.prompts,
        ACTIVE_TOOL_WECHAT_TYPE: 'wechat_message', ACTIVE_TOOL_WEB_TYPE: 'web_search',
        ACTIVE_TOOL_RANDOM_TYPE: 'random_number', ACTIVE_TOOL_KEYWORD_TYPE: 'keyword_dialogue',
        ACTIVE_TOOL_MAX_AUTO_CONTINUE: 4, crypto: require('node:crypto').webcrypto,
        console: { ...console, info() {} }
      });
      const continuations = [], toolResults = [];
      Object.assign(state, {
        normalizeActiveTools: () => tools, normalizeActiveToolBaseCallName: value => value,
        getActiveToolAggressiveness: () => 'adaptive', getActiveToolAggressivenessLabel: () => '按需',
        getActiveToolLatestUserReminder: () => '按需调用',
        activeToolMessages: [], activeToolQueueRunning: { value: false },
        activeToolHandoffPending: { value: false }, activeToolContinuationPending: { value: false },
        saveChatHistoryNow: async () => {},
        generateResponse: async (...args) => { continuations.push(args); },
        appendAssistantResponseError: (message, error) => { message.responseError = error; }
      });
      for (const file of ['14-tools-runtime.js', '17-retrieval-web-tools.js', '18-tools-ui.js']) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/app', file), 'utf8'), context);
      }
      context.window.RPHubAppSections.toolsRuntime(state);
      context.window.RPHubAppSections.retrievalWeb(state);
      context.window.RPHubAppSections.toolsUi(state);
      const appendResult = state.appendActiveToolResult;
      state.appendActiveToolResult = (callId, payload) => { toolResults.push({ callId, payload }); appendResult(callId, payload); };
      return { continuations, toolResults, async execute(calls) {
        const message = { id: 'rp-turn', role: 'assistant', content: '她拿起手机，准备联系。' };
        const uis = new Map();
        state.syncNativeActiveToolUis(message, calls, uis, tools, true);
        const native = { role: 'assistant', content: message.content, tool_calls: calls, extra_content: { signature: 'signed' } };
        const continued = await state.handleActiveToolCallFromAssistant(message, { assistantMessage: native, toolCalls: calls }, uis, tools, 0);
        return { message, continued, uis: [...uis.values()] };
      } };
    },
    async loadRecap() {
      context.getStoredValue = async () => null;
      state.buildConversationTurnSnapshot = () => ({ turns: [] });
      state.getPostprocessedChatMessages = () => [];
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/app/26-recap.js'), 'utf8'), context);
      context.window.RPHubAppSections.recap(state);
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    setScope: value => { scopeId = value; },
    async send(content) { state.wechatInput.value = content; await state.sendWechatMessage(); }
  };
}

const rpWechatTool = { id: 'tool_wechat', name: '主动微信', type: 'wechat_message', callName: 'tool_wechat', enabled: true };
const nativeCall = (id, content, name = 'tool_wechat') => ({ id, type: 'function', function: {
  name, arguments: JSON.stringify(typeof content === 'string' ? { content } : content)
} });

test('RP主动微信同轮四个并行调用只接收第一条，成功后不自动续写', async () => {
  const h = harness(), runtime = h.loadRpTools([rpWechatTool]);
  const run = await runtime.execute(['在忙吗', '图书馆', '好', '你早点弄完 别太晚'].map((text, i) => nativeCall(`call-${i}`, text)));
  assert.equal(run.continued, false);
  assert.equal(runtime.continuations.length, 0);
  assert.deepEqual(plain(h.state.pendingActiveWechatMessages), ['在忙吗']);
  assert.deepEqual(plain(runtime.toolResults.map(item => item.payload.status)), ['ok', 'error', 'error', 'error']);
  assert.deepEqual(plain(runtime.toolResults.map(item => item.callId)), ['call-0', 'call-1', 'call-2', 'call-3']);
  assert.deepEqual(plain(run.uis.map(ui => ui.status)), ['done', 'error', 'error', 'error']);
  assert.equal(runtime.toolResults[0].payload.results[0].delivered, false, '排队不冒充已经送达');
  assert.equal(runtime.toolResults[0].payload.results[0].awaitingPlayer, true);
  assert.equal(h.state.activeToolContinuationPending.value, false);
  assert.equal(h.state.activeToolQueueRunning.value, false);
});

test('主动微信不把嵌套发送者或多消息JSON解析成角色气泡，错误仍可由模型修正', async () => {
  const h = harness(), runtime = h.loadRpTools([rpWechatTool]);
  const run = await runtime.execute([nativeCall('bad-envelope', JSON.stringify({ messages: [
    { role: 'user', content: '还在实验室 你呢' }, { role: 'assistant', content: '图书馆' }
  ] }))]);
  assert.equal(h.state.pendingActiveWechatMessages.length, 0);
  assert.equal(runtime.toolResults[0].payload.status, 'error');
  assert.equal(run.continued, true, '没有成功联系时保留原工具错误修正管线');
  assert.equal(runtime.continuations.length, 1);
  assert.throws(() => h.state.deliverActiveWechatMessage('{"role":"user","content":"好"}'), /一条纯文本/);
  assert.throws(() => h.state.deliverActiveWechatMessage('```json\n{"messages":[]}\n```'), /一条纯文本/);
});

test('主动微信原生发送者字段被拒绝，合法调用仍可交接；换行只生成一个气泡', async () => {
  const h = harness(), runtime = h.loadRpTools([rpWechatTool]);
  const run = await runtime.execute([nativeCall('bad-sender', { content: '还在实验室', sender: '陈璃' }), nativeCall('valid', '在忙吗\n我刚下课')]);
  assert.equal(run.continued, false);
  assert.deepEqual(plain(runtime.toolResults.map(item => item.payload.status)), ['error', 'ok']);
  await h.state.flushActiveWechatMessages();
  const messages = h.state.wechatTimeline.value.filter(item => item.channel === 'wechat');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].content, '在忙吗\n我刚下课');
});

test('主动联系交接保留同批其他工具结果，非微信工具仍自动续写并保留原生签名', async () => {
  const random = { id: 'tool_random', callName: 'tool_random', name: '随机', type: 'random_number', enabled: true };
  const h = harness(), runtime = h.loadRpTools([random, rpWechatTool]);
  const calls = [nativeCall('random', { min: 1, max: 1 }, 'tool_random'), nativeCall('contact', '在忙吗')];
  const run = await runtime.execute(calls);
  assert.equal(run.continued, false);
  assert.equal(runtime.toolResults[0].payload.results[0].value, 1);
  assert.equal(runtime.toolResults[1].payload.operation, 'wechat');
  assert.equal(h.state.activeToolMessages[0].extra_content.signature, 'signed');
  const other = harness(), onlyRandom = other.loadRpTools([random]);
  const continued = await onlyRandom.execute([nativeCall('random-only', { min: 1, max: 1 }, 'tool_random')]);
  assert.equal(continued.continued, true);
  assert.equal(onlyRandom.continuations.length, 1);
  assert.equal(other.state.pendingActiveWechatMessages.length, 0);
});

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
  const withMemory = p.buildSystemPrompt('人设', { extraRules: '旧规则', memory: '记忆', rpSummary: '剧情', mediaPrompt: '本轮图片说明' });
  assert.ok(withMemory.indexOf(p.REPLY_DECISION_RULE) > withMemory.indexOf('旧规则'));
  assert.ok(withMemory.indexOf(p.REPLY_DECISION_RULE) > withMemory.indexOf('本轮图片说明'));
  assert.ok(withMemory.indexOf('【长期记忆】') > withMemory.indexOf(p.REPLY_DECISION_RULE));
  assert.ok(withMemory.indexOf('【之前发生的事】\n剧情') > withMemory.indexOf('【长期记忆】'));
  assert.ok(withMemory.endsWith(p.REPLY_DECISION_REMINDER));
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
  assert.ok(chat[0].content.includes('连续 1 轮'));
  assert.deepEqual(plain(chat.map(m => ({ role: m.role, content: withoutTime(m.content) })).filter(m => !m.content.startsWith('【'))), [
    { role: 'user', content: '1+1=几？' }, { role: 'assistant', content: '2' },
    { role: 'user', content: '好的' }, { role: 'user', content: '2+2=几？' }
  ]);
  assert.equal(chat[4].role, 'assistant');
  assert.ok(chat[4].content.includes('未发送消息的行为记录'));
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
  assert.equal(h.state.wechatTyping.value, false, '新请求仍在决策，不应冒充人物正在打字');
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

const rpItem = (content, index = 0) => ({
  id: `rp-${index}`, ts: index + 1, channel: 'rp', role: 'assistant', content, rpIndex: index
});
const imageItems = (count, prefix) => Array.from({ length: count }, (_, i) => ({
  id: `${prefix}-${i}`, ts: i + 10, channel: 'wechat', role: 'user', type: 'image',
  content: `data:image/png;base64,${prefix}-${i}`
}));

test('多场景RP作为叙述资料进入微信，不再标成角色自己的话或默认亲历', async () => {
  const h = harness();
  h.state.wechatTimeline.value = [rpItem('阿伟在实验室独自修改代码，小A并不在场。', 0),
    rpItem('与此同时，小A和朋友在食堂聊天，尚不知道实验室的事情。', 1)];
  await h.send('吃饭了吗');
  const request = h.requests[0];
  const background = request.messages.find(message => String(message.content).includes('【roleplay 剧情｜'));
  assert.ok(background);
  assert.match(background.content, /可能包含多场景；不是微信消息，也不等于角色亲历/);
  assert.match(background.content, /【RP叙述｜非小A的微信发言】阿伟在实验室/);
  assert.ok(!background.content.includes('你（小A）：阿伟'));
  assert.match(request.messages[0].content, /玩家和其他NPC在别处的行动、未传达的信息及内心不自动成为你的认知/);
});

test('模型判断期间不显示人物正在输入，主动空回也不产生输入提示', async () => {
  const started = defer();
  const response = defer();
  const h = harness(async () => { started.resolve(); return response.promise; });
  const running = h.send('在吗？');
  assert.equal(h.state.isWechatGenerating.value, true);
  assert.equal(h.state.wechatTyping.value, false);
  await started.promise;
  assert.equal(h.state.wechatTyping.value, false);
  assert.equal(h.state.wechatStatusText.value, '');
  assert.equal(h.state.wechatStatusTimer, null);
  assert.ok(h.state.wechatAbortController, '请求仍可中止');
  response.resolve({ content: '{"messages":[]}' });
  await running;
  assert.equal(h.state.wechatTyping.value, false);
  assert.equal(h.state.wechatStatusText.value, '');
  assert.equal(h.state.wechatTimeline.value.length, 1);
});

test('超过微信窗口预算后，最后 RP 处境仍送入模型，保留 30 条预算及时间顺序', async () => {
  const h = harness();
  h.state.wechatTimeline.value = [
    rpItem('早先在画室', 0), ...imageItems(32, 'before'),
    rpItem('你被绑架，手机被收走，尚未获救', 1), ...imageItems(35, 'after')
  ];
  await h.send('还在忙吗？');
  const chat = h.requests[0].messages.slice(1);
  assert.equal(chat.length, 30);
  assert.ok(chat[0].content.includes('尚未获救'));
  assert.ok(!JSON.stringify(chat).includes('早先在画室'));
  assert.ok(Array.isArray(chat[1].content));
  assert.equal(chat.at(-1).content, '还在忙吗？');
  assert.equal(chat.filter(m => typeof m.content === 'string' && m.content.includes('【roleplay 剧情')).length, 1);
  assert.equal(h.state.wechatTimeline.value.at(-1).replyDecision, 'silent');
});

test('未发生新的 RP 事件时，多次空回请求仍携带原处境，不追加虚构恢复事件', async () => {
  const h = harness();
  h.state.wechatTimeline.value = [rpItem('你被绑架，无法接触手机，尚未被解救')];
  for (const message of ['还在忙吗？', '你为什么不回？', '我很担心你']) await h.send(message);
  for (const request of h.requests) {
    assert.ok(request.messages.some(m => m.content.includes('无法接触手机')));
  }
  assert.equal(h.state.wechatTimeline.value.filter(i => i.channel === 'rp').length, 1);
  assert.equal(h.state.wechatTimeline.value.filter(i => i.channel === 'wechat').length, 3);
  assert.equal(h.state.wechatUnansweredCount.value, 0);
});

test('RP 恢复事件在原时间位置送入下一次微信请求，之前的空回不锁死会话', async () => {
  // 模型输出由 fixture 控制；此测试验证事件注入与接续，不评判真实模型的语义判断。
  const h = harness(async (_options, n) => ({ content: n === 1 ? '{"messages":[]}'
    : '{"messages":[{"type":"text","content":"我安全了"}]}' }));
  h.state.wechatTimeline.value = [rpItem('你被绑架，手机被收走，尚未获救', 0)];
  await h.send('还在忙吗？');
  h.state.wechatTimeline.value.push(rpItem('随后你已被解救，取回手机，但依然疲惫', 1));
  await h.send('现在怎么样？');
  const chat = h.requests[1].messages.slice(2);
  assert.deepEqual(plain(chat.map(m => m.role)), ['user', 'user', 'assistant', 'user', 'user']);
  assert.ok(chat[0].content.includes('尚未获救'));
  assert.equal(withoutTime(chat[1].content), '还在忙吗？');
  assert.ok(chat[2].content.includes('未发送消息的行为记录'));
  assert.ok(chat[3].content.includes('已被解救') && chat[3].content.includes('依然疲惫'));
  assert.equal(withoutTime(chat[4].content), '现在怎么样？');
  assert.equal(h.state.wechatTimeline.value.at(-1).content, '我安全了');
});

test('已压缩的 RP 限制由摘要保留，窗口保留规则不会重新注入已覆盖原文', async () => {
  const h = harness();
  h.state.storyRecap.value = { coversThroughTurn: 1, coversWechatCount: 0 };
  h.state.buildConversationTurnSnapshot = () => ({ turns: [{ messageIndexes: [0] }] });
  h.state.buildStoryRecapMessages = () => [{ role: 'user', content: '【前情提要】小A仍被绑架，手机被收走。' }];
  h.state.wechatTimeline.value = [rpItem('被摘要覆盖的 RP 原文', 0), ...imageItems(35, 'covered')];
  await h.send('在吗？');
  const chat = h.requests[0].messages.slice(1);
  assert.equal(chat.length, 31, '30 条历史 + 1 条摘要');
  assert.ok(chat[0].content.includes('仍被绑架'));
  assert.ok(!JSON.stringify(chat).includes('被摘要覆盖的 RP 原文'));
});

test('只开主动微信时，强制策略不会强迫调用；其他工具的强制策略保留', () => {
  const context = vm.createContext({
    window: {}, ACTIVE_TOOL_WECHAT_TYPE: 'wechat_message', ACTIVE_TOOL_WEB_TYPE: 'web_search',
    ACTIVE_TOOL_MAX_AUTO_CONTINUE: 4, isRoleMemoryContextContent: () => false
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/built-in-content.js'), 'utf8'), context);
  context.BUILTIN_PROMPTS = context.window.RPHubBuiltinContent.prompts;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/app/14-tools-runtime.js'), 'utf8'), context);
  let policy = 'force';
  let tools = [{ id: 'tool_wechat', type: 'wechat_message', callName: 'tool_wechat', name: '主动发微信', description: '' }];
  const state = {
    getActiveToolAggressiveness: () => policy, normalizeActiveToolBaseCallName: name => name,
    normalizeActiveTools: () => tools, currentCharacter: { value: { wechatEnabled: true } },
    getActiveToolLatestUserReminder: () => policy === 'force' ? '必须先调用至少 1 个工具' : '按需调用',
    getActiveToolAggressivenessLabel: () => policy === 'force' ? '强制' : '自适应'
  };
  context.window.RPHubAppSections.toolsRuntime(state);
  assert.equal(state.shouldRequireActiveToolCall([]), false);
  assert.equal(state.shouldRequireActiveToolCall(tools), false);
  const prompt = state.buildActiveToolSystemPrompt(tools);
  assert.ok(!prompt.includes('必须先调用至少 1 个工具'));
  assert.ok(prompt.includes('没有条件或意愿时直接继续 RP 正文'));
  assert.ok(prompt.includes('限制尚未解除时，不调用主动微信工具'));
  const messages = [{ role: 'user', content: '她尚未被救出' }];
  state.appendActiveToolReminderToLatestUserMessage(messages);
  assert.ok(!messages[0].content.includes('必须先调用'));
  const web = { type: 'web_search', callName: 'tool_web' };
  tools = [...tools, web];
  assert.equal(state.shouldRequireActiveToolCall(tools), true);
  assert.equal(state.shouldRequireActiveToolCall([web]), true);
  policy = 'adaptive';
  assert.equal(state.shouldRequireActiveToolCall(tools), false);
});

const silenceReply = (reason, awareness, summary) => ({ content: JSON.stringify({
  messages: [], silence: { reason, awareness, summary }
}) });
const behaviorRecords = request => request.messages.filter(m => typeof m.content === 'string' && m.content.startsWith('【未发送消息的行为记录'));

test('空回元数据归一化，限制长度/字段/思考块，非空回复不采纳沉默归因', () => {
  const p = harness().protocol;
  const reply = p.parseReplyResult(silenceReply('upset', 'read', '暂时不想解释').content);
  assert.deepEqual(plain(reply.silence), { reason: 'upset', awareness: 'read', summary: '暂时不想解释' });
  const invalid = p.normalizeSilence({ reason: 'garbage', awareness: 'garbage', summary: '<think>不要记录的推理</think>\n' + '难过'.repeat(80), extra: 'ignored' });
  assert.equal(invalid.reason, 'unknown');
  assert.equal(invalid.awareness, 'unknown');
  assert.equal(invalid.summary.length, 80);
  assert.ok(!invalid.summary.includes('推理'));
  assert.equal(invalid.extra, undefined);
  assert.equal(p.parseReplyResult('{"messages":["嗯"],"silence":{"reason":"upset"}}').silence, undefined);
  assert.deepEqual(plain(p.parseReply(silenceReply('sleeping', 'unseen', '没醒').content)), []);
});

test('两轮赌气后第三轮模型看到各次沉默及真实次数，回复后连续计数归零', async () => {
  const h = harness(async (_options, n) => n < 3 ? silenceReply('upset', 'read', '还在介意争吵，想冷静')
    : { content: '{"messages":[{"content":"我还在生气"}]}' });
  await h.send('怎么啦');
  await h.send('有错的话，我可以认的');
  await h.send('你理理我呗');
  const third = h.requests[2];
  assert.ok(third.messages[1].content.includes('连续 2 轮'));
  assert.ok(third.messages[1].content.includes('已看到内容后未回 2 轮'));
  const records = behaviorRecords(third);
  assert.equal(records.length, 2);
  assert.ok(records[0].content.includes('第 1 次') && records[1].content.includes('第 2 次'));
  assert.ok(records.every(m => m.role === 'assistant' && m.content.includes('当时看到消息内容')));
  const history = third.messages.slice(2);
  assert.deepEqual(plain(history.map(m => m.role)), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(history.at(-1).content, '你理理我呗');
  assert.equal(h.state.wechatTimeline.value.length, 4);
  assert.equal(h.state.buildWechatSilenceState(), null);
  assert.equal(h.state.wechatTimeline.value[0].replySilence.reason, 'upset');
  assert.ok(Number.isFinite(h.state.wechatTimeline.value[0].replySilence.decidedAt));
  assert.ok(h.state.wechatDisplayItems.value.every(i => !String(i.content || '').includes('行为记录')));
});

test('重复嗯嗯保留两次自然收尾记录，第三轮可以回复而非合并成首次确认', async () => {
  const h = harness(async (_options, n) => n < 3 ? silenceReply('topic_closed', 'read', '已确认，暂时没有别的话')
    : { content: '{"messages":[{"content":"怎么发这么多嗯嗯"}]}' });
  for (let i = 0; i < 3; i++) await h.send('嗯嗯');
  assert.equal(behaviorRecords(h.requests[2]).length, 2);
  assert.equal(h.requests[2].messages.filter(m => m.role === 'user' && withoutTime(m.content) === '嗯嗯').length, 3);
  assert.ok(h.requests[2].messages[1].content.includes('话题自然结束'));
  assert.equal(h.state.wechatTimeline.value.at(-1).content, '怎么发这么多嗯嗯');
});

test('睡眠的未感知、仅提示与醒后已读分别保存，不会都变成已读不回', async () => {
  // 这里只验证状态传递。是否真的被铃声吵醒由真实模型结合已知场景判断。
  const responses = [
    silenceReply('sleeping', 'unseen', '还没醒，也没感知到通知'),
    silenceReply('sleeping', 'noticed', '迷糊中听到铃声，没看内容'),
    silenceReply('low_energy', 'read', '被铃声吵醒，看过消息但仍疲惫')
  ];
  const h = harness(async (_options, n) => responses[n - 1] || { content: '{"messages":["你把我吵醒了"]}' });
  for (const message of ['今天xxxx', '我觉得可以xxx', '你睡了吗']) await h.send(message);
  await h.state.closeWechat();
  await h.state.openWechat();
  assert.deepEqual(plain(h.state.wechatTimeline.value.map(i => i.replySilence.awareness)), ['unseen', 'noticed', 'read']);
  await h.send('醒了吗');
  const records = behaviorRecords(h.requests[3]);
  assert.ok(h.requests[3].messages[1].content.includes('已看到内容后未回 1 轮，只感知提示 1 轮'));
  assert.equal(records.length, 3);
  assert.ok(records[0].content.includes('未读消息，也未感知提示'));
  assert.ok(records[1].content.includes('只感知到提示，未读内容'));
  assert.ok(records[2].content.includes('当时看到消息内容'));
  assert.equal(h.state.wechatTimeline.value.at(-1).content, '你把我吵醒了');
});

test('连发气泡只算一轮沉默，网络失败不会增加连续次数', async () => {
  const h = harness(async (_options, n) => {
    if (n === 2) throw new Error('network failed');
    return silenceReply('busy', 'unseen', '还在开会');
  });
  h.state.wechatBurstMode.value = true;
  for (const message of ['第一句', '第二句', '第三句']) await h.send(message);
  await h.state.requestWechatReplyNow();
  assert.ok(h.state.buildWechatSilenceState().content.includes('连续 1 轮'));
  await h.send('第四句');
  await h.state.requestWechatReplyNow();
  assert.ok(h.state.buildWechatSilenceState().content.includes('连续 1 轮'));
  assert.equal(h.state.wechatTimeline.value.at(-1).replySilence, undefined);
  await h.state.requestWechatReplyNow();
  assert.ok(h.state.buildWechatSilenceState().content.includes('连续 2 轮'));
  assert.equal(h.state.wechatTimeline.value.filter(i => i.replyDecision === 'silent').length, 2);
});

test('旧记录保持未知，摘要与历史裁剪后仍保留当前真实连续次数和最近原因', async () => {
  const h = harness();
  h.state.wechatTimeline.value = [
    { id: 'legacy', channel: 'wechat', role: 'user', type: 'text', content: '旧消息', replyDecision: 'silent' },
    { id: 'recent', channel: 'wechat', role: 'user', type: 'text', content: '上一轮', replyDecision: 'silent',
      replySilence: { reason: 'upset', awareness: 'read', summary: '仍在赌气' } },
    ...imageItems(35, 'after-silence')
  ];
  assert.ok(h.protocol.describeSilence(h.state.wechatTimeline.value[0].replySilence).includes('原因未记录'));
  h.state.storyRecap.value = { coversThroughTurn: 0, coversWechatCount: 2 };
  h.state.buildConversationTurnSnapshot = () => ({ turns: [] });
  h.state.buildStoryRecapMessages = () => [{ role: 'user', content: '【前情提要】此前两轮未发送消息' }];
  await h.send('新消息');
  const chat = h.requests[0].messages;
  assert.ok(chat[1].content.includes('前情提要'));
  assert.ok(chat[2].content.includes('连续 2 轮') && chat[2].content.includes('仍在赌气'));
  assert.equal(behaviorRecords(h.requests[0]).length, 0, '已覆盖的逐轮记录不重新注入');
  assert.equal(chat.at(-1).content, '新消息');
  assert.equal(h.state.wechatTimeline.value[0].replySilence, undefined, '不反推旧记录原因');
});

test('RP 回灌、摘要素材和保留原文携带行为记录，消息覆盖计数不增加', async () => {
  const h = harness(async () => silenceReply('sleeping', 'unseen', '手机静音，没醒'));
  await h.send('睡了吗');
  await h.send('明天见');
  const rp = h.state.appendWechatDigestToMessages([]);
  assert.ok(rp[0].content.includes('小A此轮未发微信'));
  assert.ok(rp[0].content.includes('手机静音') && rp[0].content.includes('未读消息，也未感知提示'));
  assert.ok(rp[0].content.includes('不能把对应正文当成人物已知'));
  assert.ok(rp[0].content.includes('不能覆盖后来被叫醒、获救等明确剧情变化'));
  assert.ok(!rp[0].content.includes('作为你已知的背景'));
  await h.loadRecap();
  const material = h.state.buildRecapMaterial(0, 2);
  assert.equal(material.length, 2, '内部行为附在原消息上，不新增素材消息计数');
  assert.ok(material.every(line => line.includes('未发送消息的行为记录')));
  h.state.storyRecap.value = { text: '摘要', coversThroughTurn: 0, coversWechatCount: 2, keepWechatCount: 2 };
  assert.ok(h.state.buildRecapRecentWechatText().includes('手机静音'));
  assert.equal(h.state.computeRecapCoverage().coversWechatCount, 2);
});

test('切换分支后连续沉默和归因不继承旧 scope', async () => {
  const h = harness(async () => silenceReply('upset', 'read', '在赌气'));
  await h.send('怎么啦');
  assert.ok(h.state.buildWechatSilenceState().content.includes('连续 1 轮'));
  h.setScope('branch-b');
  h.state.wechatTimeline.value = [];
  assert.equal(h.state.buildWechatSilenceState(), null);
  await h.send('新分支的消息');
  assert.equal(h.requests[1].messages.slice(1).some(m => m.content.startsWith('【此前连续沉默')), false);
  assert.ok(h.state.buildWechatSilenceState().content.includes('连续 1 轮'));
  assert.equal(h.stored.get('wechat_timeline/branch-a')[0].replySilence.summary, '在赌气');
});
