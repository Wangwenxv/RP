// Real Vue/Edge/IndexedDB/audio decoding. Default: deterministic offline provider fixtures.
// --live: exactly ONE short paid TTS request using BREEZE_TEST_KEY and WECHAT_VOICE_SMOKE_URL.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { createVoiceServer } = require('../wechat-voice-server.cjs');
const ROOT = path.resolve(__dirname, '../..');
const live = process.argv.includes('--live');
const key = live ? process.env.BREEZE_TEST_KEY : 'test-fixture-key';
if (live && (!key || !process.env.WECHAT_VOICE_SMOKE_URL)) throw new Error('Live test requires BREEZE_TEST_KEY and WECHAT_VOICE_SMOKE_URL');
const check = (name, ok) => { assert.ok(ok, name); console.log('PASS ' + name); };
const requests = [], upstream = [], errors = [];
let fixture = 'mixed', failAt = 0, lateResolve = null, lateStarted = false;
const voice = content => ({ type: 'voice_request', content, instructions: '像给熟悉的人留微信语音，轻声，语气放松' });
function wav() {
  const samples = 24000 * 4, b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin(i * Math.PI * 440 / 24000) * 900), 44 + i * 2);
  return b;
}
const server = live ? null : createVoiceServer({ fetchImpl: async (url, options) => {
  if (url.includes('/voices?')) return Response.json({ voices: [{ voice_id: 'voc_test', name: '测试声音', gender: 'female' }] });
  upstream.push(JSON.parse(options.body));
  if (fixture === 'late') { lateStarted = true; await new Promise(resolve => { lateResolve = resolve; }); }
  if (upstream.length === failAt) return Response.json({ error: 'quota' }, { status: 402 });
  return new Response(wav(), { headers: { 'Content-Type': 'audio/wav' } });
} });
(async () => {
  let browser;
  try {
    if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = live ? process.env.WECHAT_VOICE_SMOKE_URL.replace(/\/$/, '') : `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.marked = { use() {}, parse: text => String(text) };
      window.DOMPurify = { sanitize: text => String(text) };
      let value;
      Object.defineProperty(window, 'Vue', { configurable: true, get: () => value, set(v) {
        value = v;
        if (!v?.createApp || v.createApp.__voiceTest) return;
        const onMounted = v.onMounted;
        v.onMounted = (hook, ...args) => { const root = !v.getCurrentInstance()?.parent; return onMounted(async (...a) => { await hook(...a); if (root) window.__BOOTED = true; }, ...args); };
        const createApp = v.createApp;
        v.createApp = (...args) => { const app = createApp(...args), mount = app.mount; app.mount = (...a) => { const r = mount(...a); window.__APP = r; return r; }; return app; };
        v.createApp.__voiceTest = true;
      } });
    });
    await page.route('**/assets/js/app/28-wechat-voice.js?*', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'assets/js/app/28-wechat-voice.js'), 'utf8') + '\n{ const original = RPHubAppSections.wechatVoice; RPHubAppSections.wechatVoice = s => { window.__S = s; return original(s); }; }' }));
    await page.route('**/chat/completions', route => {
      requests.push(route.request().postDataJSON());
      const messages = live ? [voice('嗯，我在呢。')] : fixture === 'silence' ? [] : fixture === 'mixed'
        ? [{ type: 'text', content: '刚到家' }, voice('怎么啦，慢慢说。'), { type: 'image_request', media: { mode: 'album', assetId: 'builtin-cat', usage: 'scene_photo' } }, voice('我听着呢。')]
        : fixture === 'two' ? [voice('第一条，别着急。'), voice('第二条，我在呢。')]
        : [voice('我在呢。')];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ messages }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) });
    });
    await page.route('https://nai.sta1n.cn/**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__BOOTED && window.__S, { timeout: 60000 });
    await page.evaluate(async () => {
      const s = window.__S;
      s.user.name = '玩家'; s.showUserSetupModal.value = false;
      s.characters.value.push({ uuid: 'voice-e2e', name: '林晚', description: '已经回到家，在沙发上休息，可以使用手机', personality: '说话随意、温柔但有自己的生活', first_mes: '你好', wechatEnabled: true, wechatSpeed: 'fast', wechatStickerRate: 'off' });
      await s.selectCharacter(0, false, { silent: true });
      s.settings.apiUrl = 'https://mock.local/v1'; s.settings.apiKey = 'fixture'; s.settings.model = 'mock';
      await s.openWechat();
    });
    const send = text => page.evaluate(async value => { const s = window.__S; s.wechatInput.value = value; await s.sendWechatMessage(); }, text);
    if (!live) {
      fixture = 'one'; await send('想听听你的声音');
      check('未配置时不消费、不伪造语音和沉默', upstream.length === 0 && await page.evaluate(() => window.__S.wechatTimeline.value.every(i => i.type !== 'voice' && i.replyDecision !== 'silent')));
    }
    await page.evaluate(() => window.__S.openWechatSettings());
    await page.locator('.wx-voice-settings input[type=checkbox]').check();
    await page.locator('.wx-voice-settings input[type=password]').fill(key);
    await page.locator('.wx-voice-settings input[placeholder="voc_…"]').fill(live ? 'voc_b86bfwct4cjn' : 'voc_test');
    await page.locator('.wx-voice-settings textarea').fill('像平时给朋友留语音，不要播音腔');
    await page.getByRole('button', { name: '读取中文公共音色（不生成音频）' }).click();
    await page.waitForFunction(() => !window.__S.wechatVoiceCatalogLoading.value);
    check('浏览器通过转发读取音色，无 CORS 阻塞', await page.locator('.wx-voice-settings select option').count() > 1);
    await page.evaluate(() => window.__S.saveWechatSettings());
    check('Key 未写入角色卡', await page.evaluate(k => !JSON.stringify(window.__S.characters.value).includes(k), key));
    fixture = 'mixed'; await send(live ? '给我留一句语音吧' : '给我看看猫，再跟我说两句');
    const items = await page.evaluate(() => window.__S.wechatTimeline.value.filter(i => i.role === 'assistant' && i.channel === 'wechat'));
    check('文字、图片与多条语音保持原顺序', items.map(i => i.type).join(',') === (live ? 'voice' : 'text,voice,image,voice'));
    check('成功语音具有实际解码时长', items.filter(i => i.type === 'voice').every(i => i.voice.duration > 0));
    check('音频 Blob 独立持久化', await page.evaluate(async () => {
      const i = window.__S.wechatTimeline.value.find(i => i.type === 'voice');
      return (await RPHubStorage.getStoredValue('wechat_voice_blob_' + i.voice.assetId)) instanceof Blob && !JSON.stringify(i).includes('base64');
    }));
    check('默认没有自动播放', await page.evaluate(() => !window.__S.wechatVoicePlayingId.value));
    await page.locator('.wx-voice-play').first().click();
    await page.waitForFunction(() => !!window.__S.wechatVoicePlayingId.value);
    check('点击后实际播放', await page.locator('.wx-voice-play.playing').count() === 1);
    await page.locator('.wx-voice-transcribe').first().click();
    check('转文字保留实际脚本', (await page.locator('.wx-voice-transcript').first().textContent()) === items.find(i => i.type === 'voice').content);
    fs.mkdirSync(path.join(ROOT, '.refactor-tmp'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, `.refactor-tmp/wechat-voice${live ? '-live' : ''}.png`) });
    if (live) {
      const bytes = await page.evaluate(async () => { const i = window.__S.wechatTimeline.value.find(i => i.type === 'voice'); return Array.from(new Uint8Array(await (await RPHubStorage.getStoredValue('wechat_voice_blob_' + i.voice.assetId)).arrayBuffer())); });
      fs.writeFileSync(path.join(ROOT, '.refactor-tmp/wechat-voice-live.mp3'), Buffer.from(bytes));
      console.log('LIVE_AUDIO ' + JSON.stringify({ bytes: bytes.length, duration: items[0].voice.duration, text: items[0].content, paidRequests: 1 }));
    } else {
      await page.locator('.wx-voice-play').last().click();
      await page.waitForFunction(() => window.__S.wechatVoicePlayingId.value === window.__S.wechatTimeline.value.at(-1).id);
      check('切换语音只播放一条', await page.locator('.wx-voice-play.playing').count() === 1);
      fixture = 'silence'; await send('收到，不用回');
      const history = JSON.stringify(requests.at(-1).messages.slice(1));
      check('历史有语音原文，没有语气指令或资源字节', history.includes('[语音] 怎么啦，慢慢说。') && !history.includes('播音腔') && !history.includes('assetId'));
      const rp = await page.evaluate(async () => JSON.stringify(await window.__S.appendWechatDigestToMessages([{ role: 'user', content: '继续' }])));
      check('RP 回灌保留语音渠道与原文', rp.includes('[语音]') && rp.includes('慢慢说'));
      const material = await page.evaluate(() => { const s = window.__S, c = s.computeRecapCoverage(); return s.buildRecapMaterial(c.coversThroughTurn, c.coversWechatCount); });
      check('前情提要素材包含语音', JSON.stringify(material).includes('[语音]'));
    }
    await page.evaluate(() => window.__S.closeWechat());
    check('关闭面板停止播放并释放 URL', await page.evaluate(() => !window.__S.wechatVoicePlayingId.value));
    await page.evaluate(() => window.__S.openWechat());
    check('重开读取已存语音', await page.locator('.wx-voice-play').count() === (live ? 1 : 2));
    if (!live) {
      const count = upstream.length; fixture = 'silence'; await send('那先这样，不用回啦');
      check('自然空回没有语音请求', upstream.length === count && await page.evaluate(() => window.__S.wechatTimeline.value.at(-1).replyDecision === 'silent'));
      fixture = 'two'; failAt = upstream.length + 2;
      const before = await page.evaluate(() => window.__S.wechatTimeline.value.length);
      await send('还有两句话呢');
      check('第二条合成失败，整批不伪装成成功消息', await page.evaluate(n => window.__S.wechatTimeline.value.length === n + 1 && window.__S.wechatMediaTasks.value[0]?.status === 'failed', before));
      const partialCalls = upstream.length;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__BOOTED && window.__S?.currentCharacter.value);
      await page.evaluate(async () => { const s = window.__S; s.settings.apiUrl = 'https://mock.local/v1'; s.settings.apiKey = 'fixture'; s.settings.model = 'mock'; await s.openWechat(); });
      check('刷新后会话 Key 与角色语音配置恢复', await page.evaluate(() => window.__S.isWechatVoiceReady()));
      await page.getByRole('button', { name: '重试发送' }).click();
      await page.waitForFunction(() => !window.__S.isWechatGenerating.value);
      check('刷新后重试只合成失败的一条', upstream.length === partialCalls + 1);
      const ids = await page.evaluate(() => window.__S.wechatTimeline.value.map(i => i.id));
      check('重试无重复消息 ID', new Set(ids).size === ids.length);
      fixture = 'late';
      await page.evaluate(() => { const s = window.__S; s.wechatInput.value = '再来一句'; window.__LATE = s.sendWechatMessage(); });
      for (let i = 0; i < 100 && !lateStarted; i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(lateStarted);
      const oldCount = await page.evaluate(() => window.__S.wechatTimeline.value.length);
      await page.evaluate(() => window.__S.closeWechat()); lateResolve();
      await page.evaluate(() => window.__LATE); await page.evaluate(() => window.__S.openWechat());
      check('关闭后晚到语音不会落入会话', await page.evaluate(n => window.__S.wechatTimeline.value.length === n, oldCount));
      await page.evaluate(() => window.__S.dismissWechatMediaTask(window.__S.wechatMediaTasks.value[0]));
      await page.evaluate(async () => { const s = window.__S; s.confirmAction = (_prompt, cb) => cb(); await s.deleteWechatMessage(s.wechatTimeline.value.find(i => i.type === 'voice').id); });
      fixture = 'silence'; await send('刚才删了一条');
      check('语音可删除且上下文立即更新', !JSON.stringify(requests.at(-1).messages.slice(1)).includes('[语音] 怎么啦'));
      check('资源读取拒绝其他剧情分支', await page.evaluate(async () => { const s = window.__S, i = s.wechatTimeline.value.find(i => i.type === 'voice'); try { await s.readWechatVoice(i.voice, s.getStoryBranchScopeId('voice-e2e', 'other-branch')); return false; } catch { return true; } }));
      fixture = 'late'; lateStarted = false;
      await page.evaluate(() => { const s = window.__S; s.wechatInput.value = '再给我一句'; window.__LATE = s.sendWechatMessage(); });
      for (let i = 0; i < 100 && !lateStarted; i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(lateStarted);
      await page.evaluate(async () => { const s = window.__S; s.characters.value.push({ uuid: 'voice-other', name: '另一个人', first_mes: '你好', wechatEnabled: true }); await s.selectCharacter(1, false, { silent: true }); await s.openWechat(); });
      lateResolve(); await page.evaluate(() => window.__LATE);
      check('切换角色后晚到语音不会串入新会话', await page.evaluate(() => window.__S.wechatTimeline.value.every(i => i.type !== 'voice') && !window.__S.isWechatVoiceReady()));
      await page.evaluate(async () => { const s = window.__S; await s.selectCharacter(0, false, { silent: true }); await s.openWechat(); });
      await page.evaluate(async () => { const s = window.__S; await s.deleteWechatVoiceOwner('voice-e2e'); });
      check('删除角色资源清理所有音频', await page.evaluate(async () => (await RPHubStorage.getStoredValue('wechat_voice_index')).length === 0));
      check('语音气泡无横向溢出', await page.evaluate(() => document.querySelector('.wx-chat').scrollWidth <= 430));
      await page.evaluate(() => window.__S.openWechatSettings());
      await page.locator('.wx-voice-settings').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(ROOT, '.refactor-tmp/wechat-voice-settings.png') });
    }
    check('0 JavaScript 错误', errors.length === 0);
    console.log(live ? 'WECHAT VOICE LIVE: PASS' : 'WECHAT VOICE E2E: PASS');
  } finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
})().catch(error => { console.error(error); process.exitCode = 1; });
