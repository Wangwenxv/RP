// 微信单条消息编辑/删除 E2E 冒烟（无头 Edge）
// 覆盖：操作菜单定位、文字编辑与取消、空内容守卫、空回标记作废、删除确认与落库、
//       生成中禁用、下一轮请求体、前情提要覆盖计数左移、RP 编辑后回灌摘要即时对账。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 18126;
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('console', msg => {
    const t = msg.text();
    if (msg.type() === 'error' && !/Failed to load resource|gstatic|tailwind|nai\.sta1n|favicon|mock\.local/.test(t)) {
      errors.push('[console.error] ' + t.slice(0, 200));
    }
  });
  page.on('pageerror', err => errors.push('[pageerror] ' + err.message));

  await page.addInitScript(() => {
    // CDN 不通时的兜底：足够让 runtime-services 的 renderer 构造成功
    if (!window.marked) {
      const Renderer = function () { };
      Renderer.prototype.link = (href, title, text) => String(text || '');
      Renderer.prototype.html = (token) => String(typeof token === 'string' ? token : (token && token.text) || '');
      window.marked = { use() { }, parse: (t) => String(t), Renderer };
    }
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
  await page.route('**/chat/completions', async route => {
    let body = null;
    try { body = route.request().postDataJSON(); } catch (_) { }
    const msgs = body?.messages || [];
    captured.push({
      roles: msgs.map(m => m.role).join(','),
      contents: msgs.map(m => typeof m.content === 'string' ? m.content : '[parts]')
    });
    const content = JSON.stringify({ messages: [{ type: 'text', content: '嗯' }] });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    });
  });

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 30000 });

  let rootOk = false;
  for (let round = 0; round < 3 && !rootOk; round++) {
    for (let i = 0; i < 60; i++) {
      rootOk = await page.evaluate(() => {
        const r = window.__APP_PROXY__;
        return !!(r && Array.isArray(r.characters) && typeof r.deleteWechatMessage === 'function'
          && typeof r.saveWechatEdit === 'function');
      });
      if (rootOk) break;
      await page.waitForTimeout(250);
    }
    if (!rootOk) await page.reload({ waitUntil: 'load' });
  }
  if (!rootOk) { console.log('根 proxy 未就绪，终止（多为 CDN 网络问题）'); process.exit(1); }

  console.log('\n== 建角色 + 铺一条已知时间线 ==');
  const seed = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.user.name = '阿伟';
    root.settings.apiUrl = 'https://mock.local/v1';
    root.settings.apiKey = 'k';
    root.settings.model = 'mock-model';
    root.characters.push({
      name: '小B', description: '楼下书店老板', personality: '慢性子',
      first_mes: '……来了。', mes_example: '', avatar: '',
      uuid: 'test-uuid-edit', createdAt: Date.now(),
      wechatEnabled: true, wechatPeerName: '小B', wechatRelation: '熟客', wechatScene: '傍晚', wechatSpeed: 'fast'
    });
    await root.selectCharacter(0, false, { silent: true });
    await root.openWechat();
    // RP 侧先来一句，用来验证「RP 改完直接继续聊」的即时对账
    root.chatHistory.push({ role: 'user', content: 'RP 原句：今天来晚了吗', id: 'rp-u1' });
    root.chatHistory.push({ role: 'assistant', content: 'RP 原句：不算晚。', id: 'rp-a1' });
    root.wechatTimeline.push(
      { id: 'wx-u1', ts: Date.now() - 9000, channel: 'wechat', role: 'user', type: 'text', content: '原话一' },
      { id: 'wx-a1', ts: Date.now() - 8000, channel: 'wechat', role: 'assistant', type: 'text', content: '回复一' },
      { id: 'wx-s1', ts: Date.now() - 7000, channel: 'wechat', role: 'assistant', type: 'sticker', content: '🙄' },
      { id: 'wx-u2', ts: Date.now() - 6000, channel: 'wechat', role: 'user', type: 'text', content: '原话二' }
    );
    await new Promise(r => setTimeout(r, 300));
    const target = root.wechatTimeline.find(i => i.id === 'wx-u1');
    return {
      panel: root.showWechatPanel === true,
      bubbles: document.querySelectorAll('.wx-root .wx-bubble').length,
      canEditText: root.canEditWechatMessage(target) === true,
      canEditSticker: root.canEditWechatMessage(root.wechatTimeline.find(i => i.id === 'wx-s1')) === false
    };
  });
  check('微信面板已打开', seed.panel);
  check('4 条气泡渲染', seed.bubbles === 4, 'n=' + seed.bubbles);
  check('文字消息可编辑', seed.canEditText);
  check('表情消息不可编辑', seed.canEditSticker);

  console.log('\n== 操作菜单：定位与项数 ==');
  const menu = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    const rows = [...document.querySelectorAll('.wx-root .wx-row')];
    const row = rows.find(r => r.textContent.includes('原话一'));
    const btn = row?.querySelector('.wx-tool-btn');
    btn.click();
    await new Promise(r => setTimeout(r, 60));
    const menuEl = document.querySelector('.wx-msg-menu');
    const rect = menuEl?.getBoundingClientRect();
    const labels = [...(menuEl?.querySelectorAll('button') || [])].map(b => b.textContent.trim());
    return {
      open: root.wechatMenu.open,
      targetId: root.wechatMenu.id,
      labels,
      inViewport: !!rect && rect.left >= 0 && rect.top >= 0
        && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      hasMask: !!document.querySelector('.wx-msg-menu-mask')
    };
  });
  check('菜单打开且指向被点的消息', menu.open && menu.targetId === 'wx-u1', menu.targetId);
  check('文字消息菜单含 编辑/复制/删除', JSON.stringify(menu.labels) === JSON.stringify(['编辑', '复制', '删除']), JSON.stringify(menu.labels));
  check('菜单在视口内（不被裁切）', menu.inViewport);
  check('存在透明点击遮罩', menu.hasMask);

  console.log('\n== 编辑：进入 / 取消 / 保存 ==');
  const editFlow = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    const menuEdit = [...document.querySelectorAll('.wx-msg-menu button')].find(b => b.textContent.trim() === '编辑');
    menuEdit.click();
    await new Promise(r => setTimeout(r, 80));
    const ta = document.querySelector('.wx-root .wx-edit-input');
    const entered = {
      editingId: root.wechatEditingId,
      draft: root.wechatEditDraft,
      textarea: !!ta,
      focused: document.activeElement === ta,
      rowEditing: !!document.querySelector('.wx-root .wx-row.is-editing'),
      menuClosed: root.wechatMenu.open === false
    };
    // 取消不改内容
    root.wechatEditDraft = '不该保存的草稿';
    root.cancelWechatEdit();
    await new Promise(r => setTimeout(r, 60));
    const afterCancel = {
      content: root.wechatTimeline.find(i => i.id === 'wx-u1').content,
      editingId: root.wechatEditingId,
      textareaGone: !document.querySelector('.wx-root .wx-edit-input')
    };
    return { entered, afterCancel };
  });
  check('进入编辑：id 与草稿就位', editFlow.entered.editingId === 'wx-u1' && editFlow.entered.draft === '原话一');
  check('编辑框渲染并自动聚焦', editFlow.entered.textarea && editFlow.entered.focused);
  check('行进入编辑态且菜单关闭', editFlow.entered.rowEditing && editFlow.entered.menuClosed);
  check('取消不改内容且退出编辑', editFlow.afterCancel.content === '原话一'
    && editFlow.afterCancel.editingId === '' && editFlow.afterCancel.textareaGone);

  const saveFlow = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    await root.startWechatEdit('wx-u1');
    root.wechatEditDraft = '  改过的第一句  ';
    await root.saveWechatEdit();
    await new Promise(r => setTimeout(r, 150));
    const item = root.wechatTimeline.find(i => i.id === 'wx-u1');
    const bubbleText = [...document.querySelectorAll('.wx-root .wx-bubble')].map(b => b.textContent.trim());
    return {
      content: item.content,
      editedAt: Number(item.editedAt) > 0,
      editingId: root.wechatEditingId,
      bubbleText
    };
  });
  check('保存后时间线内容已更新（去首尾空白）', saveFlow.content === '改过的第一句', saveFlow.content);
  check('写入 editedAt 便于追溯', saveFlow.editedAt);
  check('保存后退出编辑态', saveFlow.editingId === '');
  check('气泡显示新文案', saveFlow.bubbleText.includes('改过的第一句') && !saveFlow.bubbleText.includes('原话一'), JSON.stringify(saveFlow.bubbleText));

  const emptyGuard = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    await root.startWechatEdit('wx-u1');
    root.wechatEditDraft = '   ';
    await root.saveWechatEdit();
    await new Promise(r => setTimeout(r, 60));
    return {
      editingId: root.wechatEditingId,
      content: root.wechatTimeline.find(i => i.id === 'wx-u1').content,
      toasts: [...document.querySelectorAll('body *')].filter(el => el.textContent === '消息不能为空，不想留可以删除这一条').length
    };
  });
  check('空内容不落库、保持编辑态', emptyGuard.editingId === 'wx-u1' && emptyGuard.content === '改过的第一句');
  check('空内容给出提示', emptyGuard.toasts > 0);
  await page.evaluate(() => window.__APP_PROXY__.cancelWechatEdit());

  console.log('\n== 编辑用户消息：作废「空回」标记 ==');
  const silenceReset = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    const last = root.wechatTimeline.find(i => i.id === 'wx-u2');
    last.replyDecision = 'silent';
    last.replySilence = { reason: 'topic_closed', summary: '没什么可说的', awareness: 'read', decidedAt: Date.now() };
    const before = root.wechatUnansweredCount;
    // 编辑的是更早那条，不该影响这条的沉默结论
    await root.startWechatEdit('wx-u1');
    root.wechatEditDraft = '改过的第一句 v2';
    await root.saveWechatEdit();
    const untouched = root.wechatTimeline.find(i => i.id === 'wx-u2').replyDecision === 'silent';
    await root.startWechatEdit('wx-u2');
    root.wechatEditDraft = '原话二（改）';
    await root.saveWechatEdit();
    await new Promise(r => setTimeout(r, 80));
    const item = root.wechatTimeline.find(i => i.id === 'wx-u2');
    return {
      before,
      untouched,
      cleared: item.replyDecision === undefined && item.replySilence === undefined,
      after: root.wechatUnansweredCount,
      buttonText: document.querySelector('.wx-reply-trigger')?.textContent?.trim() || ''
    };
  });
  check('只有被编辑的那条失去沉默标记', silenceReset.untouched);
  check('编辑后清掉 replyDecision / replySilence', silenceReset.cleared);
  check('未回复计数回到 1', silenceReset.after === 1, 'before=' + silenceReset.before + ' after=' + silenceReset.after);
  check('「让对方回复」按钮重新出现', silenceReset.buttonText.includes('让对方回复'), silenceReset.buttonText);

  console.log('\n== 生成中禁止改动 ==');
  const busyGuard = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.isWechatGenerating = true;
    await root.startWechatEdit('wx-u1');
    const editBlocked = root.wechatEditingId === '';
    root.deleteWechatMessage('wx-a1');
    const deleteBlocked = root.showConfirmModal === false;
    root.isWechatGenerating = false;
    return { editBlocked, deleteBlocked };
  });
  check('生成中不能进入编辑', busyGuard.editBlocked);
  check('生成中不能发起删除', busyGuard.deleteBlocked);

  console.log('\n== 删除：确认 → 落库 → 重新打开仍在 ==');
  const del = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    const before = root.wechatTimeline.filter(i => i.channel === 'wechat').length;
    root.deleteWechatMessage('wx-a1');
    const prompt = root.confirmMessage;
    const modalOpen = root.showConfirmModal === true;
    root.handleConfirm();
    await new Promise(r => setTimeout(r, 300));
    const after = root.wechatTimeline.filter(i => i.channel === 'wechat').length;
    const bubbles = [...document.querySelectorAll('.wx-root .wx-bubble')].map(b => b.textContent.trim());
    return { before, after, prompt, modalOpen, bubbles, gone: !root.wechatTimeline.some(i => i.id === 'wx-a1') };
  });
  check('删除前弹出确认框', del.modalOpen && del.prompt.includes('确定删除'));
  check('时间线少一条且目标已移除', del.before - del.after === 1 && del.gone, `${del.before}→${del.after}`);
  check('气泡同步消失', !del.bubbles.includes('回复一'), JSON.stringify(del.bubbles));

  const persist = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    await root.closeWechat();
    await root.openWechat();
    await new Promise(r => setTimeout(r, 400));
    return {
      hasDeleted: root.wechatTimeline.some(i => i.id === 'wx-a1'),
      hasEdited: root.wechatTimeline.find(i => i.id === 'wx-u1')?.content
    };
  });
  check('重新打开后删除仍生效（IndexedDB）', persist.hasDeleted === false);
  check('重新打开后编辑仍生效', persist.hasEdited === '改过的第一句 v2', persist.hasEdited);

  console.log('\n== 下一轮请求体：新文案进、旧文案走 ==');
  const reqBody = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.wechatInput = '那我要一杯热的';
    await root.sendWechatMessage();
    await new Promise(r => setTimeout(r, 700));
    return { generating: root.isWechatGenerating };
  });
  const wxReq = [...captured].reverse().find(c => c.contents.some(x => x.includes('那我要一杯热的')));
  const flat = (wxReq?.contents || []).join('\n');
  check('请求里带改后的句子', flat.includes('改过的第一句 v2'));
  check('请求里不再有被改掉的原话', !flat.includes('原话一'));
  check('请求里带第二处改动', flat.includes('原话二（改）'));
  check('请求里不带被删的那条', !flat.includes('回复一'));
  check('生成结束状态复位', reqBody.generating === false);

  console.log('\n== RP 编辑/删除后：镜像与回灌一起对齐 ==');
  const rpSync = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    // 先让 RP 侧的三条消息都进镜像
    await root.closeWechat();
    await root.openWechat();
    const mirroredBefore = root.wechatTimeline.filter(i => i.channel === 'rp').length;
    // 改一句、删一句，再重进微信（reconcile 在这里生效）
    root.chatHistory.find(m => m.id === 'rp-u1').content = 'RP 改过的句子：今天来晚了吗';
    root.chatHistory = root.chatHistory.filter(m => m.id !== 'rp-a1');
    await root.closeWechat();
    await root.openWechat();
    await new Promise(r => setTimeout(r, 300));
    const mirrorContent = root.wechatTimeline.find(i => i.channel === 'rp' && i.rpMsgId === 'rp-u1')?.content || '';
    return {
      mirroredBefore,
      mirrorContent,
      mirrorGone: !root.wechatTimeline.some(i => i.channel === 'rp' && i.rpMsgId === 'rp-a1')
    };
  });
  check('RP 消息已进入镜像', rpSync.mirroredBefore >= 3, 'n=' + rpSync.mirroredBefore);
  check('RP 编辑后镜像文案同步', rpSync.mirrorContent.includes('RP 改过的句子'), rpSync.mirrorContent.slice(0, 24));
  check('RP 删除后镜像一并移除', rpSync.mirrorGone);

  const digest = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.userInput = 'RP 这边接着说：那我先回去了';
    await root.sendMessage();
    await new Promise(r => setTimeout(r, 600));
    return true;
  });
  // 回灌摘要取最近一次 RP 请求体：本轮用户消息 + 微信聊天记录块
  const rpReq = [...captured].reverse().find(c => c.contents.some(x => x.includes('那我先回去了')));
  const rpFlat = (rpReq?.contents || []).join('\n');
  check('RP 请求里带微信聊天记录块', rpFlat.includes('【微信聊天记录'));
  check('回灌摘要含微信侧改后的句子', rpFlat.includes('改过的第一句 v2'), digest === true ? '' : 'no-run');
  check('回灌摘要不含被删掉的句子', !rpFlat.includes('回复一'));

  console.log('\n== 前情提要覆盖计数随删除左移 ==');
  const recap = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    root.storyRecap = { text: '此前的提要', coversThroughTurn: 0, coversWechatCount: 2, keepRPTurns: 3, keepWechatCount: 6, createdAt: Date.now() };
    const plainWx = () => root.wechatTimeline.filter(i => i.channel === 'wechat' && i.role !== 'system');
    // 覆盖段内（第 0 条）删除 → 计数减一
    const first = plainWx()[0].id;
    root.deleteWechatMessage(first);
    root.handleConfirm();
    await new Promise(r => setTimeout(r, 250));
    const afterCovered = root.storyRecap.coversWechatCount;
    // 覆盖段外（现在第 1 条）删除 → 计数不动
    const outside = plainWx()[1].id;
    root.deleteWechatMessage(outside);
    root.handleConfirm();
    await new Promise(r => setTimeout(r, 250));
    return { afterCovered, afterOutside: root.storyRecap.coversWechatCount };
  });
  check('覆盖段内删除 → 计数减一', recap.afterCovered === 1, 'after=' + recap.afterCovered);
  check('覆盖段外删除 → 计数不动', recap.afterOutside === 1, 'after=' + recap.afterOutside);

  console.log('\n== 清空记录同时复位编辑/菜单 ==');
  const clear = await page.evaluate(async () => {
    const root = window.__APP_PROXY__;
    await root.startWechatEdit(root.wechatTimeline.find(i => i.channel === 'wechat')?.id || '');
    await root.clearWechatTimeline();
    await root.clearConversationContent('all');
    return {
      editingId: root.wechatEditingId,
      menuOpen: root.wechatMenu.open,
      remaining: root.wechatTimeline.filter(i => i.channel === 'wechat').length
    };
  });
  check('清空后退出编辑态', clear.editingId === '');
  check('清空后菜单关闭', clear.menuOpen === false);
  check('微信消息已清空', clear.remaining === 0, 'n=' + clear.remaining);

  console.log('\n== 无 JS 错误 ==');
  check('无 pageerror / console.error', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter(r => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  await browser.close();
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
