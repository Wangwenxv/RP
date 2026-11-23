// 复制记录的格式、完整性和剪贴板降级；不请求模型或媒体资源。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
function harness() {
  let scope = 'branch-a';
  const copies = [], toasts = [], stored = new Map();
  const c = vm.createContext({ window: { getSelection: () => null }, console: { error() {} },
    navigator: { clipboard: { writeText: async text => copies.push(text) } },
    ref: value => ({ value }), reactive: value => value, computed: get => ({ get value() { return get(); } }),
    watch() {}, nextTick: async () => {}, setTimeout, clearTimeout, setInterval, clearInterval,
    getScopedStoredValue: async (key, branch) => stored.get(`${key}/${branch}`) || [],
    document: { activeElement: null }, generateUUID: () => 'fixture-id' });
  for (const file of ['wechat-time.js', 'wechat-protocol.js', 'app/25-wechat.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js', file), 'utf8'), c);
  }
  const s = { currentCharacter: { value: { uuid: 'character-a', name: '杨德兵', wechatPeerName: '杨德兵' } },
    activeStoryBranchId: { value: scope }, chatHistory: { value: [] }, user: { name: '王文叙' },
    getCurrentStoryBranchScopeId: () => scope, showToast: (text, type) => toasts.push({ text, type }) };
  c.window.RPHubAppSections.wechat(s);
  const T = c.window.RPHubWeChatTime;
  const message = (id, role, content, time = '2026-11-20 17:43:50', extra = {}) =>
    ({ id, channel: 'wechat', type: 'text', role, content, storyAt: T.parse(time), ...extra });
  return { c, s, T, copies, toasts, message, stored,
    async loaded() { await s.ensureWechatTimelineLoaded(); },
    switchScope(value) { scope = value; } };
}

test('姓名、上午/下午时间、秒和正文按示例输出，保留多行与连续消息顺序', () => {
  const h = harness();
  h.s.wechatTimeline.value = [
    h.message('1', 'user', '再试最后一次看看'),
    h.message('2', 'user', '真的，感觉就是这个问题了', '2026-11-20 17:44:01'),
    h.message('3', 'assistant', '咋样了，有方案了不', '2026-11-23 11:55:15'),
    h.message('4', 'user', '第一行\n\n第二行', '2026-11-23 12:01:00')
  ];
  assert.equal(h.s.buildWechatTranscriptText(), '王文叙 11/20 下午5:43:50\n再试最后一次看看\n\n'
    + '王文叙 11/20 下午5:44:01\n真的，感觉就是这个问题了\n\n'
    + '杨德兵 11/23 上午11:55:15\n咋样了，有方案了不\n\n王文叙 11/23 下午12:01:00\n第一行\n\n第二行');
});

test('图片只取存好描述，语音只取向上取整时长，表情/文件保留名字', () => {
  const h = harness();
  const secrets = '不应复制的二进制、语音正文、地址或文件原文';
  h.s.wechatTimeline.value = [
    h.message('1', 'assistant', secrets, undefined, { type: 'image', media: { assetId: 'secret-asset', caption: '木桌上的蔬菜沙拉' } }),
    h.message('2', 'assistant', secrets, undefined, { type: 'image', media: { descriptionOnly: true, caption: '靠窗的书桌' } }),
    h.message('3', 'user', 'data:image/png;base64,secret', undefined, { type: 'image' }),
    h.message('4', 'assistant', secrets, undefined, { type: 'voice', voice: { assetId: 'secret-voice', duration: 12.1 } }),
    h.message('5', 'assistant', secrets, undefined, { type: 'voice', voice: { duration: NaN } }),
    h.message('6', 'user', '点头', undefined, { type: 'sticker', stickerImage: 'data:image/png;base64,secret' }),
    h.message('7', 'user', secrets, undefined, { type: 'document', document: { name: '说明.txt', assetId: 'secret-doc' } })
  ];
  const text = h.s.buildWechatTranscriptText();
  for (const body of ['【image：木桌上的蔬菜沙拉】', '【image：靠窗的书桌】', '【image】', '【语音 13秒】', '【语音】', '【表情：点头】', '【文件：说明.txt】']) assert.ok(text.includes(body), body);
  assert.doesNotMatch(text, /secret|不应复制|data:|NaN/);
});

test('复制全部已发送微信，不受显示窗口和压缩计数影响，排除 RP 与系统记录', () => {
  const h = harness();
  h.s.wechatDisplayLimit.value = 2;
  h.s.storyRecap = { value: { coversWechatCount: 100 } };
  h.s.wechatTimeline.value = Array.from({ length: 105 }, (_, i) => h.message(String(i), i % 2 ? 'assistant' : 'user', `消息${i}`));
  h.s.wechatTimeline.value.splice(2, 0, h.message('rp', 'user', 'RP 原文', undefined, { channel: 'rp' }), h.message('sys', 'system', '系统提示'));
  const text = h.s.buildWechatTranscriptText();
  assert.equal((text.match(/11\/20/g) || []).length, 105);
  assert.ok(text.startsWith('王文叙 11/20 下午5:43:50\n消息0\n\n'));
  assert.ok(text.endsWith('消息104'));
  assert.doesNotMatch(text, /RP 原文|系统提示/);
});

test('剧情钟不按本机时区换算；旧 ts 沿用本机日历；缺时间/姓名合理降级', () => {
  const h = harness();
  h.s.user.name = '';
  h.s.currentCharacter.value.wechatPeerName = '';
  h.s.wechatTimeline.value = [h.message('midnight', 'user', '零点', '2026-11-23 00:00:05'),
    { id: 'legacy', channel: 'wechat', role: 'assistant', type: 'text', content: '旧消息', ts: new Date(2026, 10, 20, 17, 45, 28).getTime() },
    { id: 'missing', channel: 'wechat', role: 'user', type: 'text', content: '缺少时间' }];
  assert.equal(h.s.buildWechatTranscriptText(), '我 11/23 上午12:00:05\n零点\n\n杨德兵 11/20 下午5:45:28\n旧消息\n\n我\n缺少时间');
});

test('按钮写入完整文本、关闭菜单、反馈成功；编辑后复制新正文', async () => {
  const h = harness(); await h.loaded();
  const m = h.message('1', 'user', '原文'); h.s.wechatTimeline.value = [m];
  h.s.wechatMenu.open = true;
  m.content = '已编辑正文';
  await h.s.copyWechatTranscript();
  assert.deepEqual(h.copies, ['王文叙 11/20 下午5:43:50\n已编辑正文']);
  assert.equal(h.s.wechatMenu.open, false);
  assert.equal(h.toasts.at(-1).type, 'success');
  assert.equal(h.s.isWechatCopying.value, false);
  await h.s.copyWechatMessageText(m);
  assert.equal(h.copies.at(-1), '已编辑正文', '单条复制仍只复制正文');
});

test('空记录和分支未加载不碰剪贴板，加载新分支后只复制新分支', async () => {
  const h = harness(); await h.loaded(); await h.s.copyWechatTranscript();
  assert.equal(h.toasts.at(-1).text, '暂无可复制的聊天记录');
  h.s.wechatTimeline.value = [h.message('a', 'user', '旧分支')];
  h.switchScope('branch-b'); await h.s.copyWechatTranscript();
  assert.equal(h.copies.length, 0);
  assert.equal(h.toasts.at(-1).text, '聊天记录正在加载，请稍后重试');
  h.stored.set('wechat_timeline/branch-b', [h.message('b', 'assistant', '新分支')]);
  await h.loaded(); await h.s.copyWechatTranscript();
  assert.match(h.copies[0], /新分支/); assert.doesNotMatch(h.copies[0], /旧分支/);
});

test('重复点击只复制一次，异步写入使用点击时快照，生成中也可复制已发消息', async () => {
  const h = harness(); await h.loaded();
  h.s.wechatTimeline.value = [h.message('1', 'user', '当前消息')];
  h.s.isWechatGenerating.value = true;
  let resolve;
  h.c.navigator.clipboard.writeText = text => { h.copies.push(text); return new Promise(r => { resolve = r; }); };
  const pending = h.s.copyWechatTranscript();
  h.s.wechatTimeline.value.push(h.message('2', 'assistant', '之后发出'));
  await h.s.copyWechatTranscript();
  assert.equal(h.copies.length, 1); assert.doesNotMatch(h.copies[0], /之后发出/);
  assert.equal(h.s.isWechatCopying.value, true);
  resolve(); await pending; assert.equal(h.s.isWechatCopying.value, false);
});

test('剪贴板 API 缺失或拒绝时降级复制，双重失败提示错误并清理临时节点', async () => {
  for (const mode of ['missing', 'denied', 'failed']) {
    const h = harness(); await h.loaded();
    h.s.wechatTimeline.value = [h.message('1', 'user', '待复制')];
    let removed = false, restored = false, textarea;
    h.c.document.activeElement = { focus: () => { restored = true; } };
    h.c.document.createElement = () => (textarea = { style: {}, focus() {}, select() {}, remove() { removed = true; } });
    h.c.document.body = { appendChild() {} };
    h.c.document.execCommand = () => { if (mode === 'failed') return false; h.copies.push(textarea.value); return true; };
    h.c.navigator.clipboard = mode === 'missing' ? undefined : { writeText: async () => { throw new Error('denied'); } };
    await h.s.copyWechatTranscript();
    assert.ok(removed && restored);
    assert.equal(h.s.isWechatCopying.value, false);
    assert.equal(h.toasts.at(-1).type, mode === 'failed' ? 'error' : 'success');
    assert.equal(h.copies.length, mode === 'failed' ? 0 : 1);
  }
});
