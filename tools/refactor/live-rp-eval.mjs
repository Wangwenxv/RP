// 隔离真实模型评测：凭据只从调用参数/环境变量读取，不写入请求证据，不落真实微信记录。
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
async function geography() {
  const context = vm.createContext({ window: {}, console });
  for (const file of ['geography.js', 'world-data.js']) {
    vm.runInContext(await fs.readFile(path.join(ROOT, 'assets/js', file), 'utf8'), context);
  }
  return { api: context.window.RPHubGeography, world: context.window.RPHubWorlds['jiangnan-south-campus'] };
}
async function runPool({ tasks, apiKey, baseUrl, outDir, concurrency = 3, maxTokens = 4096, maxRetries = 0, onComplete = () => {} }) {
  if (!apiKey || !baseUrl || !outDir) throw new Error('需要 apiKey、baseUrl 和 outDir');
  await fs.mkdir(outDir, { recursive: true });
  const geo = await geography(), queue = [...tasks], results = [];
  let consecutiveAuthErrors = 0, stopped = false;
  async function run(task) {
    if (!/^[\w-]+$/.test(task.id)) throw new Error('评测 ID 仅允许字母、数字、下划线和连字符');
    const request = plain(task.request);
    request.model ||= 'qwen3.7-plus'; request.temperature ??= 1;
    request.max_tokens = task.maxTokens || maxTokens; request.stream = false;
    // 内部来源只用于工程组装，不发送到兼容 API。
    request.messages = request.messages.map(({ role, name, content, tool_calls, tool_call_id,
      reasoning_content, reasoning, reasoning_details, extra_content }) => ({ role, content,
      ...(name ? { name } : {}), ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}),
      ...(reasoning_content ? { reasoning_content } : {}), ...(reasoning ? { reasoning } : {}),
      ...(reasoning_details ? { reasoning_details } : {}), ...(extra_content ? { extra_content } : {}) }));
    const record = { id: task.id, startedAt: new Date().toISOString(), request: plain(request), requestHash: hash(request),
      responses: [], attempts: [], toolResults: [], isolatedWechat: true };
    try {
      for (let round = 0; round < 4; round++) {
        let response, raw;
        for (let attempt = 0; attempt <= Math.min(2, maxRetries); attempt++) {
          response = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
            body: JSON.stringify(request), signal: AbortSignal.timeout(180000)
          });
          raw = await response.text();
          record.attempts.push({ round, attempt, status: response.status,
            ...(response.ok ? {} : { error: raw.slice(0, 1200).split(apiKey).join('[REDACTED]') }) });
          if (response.ok || ![402, 408, 429, 500, 502, 503, 504].includes(response.status)) break;
          if (attempt < Math.min(2, maxRetries)) await new Promise(resolve => setTimeout(resolve, 2000));
        }
        if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + raw.slice(0, 1200));
        const parsed = JSON.parse(raw), choice = parsed.choices?.[0], message = choice?.message;
        if (!message) throw new Error('服务未返回 choices.message');
        record.responses.push(parsed);
        if (choice.finish_reason === 'length') { record.outcome = 'truncated'; break; }
        const calls = message.tool_calls || [];
        if (!calls.length) { record.outcome = 'text'; break; }
        const contacts = calls.filter(call => call.function.name === 'tool_wechat');
        if (contacts.length) {
          record.outcome = contacts.length === 1 ? 'contact' : 'multiple_contacts';
          record.contact = { arguments: JSON.parse(contacts[0].function.arguments), callId: contacts[0].id, simulatedQueue: true };
          break; // 模拟角色消息排队后立即交回玩家，不虚构玩家回应，也不自动请求续写。
        }
        request.messages.push(message);
        for (const call of calls) {
          const args = JSON.parse(call.function.arguments);
          // 当前明确玩家输入定位；无法从混合档案还原的位置保持未知，不伪造定位。
          const evidence = request.messages.filter(item => item.role === 'user').slice(-1);
          const result = call.function.name === 'tool_geo'
            ? plain(geo.api.execute(geo.world, geo.api.project(geo.world, evidence, task.bindings || {}), args))
            : { status: 'unavailable', reason: '隔离评测未提供此工具执行器' };
          record.toolResults.push({ name: call.function.name, args, result });
          request.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
        if (round === 3) record.outcome = 'tool_round_limit';
      }
    } catch (error) {
      record.outcome = 'error'; record.error = String(error?.message || error).split(apiKey).join('[REDACTED]');
    }
    record.endedAt = new Date().toISOString();
    record.elapsedSeconds = (Date.parse(record.endedAt) - Date.parse(record.startedAt)) / 1000;
    if (/^HTTP (401|402|403)\b/.test(record.error || '')) consecutiveAuthErrors++;
    else if (record.responses.length) consecutiveAuthErrors = 0;
    if (consecutiveAuthErrors >= 3) stopped = true;
    await fs.writeFile(path.join(outDir, task.id + '.json'), JSON.stringify(record, null, 2));
    results.push(record); onComplete({ id: task.id, outcome: record.outcome, elapsedSeconds: record.elapsedSeconds });
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(3, concurrency)) }, async () => {
    while (queue.length && !stopped) await run(queue.shift());
  }));
  const summary = { completed: results.length, skipped: queue.map(task => task.id), stoppedAfterAuthErrors: stopped,
    outcomes: results.map(({ id, outcome, elapsedSeconds, error }) => ({ id, outcome, elapsedSeconds, error })) };
  await fs.writeFile(path.join(outDir, 'run-summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}
export { runPool };
if (typeof process !== 'undefined' && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) (async () => {
  const [requestFile, outDir, rounds = '4', concurrency = '3'] = process.argv.slice(2);
  if (!requestFile || !outDir) throw new Error('用法：node tools/refactor/live-rp-eval.mjs 请求JSON 输出目录 [次数=4] [并发=3]；使用 RP_TEST_API_KEY / RP_TEST_BASE_URL 环境变量');
  const source = JSON.parse(await fs.readFile(requestFile, 'utf8'));
  const request = source.request || { model: source.model || 'qwen3.7-plus', temperature: source.temperature ?? 1,
    messages: source.messages || source, ...(source.tools ? { tools: source.tools, tool_choice: 'auto' } : {}) };
  const tasks = Array.from({ length: Math.max(1, Math.min(20, Number(rounds) || 4)) }, (_, i) => ({ id: 'repeat-' + (i + 1), request }));
  const summary = await runPool({ tasks, apiKey: process.env.RP_TEST_API_KEY, baseUrl: process.env.RP_TEST_BASE_URL,
    outDir: path.resolve(outDir), concurrency: Number(concurrency), onComplete: result => console.log(JSON.stringify(result)) });
  console.log(JSON.stringify(summary));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
