// 微信子系统 E2E 冒烟（无头 Edge）：协议解析 + 建角色开微聊 + 覆盖层 + 分段气泡 + 持久化
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 18125;
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

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  // 只统计真正的 JS 错误；忽略外部资源/CDN 加载失败（沙箱无外网）与 favicon。
  page.on('console', msg => {
    const t = msg.text();
    if (msg.type() === 'error' && !/Failed to load resource|gstatic|tailwindcss|nai\.sta1n|favicon|mock\.local/.test(t)) {
      errors.push('[console.error] ' + t.slice(0, 200));
    }
  });
  page.on('pageerror', err => errors.push('[pageerror] ' + err.message));

  // CDN 兜底：marked/DOMPurify 网络不通时也能渲染（沙箱内 CDN 常超时）
  // 并捕获根组件 proxy：prod 构建会清空 app._instance，但 app.mount() 返回根 proxy。
  await page.addInitScript(() => {
    window.marked = window.marked || { use() { }, parse: (t) => String(t) };
    window.DOMPurify = window.DOMPurify || { sanitize: (t) => String(t) };
    // 拦截 Vue 的挂载：prod 构建会清空 app._instance，只能从 mount() 返回值拿根 proxy。
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

  // 模拟模型接口：固定返回微信分段协议，并记录每次请求体（用于黑盒验证衔接）
  const REPLY = JSON.stringify({ messages: [
    { type: 'text', content: '在的' },
    { type: 'text', content: '刚看到消息' },
    { type: 'sticker', content: '🙄' }
  ] });
  const captured = [];
  await page.route('**/chat/completions', async route => {
    let body = null;
    try { body = route.request().postDataJSON(); } catch (_) { }
    const msgs = body?.messages || [];
    const sysContent = String(msgs[0]?.content || '');
    const isWechat = sysContent.includes('你只能输出一个 JSON 对象');
    let lastUser = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        lastUser = Array.isArray(msgs[i].content)
          ? msgs[i].content.map(p => p.text || '').join('')
          : String(msgs[i].content || '');
        break;
      }
    }
    captured.push({ isWechat, sysContent, lastUser });
    const content = isWechat ? REPLY : '（继续画着，头也没抬）……嗯，那你歇会儿。';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    });
  });

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 30000 });

  // 等待根 proxy 就绪（Vue CDN 加载时机不定/可能超时，轮询到关键属性可用为止；不行就刷新重试）
  let rootOk = false;
  for (let round = 0; round < 3 && !rootOk; round++) {
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
  if (!rootOk) { console.log('根 proxy 未就绪，终止（多为 CDN 网络问题）'); process.exit(1); }

  console.log('\n== 协议解析 ==');
  const proto = await page.evaluate(() => {
    const P = window.RPHubWeChatProtocol;
    if (!P) return { ok: false };
    return {
      ok: true,
      normal: P.parseReply('{"messages":[{"type":"text","content":"还没想好"},{"type":"sticker","content":"🙄"}]}').length === 2,
      fenced: P.parseReply('```json\n{"messages":[{"type":"text","content":"好"}]}\n```')[0]?.content === '好',
      think: P.parseReply('<thinking>x</thinking>{"messages":[{"type":"text","content":"嗯"}]}')[0]?.content === '嗯',
      fallback: P.parseReply('一\n二\n三').length === 3,
      bareEmoji: P.parseReply('{"messages":[{"type":"text","content":"😂"}]}')[0]?.type === 'sticker',
      overflow: P.parseReply('{"messages":[' + Array.from({ length: 20 }, (_, i) => `{"type":"text","content":"m${i}"}`).join(',') + ']}').length === 6
    };
  });
  Object.entries(proto).forEach(([k, v]) => { if (k !== 'ok') check('protocol.' + k, v === true); });
  if (!proto.ok) { console.log('协议未加载，终止'); process.exit(1); }

  console.log('\n== 建角色 + 开启微信 ==');
  const setup = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    if (!root) return { _err: 'no __APP_PROXY__' };
    if (!root.characters) return { _err: 'no characters', keys: Object.keys(root).slice(0, 20) };
    root.user.name = '阿伟';
    root.characters.push({
      name: '小A', description: '安静的插画师', personality: '嘴硬心软', first_mes: '……你好。',
      mes_example: '<START>\n{{user}}: 在干嘛\n{{char}}: 画画，别烦。',
      avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      uuid: 'test-uuid-1', createdAt: Date.now(),
      wechatEnabled: true, wechatPeerName: '小A', wechatRelation: '老同学', wechatScene: '深夜', wechatSpeed: 'fast'
    });
    await root.selectCharacter(0, false, { silent: true });
    return {
      name: root.currentCharacter?.name,
      wechatEnabled: root.currentCharacter?.wechatEnabled === true,
      entryButton: !!document.querySelector('button[title="打开微信"]')
    };
  });
  if (setup._err) { console.log('SETUP DIAG:', JSON.stringify(setup)); }
  check('角色已选中', setup.name === '小A', setup.name);
  check('wechatEnabled=true', setup.wechatEnabled);
  check('顶栏微信入口按钮出现', setup.entryButton);

  console.log('\n== RP 侧先聊一轮 ==');
  const rpTurn = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.settings.apiUrl = 'https://mock.local/v1';
    root.settings.apiKey = 'k';
    root.settings.model = 'mock-model';
    root.userInput = '今天画图好累';
    await root.sendMessage();
    await new Promise(r => setTimeout(r, 400));
    return { historyLen: root.chatHistory.length };
  });
  check('RP 对话已产生（含开场白+用户+助手）', rpTurn.historyLen >= 3, 'len=' + rpTurn.historyLen);

  console.log('\n== 打开微信覆盖层 ==');
  const overlay = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.settings.apiUrl = 'https://mock.local/v1';
    root.settings.apiKey = 'k';
    root.settings.model = 'mock-model';
    await root.openWechat();
    await new Promise(r => setTimeout(r, 300));
    const el = document.querySelector('.wx-root');
    return {
      panel: root.showWechatPanel === true,
      dom: !!el,
      peerName: el?.querySelector('.wx-peer-name')?.textContent?.trim()
    };
  });
  check('showWechatPanel=true', overlay.panel);
  check('.wx-root 覆盖层渲染', overlay.dom);
  check('联系人名渲染为「小A」', overlay.peerName === '小A', overlay.peerName);

  console.log('\n== 发送消息 + 分段气泡 ==');
  const send = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.wechatInput = '在吗';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 500));
    const bubbles = [...document.querySelectorAll('.wx-root .wx-bubble')];
    return {
      bubbleCount: bubbles.length,
      texts: bubbles.map(b => b.textContent.trim()),
      hasSticker: !!document.querySelector('.wx-root .wx-bubble.sticker'),
      generating: root.isWechatGenerating
    };
  });
  // 用户 1 条 + 助手 3 条 = 4 个气泡；其中 1 个是 sticker（无文字）
  check('气泡数量 = 4（1 用户 + 3 助手）', send.bubbleCount === 4, 'count=' + send.bubbleCount);
  check('助手分段文本正确', send.texts.includes('在的') && send.texts.includes('刚看到消息'), JSON.stringify(send.texts));
  check('表情气泡渲染为 sticker', send.hasSticker);
  check('生成结束状态已复位', send.generating === false);

  console.log('\n== 回 RP：微信段写入时间线并可持久化 ==');
  const back = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    await root.closeWechat();
    const items = root.wechatDisplayItems;
    const wechatMsgs = items.filter(i => i.kind === 'message');
    // 重新打开应能读回（IndexedDB）
    await root.openWechat();
    await new Promise(r => setTimeout(r, 400));
    const reopened = root.wechatDisplayItems.filter(i => i.kind === 'message');
    return {
      beforeClose: wechatMsgs.length,
      afterReopen: reopened.length,
      panel: root.showWechatPanel
    };
  });
  check('关闭后时间线含 4 条微信消息', back.beforeClose === 4, 'n=' + back.beforeClose);
  check('重新打开从 IndexedDB 读回记录', back.afterReopen === 4, 'n=' + back.afterReopen);

  console.log('\n== 双向衔接（RP ↔ 微信，黑盒：拦截真实请求体）==');
  // 微信侧请求应带上完整角色卡前提 + 对方信息
  const wxCall = [...captured].reverse().find(c => c.isWechat);
  check('微信 system prompt 含 RP 近况摘要', !!wxCall && wxCall.sysContent.includes('roleplay') && wxCall.sysContent.includes('小A'));
  check('微信 system prompt 含角色微信人设/关系', !!wxCall && wxCall.sysContent.includes('你只能输出一个 JSON 对象'));
  check('微信 prompt 含角色卡 Name', !!wxCall && wxCall.sysContent.includes('Name: 小A'));
  check('微信 prompt 含角色卡 Description', !!wxCall && wxCall.sysContent.includes('安静的插画师'));
  check('微信 prompt 含角色卡 Personality', !!wxCall && wxCall.sysContent.includes('嘴硬心软'));
  check('微信 prompt 含示例对话 mes_example', !!wxCall && wxCall.sysContent.includes('画画，别烦'));
  check('微信 prompt 含对方（用户）信息', !!wxCall && wxCall.sysContent.includes('阿伟'));
  check('微信 prompt 未混入 RP 叙事预设（第二人称）', !!wxCall && !wxCall.sysContent.includes('第二人称'));

  // 回 RP：发一条 RP 消息，最新 user 消息应被注入"后来你们在微信上聊了这些"剧情段
  const backToRp = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    await root.closeWechat();
    root.userInput = '我们继续刚才的';
    await root.sendMessage();
    await new Promise(r => setTimeout(r, 400));
    return { historyLen: root.chatHistory.length };
  });
  const rpCall = [...captured].reverse().find(c => !c.isWechat);
  check('回 RP 后仍能正常生成', backToRp.historyLen >= 5, 'len=' + backToRp.historyLen);
  check('回 RP 的请求注入了微信剧情摘要', !!rpCall && rpCall.lastUser.includes('后来你们在微信上聊了这些'));
  check('微信剧情摘要含具体对话内容', !!rpCall && rpCall.lastUser.includes('在的') && rpCall.lastUser.includes('刚看到消息'));
  check('注入后保留用户本轮原始输入', !!rpCall && rpCall.lastUser.includes('我们继续刚才的'));

  console.log('\n== 角色编辑器：微信开关 ==');
  const editor = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.editCharacter(0);
    await new Promise(r => setTimeout(r, 300));
    const box = [...document.querySelectorAll('label')].find(l => l.textContent.includes('开启微信'));
    const cb = box ? box.querySelector('input[type=checkbox]') : null;
    return {
      hasToggle: !!box,
      checked: cb ? cb.checked : null,
      tab: root.editorTab
    };
  });
  check('编辑器出现「开启微信」开关', editor.hasToggle);
  check('开关反映角色 wechatEnabled=true', editor.checked === true);

  console.log('\n== 切角色：时间线按角色隔离（游标不串）==');
  const isolation = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.showCharacterEditor = false;
    root.characters.push({
      name: '小B', description: '程序员', personality: '话痨', first_mes: '在吗？',
      avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      uuid: 'test-uuid-2', createdAt: Date.now(), wechatEnabled: true, wechatPeerName: '小B', wechatSpeed: 'fast'
    });
    await root.selectCharacter(1, false, { silent: true });
    await root.openWechat();
    await new Promise(r => setTimeout(r, 300));
    const bMsgs = root.wechatDisplayItems.filter(i => i.kind === 'message').length;
    // 小B 聊一句
    root.wechatInput = '在忙吗';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 400));
    const bAfter = root.wechatDisplayItems.filter(i => i.kind === 'message').length;
    // 切回小A，应看到小A自己的 4 条，而非小B的
    await root.closeWechat();
    await root.selectCharacter(0, false, { silent: true });
    await root.openWechat();
    await new Promise(r => setTimeout(r, 300));
    const aMsgs = root.wechatDisplayItems.filter(i => i.kind === 'message').length;
    return { bMsgs, bAfter, aMsgs };
  });
  check('小B 初始无历史（未继承小A记录）', isolation.bMsgs === 0, 'n=' + isolation.bMsgs);
  check('小B 聊天后有自己的记录', isolation.bAfter === 4, 'n=' + isolation.bAfter);
  check('切回小A 仍见小A的 4 条', isolation.aMsgs === 4, 'n=' + isolation.aMsgs);

  console.log('\nERRORS(' + errors.length + '):');
  errors.slice(0, 15).forEach(e => console.log('  ' + e));

  await browser.close();
  server.close();
  const failed = results.filter(r => !r.ok).length;
  const ok = failed === 0 && errors.length === 0;
  console.log('\n' + (ok ? 'WECHAT E2E: PASS' : `WECHAT E2E: FAIL (${failed} checks, ${errors.length} errors)`));
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('SMOKE CRASH:', e); server.close(); process.exit(2); });
