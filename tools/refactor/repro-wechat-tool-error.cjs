// 复现：模型主动调用 tool_wechat 但参数 JSON 不合法（被截断）时，会话是否卡死。
// 只跑一条链路：RP 首轮 → 模型返回坏参数工具调用 → 续写 → 收尾，全程记录忙状态。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 18131;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const SCENARIO = process.env.SCENARIO || 'once'; // once | always
const CONT = process.env.CONT || 'text'; // text | empty | error400

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => {
    const t = msg.text();
    if (msg.type() === 'error' && !/Failed to load resource|gstatic|tailwindcss|nai\.sta1n|favicon|mock\.local/.test(t)) {
      errors.push('[console.error] ' + t.slice(0, 300));
    }
  });
  page.on('pageerror', err => errors.push('[pageerror] ' + err.message));

  await page.addInitScript(() => {
    window.marked = window.marked || { use() { }, parse: (t) => String(t) };
    window.DOMPurify = window.DOMPurify || { sanitize: (t) => String(t) };
    let _vue;
    Object.defineProperty(window, 'Vue', {
      configurable: true,
      get() { return _vue; },
      set(v) {
        _vue = v;
        if (v && v.createApp && !v.createApp.__wrapped) {
          const orig = v.createApp;
          const wrapped = function (...args) {
            const app = orig.apply(this, args);
            const mount = app.mount;
            app.mount = function (...m) {
              const root = mount.apply(this, m);
              window.__APP_PROXY__ = root;
              return root;
            };
            return app;
          };
          wrapped.__wrapped = true;
          v.createApp = wrapped;
        }
      }
    });
  });

  const captured = [];
  let toolCallCount = 0;
  const SSE = process.env.SSE === '1';
  const sseBody = (events) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  const textEvents = (text) => ([
    { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  ]);
  // 参数分两片到达且被截断（模拟 max_tokens 砍在 JSON 中间）
  const badToolEvents = (n) => ([
    { choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: [{ index: 0, id: 'call_wx_bad_' + n, type: 'function', function: { name: 'tool_wechat', arguments: '{"content":"睡' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '了吗","reason":"想单独说' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }
  ]);
  const reply = async (route, text) => {
    if (SSE) {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseBody(textEvents(text)) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    });
  };
  await page.route('**/chat/completions', async route => {
    let body = null;
    try { body = route.request().postDataJSON(); } catch (_) { }
    const msgs = body?.messages || [];
    const sysContent = String(msgs[0]?.content || '');
    const isWechat = sysContent.includes('你只能输出一个 JSON 对象');
    const isRecap = sysContent.includes('上下文压缩器');
    const hasToolResult = msgs.some(m => m && m.role === 'tool');
    const tools = (Array.isArray(body?.tools) ? body.tools : []).map(t => t?.function?.name);
    const toolMsgs = msgs.filter(m => m && m.role === 'tool').map(m => ({ id: m.tool_call_id, content: String(m.content || '').slice(0, 120) }));
    const asstToolCalls = msgs.filter(m => m && m.role === 'assistant' && m.tool_calls).map(m => m.tool_calls.map(c => ({ id: c.id, name: c.function?.name, args: c.function?.arguments })));
    captured.push({ isWechat, isRecap, hasToolResult, tools, roles: msgs.map(m => m.role).join(','), toolMsgs, asstToolCalls });

    const content = isRecap
      ? '测试前情提要。'
      : isWechat ? JSON.stringify({ messages: [{ type: 'text', content: '在的' }] })
        : CONT === 'empty' ? '' : '（继续画着）……嗯，那你歇会儿。';
    if (CONT === 'error400' && hasToolResult && !isWechat && !isRecap) {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'messages: tool_call_id not found' } }) });
      return;
    }

    // 微信侧 / 压缩侧：正常返回
    if (!isWechat && !isRecap) {
      const shouldFail = tools.includes('tool_wechat')
        && (SCENARIO === 'always' ? true : !hasToolResult);
      if (shouldFail) {
        toolCallCount++;
        if (SSE) {
          await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseBody(badToolEvents(toolCallCount)) });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{
                  id: 'call_wx_bad_' + toolCallCount, type: 'function',
                  // 故意截断：不是合法 JSON（模拟 max_tokens 截断 / 模型漏括号）
                  function: { name: 'tool_wechat', arguments: '{"content":"睡了吗","reason":"想单独说' }
                }]
              },
              finish_reason: 'length'
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          })
        });
        return;
      }
    }
    await reply(route, content);
  });

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 30000 });
  let rootOk = false;
  for (let round = 0; round < 4 && !rootOk; round++) {
    for (let i = 0; i < 60; i++) {
      rootOk = await page.evaluate(() => {
        const r = window.__APP_PROXY__;
        return !!(r && Array.isArray(r.characters) && typeof r.openWechat === 'function');
      });
      if (rootOk) break;
      await page.waitForTimeout(250);
    }
    if (!rootOk) await page.reload({ waitUntil: 'load' });
  }
  if (!rootOk) { console.log('根 proxy 未就绪'); process.exit(1); }

  const out = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.user.name = '阿伟';
    root.characters.push({
      name: '小W', description: '主动微信', personality: 'x', first_mes: '开场W。',
      avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      uuid: 'test-uuid-bad', createdAt: Date.now(),
      wechatEnabled: true, wechatPeerName: '小W', wechatSpeed: 'fast', wechatStickerRate: 'off'
    });
    await root.selectCharacter(root.characters.length - 1, false, { silent: true });
    root.settings.apiUrl = 'https://mock.local/v1';
    root.settings.apiKey = 'k';
    root.settings.model = 'mock-model';
    const tool = root.activeTools.find(t => t.id === 'tool_wechat');
    if (tool) tool.enabled = true;

    const snap = (tag) => ({
      tag,
      isGenerating: root.isGenerating,
      isRemoteGenerating: root.isRemoteGenerating,
      isThinking: root.isThinking,
      isReceiving: root.isReceiving,
      busy: root.isConversationBusy,
      inlineWork: root.hasActiveToolInlineWork,
      queueRunning: root.activeToolQueueRunning,
      handoffPending: root.activeToolHandoffPending,
      continuationPending: root.activeToolContinuationPending,
      continuationMsgId: root.activeToolContinuationMessageId,
      panel: root.showWechatPanel
    });
    const samples = [];
    root.userInput = '触发微信：今天先这样吧';
    const sendPromise = root.sendMessage();
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const s = snap('t+' + (Date.now() - start));
      if (!samples.length || JSON.stringify({ ...s, tag: 0 }) !== JSON.stringify({ ...samples[samples.length - 1], tag: 0 })) samples.push(s);
      if (!s.busy && Date.now() - start > 2000) break;
      await new Promise(r => setTimeout(r, 100));
    }
    await sendPromise;
    await new Promise(r => setTimeout(r, 500));
    const final = snap('final');
    const last = root.chatHistory[root.chatHistory.length - 1];
    return {
      samples,
      final,
      historyLen: root.chatHistory.length,
      lastRole: last?.role,
      lastContent: String(last?.content || '').slice(0, 120),
      lastError: last?.responseError || null,
      toolCalls: (last?.toolCalls || []).map(t => ({ id: t.toolId, status: t.status, err: t.error, query: t.query, resultText: String(t.resultText || '').slice(0, 160) })),
      pendingWx: (root.pendingActiveWechatMessages || []).slice(),
      activeToolMessages: (root.activeToolMessages || []).map(m => m.role),
      sendBtnVisible: !!document.querySelector('.chat-view-root button[title="发送"]') || null,
      busyText: String(document.querySelector('.chat-view-root')?.innerText || '').includes('正在输入') || String(document.querySelector('.chat-view-root')?.innerText || '').includes('思考')
    };
  });

  console.log('SCENARIO:', SCENARIO, 'CONT:', CONT, 'SSE:', SSE);
  console.log('sendMessage 返回后状态:', JSON.stringify(out.final, null, 2));
  console.log('历史条数:', out.historyLen, '最后一条:', out.lastRole, JSON.stringify(out.lastContent), 'error=', out.lastError);
  console.log('工具调用:', JSON.stringify(out.toolCalls, null, 2));
  console.log('待发微信队列:', JSON.stringify(out.pendingWx));
  console.log('activeToolMessages:', JSON.stringify(out.activeToolMessages));
  console.log('忙状态采样（去重）:');
  out.samples.forEach(s => console.log('  ', JSON.stringify(s)));
  console.log('请求次数:', captured.length, '工具调用返回次数:', toolCallCount);
  console.log('逐次请求（看模型是否收到工具结果）:');
  captured.forEach((c, i) => {
    console.log(`  #${i} wechat=${c.isWechat} recap=${c.isRecap} roles=[${c.roles}] tools=[${c.tools.join(',')}]`);
    if (c.toolMsgs.length) console.log('     tool消息:', JSON.stringify(c.toolMsgs));
    if (c.asstToolCalls.length) console.log('     assistant.tool_calls:', JSON.stringify(c.asstToolCalls));
  });
  console.log('ERRORS(' + errors.length + '):');
  errors.slice(0, 10).forEach(e => console.log('  ' + e));

  await browser.close();
  server.close();
})().catch(e => { console.error('CRASH:', e); server.close(); process.exit(2); });
