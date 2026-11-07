// 真实提示词与记忆/提要模块的请求回归；不调用模型，不读取个人数据。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(ROOT, 'assets/js', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function harness() {
  const requests = [], stored = new Map(), toasts = [];
  const c = vm.createContext({ window: {}, console, AbortController,
    ref: value => ({ value }), reactive: value => value, computed: get => ({ get value() { return get(); } }), watch() {},
    parseCot: text => ({ main: String(text).replace(/<cot>[\s\S]*?<\/cot>/g, '') }),
    getMainDb: () => ({}), initDB: async () => {}, cloneForStorage: plain,
    getStoredValue: async key => stored.get(key) || null,
    setStoredValue: async (key, value) => stored.set(key, plain(value)),
    getScopedStoredValue: async (key, scope) => stored.get(`${key}/${scope}`) || null,
    setScopedStoredValue: async (key, scope, value) => stored.set(`${key}/${scope}`, plain(value)) });
  for (const file of ['built-in-content.js', 'wechat-time.js', 'wechat-protocol.js']) vm.runInContext(read(file), c);
  c.BUILTIN_PROMPTS = c.window.RPHubBuiltinContent.prompts;
  c.window.RPHubUtils = { parseCot: c.parseCot };
  const s = { currentCharacter: { value: { uuid: 'fixture', name: '林晚' } }, user: { name: '阿伟' },
    memorySettings: { classicModel: 'summary-fixture' }, settings: { apiUrl: 'https://mock.local', apiKey: 'fixture' },
    chatHistory: { value: [] }, classicMemories: { value: [] }, wechatTimeline: { value: [] },
    isConversationBusy: { value: false }, getCurrentStoryBranchScopeId: () => 'fixture', showToast: (...args) => toasts.push(args),
    stripNextResponsePrompt: text => text, stripUiTemplateContextInjection: text => text, stripDisabledImageGenContext: text => text,
    requestTrackedChatCompletion: async options => { requests.push(plain({ ...options, signal: undefined })); return { content: '核对后的总结' }; }
  };
  vm.runInContext(read('app/16-memory-extraction.js'), c); c.window.RPHubAppSections.memoryExtraction(s);
  return { c, s, requests, stored, toasts, p: c.BUILTIN_PROMPTS, async recap() {
    vm.runInContext(read('app/26-recap.js'), c); c.window.RPHubAppSections.recap(s);
    await new Promise(resolve => setImmediate(resolve));
  } };
}

test('追加本体边界保留消息顺序、来源与原生工具签名，且不修改调用者数据', () => {
  const { p } = harness();
  const source = [{ role: 'system', content: '已经经过正则的系统提示', _worldInfoEntries: ['fixture'] },
    { role: 'user', content: '我想去图书馆，但还没决定' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1' }], extra_content: { signature: 'native' } },
    { role: 'tool', tool_call_id: 'call-1', content: '路线约20分钟' }];
  const before = plain(source), result = p.appendPlayerAgencyPrompt(source, { userName: '阿伟', characterName: '林晚' });
  assert.deepEqual(plain(source), before);
  assert.deepEqual(plain(result.slice(1)), before.slice(1));
  assert.deepEqual(plain(result[0]._worldInfoEntries), ['fixture']);
  assert.ok(result[0].content.startsWith(source[0].content));
  assert.ok(result[0].content.endsWith('</player_agency>'));
  assert.match(result[0].content, /玩家是「阿伟」/);
  assert.match(result[0].content, /明确要求代写、托管/);
  assert.match(result[0].content, /撤回授权后立即停止/);
});

test('缺少system的请求也有本体边界；微信明确你是AI角色、对方是玩家', () => {
  const { c, p } = harness();
  const messages = p.appendPlayerAgencyPrompt([{ role: 'user', content: '继续' }]);
  assert.equal(messages[0].role, 'system');
  const wx = c.window.RPHubWeChatProtocol.buildSystemPrompt('插画师', {
    userName: '阿伟', characterName: '林晚', presetRules: '自主推进', memory: '阿伟想去图书馆' });
  assert.match(wx, /微信中的“你”指AI角色，“对方”才是玩家/);
  assert.ok(wx.indexOf('<player_agency>') > wx.indexOf('【长期记忆】'));
  assert.equal((wx.match(/<player_agency>/g) || []).length, 1);
});

test('RP在最后玩家输入后具名提醒，不改写原输入或插断原生工具续写', () => {
  const { p } = harness();
  const source = [{ role: 'system', content: '人设与剧情' }, { role: 'user', name: '陈璃', content: '我暂时留在实验室。继续。', _sourceIndexes: [3] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'native-call' }], extra_content: { signature: 'signed' } },
    { role: 'tool', tool_call_id: 'native-call', content: '既有工具结果' }];
  const before = plain(source), result = p.appendPlayerAgencyPrompt(source, { userName: '陈璃', characterName: '苏祈雪', includeTurnReminder: true });
  assert.deepEqual(plain(source), before);
  assert.deepEqual(plain(result.slice(2)), before.slice(2));
  assert.ok(result[1].content.startsWith(before[1].content));
  assert.match(result[1].content, /本轮玩家是「陈璃」，你扮演「苏祈雪」/);
  assert.match(result[1].content, /短回复和保持现状有效/);
  assert.ok(result[1].content.endsWith('</player_turn_boundary>'));
  assert.deepEqual(plain(result[1]._sourceIndexes), [3]);
  assert.match(result[0].content, /不得输出以「陈璃」为发送者的新微信/);
});

test('提醒保留玩家图片等多模态原件；无玩家消息时不伪造新用户回合', () => {
  const { p } = harness();
  const content = [{ type: 'text', text: '这是我现在的位置' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }];
  const result = p.appendPlayerAgencyPrompt([{ role: 'user', content }], { includeTurnReminder: true });
  assert.deepEqual(plain(result[1].content.slice(0, 2)), content);
  assert.equal(result[1].content.at(-1).type, 'text');
  assert.match(result[1].content.at(-1).text, /<player_turn_boundary>/);
  const noUser = p.appendPlayerAgencyPrompt([{ role: 'assistant', content: '旧剧情' }], { includeTurnReminder: true });
  assert.deepEqual(plain(noUser.map(message => message.role)), ['system', 'assistant']);
});

test('用户报告的陈璃代发样例作为AI素材核对，不能单凭姓名气泡存成已发送或已读', async () => {
  const { s, requests } = harness(); s.user.name = '陈璃'; s.currentCharacter.value.name = '苏祈雪';
  await s.requestClassicMemorySummary({ turn: 1, contextTurns: [{ turn: 1, isTarget: true,
    userContent: '我还在实验室，暂时没决定去哪，也没发微信。',
    assistantContent: '陈璃走出实验楼，掏出手机。陈璃：收拾完了。晚上集训，你吃饭没？他又追加一句，消息发出去，变成了已读。' }] });
  const prompt = requests[0].messages[0].content;
  assert.match(prompt, /用户角色名：陈璃。AI角色名：苏祈雪/);
  assert.match(prompt, /没有玩家原输入或明确授权支持时不能记成玩家已发送/);
  assert.match(prompt, /虚构的送达\/已读记成事实/);
  assert.match(requests[0].messages[1].content, /【玩家原输入】\n我还在实验室/);
  assert.match(requests[0].messages[2].content, /【AI叙述｜玩家行为需核对原输入】\n陈璃走出实验楼/);
});

test('逐轮总结真实请求区分玩家原输入与AI叙述，历史背景仍非目标', async () => {
  const { s, requests } = harness();
  await s.requestClassicMemorySummary({ turn: 2, contextTurns: [
    { turn: 1, isTarget: false, userContent: '我不想去', assistantContent: '角色提出邀请' },
    { turn: 2, isTarget: true, userContent: '我还在考虑', assistantContent: '阿伟答应并出门' }
  ] });
  const { messages } = requests[0];
  assert.match(messages[0].content, /AI单方面写出的玩家选择或行动不能/);
  assert.match(messages[1].content, /历史背景：仅供理解/);
  assert.match(messages[3].content, /唯一总结目标｜第 2 轮】\n【玩家原输入】\n我还在考虑/);
  assert.match(messages[4].content, /【AI叙述｜玩家行为需核对原输入】\n阿伟答应并出门/);
  assert.equal(requests[0].temperature, 0.2);
});

test('二次压缩携带原输入核对旧代写，不把缺失来源当成确认', async () => {
  const { s, requests } = harness();
  await s.requestClassicSecondarySummary([
    { turn: 2, summary: '阿伟接受邀请', sourceUserText: '' },
    { turn: 1, summary: '阿伟出门', sourceUserText: '我想去，但还没决定' }
  ]);
  const { messages } = requests[0];
  assert.match(messages[0].content, /不得压缩成决定、执行或到达/);
  assert.ok(messages[1].content.indexOf('第 1 轮') < messages[1].content.indexOf('第 2 轮'));
  assert.match(messages[1].content, /【玩家原输入｜仅供核对该轮总结】\n我想去，但还没决定/);
  assert.match(messages[1].content, /【玩家原输入缺失｜来源不清的玩家决定保持未确认】/);
});

test('RP与微信混合提要保留身份、时间顺序与未决状态约束，保留窗口同样带来源', async () => {
  const h = harness(), { s, requests, stored, toasts } = h;
  s.chatHistory.value = [
    { role: 'user', content: '我想去图书馆，但还没决定' },
    { role: 'assistant', content: '<cot>推断用户愿意</cot>阿伟已经出门' },
    { role: 'user', content: '我没有出门，仍在房间' },
    { role: 'assistant', content: '林晚留在原处' }
  ];
  s.buildConversationTurnSnapshot = () => ({ turns: [{ turn: 1, sourceIndexes: [0, 1] }, { turn: 2, sourceIndexes: [2, 3] }] });
  s.wechatTimeline.value = [{ channel: 'rp', rpIndex: 0 }, { channel: 'rp', rpIndex: 1 },
    { channel: 'wechat', role: 'assistant', type: 'text', content: '要过来吗？', storyAt: '2026-11-07T09:00:00' },
    { channel: 'wechat', role: 'user', type: 'text', content: '我还没答应', storyAt: '2026-11-07T09:00:00' },
    { channel: 'rp', rpIndex: 2 }, { channel: 'rp', rpIndex: 3 }];
  await h.recap();
  const material = s.buildRecapMaterial(2, 2).join('\n');
  assert.match(material, /【RP玩家原输入｜阿伟】我想去/);
  assert.match(material, /【RP AI叙述｜林晚】阿伟已经出门/);
  assert.ok(material.indexOf('要过来吗？') < material.indexOf('我没有出门'));
  assert.ok(!material.includes('推断用户愿意'));
  await s.runStoryRecap();
  assert.equal(requests.length, 1);
  assert.equal(toasts.filter(item => item[1] === 'error').length, 0);
  assert.equal(stored.get('story_recap/fixture').text, '核对后的总结');
  assert.match(requests[0].messages[0].content, /以更正后的状态为准/);
  assert.ok(requests[0].messages.some(message => message.content === material));
  assert.match(s.buildRecapRecentRpText(), /【RP玩家原输入｜阿伟】我没有出门/);
});

test('剧情规划不再要求推断玩家真实需求，变量更新同样要求行动来源', () => {
  const { c, p } = harness();
  for (const memoryEnabled of [false, true]) {
    const cot = c.window.RPHubBuiltinPresets.buildCotPresetContent({ memoryEnabled, uiTemplateAnalysisEnabled: true });
    assert.ok(!cot.includes('最新输入里的潜台词、情绪和真实需求'));
    assert.match(cot, /不转成玩家决定或行动/);
    assert.match(cot, /只设计回应点，不提前写出结果/);
  }
  const variables = p.buildUiTemplateAnalysisSystemPrompt({ userName: '阿伟' });
  assert.match(variables, /涉及玩家决定、移动、态度或心理的变量必须有玩家原输入/);
});

test('RP可叙述分开的NPC生活和主动联系，但读者视角不向人物共享；微信保持角色口吻', () => {
  const { c, p } = harness();
  const rp = p.appendPlayerAgencyPrompt([{ role: 'user', content: '我在实验室继续训练，我们各自忙自己的事。' }], {
    userName: '陈璃', characterName: '苏祈雪', includeTurnReminder: true });
  assert.match(rp[0].content, /玩家本轮做的事只是一条世界线/);
  assert.match(rp[0].content, /可以连贯写她与朋友相处/);
  assert.match(rp[0].content, /这只让读者看见，不会自动让玩家或别的NPC知道/);
  assert.match(rp[0].content, /不预设玩家答应、出发、援助或成功/);
  assert.match(rp[1].content, /无须玩家介入的NPC事务可以连贯展开/);
  for (const summary of [
    p.buildClassicSummarySystemPrompt({ userName: '陈璃', characterName: '苏祈雪' }),
    p.buildClassicSecondarySummaryPrompt({ userName: '陈璃', characterName: '苏祈雪', startTurn: 1, endTurn: 3 }),
    p.buildStoryRecapSystemPrompt({ userName: '陈璃', characterName: '苏祈雪' })
  ]) {
    assert.match(summary, /玩家不在场不等于没有发生/);
    assert.match(summary, /不能把压缩摘要写成所有人物共有的记忆/);
  }
  const wx = c.window.RPHubWeChatProtocol.buildSystemPrompt('苏祈雪', { userName: '陈璃', characterName: '苏祈雪' });
  assert.ok(!wx.includes('<rp_narrative_scope>'), 'RP的世界叙述不进入微信JSON角色口吻');
  assert.match(wx, /只能输出AI角色的消息/);
});

test('COT与人称预设允许NPC场景切换，去用户中心化不把主角色固定为中心', () => {
  const { c, p } = harness(), presets = c.window.RPHubBuiltinPresets.managedPresets;
  const cot = c.window.RPHubBuiltinPresets.buildCotPresetContent({ memoryEnabled: true, uiTemplateAnalysisEnabled: false });
  assert.match(cot, /无须玩家回应时允许完整展开NPC片段/);
  assert.match(cot, /读者看见不等于人物知道/);
  assert.match(presets.deUserCentric.content, /\{\{char\}\} 也不是固定叙事中心/);
  assert.match(presets.secondPerson.content, /不把镜头限制在玩家视野内/);
  assert.match(presets.thirdPerson.content, /可切换NPC场景/);
  assert.match(p.buildNextResponsePrompt(), /可以切到角色或其他NPC的独立事务/);
});
