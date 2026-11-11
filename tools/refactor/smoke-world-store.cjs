// Real IndexedDB / two-page CAS check in an isolated headless Edge context.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const { definition, conversation, sent } = require('./world-core-harness.cjs');
const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>World storage QA</title>'); });
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext(), pages = [await context.newPage(), await context.newPage()];
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const page of pages) {
      await page.goto(origin); await page.evaluate(() => { window.Vue = {}; });
      for (const file of ['data-services.js', 'world-model.js', 'world-projections.js', 'world-store.js'])
        await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../assets/js', file), 'utf8') });
    }
    const s = await pages[0].evaluate(args => RPHubWorldStore.create(args), { definition: definition(), conversations: [conversation('dm', ['player', 'qing'])] });
    const args = i => ({ sessionId: s.sessionId, branchId: 'main', expectedRevision: 0, idempotencyKey: `tab-${i}`, events: [sent(`event-${i}`, 'player', 'dm', ['player', 'qing'], `页面${i}`)] });
    const outcomes = await Promise.all(pages.map((page, i) => page.evaluate(async args => {
      try { return { okay: true, value: await RPHubWorldStore.commit(args) }; }
      catch (error) { return { okay: false, code: error.code, message: error.message }; }
    }, args(i))));
    assert.equal(outcomes.filter(o => o.okay).length, 1);
    assert.equal(outcomes.find(o => !o.okay).code, 'WORLD_CONFLICT');
    const loaded = await pages[0].evaluate(sid => RPHubWorldStore.load(sid), s.sessionId);
    assert.equal(loaded.events.length, 1); assert.equal(loaded.revision, 1);
    const winner = outcomes.findIndex(o => o.okay);
    const duplicate = await pages[1].evaluate(args => RPHubWorldStore.commit(args), args(winner));
    assert.equal(duplicate.events.length, 1); assert.equal(duplicate.revision, 1);
    const rollback = await pages[0].evaluate(async sid => {
      const s = await RPHubWorldStore.load(sid);
      try {
        await RPHubWorldStore.commit({ sessionId: sid, branchId: 'main', expectedRevision: s.revision,
          idempotencyKey: 'invalid-batch', events: [
            { kind: 'message.sent', actorId: 'player', conversationId: 'dm', access: { principals: ['player', 'qing'] }, payload: { text: '不能部分保存' } },
            { kind: 'unknown-kind', actorId: 'player', access: { principals: [] }, payload: {} }
          ] });
      } catch (_) { }
      return RPHubWorldStore.load(sid);
    }, s.sessionId);
    assert.equal(rollback.events.length, 1); assert.equal(rollback.revision, 1);
    const backup = await pages[0].evaluate(async sid => {
      const snapshot = await RPHubStorage.readStorageSnapshot();
      const found = snapshot.find(([key]) => key === RPHubWorldStore.key(sid));
      if (!found) throw Error('世界不在完整备份中');
      const pkg = await RPHubWorldStore.exportSession(sid);
      const imported = await RPHubWorldStore.importSession(pkg);
      return { sessionId: imported.sessionId, events: imported.events.length, worlds: (await RPHubWorldStore.list()).length };
    }, s.sessionId);
    assert.notEqual(backup.sessionId, s.sessionId); assert.equal(backup.events, 1); assert.equal(backup.worlds, 2);
    const picker = await pages[0].evaluate(async () => {
      await RPHubStorage.setStoredValue('unrelated-large-blob', new Blob([new Uint8Array(4 * 1024 * 1024)]), { clone: false });
      await RPHubStorage.setStoredValue('unrelated-credentials', { apiKey: 'private-test-key' });
      const before = (await RPHubWorldStore.list()).map(item => item.branches.map(b => b.eventCount));
      // A directory lookup must work even when a full-store scan is unavailable.
      const entries = await RPHubStorage.getStoredEntriesByPrefix(RPHubWorldStore.PREFIX);
      const after = (await RPHubWorldStore.list()).map(item => item.branches.map(b => b.eventCount));
      return { keys: entries.map(([key]) => key), count: entries.length, before, after,
        mediaSize: (await RPHubStorage.getStoredValue('unrelated-large-blob')).size };
    });
    assert.equal(picker.count, 2); assert.equal(picker.keys.every(key => key.startsWith('world_session_v1:')), true);
    assert.equal(picker.mediaSize, 4 * 1024 * 1024); assert.deepEqual(picker.after, picker.before);
    const revised = await pages[0].evaluate(async sid => {
      const s = await RPHubWorldStore.load(sid), definition = JSON.parse(JSON.stringify(s.definition));
      definition.actors.find(a => a.actorId === 'qing').card.personality += '新版本口吻';
      const revised = await RPHubWorldStore.reviseDefinition({ sessionId: sid, definition });
      const old = await RPHubWorldStore.load(sid);
      return { oldCard: old.definition.actors.find(a => a.actorId === 'qing').card.personality,
        newCard: revised.definition.actors.find(a => a.actorId === 'qing').card.personality, events: revised.events.length };
    }, s.sessionId);
    assert.equal(revised.oldCard.includes('新版本口吻'), false); assert.equal(revised.newCard.includes('新版本口吻'), true); assert.equal(revised.events, 1);
    console.log('PASS real IndexedDB: two-page CAS, idempotency, atomic rollback, full-backup coverage, world-package roundtrip, bounded world picker and atomic card revision');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
