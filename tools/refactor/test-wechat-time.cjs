// 剧情钟与真实生成管线回归；计时器加速，API/存储替身，不请求真实服务。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(ROOT, 'assets/js', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function harness(response = { messages: [] }) {
  let scope = 'a', id = 0;
  const stored = new Map(), requests = [], watchers = [];
  const c = vm.createContext({ window: {}, console, AbortController,
    ref: value => ({ value }), reactive: value => value, computed: get => ({ get value() { return get(); } }),
    watch: (get, fn) => watchers.push({ get, fn }), nextTick: async () => {}, requestAnimationFrame: fn => fn(),
    document: { getElementById: () => null }, setTimeout: fn => setTimeout(fn, 0), clearTimeout,
    setInterval: () => 1, clearInterval() {}, generateUUID: () => `id-${++id}`,
    getMainDb: () => ({}), initDB: async () => {}, cloneForStorage: plain,
    getStoredValue: async key => stored.has(key) ? plain(stored.get(key)) : null,
    setStoredValue: async (key, data) => stored.set(key, plain(data)),
    getScopedStoredValue: async (key, branch) => plain(stored.get(`${key}/${branch}`) || []),
    setScopedStoredValue: async (key, branch, data) => stored.set(`${key}/${branch}`, plain(data)) });
  for (const name of ['built-in-content.js', 'wechat-time.js', 'wechat-protocol.js', 'app/25-wechat.js']) vm.runInContext(read(name), c);
  const s = { currentCharacter: { value: { uuid: 'char', name: '林晚', wechatEnabled: true, wechatSpeed: 'fast', wechatStickerRate: 'high' } },
    chatHistory: { value: [] }, classicMemories: { value: [] }, storyRecap: { value: null }, memorySettings: { enabled: false },
    activeStoryBranchId: { value: 'a' }, worldInfo: { value: [] }, presets: { value: [] }, user: { name: '我' },
    getCurrentStoryBranchScopeId: () => scope, settings: { apiUrl: 'https://mock.local', apiKey: 'fixture', model: 'mock' },
    buildUserInfoPrompt: () => '我', processRegex: text => text, showToast() {}, scrollChatToBottom: async () => {},
    buildConversationTurnSnapshot: () => ({ turns: [] }), getPostprocessedChatMessages: () => [],
    requestTrackedChatCompletion: async options => { requests.push(options); return { content: JSON.stringify(response) }; } };
  c.window.RPHubAppSections.wechat(s);
  const T = c.window.RPHubWeChatTime;
  return { s, T, c, requests, stored,
    async send(text) { s.wechatInput.value = text; await s.sendWechatMessage(); },
    pick(time) { s.wechatTimeDraft.value = time; s.applyWechatSendTime(); },
    async recap() { vm.runInContext(read('app/26-recap.js'), c); c.window.RPHubAppSections.recap(s); await new Promise(r => setTimeout(r, 0)); },
    async switchScope(value) { scope = value; s.activeStoryBranchId.value = value; watchers.at(-1).fn(); await s.ensureWechatTimelineLoaded(); } };
}
const countTimes = text => (text.match(/【发送时间：/g) || []).length;
test('自定义时间标签落库、编辑与删空可恢复，点击只选择下次发送时间', async () => {
  const h = harness(); await h.s.loadWechatTimeTags();
  assert.equal(h.s.wechatClockLabel.value, '2025-03-11 18:30');
  h.s.editWechatTimeTag(); h.s.wechatTimeTagDraft.minutes = 15; await h.s.saveWechatTimeTag();
  const tag = h.s.wechatTimeTags.value.at(-1);
  assert.equal(tag.label, '15 分钟后');
  h.s.advanceWechatSendTime(tag.minutes);
  assert.equal(h.s.wechatSendAt.value, '2025-03-11T18:45:00');
  assert.equal(h.s.wechatClockLabel.value, '2025-03-11 18:30');
  h.s.editWechatTimeTag(tag); h.s.wechatTimeTagDraft.minutes = 90; h.s.wechatTimeTagDraft.label = '冷静一下'; await h.s.saveWechatTimeTag();
  const fresh = harness(); fresh.stored.set('wechat_time_tags', plain(h.stored.get('wechat_time_tags'))); await fresh.s.loadWechatTimeTags();
  assert.equal(fresh.s.wechatTimeTags.value.at(-1).label, '冷静一下');
  assert.equal(fresh.s.wechatTimeTags.value.at(-1).minutes, 90);
  for (const item of [...fresh.s.wechatTimeTags.value]) await fresh.s.deleteWechatTimeTag(item);
  const empty = harness(); empty.stored.set('wechat_time_tags', plain(fresh.stored.get('wechat_time_tags'))); await empty.s.loadWechatTimeTags();
  assert.equal(empty.s.wechatTimeTags.value.length, 0, '主动删空后不能重新塞回默认标签');
});
test('分钟校验与保存失败保留原标签、编辑草稿和剧情钟', async () => {
  const h = harness(); await h.s.loadWechatTimeTags(); h.s.editWechatTimeTag();
  for (const minutes of ['', 0, -15, 1.5, 'abc', Infinity]) {
    h.s.wechatTimeTagDraft.minutes = minutes; await h.s.saveWechatTimeTag();
    assert.equal(h.s.wechatTimeTags.value.length, 4); assert.ok(h.s.wechatTimeTagError.value);
  }
  h.s.wechatTimeTagDraft.minutes = 20; h.s.wechatTimeTagDraft.label = '等一会';
  h.c.setStoredValue = async () => { throw new Error('写入失败'); };
  await h.s.saveWechatTimeTag();
  assert.equal(h.s.wechatTimeTags.value.length, 4); assert.equal(h.s.wechatTimeTagEditing.value, true);
  assert.equal(h.s.wechatTimeTagDraft.label, '等一会'); assert.equal(h.s.wechatClockLabel.value, '2025-03-11 18:30');
  assert.equal(h.s.wechatTimeTagsSaving.value, false); assert.match(h.s.wechatTimeTagError.value, /保存失败/);
});
test('严格日历、闰年与跨年，不使用浏览器时区解析剧情日期', () => {
  const { T } = harness();
  assert.equal(T.format(T.parse('2024-02-29T23:59:01'), true), '2024-02-29 23:59:01');
  for (const bad of ['2023-02-29T09:00', '2024-13-01T12:00', '2024-01-01T24:00', '2024-01-01T00:60', '0000-01-01T00:00', '明天', '2024-01-01T00:00Z']) assert.equal(T.parse(bad), null, bad);
  const start = T.parse('2023-12-31 23:30');
  assert.equal(T.format(T.resolve({ delayMinutes: 60 }, start)), '2024-01-01 00:30');
  assert.equal(T.resolve({}, start), start);
  assert.equal(T.resolve({ delayMinutes: -1 }, start), start);
  assert.equal(T.resolve({ sendAt: '2020-01-01 09:00' }, start), start);
  assert.equal(T.resolve({ delayMinutes: Infinity }, start), start);
});
test('同一时间连发 40 条仍为一个上下文消息，只有一个时间头', async () => {
  const h = harness(); h.s.wechatBurstMode.value = true; h.pick('2023-08-01T18:00:00');
  for (let i = 1; i <= 40; i++) await h.send(String(i));
  assert.equal(h.s.wechatSendAt.value, '');
  assert.equal(new Set(h.s.wechatTimeline.value.map(m => m.storyAt)).size, 1);
  assert.equal(h.s.wechatDisplayItems.value.filter(m => m.kind === 'day').length, 1);
  await h.s.requestWechatReplyNow();
  const history = h.requests[0].messages.slice(1);
  assert.equal(history.length, 1);
  assert.equal(countTimes(history[0].content), 1);
  assert.ok(history[0].content.endsWith('\n39\n40'));
});
test('同角色跨一小时依旧合并，时间变化处才插入时间头和间隔', async () => {
  const h = harness(); h.s.wechatBurstMode.value = true; h.pick('2023-08-01T18:00:00');
  await h.send('1'); await h.send('2'); h.s.advanceWechatSendTime(60); await h.send('3'); await h.send('4');
  await h.s.requestWechatReplyNow();
  const history = h.requests[0].messages.slice(1);
  assert.equal(history.length, 1);
  assert.equal(countTimes(history[0].content), 2);
  assert.match(history[0].content, /18:00:00】\n1\n2\n【发送时间：2023-08-01 19:00:00｜距上一条 1小时】\n3\n4$/);
  assert.equal(h.s.wechatDisplayItems.value.filter(m => m.kind === 'day').length, 2);
});
test('玩家与模型即时往返共享时间头，模型延迟回复后下一条玩家消息沿用新时间', async () => {
  const h = harness({ messages: [{ type: 'text', content: '2', delayMinutes: 60 }, { type: 'text', content: '3' }] });
  h.pick('2023-08-01T18:00:00'); await h.send('1');
  assert.deepEqual(plain(h.s.wechatTimeline.value.map(m => h.T.format(m.storyAt))), ['2023-08-01 18:00', '2023-08-01 19:00', '2023-08-01 19:00']);
  h.s.wechatBurstMode.value = true; await h.send('4'); await h.s.requestWechatReplyNow();
  const text = h.requests[1].messages.slice(1).map(m => m.content).join('\n');
  assert.equal(countTimes(text), 2);
  assert.equal(h.s.wechatTimeline.value.find(m => m.content === '4').storyAt, h.T.parse('2023-08-01 19:00'));
});
test('绝对时间优先，倒退和无效时间回退为当前时刻；emoji 保留发送元数据', () => {
  const h = harness(), p = h.c.window.RPHubWeChatProtocol;
  const messages = p.parseReply(JSON.stringify({ messages: [{ type: 'text', content: '2', sendAt: '2023-08-01 19:00', delayMinutes: 120 }, { type: 'sticker', content: '🙂', delayMinutes: 5 }] }));
  h.pick('2023-08-01T18:00'); h.s.pushWechatItem({ channel: 'wechat', role: 'user', type: 'text', content: '1' });
  const timed = h.s.resolveWechatReplyTimes(messages);
  assert.deepEqual(plain(timed.map(m => h.T.format(m.storyAt))), ['2023-08-01 19:00', '2023-08-01 19:05']);
  assert.equal(p.parseReply('{"messages":[{"content":"嗯","delayMinutes":-60}]}')[0].delayMinutes, undefined);
});
test('空回不推进剧情钟，后续一小时联系保留沉默间隔', async () => {
  const h = harness({ messages: [], silence: { reason: 'upset', awareness: 'read', summary: '还在赌气' } });
  h.pick('2023-08-01T18:00'); await h.send('1');
  const first = h.s.wechatTimeline.value[0];
  assert.equal(first.replySilence.storyAt, first.storyAt);
  h.s.advanceWechatSendTime(60); await h.send('你现在还生气吗');
  assert.ok(h.requests[1].messages.some(m => m.content.includes('距离上次沉默的剧情间隔：1小时')));
  assert.equal(h.s.wechatTimeline.value.length, 2);
});
test('时间选择不提前推进；倒退发送保留草稿，取消选择恢复同一时刻', async () => {
  const h = harness(); h.s.wechatBurstMode.value = true; h.pick('2023-08-01T18:00'); await h.send('1');
  h.s.advanceWechatSendTime(60);
  assert.equal(h.s.wechatClockLabel.value, '2023-08-01 18:00');
  h.s.resetWechatSendTime(); await h.send('2');
  assert.equal(h.s.wechatTimeline.value[1].storyAt, h.s.wechatTimeline.value[0].storyAt);
  h.s.wechatSendAt.value = '2023-08-01T17:00'; await h.send('保留草稿');
  assert.equal(h.s.wechatInput.value, '保留草稿'); assert.equal(h.s.wechatTimeline.value.length, 2);
});
test('RP 首行完整公历时间自动继承；无年份、架空历法与正文提及不猜测', async () => {
  const h = harness();
  assert.equal(h.T.format(h.T.rpTime('【2023年08月01日 07时】\n她拿起手机')), '2023-08-01 07:00');
  for (const text of ['【第1日 07时】', '【承和三年八月初七 辰时】', '她说：明天是2023-08-01 07:00', '【2023年02月29日 07时】']) assert.equal(h.T.rpTime(text), null);
  h.s.chatHistory.value.push({ id: 'rp1', role: 'assistant', content: '【2023年08月01日 07时】\n她醒了' });
  await h.s.openWechat(); h.s.wechatBurstMode.value = true; await h.send('早');
  assert.equal(h.s.wechatClockLabel.value, '2023-08-01 07:00');
  h.s.chatHistory.value.push({ id: 'rp2', role: 'assistant', content: '【2023年08月01日 09时】\n她下课了' });
  await h.s.recordRpMessages(); await h.send('下课了吗');
  assert.equal(h.s.wechatClockLabel.value, '2023-08-01 09:00');
});
test('首次旧现实记录可重新锚定到剧情日期，旧 ts 不重写', async () => {
  const h = harness(), ts = Date.now();
  h.s.wechatTimeline.value.push({ id: 'legacy', ts, channel: 'wechat', role: 'user', type: 'text', content: '旧记录' });
  h.s.wechatBurstMode.value = true; h.pick('2023-08-01T18:00'); await h.send('新剧情');
  assert.equal(h.s.wechatClockLabel.value, '2023-08-01 18:00');
  assert.equal(h.s.wechatTimeline.value[0].ts, ts); assert.equal(h.s.wechatTimeline.value[0].storyAt, undefined);
});
test('落库、重新打开和分支切换恢复各自剧情钟，待发送选择不串分支', async () => {
  const h = harness(); await h.s.openWechat(); h.s.wechatBurstMode.value = true; h.pick('2023-08-01T18:00'); await h.send('A');
  await h.s.closeWechat(); await h.s.openWechat();
  assert.equal(h.s.wechatClockLabel.value, '2023-08-01 18:00'); h.s.advanceWechatSendTime(60);
  await h.switchScope('b'); assert.equal(h.s.wechatSendAt.value, ''); h.pick('2025-01-01T09:00'); await h.send('B');
  await h.s.saveWechatTimelineNow(); await h.switchScope('a');
  assert.equal(h.s.wechatClockLabel.value, '2023-08-01 18:00');
  assert.equal(h.stored.get('wechat_timeline/b')[0].storyAt, h.T.parse('2025-01-01 09:00'));
});
test('RP 回灌、摘要素材和摘要保留窗口使用同样的合并时间标记', async () => {
  const h = harness(); await h.recap(); h.s.wechatBurstMode.value = true; h.pick('2023-08-01T18:00');
  await h.send('1'); await h.send('2'); h.s.advanceWechatSendTime(60); await h.send('3'); await h.send('4');
  const rp = h.s.appendWechatDigestToMessages([]).map(m => m.content).join('\n');
  assert.equal(countTimes(rp), 2); assert.ok(rp.includes('距上一条 1小时'));
  assert.equal(countTimes(h.s.buildRecapMaterial(0, 4).join('\n')), 2);
  h.s.storyRecap.value = { text: '此前聊天', coversThroughTurn: 0, coversWechatCount: 4, keepRPTurns: 0, keepWechatCount: 2 };
  const recent = h.s.buildRecapRecentWechatText();
  assert.equal(countTimes(recent), 1); assert.ok(recent.includes('19:00:00')); assert.ok(!recent.includes('18:00:00'));
});
test('混合文字、表情、文件连发仅开头一个时间，首次多模态内容也有时间', async () => {
  const h = harness(); h.s.wechatBurstMode.value = true; h.pick('2023-08-01T18:00');
  h.s.wechatDocumentRecordText = () => '[文件] 笔记.txt';
  h.s.pushWechatItem({ channel: 'wechat', role: 'user', type: 'image', content: 'data:image/png;base64,fixture' });
  h.s.pushWechatItem({ channel: 'wechat', role: 'user', type: 'document', content: '' });
  h.s.pushWechatItem({ channel: 'wechat', role: 'user', type: 'sticker', content: '🙂' });
  await h.s.requestWechatReplyNow();
  const history = h.requests[0].messages.slice(1);
  assert.equal(countTimes(JSON.stringify(history)), 1); assert.equal(history.length, 2);
  assert.equal(history[0].content[0].type, 'text'); assert.equal(history[0].content[1].type, 'image_url');
});
