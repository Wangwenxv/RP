const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../assets/js/api-utils.js'), 'utf8');
function harness(respond) {
  const events = [], logs = [], requests = [];
  const c = vm.createContext({ window: { RPHubUtils: { extractApiErrorMessage: data => data?.error?.message,
    formatApiErrorMessage: status => 'HTTP ' + status, getApiUsagePayload: data => data?.usage },
    RPHubCardUtils: { extractNativeReasoning: value => value?.reasoning_content || value?.reasoning || '', isNativeReasoningPart: () => false } },
    AbortController, setTimeout, clearTimeout, setInterval, clearInterval, TextDecoder,
    console: { groupCollapsed() {}, groupEnd() {}, info: (...args) => { events.push('console'); logs.push(args); } },
    fetch: async (url, options) => { events.push('fetch'); requests.push({ url, options, body: JSON.parse(options.body) });
      const response = await respond?.(requests.length);
      return response instanceof Response ? response : new Response(JSON.stringify(response || { choices: [{ message: { content: '好的' }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } }); } });
  vm.runInContext(source, c);
  return { c, api: c.window.RPHubApiClient, events, logs, requests };
}
const options = () => ({ url: 'https://mock.local/v1/chat/completions', apiKey: 'fixture-secret', model: 'mock', temperature: 0.2,
  logRequest: true, messages: [{ role: 'user', content: '原文\n第二行' }, { role: 'assistant', tool_calls: [{ id: 'x', type: 'function', function: { name: 'tool_search_history', arguments: '{"query":"钥匙"}' } }] }, { role: 'tool', tool_call_id: 'x', content: '{"status":"empty"}' }] });
test('每次发送前输出与请求体一致的messages固定快照，保留换行/原生工具签名，不输出密钥', async () => {
  const h = harness(), input = options(); await h.api.requestChatCompletion(input);
  assert.deepEqual(h.events, ['console', 'console', 'fetch']);
  const logged = h.logs.find(args => args[0].startsWith('[模型请求]'))[1]; assert.deepEqual(JSON.parse(logged.messagesJSON), h.requests[0].body.messages);
  assert.equal(logged.messages[0].content, '原文\n第二行'); assert.equal(logged.messages[2].tool_call_id, 'x');
  input.messages[0].content = '后来编辑'; assert.equal(logged.messages[0].content, '原文\n第二行');
  assert.ok(!JSON.stringify(h.logs).includes('fixture-secret'));
});

test('请求摘要只含图片数量和工具名，可区分新图与参考，不复制像素或消息内容', async () => {
  const h = harness(), input = options();
  input.messages.push({ role: 'user', content: [
    { type: 'text', text: '【本轮新图 #new】private-caption' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,private-pixels' } },
    { type: 'text', text: '【人物参考 #ref】' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,reference-pixels' } },
    { type: 'text', text: '【本轮对照旧图 #old｜角色刚才发送】' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,old-pixels' } },
    { type: 'text', text: '【本轮对照旧图 #missing 读取失败】' },
    { type: 'text', text: '【本轮追问旧图 #review｜第1张】' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,review-pixels' } },
    { type: 'text', text: '【本轮追问旧图 #missing 读取失败】' }
  ] });
  await h.api.requestChatCompletion(input);
  const line = h.logs.find(args => args[0].startsWith('[模型请求摘要]'))[0];
  const summary = JSON.parse(line.slice('[模型请求摘要] '.length));
  assert.equal(summary.images, 4); assert.equal(summary.freshImageLabels, 1); assert.equal(summary.referenceLabels, 1); assert.equal(summary.comparisonImageLabels, 1);
  assert.equal(summary.followupImageLabels, 1);
  assert.deepEqual(summary.toolCalls, ['tool_search_history']); assert.equal(summary.toolResults, 1);
  assert.doesNotMatch(line, /private|pixels|base64|fixture-secret/);
});

test('独立核对摘要区分逐图输入与人物参考，不复制核对内容', async () => {
  const h = harness(), input = options(); input.requestType = '微信独立画面核对';
  input.messages = [{ role: 'user', content: [
    { type: 'text', text: '【核对图片 #new｜玩家新图】' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,private-pixels' } },
    { type: 'text', text: '【核对图片 #reference:a｜人物造型参考】' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,private-ref' } }
  ] }];
  await h.api.requestChatCompletion(input);
  const line = h.logs.find(args => args[0].startsWith('[模型请求摘要]'))[0], summary = JSON.parse(line.slice('[模型请求摘要] '.length));
  assert.equal(summary.visualCheckImageLabels, 2); assert.equal(summary.visualCheckReferenceLabels, 1);
  assert.equal(summary.request, '微信独立画面核对'); assert.doesNotMatch(line, /private|pixels|base64/);
});
test('关闭请求调试不输出；自动重试的每次实际发送都打印并标记尝试次数', async () => {
  const off = harness(); await off.api.requestChatCompletion({ ...options(), logRequest: false }); assert.equal(off.logs.length, 0);
  const retry = harness(count => ({ choices: [{ message: { content: count === 1 ? '' : '成功' }, finish_reason: 'stop' }] }));
  await retry.api.requestChatCompletion({ ...options(), replyInTool: true });
  const logs = retry.logs.filter(args => String(args[0]).startsWith('[模型请求]'));
  assert.equal(logs.length, 2); assert.match(logs[0][0], /尝试 1/); assert.match(logs[1][0], /尝试 2/);
});
test('调试console报错不会阻断模型请求，日志区分总结类型', async () => {
  const h = harness(); h.c.console.info = () => { throw new Error('console hook'); };
  assert.equal((await h.api.requestChatCompletion(options())).content, '好的');
  const labelled = harness(); await labelled.api.requestChatCompletion({ ...options(), requestType: 'RP/微信前情提要' });
  assert.match(labelled.logs[0][0], /前情提要/);
});

const summaryOf = h => JSON.parse(h.logs.find(args => String(args[0]).startsWith('[模型输出摘要]'))[0].slice('[模型输出摘要] '.length));
function sse(events) {
  const bytes = new TextEncoder().encode(events.map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n');
  return new Response(new ReadableStream({ start(controller) {
    // Split UTF-8 characters and SSE boundaries to exercise the wire parser.
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('流式思考、工具参数与实际请求按同一ID配对，正文不混入思考', async () => {
  const h = harness(() => sse([
    { choices: [{ delta: { role: 'assistant', reasoning_content: '先检查' } }] },
    { choices: [{ delta: { reasoning_content: '资料。', tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'tool_read', arguments: '{"id":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"doc"}' } }] }, finish_reason: 'tool_calls' }] }
  ]));
  const deltas = [];
  const result = await h.api.requestChatCompletion({ ...options(), requestType: '微信工具续写', logResponse: true, stream: true, onDelta: delta => deltas.push(delta) });
  const summary = summaryOf(h), request = JSON.parse(h.logs[0][0].slice('[模型请求摘要] '.length));
  assert.equal(result.reasoning, '先检查资料。'); assert.equal(result.content, '');
  assert.equal(deltas.map(delta => delta.reasoning).join(''), result.reasoning);
  assert.equal(summary.requestId, request.requestId); assert.equal(summary.request, '微信工具续写');
  assert.equal(summary.reasoningStatus, 'returned'); assert.equal(summary.reasoningCharacters, 6);
  assert.equal(summary.receivedEventStream, true); assert.equal(summary.payloadCount, 3);
  assert.deepEqual(summary.toolCalls, [{ id: 'read-1', name: 'tool_read', arguments: '{"id":"doc"}' }]);
  const full = h.logs.find(args => args[0] === '[模型输出][最新一次]')[1];
  assert.equal(full.推理文本, result.reasoning);
  assert.equal(JSON.parse(full.响应体).choices[0].message.reasoning_content, result.reasoning);
  const readable = h.logs.find(args => args[0].startsWith('[模型输出原文]'))[0];
  assert.deepEqual(JSON.parse(readable.slice('[模型输出原文] '.length)), JSON.parse(JSON.stringify(full)));
  const events = JSON.parse(h.logs.find(args => args[0].startsWith('[模型流式事件]'))[0].slice('[模型流式事件] '.length));
  assert.equal(events.requestId, request.requestId);
  assert.equal(events.events.length, 3);
  assert.equal(events.events[1].choices[0].delta.reasoning_content, '资料。');
  assert.equal(events.events[2].choices[0].delta.tool_calls[0].function.arguments, '"doc"}');
  assert.ok(h.logs.some(args => args[0].startsWith('[模型思考开始]')));
  assert.doesNotMatch(JSON.stringify(h.logs), /fixture-secret/);
  assert.equal(h.requests[0].body.requestDebugId, undefined);
});

test('服务未返回推理时明确记为not_returned，不把普通正文当成思考', async () => {
  const h = harness(() => sse([{ choices: [{ delta: { content: '好的' }, finish_reason: 'stop' }] }]));
  const result = await h.api.requestChatCompletion({ ...options(), logResponse: true, stream: true });
  const summary = summaryOf(h);
  assert.equal(summary.reasoningStatus, 'not_returned'); assert.equal(summary.reasoningCharacters, 0);
  assert.equal(summary.firstReasoningMs, null); assert.equal(summary.contentCharacters, 2);
  assert.equal(result.reasoning, ''); assert.equal(result.content, '好的');
  assert.ok(!h.logs.some(args => args[0].startsWith('[模型思考开始]')));
});

test('非流式推理和伪装JSON的SSE均保留接口实际返回，行内thinking另行标记', async () => {
  const h = harness(() => ({ choices: [{ message: { reasoning_content: '核查资料', content: '<thinking>可见标签</thinking>好的' }, finish_reason: 'stop' }] }));
  await h.api.requestChatCompletion({ ...options(), logResponse: true, stream: true });
  const summary = summaryOf(h);
  assert.equal(summary.requestedStream, true); assert.equal(summary.receivedEventStream, false);
  assert.equal(summary.reasoningCharacters, 4); assert.equal(summary.inlineThinkingPresent, true);
  const disguised = harness(async () => new Response(await sse([{ choices: [{ delta: { reasoning_content: '检查' }, finish_reason: 'stop' }] }]).text(), { headers: { 'Content-Type': 'application/json' } }));
  await disguised.api.requestChatCompletion({ ...options(), logResponse: true, stream: true });
  assert.equal(summaryOf(disguised).receivedEventStream, true);
});

test('中断保留已返回推理并标记失败；响应日志钩子异常不改变请求结果', async () => {
  let reads = 0;
  const h = harness(() => new Response(new ReadableStream({ pull(controller) {
    if (!reads++) controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"已返回片段"}}]}\n\n'));
    else controller.error(new DOMException('已停止', 'AbortError'));
  } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(h.api.requestChatCompletion({ ...options(), logResponse: true, stream: true }), { name: 'AbortError' });
  assert.equal(summaryOf(h).status, 'failed'); assert.equal(summaryOf(h).reasoningCharacters, 5);
  const safe = harness(); safe.c.console.info = () => { throw new Error('debug hook'); };
  assert.equal((await safe.api.requestChatCompletion({ ...options(), logResponse: true })).content, '好的');
});

test('关闭输出调试不新增响应日志；请求摘要提供大小、工具选择与温度而不复制内容', async () => {
  const h = harness(); await h.api.requestChatCompletion(options());
  assert.ok(!h.logs.some(args => args[0].startsWith('[模型输出')));
  assert.ok(!h.logs.some(args => args[0].startsWith('[模型流式事件]')));
  const summary = JSON.parse(h.logs[0][0].slice('[模型请求摘要] '.length));
  assert.equal(summary.messageCount, 3); assert.equal(summary.temperature, 0.2);
  assert.ok(summary.textCharacters > 0); assert.deepEqual(summary.availableTools, []);
  assert.equal(summary.toolChoice, null); assert.doesNotMatch(h.logs[0][0], /钥匙|原文|fixture-secret/);
});
