// Real Vue, Edge and IndexedDB; model responses are fixtures, no real API keys.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..');
const requests = [], errors = [];
let tearingDown = false;
// Playwright 1.49 can reject an internal navigation promise when Edge disposes a
// temporary Blob-download target during browser.close(). Only tolerate that at teardown.
process.on('unhandledRejection', error => {
  if (tearingDown && error?.name === 'TargetClosedError') return;
  console.error(error); process.exitCode = 1;
});
let fixture = 'ack', messageId = '', releaseLate, releaseReader, releaseReply, readerHolds = 0;
const server = http.createServer((req, res) => {
  const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
const check = (label, ok) => { assert.ok(ok, label); console.log('PASS ' + label); };
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.marked = { use() {}, parse: text => String(text) }; window.DOMPurify = { sanitize: text => String(text) };
      let value;
      Object.defineProperty(window, 'Vue', { configurable: true, get: () => value, set(v) {
        value = v;
        if (!v?.createApp || v.createApp.__docTest) return;
        const mounted = v.onMounted;
        v.onMounted = (hook, ...args) => { const root = !v.getCurrentInstance()?.parent; return mounted(async (...hookArgs) => { await hook(...hookArgs); if (root) window.__DOC_BOOTED__ = true; }, ...args); };
        const createApp = v.createApp;
        v.createApp = (...args) => { const app = createApp(...args), mount = app.mount; app.mount = (...args) => { const root = mount.apply(app, args); window.__APP_PROXY__ = root; return root; }; return app; };
        v.createApp.__docTest = true;
      } });
    });
    await page.route('**/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'mock', object: 'model' }] }) }));
    await page.route('**/chat/completions', async route => {
      const body = route.request().postDataJSON(); requests.push(body);
      let message = { role: 'assistant', content: '{"messages":[{"type":"text","content":"好，我先收着"}]}' }, finish_reason = 'stop';
      const isolated = body.messages[0]?.content.includes('你是隔离的文档读者');
      const hasResult = body.messages.some(item => item.role === 'tool');
      const toolCall = (id, name, args) => {
        message = { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
        finish_reason = 'tool_calls';
      };
      const toolTexts = body.messages.filter(item => item.role === 'tool').map(item => String(item.content));
      if (isolated) message.content = '小林在仓库找到翡翠钥匙。来源块0。';
      else if (fixture === 'grep') {
        // Search with grep syntax, then read back the exact character offset from the result.
        const offset = /字符 (\d+)–/.exec(toolTexts[0] || '');
        if (!toolTexts.length) toolCall('grep-1', 'tool_search_document', { messageId, query: '+翡翠钥匙 -离别', limit: 2 });
        else if (toolTexts.length === 1) toolCall('grep-2', 'tool_read_document', { messageId, startChar: offset ? Number(offset[1]) + 6 : 0 });
        else message.content = '{"messages":[{"type":"text","content":"我翻到原句了"}]}';
      } else if (fixture === 'multi') {
        // Omitting messageId fans out over every attachment in scope.
        if (!hasResult) toolCall('multi-1', 'tool_search_document', { query: '翡翠钥匙' });
        else message.content = '{"messages":[{"type":"text","content":"两个文件里都有"}]}';
      } else if (['search', 'reader', 'late'].includes(fixture) && !hasResult) {
        const name = fixture === 'search' ? 'tool_search_document' : 'tool_document_reader';
        const args = fixture === 'search' ? { messageId, query: '翡翠钥匙' } : { messageId };
        message = { role: 'assistant', content: '', tool_calls: [{ id: 'doc-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; finish_reason = 'tool_calls';
      } else if (hasResult) message.content = '{"messages":[{"type":"text","content":"找到了，在仓库"}]}';
      if (fixture === 'late' && isolated) await new Promise(resolve => { releaseLate = resolve; });
      if (fixture === 'reader' && isolated && readerHolds++ < 2) await new Promise(resolve => { releaseReader = resolve; });
      if (fixture === 'reader' && !isolated && hasResult) await new Promise(resolve => { releaseReply = resolve; });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) });
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__DOC_BOOTED__ && window.__APP_PROXY__?.characters, { timeout: 60000 });
    await page.evaluate(async () => {
      const r = window.__APP_PROXY__; r.user.name = '玩家'; r.showUserSetupModal = false;
      r.characters.push({ uuid: 'document-character', name: '林晚', description: '角色私有背景', first_mes: '你好', wechatEnabled: true, wechatSpeed: 'fast', wechatStickerRate: 'off' });
      await r.selectCharacter(r.characters.length - 1, false, { silent: true });
      r.settings.apiUrl = 'https://mock.local/v1'; r.settings.apiKey = 'fixture'; r.settings.model = 'mock';
      await window.RPHubStorage.setStoredValue('characters', window.Vue.toRaw(r.characters));
      await window.RPHubStorage.setStoredValue('settings', window.Vue.toRaw(r.settings));
      await r.openWechat();
    });
    const selector = '.wx-composer input[aria-label="选择图片或文本文件"]';
    const novel = '第一章 夜雨\n小林在旧仓库找到翡翠钥匙。\n' + '雨滴敲打窗户，故事继续。\n'.repeat(6000) + '\n第二章 离别\n小林带着钥匙离开小镇。';
    await page.locator(selector).setInputFiles({ name: '长篇小说.txt', mimeType: 'text/plain', buffer: Buffer.from(novel) });
    await page.waitForFunction(() => window.__APP_PROXY__.wechatPendingDocument && !window.__APP_PROXY__.isWechatDocumentPreparing);
    check('真实文件输入整理完成，纯附件也能发送', await page.locator('.wx-send').isEnabled());
    await page.locator('.wx-send').click();
    await page.waitForFunction(() => !window.__APP_PROXY__.isWechatGenerating && window.__APP_PROXY__.wechatTimeline.some(item => item.type === 'document'));
    messageId = await page.evaluate(() => window.__APP_PROXY__.wechatTimeline.find(item => item.type === 'document').id);
    check('文件气泡可见，首轮不夹带小说正文', await page.locator('.wx-document-card').count() === 1 && !JSON.stringify(requests[0]).includes('旧仓库'));
    check('真实 IndexedDB 分块与原 Blob 落盘，时间线仅引用', await page.evaluate(async () => {
      const item = window.__APP_PROXY__.wechatTimeline.find(item => item.type === 'document');
      const lib = window.RPHubWeChatDocuments.createLibrary(window.RPHubStorage), doc = await lib.get(item.document.id);
      const blob = await lib.blob(doc.id); return doc.chunkCount > 20 && blob instanceof Blob && (await blob.text()).includes('翡翠钥匙') && !JSON.stringify(window.__APP_PROXY__.wechatTimeline).includes('雨滴');
    }));
    await page.locator('.wx-document-card').click();
    await page.waitForSelector('.wx-document-text');
    check('文件预览安全显示原文，按两块分页', (await page.locator('.wx-document-text').textContent()).includes('翡翠钥匙') && (await page.locator('.wx-document-text').textContent()).length <= 4800);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.waitForFunction(() => window.__APP_PROXY__.wechatDocumentPreview.start === 2);
    const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: '下载原文件' }).click();
    const download = await downloadPromise; check('可下载原文件', download.suggestedFilename() === '长篇小说.txt');
    fs.mkdirSync(path.join(ROOT, '.refactor-tmp'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, '.refactor-tmp/wechat-document-preview.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '关闭文件', exact: true }).click();
    const send = text => page.evaluate(async text => { const r = window.__APP_PROXY__; r.wechatInput = text; await r.sendWechatMessage(); }, text);
    fixture = 'search'; const start = requests.length; await send('那把钥匙在哪儿找到的');
    check('真实工具续写收到检索片段，工具不生成气泡', requests.slice(start).some(body => body.messages.some(item => item.role === 'tool' && item.content.includes('翡翠钥匙'))) && await page.locator('.wx-document-card').count() === 1);
    fixture = 'grep'; const grepStart = requests.length; await send('原句怎么写的');
    const grepTexts = requests.slice(grepStart).flatMap(body => body.messages.filter(item => item.role === 'tool').map(item => String(item.content)));
    check('grep 表达式（必含/排除）在真实链路生效', grepTexts.some(text => text.includes('表达式：+翡翠钥匙 -离别') && text.includes('命中')));
    check('按搜索结果字符位置定位原文', grepTexts.some(text => text.includes('已按字符') && text.includes('翡翠钥匙')));
    fixture = 'ack';
    await page.locator(selector).setInputFiles({ name: '补充.txt', mimeType: 'text/plain', buffer: Buffer.from('补充材料里也提到翡翠钥匙。') });
    await page.waitForFunction(() => window.__APP_PROXY__.wechatPendingDocument && !window.__APP_PROXY__.isWechatDocumentPreparing);
    await page.locator('.wx-send').click();
    await page.waitForFunction(() => !window.__APP_PROXY__.isWechatGenerating && window.__APP_PROXY__.wechatTimeline.filter(item => item.type === 'document').length === 2);
    fixture = 'multi'; const multiStart = requests.length; await send('哪个文件提到钥匙');
    const multiTexts = requests.slice(multiStart).flatMap(body => body.messages.filter(item => item.role === 'tool').map(item => String(item.content)));
    check('省略 messageId 一次搜索多个附件并回传文件消息 ID', multiTexts.some(text => text.includes('搜索 2 个附件') && text.includes('补充.txt') && /#\S+｜/.test(text)));
    fixture = 'ack'; const nextStart = requests.length; await send('好');
    check('下一轮不重复带小说原文', !JSON.stringify(requests[nextStart]).includes('雨滴敲打'));
    fixture = 'reader'; const readerStart = requests.length; const reading = send('你先读一读这本小说');
    await page.waitForFunction(() => window.__APP_PROXY__.wechatActivity?.modelRequests === 2);
    check('模型阅读时显示系统状态，不显示人物正在输入', await page.locator('.wx-activity').isVisible() && await page.locator('.wx-typing').count() === 0 && await page.evaluate(() => window.__APP_PROXY__.wechatActivity.completed === 0));
    await page.waitForFunction(() => window.__APP_PROXY__.wechatActivity.seconds >= 1);
    check('等待时间实时更新，显示真实模型和工具次数', (await page.locator('.wx-activity-meta').textContent()).includes('模型请求 2 次 · 工具调用 1 次'));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { const el = document.getElementById('wechat-chat-scroll'); el.scrollTop = el.scrollHeight; });
    await page.screenshot({ path: path.join(ROOT, '.refactor-tmp/wechat-document-reading-desktop.png'), animations: 'disabled' });
    while (!releaseReader) await new Promise(resolve => setTimeout(resolve, 30));
    const firstRelease = releaseReader; releaseReader = null; firstRelease();
    await page.waitForFunction(() => window.__APP_PROXY__.wechatActivity?.modelRequests === 3);
    check('第二批只显示第一批已保存进度', await page.evaluate(() => window.__APP_PROXY__.wechatActivity.completed === 4 && window.__APP_PROXY__.wechatActivity.detail.includes('第 2/6 批')));
    await page.setViewportSize({ width: 430, height: 900 });
    await page.screenshot({ path: path.join(ROOT, '.refactor-tmp/wechat-document-reading-mobile.png'), animations: 'disabled' });
    check('手机阅读状态没有横向溢出，停止按钮可见', await page.evaluate(() => document.querySelector('.wx-activity').scrollWidth <= document.querySelector('.wx-activity').clientWidth) && await page.getByRole('button', { name: '停止', exact: true }).isVisible());
    while (!releaseReader) await new Promise(resolve => setTimeout(resolve, 30));
    releaseReader(); releaseReader = null;
    await page.waitForFunction(() => window.__APP_PROXY__.wechatActivity?.modelRequests === 8);
    check('六批阅读后，继续显示等待主模型回复的状态', await page.evaluate(() => window.__APP_PROXY__.wechatActivity.title === '正在整理回复' && !window.__APP_PROXY__.wechatTyping));
    while (!releaseReply) await new Promise(resolve => setTimeout(resolve, 30));
    releaseReply(); releaseReply = null; await reading;
    check('回复完成后清掉处理状态，状态不进入时间线', await page.locator('.wx-activity').count() === 0 && await page.evaluate(() => !JSON.stringify(window.__APP_PROXY__.wechatTimeline).includes('modelRequests')));
    const readerRequests = requests.slice(readerStart).filter(body => body.messages[0]?.content.includes('你是隔离的文档读者'));
    check('隔离读者调用有独立预算，不含角色/聊天上下文', readerRequests.length === 6 && readerRequests.every(body => body.max_tokens === 2400 && !body.tools && !JSON.stringify(body).includes('角色私有背景')));
    check('主聊天只收到短阅读笔记和未完成进度', requests.at(-1).messages.some(item => item.role === 'tool' && item.content.includes('尚未读完')) && JSON.stringify(requests.at(-1)).length < 22000);
    await page.evaluate(() => window.__APP_PROXY__.closeWechat());
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.__DOC_BOOTED__, { timeout: 60000 });
    await page.evaluate(async () => { const r = window.__APP_PROXY__; r.showUserSetupModal = false; const at = r.characters.findIndex(item => item.uuid === 'document-character'); await r.selectCharacter(at, false, { silent: true }); await r.openWechat(); });
    await page.locator('.wx-document-card').first().click(); await page.waitForSelector('.wx-document-text');
    check('刷新后文件、正文与读者进度均可恢复', await page.evaluate(() => window.__APP_PROXY__.wechatDocumentPreview.readThrough === 24));
    await page.getByRole('button', { name: '关闭文件', exact: true }).click();
    // Abort a reader provider response after it has started, then switch characters.
    fixture = 'late'; const pending = send('继续读');
    while (!releaseLate) await new Promise(resolve => setTimeout(resolve, 30));
    await page.evaluate(async () => { const r = window.__APP_PROXY__; r.stopWechatGeneration(); await r.closeWechat(); r.characters.push({ uuid: 'document-other', name: '小夏', first_mes: '你好', wechatEnabled: true }); await r.selectCharacter(r.characters.length - 1, false, { silent: true }); await r.openWechat(); });
    releaseLate(); await pending;
    check('中止与切角色后，晚到的读者结果不写新会话或恢复状态', await page.evaluate(() => !window.__APP_PROXY__.wechatTimeline.some(item => item.type === 'document') && !window.__APP_PROXY__.isWechatGenerating && !window.__APP_PROXY__.wechatActivity));
    await page.evaluate(async () => { const r = window.__APP_PROXY__; await r.closeWechat(); await r.selectCharacter(r.characters.findIndex(item => item.uuid === 'document-character'), false, { silent: true }); await r.openWechat(); });
    await page.locator('.wx-document-card').first().click(); await page.waitForSelector('.wx-document-text');
    check('中止批次未推进阅读笔记', await page.evaluate(() => window.__APP_PROXY__.wechatDocumentPreview.readThrough === 24));
    await page.getByRole('button', { name: '关闭文件', exact: true }).click();
    const hostile = '<script>alert("bad")</script>\n用户提供的内容';
    fixture = 'ack'; await page.locator(selector).setInputFiles({ name: '安全显示.md', mimeType: 'text/plain', buffer: Buffer.from(hostile) });
    await page.waitForFunction(() => window.__APP_PROXY__.wechatPendingDocument); await page.locator('.wx-send').click(); await page.waitForFunction(() => !window.__APP_PROXY__.isWechatGenerating);
    await page.locator('.wx-document-card').last().click(); await page.waitForSelector('.wx-document-text');
    check('HTML/提示词作为原文显示，不执行脚本', (await page.locator('.wx-document-text').textContent()).includes('<script>') && await page.locator('.wx-document-text script').count() === 0);
    await page.screenshot({ path: path.join(ROOT, '.refactor-tmp/wechat-document-mobile.png'), animations: 'disabled' });
    check('手机文件界面没有横向溢出', await page.evaluate(() => document.querySelector('.wx-document-preview').scrollWidth <= 430 && document.querySelector('.wx-composer').scrollWidth <= 430));
    const deletedDoc = await page.evaluate(() => window.__APP_PROXY__.wechatDocumentPreview.doc.id);
    const beforeRemove = await page.evaluate(() => window.__APP_PROXY__.wechatTimeline.filter(item => item.type === 'document').length);
    await page.getByRole('button', { name: '移除附件', exact: true }).click();
    await page.waitForFunction(() => window.__APP_PROXY__.showConfirmModal);
    // Exercise the real confirmation callback without depending on modal wording elsewhere.
    await page.evaluate(() => window.__APP_PROXY__.handleConfirm());
    await page.waitForFunction(count => !window.__APP_PROXY__.wechatDocumentPreview
      && window.__APP_PROXY__.wechatTimeline.filter(item => item.type === 'document').length === count - 1, beforeRemove);
    check('移除文件后原 Blob、分块和消息一起回收', await page.evaluate(async id => {
      const lib = window.RPHubWeChatDocuments.createLibrary(window.RPHubStorage);
      return !(await lib.get(id)) && !(await window.RPHubStorage.getStoredValue(`wechat_document_blob_${id}`)) && !(await window.RPHubStorage.getStoredValue(`wechat_document_chunk_${id}_0`));
    }, deletedDoc));
    check('零 JavaScript 错误', errors.length === 0);
    console.log('DOCUMENT E2E: PASS');
  } finally { tearingDown = true; releaseLate?.(); releaseReader?.(); releaseReply?.(); await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
