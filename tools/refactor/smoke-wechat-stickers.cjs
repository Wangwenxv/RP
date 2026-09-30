// 表情包库 + 粘贴图片 + 改头像 —— 短验证（无头 Edge）
// 只验新增链路，不复跑 smoke-wechat.cjs 的全量场景。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 18129;
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
  page.on('console', msg => {
    const t = msg.text();
    if (msg.type() === 'error' && !/Failed to load resource|gstatic|tailwindcss|favicon|mock\.local/.test(t)) {
      errors.push('[console.error] ' + t.slice(0, 200));
    }
  });
  page.on('pageerror', err => errors.push('[pageerror] ' + err.message));

  await page.addInitScript(() => {
    window.marked = window.marked || {
      use() { }, parse: (t) => String(t),
      // 真实 marked 有 Renderer，runtime-services 会 new 它；stub 补上免得初始化中断
      Renderer: function () { this.html = (t) => String(t); }
    };
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

  // 模型固定回一条「名字表情包」，用来验命中库 → 贴图
  const captured = [];
  await page.route('**/chat/completions', async route => {
    let body = null;
    try { body = route.request().postDataJSON(); } catch (_) { }
    const msgs = body?.messages || [];
    const sysContent = String(msgs[0]?.content || '');
    const isWechat = sysContent.includes('你只能输出一个 JSON 对象');
    captured.push({
      isWechat, sysContent,
      // 聊天记录（不含 system），用来验表情包在上下文里怎么呈现
      chatContents: msgs.slice(1).map(m => typeof m.content === 'string' ? m.content : '[parts]')
    });
    const content = isWechat
      ? JSON.stringify({ messages: [{ type: 'sticker', content: '伤心猫' }] })
      : '（继续画着）……嗯。';
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    });
  });

  // 表情包 CDN 图片：返回 tiny PNG，避免测试联网（也验证 crossOrigin 压缩链路）
  const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await page.route(/EmojiPackage/, async route => {
    // crossOrigin='anonymous' 的图片请求要求响应带 ACAO，否则加载失败（真实 CDN 会带）
    await route.fulfill({
      status: 200, contentType: 'image/png',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: TINY_PNG
    });
  });

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 30000 });

  let rootOk = false;
  for (let round = 0; round < 3 && !rootOk; round++) {
    for (let i = 0; i < 60; i++) {
      rootOk = await page.evaluate(() => {
        const r = window.__APP_PROXY__;
        return !!(r && Array.isArray(r.characters) && typeof r.saveSticker === 'function'
          && typeof r.handleWechatPaste === 'function' && typeof r.handleWechatAvatarSelection === 'function');
      });
      if (rootOk) break;
      await page.waitForTimeout(250);
    }
    if (!rootOk) await page.reload({ waitUntil: 'load' });
  }
  if (!rootOk) { console.log('根 proxy 未就绪，终止（多为 CDN 网络问题）'); process.exit(1); }

  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await page.evaluate((b64) => {
    window.__mkPng = () => {
      const bin = atob(b64); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new File([arr], 'a.png', { type: 'image/png' });
    };
  }, PNG);

  console.log('\n== 建角色 + 开微信 ==');
  const setup = await page.evaluate(async () => {
    const r = window.__APP_PROXY__;
    r.user.name = '阿伟';
    r.characters.push({
      name: '小A', description: '安静的插画师', personality: '嘴硬心软', first_mes: '……你好。',
      avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      uuid: 'test-uuid-sticker', createdAt: Date.now(),
      wechatEnabled: true, wechatPeerName: '小A', wechatRelation: '老同学', wechatScene: '深夜', wechatSpeed: 'fast',
      wechatStickerRate: 'normal'
    });
    await r.selectCharacter(0, false, { silent: true });
    r.settings.apiUrl = 'https://mock.local/v1';
    r.settings.apiKey = 'k';
    r.settings.model = 'mock-model';
    await r.openWechat();
    return { name: r.currentCharacter?.name };
  });
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => !!document.querySelector('.wx-root'));
  check('微信覆盖层已打开', opened, setup.name);

  console.log('\n== 表情包库 CRUD ==');
  const added = await page.evaluate(async () => {
    const r = window.__APP_PROXY__;
    r.stickerDraft.name = '伤心猫';
    r.stickerDraft.description = '委屈、想被安慰时用';
    r.stickerDraft.image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await r.saveSticker();
    return { count: r.wechatStickers.length, name: r.wechatStickers[0]?.name };
  });
  check('表情包已入库', added.count === 1 && added.name === '伤心猫', JSON.stringify(added));

  const dup = await page.evaluate(async () => {
    const r = window.__APP_PROXY__;
    r.stickerDraft.name = '伤心猫';
    r.stickerDraft.image = 'data:image/png;base64,AAAA';
    await r.saveSticker();
    const n = r.wechatStickers.length;
    r.resetStickerDraft();
    return n;
  });
  check('重名被拒绝（数量不变）', dup === 1, 'n=' + dup);

  console.log('\n== 目录注入 + 命中贴图 ==');
  await page.evaluate(async () => {
    const r = window.__APP_PROXY__;
    r.wechatInput = '在吗';
    await r.sendWechatMessage();
  });
  await page.waitForTimeout(600);
  const wxCall = captured.filter(c => c.isWechat).pop();
  check('system prompt 注入【表情包库】目录', !!wxCall && wxCall.sysContent.includes('【表情包库】') && wxCall.sysContent.includes('伤心猫｜委屈、想被安慰时用'));

  const rendered = await page.evaluate(() => {
    const r = window.__APP_PROXY__;
    const items = r.wechatDisplayItems.filter(i => i.type === 'sticker');
    return { hasImage: items.length > 0 && items.every(i => !!i.stickerImage), domImg: document.querySelectorAll('.wx-root .wx-sticker-img').length };
  });
  check('命中库的表情包渲染成 <img>', rendered.hasImage && rendered.domImg >= 1, JSON.stringify(rendered));

  console.log('\n== 用户发表情包 ==');
  const sentSticker = await page.evaluate(async () => {
    const r = window.__APP_PROXY__;
    const before = r.wechatTimeline.filter(i => i.channel === 'wechat' && i.type === 'sticker' && i.role === 'user').length;
    await r.sendWechatSticker(r.wechatStickers[0]);
    const after = r.wechatTimeline.filter(i => i.channel === 'wechat' && i.type === 'sticker' && i.role === 'user').length;
    return { before, after };
  });
  check('用户发出的表情包写进时间线', sentSticker.after === sentSticker.before + 1, JSON.stringify(sentSticker));

  console.log('\n== 粘贴图片 ==');
  const pasted = await page.evaluate(async () => {
    const r = window.__APP_PROXY__;
    r.wechatPendingImage = null;
    const dt = new DataTransfer();
    dt.items.add(window.__mkPng());
    const input = document.querySelector('.wx-input');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise(res => setTimeout(res, 400));
    return !!r.wechatPendingImage;
  });
  check('粘贴图片进入待发送区', pasted);

  console.log('\n== 改头像 ==');
  const avatar = await page.evaluate(async () => {
    const r = window.__APP_PROXY__;
    const char = r.currentCharacter;
    const before = char.avatar;
    await r.handleWechatAvatarSelection('peer', { target: { files: [window.__mkPng()], value: '' } });
    return { before, changed: char.avatar !== before && String(char.avatar).startsWith('data:image') };
  });
  check('微信内改角色头像写回 char.avatar', avatar.changed, JSON.stringify({ before: String(avatar.before).slice(0, 20) }));

  console.log('\n== 持久化（重开仍在）==');
  const persisted = await page.evaluate(async () => {
    const raw = await window.RPHubStorage.getStoredValue('wechat_stickers');
    return Array.isArray(raw) ? raw.map(s => s.name) : null;
  });
  check('wechat_stickers 已落盘', !!persisted && persisted.includes('伤心猫'), JSON.stringify(persisted));

  console.log('\n== 开源表情包商店导入 ==');
  const catalog = await page.evaluate(() => {
    const c = window.RPHubEmojiCatalog;
    return c ? { cats: c.categories.length, base: c.base, first: c.categories[0].name, files: c.categories[0].files.length } : null;
  });
  check('emoji-catalog 已加载', !!catalog && catalog.cats > 0 && catalog.base.startsWith('http'), JSON.stringify(catalog));

  const firstCat = catalog ? catalog.first : '难过';
  const imported = await page.evaluate(async (cat) => {
    const r = window.__APP_PROXY__;
    const files = r.stickerStoreVisible.filter(i => i.cat === cat).map(i => i.file).slice(0, 3);
    const before = r.wechatStickers.length;
    await r.importStickerStoreItems(files.map(f => ({ cat, file: f })));
    await new Promise(res => setTimeout(res, 200));
    const addedItems = r.wechatStickers.slice(before);
    return {
      before, after: r.wechatStickers.length,
      names: addedItems.map(s => s.name),
      allLocal: addedItems.every(s => String(s.image).startsWith('data:image/')),
      desc: addedItems[0]?.description
    };
  }, firstCat);
  check('导入本类前 3 张写入库', imported.after === imported.before + 3, JSON.stringify({ before: imported.before, after: imported.after }));
  check('静态图压缩存本地 dataURL', imported.allLocal, imported.names.join(','));
  check('描述取自文件名（非分类兜底）', !!imported.desc && imported.desc.length > 0 && imported.desc !== firstCat, imported.desc);

  const dupBlock = await page.evaluate(async (cat) => {
    const r = window.__APP_PROXY__;
    const items = r.stickerStoreVisible.filter(i => i.cat === cat).slice(0, 3).map(i => ({ cat: i.cat, file: i.file }));
    const before = r.wechatStickers.length;
    await r.importStickerStoreItems(items);
    await new Promise(res => setTimeout(res, 200));
    return { before, after: r.wechatStickers.length, loaded: r.stickerStoreItemState(cat, items[0].file) };
  }, firstCat);
  check('重复导入被跳过', dupBlock.after === dupBlock.before, JSON.stringify(dupBlock));
  check('已加入项在商店里标为 loaded', dupBlock.loaded === 'loaded');

  const gif = await page.evaluate(async () => {
    const r = window.__APP_PROXY__;
    const gifItem = r.stickerStoreVisible.find(i => /\.gif$/i.test(i.file));
    if (!gifItem) return null;
    await r.importStickerStoreItems([{ cat: gifItem.cat, file: gifItem.file }]);
    await new Promise(res => setTimeout(res, 200));
    const last = r.wechatStickers[r.wechatStickers.length - 1];
    return { file: gifItem.file, lastImage: String(last?.image || '').slice(0, 70), isUrl: /^https?:\/\//.test(String(last?.image || '')) };
  });
  if (gif) check('GIF 存 CDN 引用而非本地', gif.isUrl, gif.file + ' -> ' + gif.lastImage);
  else console.log('  SKIP  目录里没有 GIF，跳过动图检查');

  const storeRendered = await page.evaluate(() => {
    const r = window.__APP_PROXY__;
    r.openStickerStore();
    return new Promise(res => setTimeout(() => {
      res({ open: !!document.querySelector('.wx-store-grid'), cells: document.querySelectorAll('.wx-store-cell').length });
    }, 150));
  });
  check('商店模态渲染出缩略图网格', storeRendered.cells > 0, JSON.stringify(storeRendered));

  console.log('\n== 表情包上下文标记（模型知道这是表情包）==');
  const stickerCtx = await page.evaluate(async () => {
    const r = window.__APP_PROXY__;
    // 用户发一个库里已有的表情包（走连发，先不请求回复）
    r.wechatBurstMode = true;
    await r.sendWechatSticker(r.wechatStickers.find(s => s.name === '伤心猫'));
    await new Promise(res => setTimeout(res, 400));
    r.wechatBurstMode = false;
    await r.requestWechatReplyNow();
    await new Promise(res => setTimeout(res, 500));
    return r.wechatTimeline.filter(i => i.channel === 'wechat' && i.type === 'sticker').map(i => i.content);
  });
  const wxLast = captured.filter(c => c.isWechat).pop();
  const ctxHasMark = !!wxLast && wxLast.chatContents.some(c => c.includes('[表情 伤心猫]'));
  const ctxNoBareName = !!wxLast && !wxLast.chatContents.some(c => c.trim() === '伤心猫');
  check('模型上下文里表情包标为 [表情 名字]', ctxHasMark, (wxLast?.chatContents || []).filter(c => c.includes('[表情')).join(' | '));
  check('不再把表情包名当裸文字发', ctxNoBareName);

  console.log('\n== 连发：多条攒发再回复 ==');
  const burst = await page.evaluate(async () => {
    const r = window.__APP_PROXY__;
    const countUser = () => r.wechatTimeline.filter(i => i.channel === 'wechat' && i.role === 'user').length;
    const before = countUser();
    r.wechatPendingImage = null; // 前面粘贴测试残留的待发图会多算一条
    r.wechatBurstMode = true;
    for (const t of ['先说一句', '再说一句', '还有一句']) {
      r.wechatInput = t;
      await r.sendWechatMessage();
    }
    await new Promise(res => setTimeout(res, 300));
    return { added: countUser() - before, generating: r.isWechatGenerating, unanswered: r.wechatUnansweredCount };
  });
  check('连发时只落气泡、不立刻请求回复',
    burst.added === 3 && burst.generating === false, JSON.stringify(burst));

  const callsBefore = captured.filter(c => c.isWechat).length;
  const reply = await page.evaluate(async () => {
    const r = window.__APP_PROXY__;
    await r.requestWechatReplyNow();
    await new Promise(res => setTimeout(res, 600));
    return { generating: r.isWechatGenerating };
  });
  const callsAfter = captured.filter(c => c.isWechat).length;
  check('点「让对方回复」触发一次带上下文请求',
    callsAfter === callsBefore + 1, JSON.stringify({ added: callsAfter - callsBefore, ...reply }));

  console.log('\nERRORS(' + errors.length + '):');
  errors.forEach(e => console.log('  ' + e));

  const failed = results.filter(r => !r.ok).length;
  console.log('\nSTICKER E2E: ' + (failed === 0 && errors.length === 0 ? 'PASS' : 'FAIL') + ` (${results.length} checks, ${failed} failed)`);

  await browser.close();
  server.close();
  process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
})();
