// Real download/import in isolated Edge contexts; never opens the user's browser profile.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), OUT = path.join(ROOT, '.refactor-tmp/branch-chat');
let closing = false;
process.on('unhandledRejection', error => {
    if (closing && /Target page, context or browser has been closed/.test(error?.message || '') && /FrameSession\.dispose/.test(error?.stack || '')) return;
    throw error;
});
const server = http.createServer((req, res) => {
    const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': `${mime[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` }); fs.createReadStream(file).pipe(res);
});
const ready = page => page.waitForFunction(() => window.__CHAT_SCOPE__?._initComplete && !window.__CHAT_SCOPE__._isApplyingCharacterScopedData
    && !window.__CHAT_SCOPE__.storyBranchSwitching.value && window.__CHAT_SCOPE__.switchingCharacterIndex.value < 0);
(async () => {
    let browser;
    const errors = [];
    try {
        fs.mkdirSync(OUT, { recursive: true });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const open = async () => {
            const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
            const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => { window.marked = { use() {}, parse: String }; window.DOMPurify = { sanitize: String }; });
            await page.route('**/*', route => ['127.0.0.1', 'unpkg.com', 'cdn.jsdelivr.net', 'cdn.tailwindcss.com'].includes(new URL(route.request().url()).hostname)
                ? route.continue() : route.fulfill({ contentType: 'application/json', body: '{"data":[]}' }));
            await page.route('**/assets/js/app.js?*', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8')
                .replace('const __s = {};', 'const __s = window.__CHAT_SCOPE__ = {};') }));
            await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load', timeout: 45000 }); await ready(page);
            return page;
        };
        const source = await open();
        await source.evaluate(async () => {
            const s = window.__CHAT_SCOPE__, S = window.RPHubStorage;
            s.showUserSetupModal.value = false;
            s.characters.value = [{ uuid: 'source', name: '分支导出测试', description: '', first_mes: '', avatar: '', wechatEnabled: true },
                { uuid: 'wechat-only', name: '仅微信测试', first_mes: '', avatar: '', wechatEnabled: true }];
            await s.selectCharacter(0, false, { silent: true });
            s.memorySettings.enabled = false;
            s.chatHistory.value = [{ id: 'rp-u', role: 'user', content: 'RP 玩家原文' }, { id: 'rp-a', role: 'assistant', content: 'RP 角色原文' }];
            s.classicMemories.value = [{ id: 'source-memory', classicMemory: true, turn: 1, summary: '源角色总结', enabled: true, sourceUserIds: ['rp-u'], sourceAssistantIds: ['rp-a'] }];
            await S.setScopedStoredValue('story_recap', 'source', { text: '源角色提要', coversThroughTurn: 1, coversWechatCount: 2, keepRPTurns: 1, keepWechatCount: 1 });
            s.storyBranches.value.push({ id: 'alt', name: '分支二', parentId: 'main', createdAt: 1, updatedAt: 1 });
            await S.setScopedStoredValue('chat', 'source__branch__alt', [{ id: 'rp-alt', role: 'assistant', content: '分支二 RP' }]);
            const png = new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/aUAAAAASUVORK5CYII='), char => char.charCodeAt(0))], { type: 'image/png' });
            const image = await window.RPHubWeChatMedia.createLibrary(S).save({ blob: png, thumb: png, width: 1, height: 1 }, { ownerId: 'source', scopeId: 'source', caption: '测试照片', album: true });
            s.wechatStickers.value = [{ id: 'sticker-original', name: '测试表情', image: await window.RPHubWeChatMedia.blobToDataURL(png), description: '测试' }];
            const voice = await window.RPHubWeChatVoice.createLibrary(S).save(new Blob(['VOICE'], { type: 'audio/wav' }), { ownerId: 'source', scopeId: 'source__branch__alt' });
            const doc = await window.RPHubWeChatDocuments.createLibrary(S).save(new File(['# 标题\n附件完整原文'], '原文.txt', { type: 'text/plain' }), { ownerId: 'source', scopeId: 'source__branch__alt' });
            await S.setStoredValue(`wechat_document_reader_${doc.id}`, { next: 1, summary: '读者笔记', batches: 1 });
            s.replaceWechatTimeline([{ id: 'main-wx', channel: 'wechat', type: 'text', role: 'user', content: '主线微信', ts: 100, storyAt: '2026-11-09T12:00:00' },
                { id: 'main-photo', channel: 'wechat', type: 'image', role: 'assistant', content: '', media: { assetId: image.id, caption: '测试照片' }, ts: 101 },
                { id: 'main-sticker', channel: 'wechat', type: 'sticker', role: 'assistant', content: '测试表情', ts: 102 }]);
            await S.setScopedStoredValue('wechat_timeline', 'source__branch__alt', [
                { id: 'alt-wx', channel: 'wechat', type: 'text', role: 'assistant', content: '分支二微信', ts: 200 },
                { id: 'alt-voice', channel: 'wechat', type: 'voice', role: 'assistant', content: '语音台词', media: { assetId: voice.id }, ts: 201 },
                { id: 'alt-doc', channel: 'wechat', type: 'document', role: 'user', content: '', document: { id: doc.id, name: doc.name }, ts: 202 }]);
            await S.setScopedStoredValue('chat', 'wechat-only', []);
            await S.setScopedStoredValue('wechat_timeline', 'wechat-only', [{ channel: 'wechat', type: 'text', role: 'user', content: '仅有微信' }]);
            await s.saveData({ throwOnError: true });
        });
        await ready(source);
        const downloadPromise = source.waitForEvent('download');
        await source.evaluate(() => window.__CHAT_SCOPE__.exportCharacterChat(0));
        const download = await downloadPromise, file = path.join(OUT, download.suggestedFilename()); await download.saveAs(file);
        const text = fs.readFileSync(file, 'utf8'), records = text.split('\n').map(JSON.parse);
        assert.equal(records[0].version, 2); assert.equal(records.filter(record => record.type === 'rp-hub-chat-resource').length, 3);
        assert.ok(records.find(record => record.branchId === 'main' && record.messages).wechatTimeline.some(item => item.id === 'main-wx'));
        const onlyPromise = source.waitForEvent('download'); await source.evaluate(() => window.__CHAT_SCOPE__.exportCharacterChat(1));
        const only = await onlyPromise; await only.saveAs(path.join(OUT, only.suggestedFilename()));
        const destination = await open();
        await destination.evaluate(async () => {
            const s = window.__CHAT_SCOPE__, S = window.RPHubStorage;
            s.showUserSetupModal.value = false;
            s.characters.value = [{ uuid: 'destination', name: '导入目标', first_mes: '', avatar: '', wechatEnabled: false },
                { uuid: 'unrelated', name: '其他角色', first_mes: '', avatar: '' }];
            await s.selectCharacter(0, false, { silent: true }); s.memorySettings.enabled = false;
            s.chatHistory.value = [{ id: 'old-rp', role: 'user', content: '旧 RP' }];
            s.replaceWechatTimeline([{ id: 'old-wx', channel: 'wechat', role: 'user', type: 'text', content: '旧微信' }]);
            s.replaceStoryRecap({ text: '旧提要', coversWechatCount: 1 });
            await s.flushPendingWechatSave();
            await S.setScopedStoredValue('classic_memories', 'destination', [{ id: 'old-memory', summary: '旧总结' }]);
            await S.setScopedStoredValue('chat', 'unrelated', [{ role: 'user', content: '其他角色原文' }]);
            await s.saveData({ throwOnError: true });
            await s.reloadWechatMediaLibrary(); // Populate the cache before import to test its invalidation.
        });
        await ready(destination);
        const importText = async (page, content) => {
            const before = await page.evaluate(() => window.__CHAT_SCOPE__.toasts.value.map(toast => toast.id));
            await page.evaluate(content => window.__CHAT_SCOPE__.importCharacter({ target: { files: [new File([content], '聊天.jsonl')], value: 'test' } }), content);
            await page.waitForFunction(ids => window.__CHAT_SCOPE__.toasts.value.some(toast => !ids.includes(toast.id) && /导入|失败/.test(toast.message)), before);
            await ready(page);
            return page.evaluate(ids => window.__CHAT_SCOPE__.toasts.value.filter(toast => !ids.includes(toast.id)), before);
        };
        assert.equal((await importText(destination, text)).at(-1).type, 'success');
        assert.equal(await destination.evaluate(() => window.__CHAT_SCOPE__.currentCharacter.value.wechatEnabled), true);
        assert.equal(await destination.evaluate(async () => (await window.RPHubStorage.getStoredValue('characters'))[0].wechatEnabled), true);
        const damaged = records.map(record => ({ ...record }));
        delete damaged.find(record => record.branchId === 'main' && record.messages).wechatTimeline;
        assert.equal((await importText(destination, damaged.map(JSON.stringify).join('\n'))).at(-1).type, 'error');
        const main = await destination.evaluate(async () => {
            const s = window.__CHAT_SCOPE__, S = window.RPHubStorage;
            await s.openWechat();
            const imageId = s.wechatTimeline.value.find(item => item.id === 'main-photo').media.assetId;
            const image = await window.RPHubWeChatMedia.createLibrary(S).read(imageId);
            return { rp: s.chatHistory.value.map(item => item.content), wx: s.wechatTimeline.value.filter(item => item.channel === 'wechat'),
                bytes: image.size, mime: image.type, recap: s.storyRecap.value, memories: await S.getScopedStoredValue('classic_memories', 'destination'),
                other: await S.getScopedStoredValue('chat', 'unrelated'), sticker: s.wechatDisplayItems.value.find(item => item.id === 'main-sticker').stickerImage,
                stickerLibrary: s.wechatStickers.value };
        });
        assert.deepEqual(main.rp, ['RP 玩家原文', 'RP 角色原文']); assert.equal(main.wx[0].content, '主线微信');
        assert.equal(main.wx[0].storyAt, '2026-11-09T12:00:00'); assert.ok(main.bytes > 0); assert.equal(main.mime, 'image/png');
        assert.equal(main.recap.text, '源角色提要'); assert.equal(main.memories[0].summary, '源角色总结'); assert.equal(main.other[0].content, '其他角色原文');
        assert.match(main.sticker, /^data:image\/png;base64,/); assert.equal(main.stickerLibrary.length, 0);
        await destination.evaluate(async () => { const s = window.__CHAT_SCOPE__; await s.closeWechat(); await s.switchStoryBranch('alt'); await s.openWechat(); });
        const alt = await destination.evaluate(async () => {
            const s = window.__CHAT_SCOPE__, S = window.RPHubStorage, items = s.wechatTimeline.value;
            const voice = items.find(item => item.id === 'alt-voice'), doc = items.find(item => item.id === 'alt-doc');
            return { wx: items.find(item => item.id === 'alt-wx').content,
                audio: await (await s.readWechatVoice(voice.media, s.getCurrentStoryBranchScopeId())).text(),
                document: await (await window.RPHubWeChatDocuments.createLibrary(S).blob(doc.document.id)).text(),
                note: await S.getStoredValue(`wechat_document_reader_${doc.document.id}`),
                index: await S.getStoredValue('wechat_document_index') };
        });
        assert.equal(alt.wx, '分支二微信'); assert.equal(alt.audio, 'VOICE'); assert.equal(alt.document, '# 标题\n附件完整原文');
        assert.equal(alt.note.summary, '读者笔记'); assert.equal(alt.index[0].ownerId, 'destination'); assert.equal(alt.index[0].scopeId, 'destination__branch__alt');
        await destination.reload(); await ready(destination); await destination.evaluate(() => window.__CHAT_SCOPE__.ensureWechatTimelineLoaded());
        assert.equal(await destination.evaluate(() => window.__CHAT_SCOPE__.wechatTimeline.value.find(item => item.id === 'alt-wx').content), '分支二微信');
        // Force a real IndexedDB transaction abort after one put; all writes must roll back.
        const indexBefore = await destination.evaluate(() => window.RPHubStorage.getStoredValue('wechat_media_index'));
        await destination.evaluate(() => {
            const put = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (...args) { const request = put.apply(this, args); if (String(args[1]).startsWith('rp_hub_wechat_media_thumb_')) this.transaction.abort(); return request; };
            window.__RESTORE_PUT__ = () => { IDBObjectStore.prototype.put = put; };
        });
        assert.equal((await importText(destination, text)).at(-1).type, 'error');
        await destination.evaluate(() => window.__RESTORE_PUT__());
        assert.deepEqual(await destination.evaluate(() => window.RPHubStorage.getStoredValue('wechat_media_index')), indexBefore);
        assert.equal(await destination.evaluate(async () => (await window.RPHubStorage.getScopedStoredValue('chat', 'destination__branch__alt'))[0].content), '分支二 RP');
        // Same character and same active branch: in-memory old WeChat must be replaced immediately.
        await destination.evaluate(() => window.__CHAT_SCOPE__.replaceWechatTimeline([{ id: 'stale', channel: 'wechat', role: 'user', type: 'text', content: '内存旧微信' }]));
        const altText = [JSON.stringify({ ...records[0], activeBranchId: 'alt' }), ...records.slice(1).map(JSON.stringify)].join('\n');
        assert.equal((await importText(destination, altText)).at(-1).type, 'success');
        assert.equal(await destination.evaluate(() => window.__CHAT_SCOPE__.wechatTimeline.value.some(item => item.id === 'stale')), false);
        const legacy = JSON.stringify({ ...records[0], version: 1, activeBranchId: 'alt' }) + '\n' + records.filter(record => record.messages).map(record => JSON.stringify({ branchId: record.branchId, messages: record.messages })).join('\n');
        const legacyToast = (await importText(destination, legacy)).at(-1);
        assert.equal(legacyToast.type, 'success'); assert.match(legacyToast.message, /旧版文件不含微信/);
        assert.equal(await destination.evaluate(() => window.__CHAT_SCOPE__.wechatTimeline.value.find(item => item.id === 'alt-wx').content), '分支二微信');
        assert.deepEqual(errors, []);
        console.log('PASS: actual JSONL downloads, WeChat-only/inactive character export, cross-character import, main/alt switching, media bytes, refresh, transaction rollback, same-scope reload and v1 compatibility');
    } finally {
        closing = true; if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
