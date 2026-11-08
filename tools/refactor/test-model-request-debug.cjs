const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../assets/js/api-utils.js'), 'utf8');
function harness(respond) {
  const events = [], logs = [], requests = [];
  const c = vm.createContext({ window: { RPHubUtils: { extractApiErrorMessage: data => data?.error?.message,
    formatApiErrorMessage: status => 'HTTP ' + status, getApiUsagePayload: data => data?.usage },
    RPHubCardUtils: { extractNativeReasoning: () => '', isNativeReasoningPart: () => false } },
    AbortController, setTimeout, clearTimeout, setInterval, clearInterval, TextDecoder,
    console: { groupCollapsed() {}, groupEnd() {}, info: (...args) => { events.push('console'); logs.push(args); } },
    fetch: async (url, options) => { events.push('fetch'); requests.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify(respond?.(requests.length) || { choices: [{ message: { content: '好的' }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } }); } });
  vm.runInContext(source, c);
  return { c, api: c.window.RPHubApiClient, events, logs, requests };
}
const options = () => ({ url: 'https://mock.local/v1/chat/completions', apiKey: 'fixture-secret', model: 'mock', temperature: 0.2,
  logRequest: true, messages: [{ role: 'user', content: '原文\n第二行' }, { role: 'assistant', tool_calls: [{ id: 'x', type: 'function', function: { name: 'tool_search_history', arguments: '{"query":"钥匙"}' } }] }, { role: 'tool', tool_call_id: 'x', content: '{"status":"empty"}' }] });
test('每次发送前输出与请求体一致的messages固定快照，保留换行/原生工具签名，不输出密钥', async () => {
  const h = harness(), input = options(); await h.api.requestChatCompletion(input);
  assert.deepEqual(h.events, ['console', 'fetch']);
  const logged = h.logs[0][1]; assert.deepEqual(JSON.parse(logged.messagesJSON), h.requests[0].body.messages);
  assert.equal(logged.messages[0].content, '原文\n第二行'); assert.equal(logged.messages[2].tool_call_id, 'x');
  input.messages[0].content = '后来编辑'; assert.equal(logged.messages[0].content, '原文\n第二行');
  assert.ok(!JSON.stringify(h.logs).includes('fixture-secret'));
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
