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
    const isRecap = sysContent.includes('上下文压缩器');
    const hasToolResult = msgs.some(m => m && m.role === 'tool');
    const toolNames = (Array.isArray(body?.tools) ? body.tools : []).map(t => t?.function?.name).filter(Boolean);
    let lastUser = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        lastUser = Array.isArray(msgs[i].content)
          ? msgs[i].content.map(p => p.text || '').join('')
          : String(msgs[i].content || '');
        break;
      }
    }
    captured.push({
      isWechat, isRecap, sysContent, lastUser, hasToolResult, toolNames,
      roles: msgs.map(m => m.role).join(','),
      contents: msgs.map(m => typeof m.content === 'string' ? m.content.slice(0, 400) : '[parts]')
    });
    // RP 主动发起微信探针：本轮首次请求（还没有 tool 结果回传）且用户输入带标记时，
    // 让模型先调用 tool_wechat，再在续写请求里正常出正文。
    const probeSent = msgs.some(m => typeof m.content === 'string' && m.content.includes('触发微信'));
    if (!isWechat && !isRecap && !hasToolResult && probeSent) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{
            message: {
              role: 'assistant', content: '',
              tool_calls: [{
                id: 'call_wx_1', type: 'function',
                function: { name: 'tool_wechat', arguments: JSON.stringify({ content: '在吗，睡了吗', reason: '想私下找你' }) }
              }]
            },
            finish_reason: 'tool_calls'
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      });
      return;
    }
    const content = isRecap
      ? '林晚与 lin 在微信上聊过天，约定晚些时候再联系。'
      : (isWechat ? REPLY : '（继续画着，头也没抬）……嗯，那你歇会儿。');
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
      overflow: P.parseReply('{"messages":[' + Array.from({ length: 20 }, (_, i) => `{"type":"text","content":"m${i}"}`).join(',') + ']}').length === 6,
      // 小作文：协议要留得下长消息，不能拦腰截断
      essayKeptIntact: P.parseReply('{"messages":[{"type":"text","content":"' + '好'.repeat(300) + '"}]}')[0]?.content.length === 300,
      essayRuleInProtocol: P.PROTOCOL.includes('小作文')
    };
  });
  Object.entries(proto).forEach(([k, v]) => { if (k !== 'ok') check('protocol.' + k, v === true); });
  if (!proto.ok) { console.log('协议未加载，终止'); process.exit(1); }

  console.log('\n== 表情包档位裁剪（注入 random，确定性） ==');
  const tiers = await page.evaluate(() => {
    const P = window.RPHubWeChatProtocol;
    const mix = () => ([{ type: 'text', content: 'a' }, { type: 'sticker', content: '🙄' }, { type: 'sticker', content: '😂' }]);
    const stickers = (list) => list.filter(m => m.type === 'sticker').length;
    return {
      offDropsAll: stickers(P.applyStickerPolicy(mix(), 'off')) === 0,
      lowKeepsAtMostOne: stickers(P.applyStickerPolicy(mix(), 'low', { random: () => 0 })) === 1,
      lowDropsWhenUnlucky: stickers(P.applyStickerPolicy(mix(), 'low', { random: () => 0.999 })) === 0,
      highKeepsAll: stickers(P.applyStickerPolicy(mix(), 'high', { random: () => 0.999 })) === 2,
      textUntouched: P.applyStickerPolicy(mix(), 'off').filter(m => m.type === 'text').length === 1,
      stickerOnlyNeverEmpty: P.applyStickerPolicy([{ type: 'sticker', content: '🙄' }], 'off').length === 1,
      unknownTierFallsBack: P.normalizeStickerTier('nope') === P.DEFAULT_STICKER_TIER,
      ruleChangesWithTier: P.stickerRuleFor('off') !== P.stickerRuleFor('high')
    };
  });
  Object.entries(tiers).forEach(([k, v]) => check('sticker.' + k, v === true));

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
      wechatEnabled: true, wechatPeerName: '小A', wechatRelation: '老同学', wechatScene: '深夜', wechatSpeed: 'fast',
      worldInfo: [
        { comment: '画室设定', content: '小A 在城西画室打工，右手有旧伤，阴天会疼。', enabled: true, scope: 'character', order: 10 },
        { comment: '没勾选的条目', content: '这段设定没被勾选，不该出现在微信提示词里。', enabled: true, scope: 'character', order: 20 }
      ],
      wechatWorldInfoComments: ['画室设定'],
      wechatStickerRate: 'low'
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
      stickerCount: document.querySelectorAll('.wx-root .wx-bubble.sticker').length,
      generating: root.isWechatGenerating
    };
  });
  // 用户 1 条 + 助手 2~3 条；助手第 3 条是 sticker，low 档下可能被裁掉，所以数量是范围，
  // 但「最多留 1 个表情」是档位硬上限，任何随机结果都必须成立。
  check('气泡数量 = 3~4（1 用户 + 2~3 助手）', send.bubbleCount >= 3 && send.bubbleCount <= 4, 'count=' + send.bubbleCount);
  check('助手分段文本正确', send.texts.includes('在的') && send.texts.includes('刚看到消息'), JSON.stringify(send.texts));
  check('low 档表情气泡数量不超过 1', send.stickerCount <= 1, 'stickers=' + send.stickerCount);
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
  check('关闭后时间线与气泡数一致', back.beforeClose === send.bubbleCount, 'n=' + back.beforeClose);
  check('重新打开从 IndexedDB 读回记录', back.afterReopen === send.bubbleCount, 'n=' + back.afterReopen);

  console.log('\n== 双向衔接（RP ↔ 微信，黑盒：拦截真实请求体）==');
  // 微信侧请求应带上完整角色卡前提 + 对方信息
  const wxCall = [...captured].reverse().find(c => c.isWechat);
  // RP 上下文不再堆在 system 里，而是按时间线还原成消息序列
  check('RP 剧情块按时间顺序排在微信消息之前',
    !!wxCall
    && wxCall.contents[1]?.includes('【roleplay 剧情')
    && wxCall.contents[wxCall.contents.length - 1]?.includes('在吗'),
    JSON.stringify(wxCall ? wxCall.contents.map(c => c.replace(/\n/g, ' ').slice(0, 22)) : []));
  check('微信 system prompt 不再重复塞 RP 摘要',
    !!wxCall && !wxCall.sysContent.includes('【之前发生的事】'));
  check('微信 system prompt 含角色微信人设/关系', !!wxCall && wxCall.sysContent.includes('你只能输出一个 JSON 对象'));
  check('微信 prompt 含角色卡 Name', !!wxCall && wxCall.sysContent.includes('Name: 小A'));
  check('微信 prompt 含角色卡 Description', !!wxCall && wxCall.sysContent.includes('安静的插画师'));
  check('微信 prompt 含角色卡 Personality', !!wxCall && wxCall.sysContent.includes('嘴硬心软'));
  check('微信 prompt 含示例对话 mes_example', !!wxCall && wxCall.sysContent.includes('画画，别烦'));
  check('微信 prompt 含对方（用户）信息', !!wxCall && wxCall.sysContent.includes('阿伟'));
  check('微信 prompt 未混入 RP 叙事预设（第二人称）', !!wxCall && !wxCall.sysContent.includes('第二人称'));
  // 世界书：只注入被勾选的条目（含条目名），未勾选的不进提示词
  check('微信 prompt 含【世界设定】段', !!wxCall && wxCall.sysContent.includes('【世界设定】'));
  check('微信 prompt 含勾选的世界书条目名', !!wxCall && wxCall.sysContent.includes('[画室设定]'));
  check('微信 prompt 含勾选的世界书正文', !!wxCall && wxCall.sysContent.includes('右手有旧伤'));
  check('微信 prompt 未注入未勾选的条目', !!wxCall && !wxCall.sysContent.includes('这段设定没被勾选'));
  // 表情包档位提示词
  check('微信 prompt 含表情包策略', !!wxCall && wxCall.sysContent.includes('表情包策略'));
  // 回归：内置 RP 写作预设（禁止规则/防神化）曾按名字白名单无条件注入，把 prompt 淹掉
  check('微信 prompt 不再泄漏内置 RP 写作预设',
    !!wxCall && !wxCall.sysContent.includes('<prohibited_content>') && !wxCall.sysContent.includes('<R-LOGIC>'));

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
  check('回 RP 的请求注入了微信聊天记录块（独立消息）',
    !!rpCall && rpCall.contents.some(c => c.includes('【微信聊天记录')));
  check('微信剧情摘要含具体对话内容',
    !!rpCall && rpCall.contents.some(c => c.includes('在的') && c.includes('刚看到消息')));
  check('注入后保留用户本轮原始输入', !!rpCall && rpCall.lastUser.includes('我们继续刚才的'));

  // 微信段回灌 RP 时，玩家要标成用户名（阿伟），不能用「你」——那段里「你」= 主角 = 角色
  const wxSeg = (rpCall?.contents || []).find(c => c.includes('【微信聊天记录'));
  check('微信段回灌玩家用用户名标注（非「你」）',
    !!wxSeg && wxSeg.includes('阿伟：') && !wxSeg.includes('\n你：'),
    wxSeg ? wxSeg.replace(/\n/g, ' | ').slice(0, 160) : 'none');

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

  console.log('\n== 微信设置抽屉：世界书与表情包档位 ==');
  const drawer = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.showCharacterEditor = false;
    await root.openWechat();
    root.openWechatSettings();
    await new Promise(r => setTimeout(r, 250));
    const onOpen = JSON.parse(JSON.stringify(root.wechatSettingsDraft));
    const optionNames = root.wechatWorldInfoOptions.map(o => o.comment);
    // 两个勾选列表：0 = 世界书，1 = 预设
    const listCounts = [...document.querySelectorAll('.wx-pick-list')].map(l => l.querySelectorAll('.wx-pick-item').length);
    root.wechatSettingsDraft.stickerRate = 'off';
    await root.saveWechatSettings();
    return {
      optionNames,
      listCounts,
      presetNames: root.wechatPresetOptions.map(o => o.name),
      draftComments: onOpen.worldInfoComments,
      draftPresets: onOpen.presetNames,
      draftTier: onOpen.stickerRate,
      savedTier: root.currentCharacter.wechatStickerRate,
      savedComments: root.currentCharacter.wechatWorldInfoComments,
      savedPresets: root.currentCharacter.wechatPresetNames,
      drawerClosed: root.showWechatSettings === false
    };
  });
  check('抽屉列出角色世界书条目', drawer.optionNames.includes('画室设定') && drawer.optionNames.includes('没勾选的条目'), JSON.stringify(drawer.optionNames));
  check('抽屉渲染世界书列表 DOM', (drawer.listCounts[0] || 0) >= 2, 'counts=' + JSON.stringify(drawer.listCounts));
  check('抽屉渲染预设列表 DOM', (drawer.listCounts[1] || 0) >= 1, 'counts=' + JSON.stringify(drawer.listCounts));
  check('抽屉只列带微信版文案的预设',
    ['破限', '破限预注入 · User 1', '破限预注入 · AI 1', '破限预注入 · User 2', '破限预注入 · AI 2',
      'NSFW增强', '人格内核', '防神化', '活人感'].every(n => drawer.presetNames.includes(n))
    && !drawer.presetNames.includes('禁止规则')
    && !drawer.presetNames.includes('时间戳')
    && !drawer.presetNames.includes('COT'),
    JSON.stringify(drawer.presetNames));
  check('预设列表 DOM 与选项数一致', drawer.listCounts[1] === drawer.presetNames.length,
    'dom=' + drawer.listCounts[1] + ' opt=' + drawer.presetNames.length);
  check('打开设置时草稿回填已勾选条目', JSON.stringify(drawer.draftComments) === JSON.stringify(['画室设定']), JSON.stringify(drawer.draftComments));
  check('打开设置时草稿预设为空', Array.isArray(drawer.draftPresets) && drawer.draftPresets.length === 0, JSON.stringify(drawer.draftPresets));
  check('打开设置时草稿回填表情包档位', drawer.draftTier === 'low', drawer.draftTier);
  check('保存后档位写回角色', drawer.savedTier === 'off', drawer.savedTier);
  check('保存后世界书选择写回角色', JSON.stringify(drawer.savedComments) === JSON.stringify(['画室设定']), JSON.stringify(drawer.savedComments));
  check('保存后预设选择写回角色', Array.isArray(drawer.savedPresets) && drawer.savedPresets.length === 0, JSON.stringify(drawer.savedPresets));
  check('保存后抽屉关闭', drawer.drawerClosed === true);

  console.log('\n== 切角色：时间线按角色隔离（游标不串）==');
  const isolation = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.characters.push({
      name: '小B', description: '程序员', personality: '话痨', first_mes: '在吗？',
      avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      uuid: 'test-uuid-2', createdAt: Date.now(), wechatEnabled: true, wechatPeerName: '小B',
      wechatSpeed: 'fast', wechatStickerRate: 'high'
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
    // 切回小A，应看到小A自己的记录，而非小B的
    await root.closeWechat();
    await root.selectCharacter(0, false, { silent: true });
    await root.openWechat();
    await new Promise(r => setTimeout(r, 300));
    const aMsgs = root.wechatDisplayItems.filter(i => i.kind === 'message').length;
    return { bMsgs, bAfter, aMsgs };
  });
  check('小B 初始无历史（未继承小A记录）', isolation.bMsgs === 0, 'n=' + isolation.bMsgs);
  check('小B 聊天后有自己的记录', isolation.bAfter === 4, 'n=' + isolation.bAfter);
  check('切回小A 仍见小A自己的记录', isolation.aMsgs === send.bubbleCount, 'n=' + isolation.aMsgs);

  console.log('\n== 表情包档位端到端生效 ==');
  // 小A 上一步已存成 off 档：这一轮不该多出任何表情
  const stickerOff = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    const countStickers = () => root.wechatDisplayItems.filter(i => i.type === 'sticker').length;
    const before = countStickers();
    root.wechatInput = '在吗';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 400));
    return { tier: root.currentCharacter.wechatStickerRate, added: countStickers() - before };
  });
  check('off 档本轮不发表情', stickerOff.tier === 'off' && stickerOff.added === 0, JSON.stringify(stickerOff));

  const stickerHigh = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.currentCharacter.wechatStickerRate = 'high';
    const countStickers = () => root.wechatDisplayItems.filter(i => i.type === 'sticker').length;
    const before = countStickers();
    root.wechatInput = '在吗';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 400));
    return {
      tier: root.currentCharacter.wechatStickerRate,
      added: countStickers() - before,
      domStickers: document.querySelectorAll('.wx-root .wx-bubble.sticker').length
    };
  });
  check('high 档本轮发出表情', stickerHigh.tier === 'high' && stickerHigh.added >= 1, JSON.stringify(stickerHigh));
  check('表情气泡渲染为 sticker 样式', stickerHigh.domStickers >= 1, 'dom=' + stickerHigh.domStickers);

  console.log('\n== 预设微信版注入与 RP 长期记忆 ==');
  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    // 顺手把 RP 侧的「人格内核」停用：微信勾选应当独立生效，不被这个开关带动
    const core = root.presets.find(preset => preset.name === '人格内核');
    if (core) core.enabled = false;
    root.currentCharacter.wechatPresetNames = ['人格内核'];
    root.wechatInput = '在吗';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 500));
  });
  const presetCall = [...captured].reverse().find(c => c.isWechat);
  check('注入的是预设的微信版文案（而非 RP 版）',
    !!presetCall && presetCall.sysContent.includes('你就是这个人') && !presetCall.sysContent.includes('【人物成立】'));
  check('未勾选的预设不注入（防神化缺席）',
    !!presetCall && !presetCall.sysContent.includes('你只知道你知道的'));
  check('预设停用不影响微信勾选', !!presetCall && presetCall.sysContent.includes('【预设规则】'));
  check('长期记忆未开启时不注入', !!presetCall && !presetCall.sysContent.includes('【长期记忆】'));

  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.memorySettings.enabled = true;
    root.classicMemories.push({
      id: 'mem-1', classicMemory: true, enabled: true,
      turn: 5, turnStart: 3, turnEnd: 5,
      summary: '你们第一次见面是在画室楼下，她借了你一把伞。'
    });
    root.wechatInput = '在吗';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 500));
  });
  const memCall = [...captured].reverse().find(c => c.isWechat);
  check('长期记忆注入微信 prompt', !!memCall && memCall.sysContent.includes('【长期记忆】'));
  check('长期记忆带轮次标签与正文',
    !!memCall && memCall.sysContent.includes('第 3–5 轮') && memCall.sysContent.includes('借了你一把伞'));

  console.log('\n== 破限族：system 版与预注入轮次分流 ==');
  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.currentCharacter.wechatPresetNames = [
      '破限', '破限预注入 · User 1', '破限预注入 · AI 1', '破限预注入 · User 2', '破限预注入 · AI 2'
    ];
    root.wechatInput = '在吗';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 500));
  });
  const breachCall = [...captured].reverse().find(c => c.isWechat);
  check('破限进 system prompt（且是微信版）',
    !!breachCall && breachCall.sysContent.includes('微信聊天模式') && !breachCall.sysContent.includes('# 角色扮演模式'));
  check('预注入作为真实消息插在 system 与聊天记录之间',
    !!breachCall && breachCall.roles.startsWith('system,user,assistant,user,assistant'),
    breachCall ? breachCall.roles : '');
  check('预注入用的是微信版文案',
    !!breachCall
    && breachCall.contents.some(c => c.includes('本次微信扮演'))
    && breachCall.contents.some(c => c.includes('[WeChat READY]'))
    && !breachCall.contents.some(c => c.includes('RP-Hub READY')));
  check('预注入没有混进 system 提示词',
    !!breachCall && !breachCall.sysContent.includes('[WeChat READY]'));

  console.log('\n== RP ↔ 微信 交错：按时间顺序还原 ==');
  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    // 关掉记忆：这一段要验证「原始块按序全部保留」，开着记忆会被收敛掉
    root.memorySettings.enabled = false;
    root.characters.push({
      name: '小C', description: '乐手', personality: '闷', first_mes: '……',
      avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      uuid: 'test-uuid-3', createdAt: Date.now(),
      wechatEnabled: true, wechatPeerName: '小C', wechatSpeed: 'fast', wechatStickerRate: 'high'
    });
    await root.selectCharacter(2, false, { silent: true });

    // 第一轮 RP
    root.chatHistory.length = 0;
    root.chatHistory.push(
      { role: 'assistant', content: '（把吉他放下）你来了。' },
      { role: 'user', content: '演出怎么样' },
      { role: 'assistant', content: '（耸肩）就那样。' }
    );
    await root.openWechat();
    root.wechatInput = '微信第一轮';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 400));
    await root.closeWechat();

    // 第二轮 RP（在第一轮微信之后）
    root.chatHistory.push(
      { role: 'user', content: '我给你带了夜宵' },
      { role: 'assistant', content: '（愣了一下）谢了。' }
    );

    await root.openWechat();
    root.wechatInput = '微信第二轮';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 400));
  });
  const interCall = [...captured].reverse().find(c => c.isWechat);
  const idxFrom = (needle, from = 0) => interCall
    ? interCall.contents.findIndex((c, i) => i >= from && c.includes(needle))
    : -1;
  const rpBlock1 = idxFrom('【roleplay 剧情');
  const wxRound1 = idxFrom('微信第一轮');
  const rpBlock2 = idxFrom('【roleplay 剧情', wxRound1 + 1);
  const wxRound2 = idxFrom('微信第二轮');
  check('交错顺序还原为 RP → 微信 → RP → 微信',
    rpBlock1 >= 0 && wxRound1 > rpBlock1 && rpBlock2 > wxRound1 && wxRound2 > rpBlock2,
    JSON.stringify((interCall ? interCall.contents : []).map((c, i) => `#${i} ${c.replace(/\n/g, ' ').slice(0, 16)}`)));
  check('前后两段 RP 各自归到自己的块里',
    !!interCall
    && !interCall.contents[rpBlock1].includes('带了夜宵')
    && interCall.contents[rpBlock2].includes('带了夜宵'));

  console.log('\n== 乙：记忆覆盖后只留最近一段 RP ==');
  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.memorySettings.enabled = true;
    root.classicMemories.push({
      id: 'mem-C', classicMemory: true, enabled: true,
      turn: 1, turnStart: 1, turnEnd: 1, summary: '你们在排练室见过一面。'
    });
    root.wechatInput = '还在吗';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 400));
  });
  const collapseCall = [...captured].reverse().find(c => c.isWechat);
  const rpBlockCount = collapseCall
    ? collapseCall.contents.filter(c => c.includes('【roleplay 剧情')).length
    : -1;
  check('记忆覆盖后只保留最近一段 RP', rpBlockCount === 1, 'rpBlocks=' + rpBlockCount);
  check('收敛不影响微信消息本身',
    !!collapseCall
    && collapseCall.contents.some(c => c.includes('微信第一轮'))
    && collapseCall.contents.some(c => c.includes('微信第二轮')));

  console.log('\n== A：相邻同角色气泡合并 ==');
  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    for (let i = 0; i < 4; i++) {
      root.wechatInput = '再聊一句' + i;
      await root.sendWechatMessage();
      await new Promise(r => setTimeout(r, 300));
    }
    root.wechatInput = '最后一句';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 400));
  });
  const mergeCall = [...captured].reverse().find(c => c.isWechat);
  check('同轮多条气泡合并成一条（含表情）',
    !!mergeCall && mergeCall.contents.some(c =>
      c.includes('在的') && c.includes('刚看到消息') && c.includes('🙄')),
    JSON.stringify(mergeCall ? mergeCall.contents.slice(-4) : []));
  check('不再把一轮拆成多条分别发',
    !!mergeCall && !mergeCall.contents.includes('刚看到消息'));

  console.log('\n== 剧情块：占位符解析 + 长文完整保留（不截断） ==');
  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    // 关记忆，避免剧情块被收敛掉
    root.memorySettings.enabled = false;
    // 用户名设成 lin：{{user}}→lin 变短，旧实现按 200 字截断会把名字切成「l」
    root.user.name = 'lin';
    // 段一：短句占位符 → 应被 RP 正则管线解析成用户名
    root.chatHistory.push({ role: 'user', content: '{{user}}坐下，端起碗。' });
    root.chatHistory.push({ role: 'assistant', content: '好。' });
    await root.closeWechat();
    await root.openWechat();
    root.wechatInput = '分段探针一';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 400));
    // 段二：230 字前缀把正文推过 200 字，验证超长部分仍完整保留、名字不被切
    root.chatHistory.push({ role: 'assistant', content: '钥'.repeat(230) + '{{user}}随后坐下，这是结尾标记。' });
    await root.closeWechat();
    await root.openWechat();
    root.wechatInput = '分段探针二';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 500));
  });
  const clipCall = [...captured].reverse().find(c => c.isWechat);
  const clipBlocks = clipCall ? clipCall.contents.filter(c => c.includes('【roleplay 剧情')) : [];
  const shortBlock = clipBlocks.find(c => c.includes('坐下，端起碗')) || '';
  const longBlock = clipBlocks.find(c => c.includes('钥')) || '';
  check('剧情块里的 {{user}} 经 RP 正则解析成用户名',
    shortBlock.includes('lin') && !shortBlock.includes('{{user}}'),
    shortBlock.slice(0, 60));
  check('超长正文（>200 字）完整保留、不截断',
    longBlock.includes('lin随后坐下') && longBlock.includes('这是结尾标记'),
    JSON.stringify(longBlock.slice(-16)));
  check('用户名不被切半个（lin 不切成 l）',
    longBlock.includes('lin随后坐下'),
    JSON.stringify(longBlock.slice(-16)));

  console.log('\n== 编辑 RP 消息后，微信块同步更新（不再发旧文案） ==');
  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.memorySettings.enabled = false;
    // 用户名不能是 roleplay 子串（此前是 阿伟），否则正则「Auto Replace」会卡死浏览器
    root.user.name = 'lin';
    root.characters.push({
      name: '小D', description: '编辑同步测试', personality: 'x', first_mes: '原始开场白：你好。',
      avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      uuid: 'test-uuid-edit', createdAt: Date.now(),
      wechatEnabled: true, wechatPeerName: '小D', wechatSpeed: 'fast'
    });
    const index = root.characters.length - 1;
    await root.selectCharacter(index, false, { silent: true });
    root.chatHistory.length = 0;
    root.chatHistory.push({ role: 'assistant', content: '原始开场白：你好。' });
    await root.openWechat();
    root.wechatInput = '编辑前探针';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 400));
    await root.closeWechat();
    // 模拟 saveEditMessage 只改 chatHistory 里的 content
    root.chatHistory[0].content = '改过的开场白：晚安。';
    await root.openWechat();
    root.wechatInput = '编辑后探针';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 500));
  });
  const editCalls = captured.filter(c => c.isWechat
    && (c.contents.some(x => x.includes('编辑前探针')) || c.contents.some(x => x.includes('编辑后探针'))));
  const beforeCall = editCalls.find(c => c.contents.some(x => x.includes('编辑前探针')));
  const afterCall = editCalls.find(c => c.contents.some(x => x.includes('编辑后探针')));
  check('编辑前微信块是旧文案',
    !!beforeCall && beforeCall.contents.some(c => c.includes('原始开场白')));
  check('编辑 RP 消息后微信块更新为新文案',
    !!afterCall && afterCall.contents.some(c => c.includes('改过的开场白')),
    afterCall ? afterCall.contents.find(c => c.includes('开场白'))?.slice(0, 70) : 'no call');
  check('编辑后旧文案不再出现',
    !!afterCall && !afterCall.contents.some(c => c.includes('原始开场白')));

  console.log('\n== 重新生成换了 id 后，缺失的 RP 镜像被补回 ==');
  const regen = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.characters.push({
      name: '小F', description: '重生成对账', personality: 'x', first_mes: '开场白甲。',
      avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      uuid: 'test-uuid-regen', createdAt: Date.now(),
      wechatEnabled: true, wechatPeerName: '小F', wechatSpeed: 'fast'
    });
    await root.selectCharacter(root.characters.length - 1, false, { silent: true });
    // 手工构造：时间线里第 3 项是已过期的镜像（旧 id / 旧文案），
    // chatHistory 里对应消息被重新生成换了新 id。
    root.wechatTimeline = [
      { id: 't1', ts: 100, channel: 'rp', rpIndex: 0, rpMsgId: 'msg-a', role: 'assistant', type: 'text', content: '开场白甲。' },
      { id: 't2', ts: 101, channel: 'wechat', role: 'user', type: 'text', content: '微信一句' },
      { id: 't3', ts: 102, channel: 'rp', rpIndex: 1, rpMsgId: 'stale-id', role: 'assistant', type: 'text', content: '旧文案' }
    ];
    root.chatHistory = [
      { id: 'msg-a', role: 'assistant', content: '开场白甲。' },
      { id: 'new-id', role: 'assistant', content: '重新生成后的文案' }
    ];
    const changed = root.reconcileRpTimeline();
    const tl = root.wechatTimeline;
    return {
      changed,
      order: tl.map(i => i.channel),
      contents: tl.filter(i => i.channel === 'rp').map(i => i.content),
      // 新镜像的 ts 必须比它前面的微信消息新，否则回 RP 摘要会漏掉
      tsOrderOk: tl[2].ts > tl[1].ts
    };
  });
  check('过期镜像被替换为新文案（按新 id 补回）',
    regen.changed === true && regen.contents.includes('重新生成后的文案'),
    JSON.stringify(regen.contents));
  check('补回后保持 RP→微信→RP 的顺序',
    JSON.stringify(regen.order) === JSON.stringify(['rp', 'wechat', 'rp']),
    JSON.stringify(regen.order));
  check('补回的镜像 ts 排在后面微信消息之后（摘要不漏）', regen.tsOrderOk === true);

  console.log('\n== 清空微信记录（确认弹窗必须能盖在微信层上） ==');
  const clearFlow = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    // 独立角色并先聊两句，用例自足（不依赖前面测试留下的角色/面板状态）
    root.characters.push({
      name: '小H', description: '清空测试', personality: 'x', first_mes: '嗨。',
      avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      uuid: 'test-uuid-clear', createdAt: Date.now(),
      wechatEnabled: true, wechatPeerName: '小H', wechatSpeed: 'fast'
    });
    await root.selectCharacter(root.characters.length - 1, false, { silent: true });
    await root.openWechat();
    root.wechatInput = '清空前的消息';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 400));
    const countMsgs = () => root.wechatDisplayItems.filter(i => i.kind === 'message').length;
    const before = countMsgs();
    root.clearWechatTimeline();
    await new Promise(r => setTimeout(r, 300));
    const confirmBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '确认');
    const overlay = confirmBtn ? confirmBtn.closest('.fixed') : null;
    const wxRoot = document.querySelector('.wx-root');
    return {
      before,
      modalShown: root.showConfirmModal === true,
      hasConfirmButton: !!confirmBtn,
      modalZ: overlay ? Number(getComputedStyle(overlay).zIndex) : NaN,
      wxZ: wxRoot ? Number(getComputedStyle(wxRoot).zIndex) : NaN
    };
  });
  check('清空前有聊天记录', clearFlow.before > 0, 'n=' + clearFlow.before);
  check('点🗑 弹出确认框', clearFlow.modalShown === true && clearFlow.hasConfirmButton === true);
  check('确认框层级高于微信覆盖层', clearFlow.modalZ > clearFlow.wxZ,
    `modal=${clearFlow.modalZ} wx=${clearFlow.wxZ}`);

  const cleared = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    const confirmBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '确认');
    confirmBtn.click();
    await new Promise(r => setTimeout(r, 600));
    const afterClear = root.wechatDisplayItems.filter(i => i.kind === 'message').length;
    // 重新打开，验证落盘
    await root.closeWechat();
    await root.openWechat();
    await new Promise(r => setTimeout(r, 400));
    return {
      afterClear,
      afterReopen: root.wechatDisplayItems.filter(i => i.kind === 'message').length,
      modalClosed: root.showConfirmModal === false
    };
  });
  check('确认后记录被清空', cleared.afterClear === 0, 'n=' + cleared.afterClear);
  check('清空已落盘（重开仍为空）', cleared.afterReopen === 0, 'n=' + cleared.afterReopen);
  check('确认后弹窗关闭', cleared.modalClosed === true);

  console.log('\n== 预设编辑器：微信版内容 ==');
  const presetEdit = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    // 「防抢话」本来没有微信版，现加一份
    const index = root.presets.findIndex(p => p.name === '防抢话');
    const before = root.wechatPresetOptions.some(o => o.name === '防抢话');
    root.editPreset(index);
    await new Promise(r => setTimeout(r, 300));
    const hasField = !!document.querySelector('.app-modal-panel textarea[placeholder^="留空"]');
    root.editingPreset.data.wechatContent = '# 微信版防抢话\n对方说过的要接住，不要替他补话。';
    await root.savePreset();
    await new Promise(r => setTimeout(r, 300));
    return {
      before,
      hasField,
      saved: root.presets[index].wechatContent,
      after: root.wechatPresetOptions.some(o => o.name === '防抢话')
    };
  });
  check('预设编辑器有微信版输入框', presetEdit.hasField === true);
  check('未填微信版时抽屉不列出该预设', presetEdit.before === false);
  check('保存后写入 wechatContent', String(presetEdit.saved).includes('不要替他补话'), String(presetEdit.saved).slice(0, 30));
  check('保存后该预设出现在微信抽屉', presetEdit.after === true);

  console.log('\n== 微信1→RP1→微信2→RP2：两段微信都进 RP2 的背景 ==');
  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.memorySettings.enabled = false;
    // 独立角色，避免污染前面依赖精确计数的用例
    root.characters.push({
      name: '小G', description: '交错背景', personality: 'x', first_mes: '开场。',
      avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      uuid: 'test-uuid-interleave', createdAt: Date.now(),
      wechatEnabled: true, wechatPeerName: '小G', wechatSpeed: 'fast'
    });
    await root.selectCharacter(root.characters.length - 1, false, { silent: true });
    root.chatHistory = [{ id: 'g-open', role: 'assistant', content: '开场。' }];
    // 微信1
    await root.openWechat();
    root.wechatInput = '第一段微信内容';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 400));
    await root.closeWechat();
    // RP1
    root.userInput = 'RP 第一轮输入';
    await root.sendMessage();
    await new Promise(r => setTimeout(r, 400));
    // 微信2
    await root.openWechat();
    root.wechatInput = '第二段微信内容';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 400));
    await root.closeWechat();
    // RP2
    root.userInput = 'RP 第二轮输入';
    await root.sendMessage();
    await new Promise(r => setTimeout(r, 500));
  });
  const rp2Call = [...captured].reverse().find(c => !c.isWechat);
  const idx2 = (needle) => rp2Call ? rp2Call.contents.findIndex(c => c.includes(needle)) : -1;
  const wx1i = idx2('第一段微信内容');
  const rp1i = idx2('RP 第一轮输入');
  const wx2i = idx2('第二段微信内容');
  check('RP2 的注入里同时含微信1 和微信2 的内容',
    !!rp2Call && wx1i >= 0 && wx2i >= 0,
    rp2Call ? rp2Call.contents.map((c, i) => `#${i}${c.includes('第一段微信内容') ? '←wx1' : ''}${c.includes('RP 第一轮输入') ? '←rp1' : ''}${c.includes('第二段微信内容') ? '←wx2' : ''}`).filter(x => x.includes('←')).join(' ') : 'no call');
  check('两段微信各自按时间位置插入（微信1 → RP1 → 微信2）',
    wx1i >= 0 && rp1i >= 0 && wx2i >= 0 && wx1i < rp1i && rp1i < wx2i,
    `wx1=${wx1i} rp1=${rp1i} wx2=${wx2i}`);

  console.log('\n== 前情提要：手动压缩 + 两侧裁剪 + 去重 ==');
  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.memorySettings.enabled = false; // 先不掺记忆，单独验证提要
    root.memorySettings.classicModel = 'mock-model'; // 压缩复用记忆模型
    root.user.name = 'lin';
    root.characters.push({
      name: '小R', description: '前情提要测试', personality: 'x', first_mes: '开场R。',
      avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      uuid: 'test-uuid-recap', createdAt: Date.now(),
      wechatEnabled: true, wechatPeerName: '小R', wechatSpeed: 'fast'
    });
    await root.selectCharacter(root.characters.length - 1, false, { silent: true });
    // 3 轮 RP（手工构造带 id，供轮次快照使用）
    root.chatHistory = [
      { id: 'r0', role: 'assistant', content: '开场R。' },
      { id: 'r1u', role: 'user', content: 'RP第一用户句' },
      { id: 'r1a', role: 'assistant', content: 'RP第一助手句' },
      { id: 'r2u', role: 'user', content: 'RP第二用户句' },
      { id: 'r2a', role: 'assistant', content: 'RP第二助手句' },
      { id: 'r3u', role: 'user', content: 'RP第三用户句' },
      { id: 'r3a', role: 'assistant', content: 'RP第三助手句' }
    ];
    // 3 条微信
    await root.openWechat();
    for (const t of ['微信内容甲', '微信内容乙', '微信内容丙']) {
      root.wechatInput = t;
      await root.sendWechatMessage();
      await new Promise(r => setTimeout(r, 250));
    }
    await root.closeWechat();
    // 保留窗口：压缩前设成「保留最近 2 轮 RP + 6 条微信」，验证注入块贴回近期原文
    // （微信每轮会带回助手回复，所以条数要够多才盖得到用户消息「丙」）
    await root.setRecapKeepSettings({ rpTurns: 2, wechatCount: 6 });
    // 压缩：全量（压缩点之前的所有 RP 轮次 + 全部微信）
    await root.runStoryRecap();
  });
  const recapCall = captured.find(c => c.isRecap);
  check('压缩触发了一次模型调用', !!recapCall);
  check('压缩素材含 RP 与微信正文',
    !!recapCall && recapCall.contents.some(c => c.includes('RP第一用户句'))
    && recapCall.contents.some(c => c.includes('微信内容甲')));
  const recapState = await page.evaluate(() => {
    const root = window.__APP_PROXY__;
    const r = root.storyRecap;
    const wx = root.wechatTimeline.filter(i => i.channel === 'wechat' && i.role !== 'system');
    return {
      text: r?.text || '', ct: r?.coversThroughTurn, cw: r?.coversWechatCount,
      keepRP: r?.keepRPTurns, keepWx: r?.keepWechatCount,
      totalWx: wx.length, firstWx: wx[0]?.content, lastWx: wx[wx.length - 1]?.content
    };
  });
  check('前情提要已生成，覆盖全部 3 轮 RP',
    recapState.text.includes('林晚') && recapState.ct === 3,
    `ct=${recapState.ct}`);
  check('覆盖全部微信消息（全量压缩）',
    recapState.cw === recapState.totalWx && recapState.totalWx > 0,
    `cw=${recapState.cw} total=${recapState.totalWx}`);
  check('保留条数随压缩快照进 recap 对象',
    recapState.keepRP === 2 && recapState.keepWx === 6,
    `keepRP=${recapState.keepRP} keepWx=${recapState.keepWx}`);

  // 生成一轮 RP：上下文应含提要、被覆盖的老轮次全部剔除（全量压缩后只剩提要 + 本轮）
  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.userInput = 'RP 后续输入';
    await root.sendMessage();
    await new Promise(r => setTimeout(r, 400));
  });
  const recapRp = [...captured].reverse().find(c => !c.isWechat && !c.isRecap);
  check('RP 上下文含前情提要块',
    !!recapRp && recapRp.contents.some(c => c.includes('【前情提要')));
  check('保留窗口把最近 2 轮 RP 原文放进独立消息（摘要之后）',
    !!recapRp && recapRp.contents.some(c => c.includes('最近 RP 原文'))
    && recapRp.contents.some(c => c.includes('RP第二助手句'))
    && recapRp.contents.some(c => c.includes('RP第三助手句')),
    'tail 应含第 2、3 轮原文');
  check('超出保留窗口的更早轮次仍剔除',
    !!recapRp && !recapRp.contents.some(c => c.includes('RP第一助手句')));

  // 进微信：system 含提要、历史剔除被覆盖的旧内容
  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    await root.openWechat();
    root.wechatInput = '微信后续';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 400));
  });
  const recapWx = [...captured].reverse().find(c => c.isWechat);
  check('微信侧前情提要在对话记录里、不再进 system',
    !!recapWx && !recapWx.sysContent.includes('【前情提要】')
    && recapWx.contents.some(c => c.includes('【前情提要')));
  check('前情提要排在微信历史首条（未被覆盖内容之前）',
    !!recapWx && recapWx.contents.findIndex(c => c.includes('【前情提要')) === 1,
    recapWx ? String(recapWx.contents[1] || '').slice(0, 24) : '');
  check('微信历史剔除被覆盖的旧微信段',
    !!recapWx && !!recapState.firstWx && !recapWx.contents.some(c => c.includes(recapState.firstWx)),
    recapState.firstWx);
  check('微信侧保留窗口把最近微信原文放进独立消息',
    !!recapWx && recapWx.contents.some(c => c.includes('最近微信原文'))
    && !!recapState.lastWx && recapWx.contents.some(c => c.includes(recapState.lastWx)),
    recapState.lastWx);
  check('微信历史保留未覆盖的新微信段',
    !!recapWx && recapWx.contents.some(c => c.includes('微信后续')));

  console.log('\n== 前情提要：压缩素材按统一时间线交错 ==');
  const orderCallStart = captured.length;
  await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.memorySettings.enabled = false;
    root.memorySettings.classicModel = 'mock-model';
    root.user.name = 'lin';
    root.characters.push({
      name: '小I', description: '交错压缩', personality: 'x', first_mes: '开场I。',
      avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      uuid: 'test-uuid-recap-order', createdAt: Date.now(),
      wechatEnabled: true, wechatPeerName: '小I', wechatSpeed: 'fast'
    });
    await root.selectCharacter(root.characters.length - 1, false, { silent: true });
    const sendRp = async (text) => { root.userInput = text; await root.sendMessage(); await new Promise(r => setTimeout(r, 400)); };
    const sendWx = async (text) => {
      await root.openWechat(); root.wechatInput = text;
      await root.sendWechatMessage(); await new Promise(r => setTimeout(r, 400));
      await root.closeWechat();
    };
    // RP1 → 微信1 → RP2 → 微信2 → RP3：压缩素材必须原样保持这个先后
    await sendRp('RP甲轮输入'); await sendWx('微信甲段');
    await sendRp('RP乙轮输入'); await sendWx('微信乙段');
    await sendRp('RP丙轮输入');
    await root.runStoryRecap();
    await new Promise(r => setTimeout(r, 500));
  });
  const orderCall = captured.slice(orderCallStart).find(c => c.isRecap);
  const orderMaterial = orderCall
    ? (orderCall.contents.find(c => c.includes('RP甲轮输入')) || '') : '';
  const at = (needle) => orderMaterial.indexOf(needle);
  check('压缩素材按 RP1→微信1→RP2→微信2→RP3 交错',
    at('RP甲轮输入') >= 0 && at('微信甲段') > at('RP甲轮输入')
    && at('RP乙轮输入') > at('微信甲段') && at('微信乙段') > at('RP乙轮输入')
    && at('RP丙轮输入') > at('微信乙段'),
    `rp1=${at('RP甲轮输入')} wx1=${at('微信甲段')} rp2=${at('RP乙轮输入')} wx2=${at('微信乙段')} rp3=${at('RP丙轮输入')}`);

  console.log('\n== RP 主动发起微信：tool_wechat ==');

  // 未开微信的角色：即使工具是开着的，也不该进模型工具表（没有落点）
  const noWxTool = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.memorySettings.enabled = false;
    root.settings.apiUrl = 'https://mock.local/v1';
    root.settings.apiKey = 'k';
    root.settings.model = 'mock-model';
    root.characters.push({
      name: '小N', description: '未开微信', personality: 'x', first_mes: '开场N。',
      avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      uuid: 'test-uuid-no-wx', createdAt: Date.now(), wechatEnabled: false
    });
    await root.selectCharacter(root.characters.length - 1, false, { silent: true });
    const tool = root.activeTools.find(t => t.id === 'tool_wechat');
    const existed = !!tool;
    const defaultEnabled = tool?.enabled;
    if (tool) tool.enabled = true;
    root.userInput = '普通一轮';
    await root.sendMessage();
    await new Promise(r => setTimeout(r, 400));
    const after = root.activeTools.find(t => t.id === 'tool_wechat');
    if (after) after.enabled = defaultEnabled === true;
    return { existed, defaultEnabled };
  });
  const noWxCall = [...captured].reverse().find(c => !c.isWechat && !c.isRecap);
  check('内置默认存在 tool_wechat 且默认关闭',
    noWxTool.existed === true && noWxTool.defaultEnabled === false,
    JSON.stringify(noWxTool));
  check('未开微信的角色：tool_wechat 不进模型工具表',
    !!noWxCall && !noWxCall.toolNames.includes('tool_wechat'),
    noWxCall ? 'tools=[' + noWxCall.toolNames.join(',') + ']' : 'no call');

  // 开微信的角色：模型调用 tool_wechat → 面板在本轮 RP 结束后自动弹出并发出这条微信
  const activeWx = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    const waitFor = async (fn, timeout = 6000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (fn()) return true;
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    };
    root.characters.push({
      name: '小W', description: '主动微信', personality: 'x', first_mes: '开场W。',
      avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      uuid: 'test-uuid-active-wx', createdAt: Date.now(),
      wechatEnabled: true, wechatPeerName: '小W', wechatSpeed: 'fast', wechatStickerRate: 'off'
    });
    await root.selectCharacter(root.characters.length - 1, false, { silent: true });
    root.settings.apiUrl = 'https://mock.local/v1';
    root.settings.apiKey = 'k';
    root.settings.model = 'mock-model';
    const enable = (value) => {
      const tool = root.activeTools.find(t => t.id === 'tool_wechat');
      if (tool) tool.enabled = value;
    };
    enable(true);
    root.userInput = '触发微信：今天先这样吧';
    await root.sendMessage();
    const panelOpened = await waitFor(() => root.showWechatPanel === true);
    const delivered = await waitFor(() => root.wechatTimeline.some(i => i.channel === 'wechat' && i.content === '在吗，睡了吗'));
    await waitFor(() => root.isWechatGenerating === false);
    const last = root.chatHistory[root.chatHistory.length - 1];
    const result = {
      panelOpened,
      delivered,
      wechatContents: root.wechatTimeline.filter(i => i.channel === 'wechat').map(i => i.content),
      lastRole: last?.role,
      lastContent: String(last?.content || ''),
      toolIds: (last?.toolCalls || []).map(toolCall => toolCall.toolId),
      generating: root.isWechatGenerating
    };
    enable(false);
    await root.closeWechat();
    return result;
  });
  check('微信面板在本轮 RP 结束后自动弹出', activeWx.panelOpened === true);
  check('角色的那句话发进了微信时间线', activeWx.delivered === true, JSON.stringify(activeWx.wechatContents));
  check('RP 正文照常生成（未被工具吞掉）',
    activeWx.lastRole === 'assistant' && activeWx.lastContent.includes('那你歇会儿'),
    activeWx.lastContent.slice(0, 30));
  check('工具调用记为 tool_wechat', activeWx.toolIds.includes('tool_wechat'), JSON.stringify(activeWx.toolIds));
  check('消息发完后不再处于「正在输入」', activeWx.generating === false);

  const wxRounds = captured.filter(c => !c.isWechat && !c.isRecap && c.toolNames.includes('tool_wechat'));
  const wxFirstCall = wxRounds.find(c => !c.hasToolResult);
  check('开启后模型工具表暴露 tool_wechat', wxRounds.length >= 1, 'rounds=' + wxRounds.length);
  check('工具结果以 tool 消息回传后才续写正文',
    wxRounds.some(c => !c.hasToolResult) && wxRounds.some(c => c.hasToolResult),
    wxRounds.map(c => (c.hasToolResult ? 'tool' : 'first')).join(','));
  check('切角色后不把上个角色的微信记录带进 RP 上下文',
    !!wxFirstCall && !wxFirstCall.contents.some(c => c.includes('微信甲段') || c.includes('微信乙段')),
    wxFirstCall ? JSON.stringify(wxFirstCall.contents.map(c => c.slice(0, 14))) : 'no call');

  // 提示词：模型光看到 tools 数组还不够，system 里必须有「怎么用」的说明
  check('RP system prompt 含 active_tools 区块',
    !!wxFirstCall && wxFirstCall.sysContent.includes('<active_tools>'));
  check('RP system prompt 含 tool_wechat 调用说明',
    !!wxFirstCall && wxFirstCall.sysContent.includes('主动发微信工具只在剧情自然需要私下联系时使用'),
    wxFirstCall ? wxFirstCall.sysContent.split('\n').filter(l => l.includes('微信')).join(' | ').slice(0, 160) : 'no call');
  check('RP system prompt 列出 tool_wechat 及其描述',
    !!wxFirstCall
    && wxFirstCall.sysContent.includes('tool_wechat（主动发微信）')
    && wxFirstCall.sysContent.includes('content 写成真人微信口吻的短消息'),
    '');
  check('未开微信的角色：system prompt 不含 tool_wechat 说明',
    !!noWxCall && !noWxCall.sysContent.includes('tool_wechat'));

  console.log('\n== 工具说明按类型裁剪 + 开关错配提示 ==');
  check('只开微信工具时不下发检索专用说明',
    !!wxFirstCall
    && !wxFirstCall.sysContent.includes('检索工具的 query')
    && !wxFirstCall.sysContent.includes('检索未命中')
    && !wxFirstCall.sysContent.includes('对话片段和网页'),
    wxFirstCall ? wxFirstCall.sysContent.split('\n').filter(l => l.includes('检索')).join(' | ').slice(0, 120) : 'no call');

  const notice = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    const read = () => {
      const n = root.wechatActiveToolNotice;
      return n ? `${n.kind}:${n.actionLabel}` : null;
    };
    const domText = () => {
      const el = document.querySelector('.chat-view-root .wx-tool-notice');
      return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
    };
    const setTool = (value) => {
      const tool = root.activeTools.find(item => item.id === 'tool_wechat');
      if (tool) tool.enabled = value;
    };
    const wait = () => new Promise(r => setTimeout(r, 80));
    const noWxIndex = root.characters.findIndex(c => c.uuid === 'test-uuid-no-wx');
    const wxIndex = root.characters.findIndex(c => c.uuid === 'test-uuid-active-wx');
    const out = {};

    // 角色没开微信 + 工具开着 → 提示「角色未开启微信」
    await root.selectCharacter(noWxIndex, false, { silent: true });
    setTool(true);
    await wait();
    out.charOff = read();
    out.charOffDom = domText();

    // 两边都没开 → 不提示
    setTool(false);
    await wait();
    out.bothOff = read();

    // 角色开了微信 + 工具没开 → 提示去打开工具
    await root.selectCharacter(wxIndex, false, { silent: true });
    await wait();
    out.toolOff = read();
    out.toolOffDom = domText();

    // 两边都开 → 不提示
    setTool(true);
    await wait();
    out.bothOn = read();

    // 关掉后不再提示
    root.dismissWechatActiveToolNotice();
    setTool(false);
    await wait();
    out.afterDismiss = read();

    setTool(false);
    return out;
  });
  check('工具开/角色微信关 → 提示角色未开启微信',
    notice.charOff === 'char-off:去开启', String(notice.charOff));
  check('该提示渲染进聊天页 DOM',
    !!notice.charOffDom && notice.charOffDom.includes('未开启微信'), String(notice.charOffDom));
  check('两边都没开 → 不提示', notice.bothOff === null, String(notice.bothOff));
  check('角色微信开/工具关 → 提示去打开工具',
    notice.toolOff === 'tool-off:去打开', String(notice.toolOff));
  check('该提示渲染进聊天页 DOM',
    !!notice.toolOffDom && notice.toolOffDom.includes('主动发微信'), String(notice.toolOffDom));
  check('两边都开 → 不提示', notice.bothOn === null, String(notice.bothOn));
  check('关掉后不再提示', notice.afterDismiss === null, String(notice.afterDismiss));

  console.log('\n== 清空聊天记录联动清除前情提要 ==');
  const afterClear = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    // 直接走清空逻辑（confirmAction 在无头下不可点，改调底层清理等价路径）
    root.chatHistory = [];
    root.classicMemories = [];
    root.clearStoryRecapSilently?.();
    await new Promise(r => setTimeout(r, 200));
    return { recap: root.storyRecap };
  });
  check('清空后前情提要被清除（不再作为对话首条）', !afterClear.recap,
    afterClear.recap ? String(afterClear.recap.text || '').slice(0, 20) : 'null');

  console.log('\nERRORS(' + errors.length + '):');
  errors.slice(0, 15).forEach(e => console.log('  ' + e));

  await browser.close();
  server.close();
  const failed = results.filter(r => !r.ok).length;
  const ok = failed === 0 && errors.length === 0;
  console.log('\n' + (ok ? 'WECHAT E2E: PASS' : `WECHAT E2E: FAIL (${failed} checks, ${errors.length} errors)`));
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('SMOKE CRASH:', e); server.close(); process.exit(2); });
