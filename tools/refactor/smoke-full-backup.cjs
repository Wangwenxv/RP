// 独立浏览器测试：完整备份下载、预览、真实恢复/重载、媒体读回、事务回滚。
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), OUT = path.join(ROOT, '.refactor-tmp/full-backup');
let closing = false;
// Playwright 1.49 在 Node 25 关闭重载过的页面时会拒绝内部导航 promise。
// 只忽略关闭期间来自 FrameSession.dispose 的 TargetClosedError，其他拒绝仍令测试失败。
process.on('unhandledRejection', error => {
  if (closing && /Target page, context or browser has been closed/.test(error?.message || '') && /FrameSession\.dispose/.test(error?.stack || '')) return;
  throw error;
});
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0], file = path.resolve(ROOT, '.' + decodeURIComponent(url === '/' ? '/index.html' : url));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': `${mime[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
  fs.createReadStream(file).pipe(res);
});
(async () => {
  let browser;
  const errors = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); fs.mkdirSync(OUT, { recursive: true });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.marked = { use() {}, parse(text) { return String(text); } };
      window.DOMPurify = { sanitize(text) { return String(text); } };
    });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' || ['unpkg.com', 'cdn.jsdelivr.net', 'cdn.tailwindcss.com'].includes(url.hostname)) return route.continue();
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
    });
    await page.route('**/assets/js/app.js?*', route => route.fulfill({ contentType: 'text/javascript',
      body: fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8')
        .replace('const __s = {};', 'const __s = window.__BACKUP_SCOPE__ = {};')
        .replace("app.mount('#app');", "window.__APP_PROXY__ = app.mount('#app');") }));
    const ready = async () => page.waitForFunction(() => window.__APP_PROXY__ && window.__BACKUP_SCOPE__._initComplete
      && !window.__BACKUP_SCOPE__.storyBranchSwitching.value && window.__BACKUP_SCOPE__.switchingCharacterIndex.value < 0
      && !window.__BACKUP_SCOPE__._isApplyingCharacterScopedData
      && (!window.__BACKUP_SCOPE__.characters.value.length || window.__BACKUP_SCOPE__.currentCharacterIndex.value >= 0));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load', timeout: 45000 }); await ready();
    const fixture = await page.evaluate(async () => {
      const s = window.__BACKUP_SCOPE__, S = window.RPHubStorage;
      window.__APP_PROXY__.showUserSetupModal = false;
      s.characters.value = [{ uuid: 'backup-a', name: '角色甲', description: '测试', personality: '', first_mes: '', avatar: '', wechatEnabled: true },
        { uuid: 'backup-b', name: '角色乙', description: '第二个角色', first_mes: '', avatar: '' }];
      await s.selectCharacter(0, false, { silent: true });
      Object.assign(s.memorySettings, { enabled: false, mode: 'classic', classicModel: '' });
      Object.assign(s.settings, { apiUrl: 'https://mock.local/v1', customApiUrl: 'https://mock.local/v1', apiProviderId: 'custom', apiKey: 'backup-api-secret', imageGenKey: 'backup-image-secret', model: 'backup-model' });
      s.user.name = '备份玩家';
      s.chatHistory.value = [{ id: 'u1', role: 'user', content: 'RP 原始对话' }, { id: 'a1', role: 'assistant', content: '角色原文' }];
      s.classicMemories.value = [{ id: 'm1', classicMemory: true, turn: 1, summary: '保留的总结', enabled: true, sourceUserIds: ['u1'], sourceAssistantIds: ['a1'] }];
      s.storyBranches.value.push({ id: 'alt', name: '另一个分支', createdAt: Date.now(), updatedAt: Date.now(), parentId: 'main', forkTurn: 1 });
      await S.setScopedStoredValue('chat', s.getStoryBranchScopeId('backup-a', 'alt'), [{ id: 'alt-a', role: 'assistant', content: '分支剧情' }]);
      await S.setScopedStoredValue('chat', 'backup-b', [{ id: 'b-a', role: 'assistant', content: '乙的聊天' }]);
      await S.setScopedStoredValue('wechat_timeline', s.getStoryBranchScopeId('backup-a', 'alt'), [{ id: 'alt-w', channel: 'wechat', role: 'user', type: 'text', content: '分支微信', ts: 1000 }]);
      await s.ensureWechatTimelineLoaded();
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/aUAAAAASUVORK5CYII='), char => char.charCodeAt(0));
      const png = new Blob([bytes], { type: 'image/png' });
      const image = await window.RPHubWeChatMedia.createLibrary(S).save({ blob: png, thumb: png, width: 1, height: 1 }, { ownerId: 'backup-a', scopeId: 'backup-a', caption: '一张测试图片', album: true });
      const voice = await window.RPHubWeChatVoice.createLibrary(S).save(new Blob(['VOICE-ORIGINAL'], { type: 'audio/wav' }), { ownerId: 'backup-a', scopeId: 'backup-a', transcript: '测试语音' });
      const docLibrary = window.RPHubWeChatDocuments.createLibrary(S);
      const document = await docLibrary.save(new File(['# 测试文件\n文档原文要完整保存'], '测试.txt', { type: 'text/plain' }), { ownerId: 'backup-a', scopeId: 'backup-a' });
      await docLibrary.saveReader(document.id, { next: 1, summary: '已读笔记', batches: 1 });
      s.wechatTimeline.value = [{ id: 'w1', channel: 'wechat', role: 'user', type: 'text', content: '微信原文', ts: 2000, storyAt: '2026-01-01T12:00:00' },
        { id: 'w2', channel: 'wechat', role: 'assistant', type: 'image', media: { ...image }, content: image.caption, ts: 3000 },
        { id: 'w3', channel: 'wechat', role: 'assistant', type: 'voice', media: { ...voice }, content: '测试语音', ts: 4000 },
        { id: 'w4', channel: 'wechat', role: 'user', type: 'file', document: { ...document }, content: document.name, ts: 5000 }];
      await s.ensureStoryRecapLoaded();
      s.storyRecap.value = { summary: 'RP 和微信前情提要', coversThroughTurn: 1, coversWechatCount: 1, createdAt: Date.now() };
      s.wechatStickers.value = [{ id: 'sticker1', name: '测试表情', description: '测试', dataUrl: 'data:image/png;base64,AA==' }];
      await S.setStoredValue('geographyMaps', []);
      await S.setStoredValue('future_extension', { data: '未来扩展也需保留' });
      await S.setStoredValue('wechat_time_tags', [{ id: 'tag1', minutes: 15, label: '十五分钟后' }]);
      await S.setStoredValue('novel_library', { version: 1, books: [{ id: 'novel1', title: '已保存的小说', chapters: [{ content: '小说原文' }] }] });
      const oldWorkshop = await new Promise((resolve, reject) => {
        const request = indexedDB.open('AICharGen', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('characters');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = oldWorkshop.transaction('characters', 'readwrite');
        transaction.objectStore('characters').put(JSON.stringify([{ id: 'draft1', name: '旧工坊草稿', desc: '迁移后应能读回' }]), 'ai_chargen_characters');
        transaction.oncomplete = resolve; transaction.onerror = reject;
      }); oldWorkshop.close();
      localStorage.setItem('ai_chargen_options', JSON.stringify({ generateExtra: true }));
      localStorage.setItem('ai_chargen_active_index', '0');
      sessionStorage.setItem('rphub_wechat_voice_key', 'backup-voice-secret');
      sessionStorage.setItem('rphub_wechat_voice_service', 'https://voice.local');
      window.RPHubTheme.set('dark');
      window.__APP_PROXY__.currentView = 'settings';
      await Vue.nextTick();
      return { imageId: image.id, voiceId: voice.id, documentId: document.id };
    });
    await page.waitForFunction(() => !window.__APP_PROXY__.fullBackupBlocked);
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.entry-transition')).opacity) === 0);
    const panel = page.locator('#full-backup-settings'); await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, 'desktop.png') });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出全部内容', exact: true }).click();
    const download = await downloadPromise, backupPath = path.join(OUT, 'roundtrip.rphub'); await download.saveAs(backupPath);
    assert.ok(fs.statSync(backupPath).size > 0);
    await page.waitForFunction(() => !window.__APP_PROXY__.fullBackupBusy);
    console.log('PASS 原设置页导出全部内容，生成独立完整备份文件');
    await page.evaluate(async () => {
      const s = window.__BACKUP_SCOPE__;
      s.user.name = '导入前玩家'; s.characters.value[0].name = '临时角色名'; s.chatHistory.value[1].content = '临时改动';
      await window.RPHubStorage.setStoredValue('only_before_restore', '应被完整恢复移除');
      await s.saveData({ throwOnError: true });
    });
    await page.getByLabel('导入全部内容', { exact: true }).setInputFiles(backupPath);
    const dialog = page.getByRole('dialog', { name: '导入全部内容' }); await dialog.waitFor({ state: 'visible' });
    const text = await dialog.innerText();
    for (const item of ['角色 2', '微信记录 5', '图片 1', '语音 1', '文档原件 1', '工坊草稿 1', '小说 1']) assert.ok(text.includes(item), text);
    assert.equal(await page.evaluate(() => window.__BACKUP_SCOPE__.characters.value[0].name), '临时角色名');
    await page.screenshot({ path: path.join(OUT, 'preview.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await dialog.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 391);
    await page.screenshot({ path: path.join(OUT, 'mobile-preview.png') });
    const rollbackPromise = page.waitForEvent('download');
    const reloaded = page.waitForEvent('domcontentloaded');
    await page.getByRole('button', { name: '覆盖并导入全部内容', exact: true }).click();
    const rollback = await rollbackPromise; await rollback.saveAs(path.join(OUT, 'rollback.rphub'));
    await reloaded;
    await page.waitForLoadState('load');
    await page.waitForFunction(() => window.__APP_PROXY__?.user.name === '备份玩家'); await ready();
    const recovered = await page.evaluate(async fixture => {
      const s = window.__BACKUP_SCOPE__, S = window.RPHubStorage;
      await s.ensureWechatTimelineLoaded();
      const image = await window.RPHubWeChatMedia.createLibrary(S).read(fixture.imageId);
      const voice = await window.RPHubWeChatVoice.createLibrary(S).read(fixture.voiceId, 'backup-a');
      const documents = window.RPHubWeChatDocuments.createLibrary(S), document = await documents.blob(fixture.documentId);
      return { names: s.characters.value.map(c => c.name), user: s.user.name, chat: s.chatHistory.value[1].content,
        memory: s.classicMemories.value[0].summary, timeline: s.wechatTimeline.value.map(item => item.content),
        alt: (await S.getScopedStoredValue('chat', s.getStoryBranchScopeId('backup-a', 'alt')))[0].content,
        other: (await S.getScopedStoredValue('chat', 'backup-b'))[0].content,
        imageBytes: image.size, voice: await voice.text(), document: await document.text(), notes: await documents.reader(fixture.documentId),
        extension: await S.getStoredValue('future_extension'), removed: await S.getStoredValue('only_before_restore'),
        workshop: JSON.parse(await S.getStoredValue('workshop_characters'))[0].name,
        novel: (await S.getStoredValue('novel_library')).books[0].chapters[0].content,
        apiKey: s.settings.apiKey, voiceKey: sessionStorage.getItem('rphub_wechat_voice_key'), theme: window.RPHubTheme.current };
    }, fixture);
    assert.deepEqual(recovered.names, ['角色甲', '角色乙']); assert.equal(recovered.chat, '角色原文');
    assert.equal(recovered.memory, '保留的总结'); assert.ok(recovered.timeline.includes('微信原文'));
    assert.equal(recovered.alt, '分支剧情'); assert.equal(recovered.other, '乙的聊天');
    assert.ok(recovered.imageBytes > 0); assert.equal(recovered.voice, 'VOICE-ORIGINAL');
    assert.equal(recovered.document, '# 测试文件\n文档原文要完整保存'); assert.equal(recovered.notes.summary, '已读笔记');
    assert.equal(recovered.extension.data, '未来扩展也需保留'); assert.equal(recovered.removed, undefined);
    assert.equal(recovered.workshop, '旧工坊草稿'); assert.equal(recovered.novel, '小说原文');
    assert.equal(recovered.apiKey, ''); assert.equal(recovered.voiceKey, null); assert.equal(recovered.theme, 'dark');
    console.log('PASS 预览不改数据、桌面/移动端可操作、覆盖前下载回退包、真实重载后恢复所有角色与附件原件');
    const atomic = await page.evaluate(async () => {
      const S = window.RPHubStorage;
      await S.setStoredValue('atomic_sentinel', '旧值');
      const db = S.getMainDb();
      await new Promise((resolve, reject) => { const tx = db.transaction('store', 'readwrite'); tx.objectStore('store').put('无关数据', 'other_namespace'); tx.oncomplete = resolve; tx.onerror = reject; });
      let failed = false;
      try { await S.restoreStorageSnapshot([['characters', []], ['bad', () => {}]]); } catch (_) { failed = true; }
      const old = await S.getStoredValue('atomic_sentinel');
      S.setStorageWriteLock(true); let blocked = false;
      try { await S.setStoredValue('atomic_sentinel', '不应写入'); } catch (_) { blocked = true; }
      S.setStorageWriteLock(false);
      return { failed, old, blocked, count: (await S.getStoredValue('characters')).length };
    });
    assert.deepEqual(atomic, { failed: true, old: '旧值', blocked: true, count: 2 });
    console.log('PASS 实际IndexedDB事务写入失败完整回滚，恢复期间旧页面写入被阻止');
    // 导入前回退包带有密钥；选择恢复密钥后重新载入，确认可真正返回导入前状态。
    await page.evaluate(() => { window.__APP_PROXY__.showUserSetupModal = false; window.__APP_PROXY__.currentView = 'settings'; });
    await page.getByLabel('导入全部内容', { exact: true }).setInputFiles(path.join(OUT, 'rollback.rphub'));
    await page.getByRole('dialog', { name: '导入全部内容' }).waitFor({ state: 'visible' });
    await page.getByText('恢复备份中的 API 与语音密钥', { exact: true }).click();
    const secondRollback = page.waitForEvent('download'), secondReload = page.waitForEvent('domcontentloaded');
    await page.getByRole('button', { name: '覆盖并导入全部内容', exact: true }).click(); await secondRollback; await secondReload;
    await page.waitForLoadState('load');
    await page.waitForFunction(() => window.__APP_PROXY__?.user.name === '导入前玩家'); await ready();
    const undone = await page.evaluate(() => ({ name: window.__APP_PROXY__.characters[0].name, key: window.__APP_PROXY__.settings.apiKey,
      voiceKey: sessionStorage.getItem('rphub_wechat_voice_key'), chat: window.__APP_PROXY__.chatHistory[1].content }));
    assert.equal(undone.name, '临时角色名'); assert.equal(undone.key, 'backup-api-secret');
    assert.equal(undone.voiceKey, 'backup-voice-secret'); assert.equal(undone.chat, '临时改动');
    const workshop = await page.context().newPage();
    workshop.on('pageerror', error => errors.push('工坊：' + error.message));
    await workshop.addInitScript(() => { window.marked = { use() {}, parse(text) { return String(text); } }; window.DOMPurify = { sanitize(text) { return String(text); } }; });
    await workshop.route('https://mock.local/**', route => route.fulfill({ contentType: 'application/json', body: '{"data":[]}' }));
    await workshop.route('**/character/index.html', route => route.fulfill({ contentType: 'text/html',
      body: fs.readFileSync(path.join(ROOT, 'character/index.html'), 'utf8').replace('createApp({', 'window.__WORKSHOP__ = createApp({') }));
    await workshop.goto(`http://127.0.0.1:${server.address().port}/character/index.html`, { waitUntil: 'load', timeout: 45000 });
    await workshop.waitForFunction(() => window.__WORKSHOP__?.characters[0]?.name === '旧工坊草稿');
    await workshop.evaluate(() => { window.__WORKSHOP__.characters[0].description = '共用数据库草稿保存'; });
    await workshop.waitForFunction(async () => JSON.parse(await window.RPHubStorage.getStoredValue('workshop_characters'))[0].description === '共用数据库草稿保存');
    await workshop.close();
    console.log('PASS 旧工坊草稿迁移并进入完整备份，独立工坊页面载入/编辑共用数据库正常，小说库也可恢复');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS 回退包可恢复覆盖前状态和密钥，整个流程无JS运行时异常');
  } finally { closing = true; if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
