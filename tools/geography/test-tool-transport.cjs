const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function harness(reply) {
    const requests = [];
    const ctx = vm.createContext({ window: {}, console: { ...console, info() {} }, Response, AbortController, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval,
        fetch: async (url, options) => { requests.push(JSON.parse(options.body)); return reply instanceof Response ? reply : new Response(JSON.stringify({ choices: [{ message: reply, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } }); } });
    for (const name of ['built-in-content.js', 'core-utils.js', 'api-utils.js']) vm.runInContext(fs.readFileSync(path.join(root, 'assets/js', name), 'utf8'), ctx);
    return { requests, request: opts => ctx.window.RPHubApiClient.requestChatCompletion({ url: 'http://fixture/v1/chat/completions', apiKey: 'fixture', model: 'mock', messages: [], tools: [{ type: 'function', function: { name: 'tool_geo', parameters: {} } }], ...opts }) };
}
test('一次响应三个业务调用完整保留ID/参数/签名，发送parallel_tool_calls:true', async () => {
    const h = harness({ role: 'assistant', content: '', reasoning_content: '保留签名的推理字段', tool_calls: [call('a', 'tool_geo', { operation: 'place', query: '风采园' }), call('b', 'tool_geo', { operation: 'status' }), call('c', 'tool_geo', { operation: 'route', from: '13栋', to: '实验楼A区' })] });
    const r = await h.request({ parallelTools: true });
    assert.equal(h.requests[0].parallel_tool_calls, true); assert.deepEqual(JSON.parse(JSON.stringify(r.toolCalls.map(c => c.id))), ['a', 'b', 'c']);
    assert.equal(r.assistantMessage.reasoning_content, '保留签名的推理字段'); assert.equal(JSON.parse(r.toolCalls[0].function.arguments).query, '风采园');
});
test('输出回复工具存在时关闭并行；强制业务阶段无回复工具时可并行', async () => {
    const h = harness({ role: 'assistant', content: '', tool_calls: [call('reply', 'output_reply', { content: '正常回复' })] });
    const r = await h.request({ parallelTools: true, replyInTool: true });
    assert.equal(h.requests[0].parallel_tool_calls, false); assert.equal(r.content, '正常回复');
    const business = harness({ role: 'assistant', content: '', tool_calls: [call('a', 'tool_geo', { operation: 'status' }), call('b', 'tool_geo', { operation: 'place', query: '三饭' })] });
    await business.request({ parallelTools: true, replyInTool: true, requireTool: true });
    assert.equal(business.requests[0].parallel_tool_calls, true); assert.ok(!business.requests[0].tools.some(t => t.function.name === 'output_reply'));
});
test('其它模型用途没有主动启用时保持原并行选项', async () => {
    const h = harness({ role: 'assistant', content: '正常回复' }); await h.request({}); assert.equal(h.requests[0].parallel_tool_calls, false);
});
test('SSE交错到达的多个工具参数正确组装并按index配对', async () => {
    const chunks = [
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'tool_geo', arguments: '{"operation":' } }, { index: 0, id: 'a', type: 'function', function: { name: 'tool_geo', arguments: '{"operation":"place",' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"query":"风采园"}' } }, { index: 1, function: { arguments: '"status"}' } }] }, finish_reason: 'tool_calls' }] }
    ];
    const stream = chunks.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
    const h = harness(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    const r = await h.request({ parallelTools: true, stream: true });
    assert.equal(r.toolCalls[0].id, 'a'); assert.equal(r.toolCalls[1].id, 'b'); assert.equal(JSON.parse(r.toolCalls[0].function.arguments).query, '风采园'); assert.equal(JSON.parse(r.toolCalls[1].function.arguments).operation, 'status');
});
