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

test('RP具名规则集中到system，玩家输入和原生工具续写保持原样', () => {
  const { p } = harness();
  const source = [{ role: 'system', content: '人设与剧情' }, { role: 'user', name: '陈璃', content: '我暂时留在实验室。继续。', _sourceIndexes: [3] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'native-call' }], extra_content: { signature: 'signed' } },
    { role: 'tool', tool_call_id: 'native-call', content: '既有工具结果' }];
  const before = plain(source), result = p.appendPlayerAgencyPrompt(source, { userName: '陈璃', characterName: '苏祈雪', includeTurnReminder: true });
  assert.deepEqual(plain(source), before);
  assert.deepEqual(plain(result.slice(2)), before.slice(2));
  assert.deepEqual(plain(result[1]), before[1]);
  assert.match(result[0].content, /玩家是「陈璃」，AI扮演「苏祈雪」/);
  assert.deepEqual(plain(result[1]._sourceIndexes), [3]);
  assert.match(result[0].content, /不得输出以「陈璃」为发送者的新微信/);
  const repeated = p.appendPlayerAgencyPrompt(result, { userName: '陈璃', characterName: '苏祈雪', includeTurnReminder: true });
  assert.deepEqual(plain(repeated), plain(result), '重复装配同一规则不重复注入');
  assert.equal((JSON.stringify(result).match(/<player_agency>/g) || []).length, 1);
});

test('提醒保留玩家图片等多模态原件；无玩家消息时不伪造新用户回合', () => {
  const { p } = harness();
  const content = [{ type: 'text', text: '这是我现在的位置' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }];
  const result = p.appendPlayerAgencyPrompt([{ role: 'user', content }], { includeTurnReminder: true });
  assert.deepEqual(plain(result[1].content), content);
  const noUser = p.appendPlayerAgencyPrompt([{ role: 'assistant', content: '旧剧情' }], { includeTurnReminder: true });
  assert.deepEqual(plain(noUser.map(message => message.role)), ['system', 'assistant']);
});

test('发送者边界区分玩家草稿、玩家明确发送与角色发送指令，身份和工具来自本轮参数', () => {
  const { p } = harness();
  const rp = p.buildPlayerAgencyPrompt({ userName: '陈璃', characterName: '苏祈雪', wechatToolNames: ['tool_wechat'] });
  assert.match(rp, /tool_wechat 的方向固定为「苏祈雪」→「陈璃」/);
  assert.match(rp, /“我想给苏祈雪发：到宿舍了吗”→这是「陈璃」的草稿和意向，尚未发送/);
  assert.match(rp, /“我给苏祈雪发：到宿舍了吗”→保留「陈璃」→「苏祈雪」的方向/);
  assert.match(rp, /“让苏祈雪给我发：到宿舍了吗”才是指向角色发送的要求/);
  assert.match(rp, /“帮我发给她”仍是玩家代发请求/);
  assert.match(rp, /玩家想说某句话不构成角色主动联系的动机/);
  assert.match(rp, /queued:true、delivered:false 只证明已排队/);
  assert.ok(!rp.includes('本轮未提供角色发送工具'));
  const off = p.buildPlayerAgencyPrompt({ userName: '陈璃', characterName: '苏祈雪' });
  assert.match(off, /本轮未提供角色发送工具/);
  const wx = p.buildPlayerAgencyPrompt({ userName: '陈璃', characterName: '苏祈雪', channel: 'wechat' });
  assert.match(wx, /当前微信回复只生成「苏祈雪」发给「陈璃」的消息/);
  assert.ok(!wx.includes('本轮未提供角色发送工具'), '被动微信仍用回复协议，不要求RP发送工具');
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
  assert.match(messages[0].content, /玩家想发给角色的台词不能总结成角色主动发给玩家/);
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
  const archives = s.buildStoryRecapMessages();
  assert.equal(archives.length, 3, '摘要、RP窗口、微信窗口各自独立');
  assert.ok(archives.every(message => message.role === 'user' && !message.name
    && message._contextOrigin === 'story_archive' && message._preventContextMerge));
  assert.ok(archives.every(message => message.content.includes('非玩家本轮发言')));
  vm.runInContext(read('data-services.js'), h.c);
  const source = [...archives, { role: 'user', name: '阿伟', content: '本轮我还在房间', _sourceIndexes: [4] }];
  const before = plain(source), utils = h.c.window.RPHubContextUtils;
  const normalized = utils.postprocessContextMessages(utils.postprocessContextMessages(source));
  assert.deepEqual(plain(source), before, '不改写保存的来源');
  assert.equal(normalized.length, 4, '背景不与最新玩家输入合并');
  assert.ok(normalized.slice(0, 3).every(message => !message.name && message._contextOrigin === 'story_archive'));
  assert.equal(normalized.at(-1).name, '阿伟');
  // 即使调用方没有合并保护标记，不同来源也不能冒用后一条玩家的 name。
  assert.equal(utils.postprocessContextMessages([
    { role: 'user', content: '历史资料', _contextOrigin: 'story_archive' },
    { role: 'user', name: '阿伟', content: '真实输入' }
  ]).length, 2);
});

test('开启逐轮记忆后，前情提要仍读完整正文而不是替换后的总结；已有提要也不会让原文目标变成旧总结', async () => {
  const h = harness(), { s, requests } = h;
  s.memorySettings.enabled = true;
  s.chatHistory.value = [{ role: 'user', content: '我只借蓝色钥匙，周五还，没有答应留宿。' }, { role: 'assistant', content: '钥匙编号 K731，在第三层抽屉。' }];
  s.classicMemories.value = [{ turn: 1, summary: 'MEMORY_SHORT 只是借钥匙' }];
  s.buildConversationTurnSnapshot = () => ({ turns: [{ turn: 1, sourceIndexes: [0, 1] }] });
  await h.recap(); s.storyRecap.value = { text: 'OLD_RECAP 钥匙事件', coversThroughTurn: 0, coversWechatCount: 0 };
  await s.runStoryRecap();
  const material = requests[0].messages.find(message => message.content.includes('【RP玩家原输入'));
  assert.match(material.content, /编号 K731.*第三层抽屉/);
  assert.match(material.content, /没有答应留宿/); assert.doesNotMatch(material.content, /MEMORY_SHORT/);
  assert.ok(requests[0].messages.some(message => message.content.includes('【已有前情提要】')));
  assert.equal(requests[0].requestLabel, 'RP/微信前情提要');
});

test('增强召回不重复注入当前上下文中已经存在的同一总结，相关候选仍附来源且不改原消息', () => {
  const h = harness(); vm.runInContext(read('data-services.js'), h.c);
  const input = [{ role: 'assistant', content: '已有总结' }, { role: 'user', content: '想核对旧事' }], before = plain(input);
  const result = h.c.window.RPHubContextUtils.appendEnhancedMemoryRecall(input, [
    { turn: 1, summary: '已有总结', sourceUserText: '旧输入', score: 1 },
    { turn: 2, summary: '其他候选', sourceUserText: '还没决定', score: 0.6 }]);
  assert.deepEqual(plain(input), before);
  assert.equal((JSON.stringify(result).match(/已有总结/g) || []).length, 1);
  assert.match(result[1].content, /其他候选/); assert.match(result[1].content, /高相关度.*事实证明/);
});

test('剧情规划不再要求推断玩家真实需求，变量更新同样要求行动来源', () => {
  const { c, p } = harness();
  for (const memoryEnabled of [false, true]) {
    const cot = c.window.RPHubBuiltinPresets.buildCotPresetContent({ memoryEnabled, uiTemplateAnalysisEnabled: true });
    assert.ok(!cot.includes('最新输入里的潜台词、情绪和真实需求'));
    assert.match(cot, /明确言行、意向、假设、问题与拒绝分开/);
    assert.match(cot, /未表达的意图保持未知/);
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
  assert.match(rp[0].content, /独立NPC片段可以有完整过程/);
  assert.equal(rp[1].content, '我在实验室继续训练，我们各自忙自己的事。');
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
  assert.match(p.buildPlayerAgencyPrompt(), /可以连贯写她与朋友相处/);
});

test('分线更新默认转NPC镜头，保留直接互动和明确代写的边界；历史RP台词不冒充微信', () => {
  const { p } = harness();
  const source = [{ role: 'user', content: '历史：林晚当面说“明晚再说”。', _contextOrigin: 'story_archive', _preventContextMerge: true },
    { role: 'user', name: '阿伟', content: '我和同伴走到街口，正在考虑找住处，也许以后带她来看看。', _sourceIndexes: [3] }];
  const before = plain(source), result = p.appendPlayerAgencyPrompt(source, { userName: '阿伟', characterName: '林晚' });
  assert.deepEqual(plain(source), before);
  assert.deepEqual(plain(result.slice(1)), before);
  const system = result[0].content;
  assert.match(system, /若「阿伟」只更新自己的经历、地点或想法/);
  assert.match(system, /默认转入「林晚」或其他NPC的独立场景/);
  assert.match(system, /无需玩家另行要求“切视角”/);
  assert.match(system, /玩家正在与NPC直接互动时，写NPC当轮回应与客观结果/);
  assert.match(system, /只有玩家明确委托代写时，才在指定范围内续写玩家/);
  assert.match(system, /不能自动续写玩家办理入住、递身份证、洗澡、躺下、打字又删除/);
  assert.match(system, /RP当面台词不能改成历史微信/);
  assert.match(system, /旧微信、与玩家的共同经历和已确认约定须有来源/);
  assert.match(system, /日常事务和事件/);
  assert.match(system, /角色卡定义人物，不要求所有NPC围绕该人物/);
});

test('COT和固定准备对话都选择非玩家场景，不再把最近玩家事件当成自动续写流程', () => {
  const { c } = harness(), builtin = c.window.RPHubBuiltinPresets;
  for (const memoryEnabled of [false, true]) {
    const cot = builtin.buildCotPresetContent({ memoryEnabled, uiTemplateAnalysisEnabled: true, storyPanelsEnabled: true });
    assert.match(cot, /“玩家独立线更新”“与NPC直接互动”还是“明确委托代写”/);
    assert.match(cot, /默认选择 \{\{char\}\} 或其他NPC的独立场景/);
    assert.match(cot, /除明确委托代写的范围外/);
    assert.match(cot, /区分RP当面台词与真实微信记录/);
  }
  const ready = builtin.corePresets.find(preset => preset.name === '破限预注入 · AI 2').content;
  for (const prefillEnabled of [false, true]) {
    const prompt = builtin.buildCotPresetContent({ prefillPhase: 2, prefillEnabled, prefillBaseContent: ready });
    assert.match(prompt, /分开时自行选择非玩家场景/);
    assert.doesNotMatch(prompt, /从最后一个真实事件接着写|先找出最近一个有效事件，再用对白或行动让局面产生变化/);
    if (prefillEnabled) assert.match(prompt, /无须玩家要求切视角/);
  }
});

test('当前时段取真实玩家原文的最后独立时标，不从背景或代码补造时间', () => {
  const { p } = harness();
  const options = { userName: '阿伟', characterName: '林晚' };
  const current = '已完成此前的事。\n【2025年03月11日 22时35分】\n我留在食堂。\n【2025年03月12日 02时11分】\n我走到街口。';
  const source = [{ role: 'system', content: '原系统' }, { role: 'user', name: '阿伟', content: current },
    { role: 'user', _contextOrigin: 'story_archive', content: '【2030年03月12日 23时11分】' }];
  const result = p.appendPlayerAgencyPrompt(source, options);
  assert.match(result[0].content, /最后明确的剧情时标：2025-03-12 02:11/);
  assert.deepEqual(plain(result.slice(1)), plain(source.slice(1)));
  assert.deepEqual(plain(p.appendPlayerAgencyPrompt(result, options)), plain(result));
  for (const content of ['日期尚未确定。', '> 【2025年03月12日 02时11分】',
    '“【2025年03月12日 02时11分】”', '【2025年02月29日 02时11分】',
    '```text\n【2025年03月12日 02时11分】\n```', '~~~text\n【2025年03月12日 02时11分】']) {
    const messages = p.appendPlayerAgencyPrompt([{ role: 'user', content }], options);
    assert.ok(!messages[0].content.includes('<current_turn_frame>'), content);
  }
  const media = [{ type: 'text', text: current }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }];
  const withMedia = p.appendPlayerAgencyPrompt([{ role: 'user', content: media }], options);
  assert.match(withMedia[0].content, /2025-03-12 02:11/);
  assert.deepEqual(plain(withMedia[1].content), media);
  const injected = p.appendPlayerAgencyPrompt([{ role: 'user', content: '【2030年03月12日 23时11分】', _worldInfoEntries: [{}] }], {
    ...options, currentPlayerContent: current });
  assert.match(injected[0].content, /2025-03-12 02:11/);
  assert.doesNotMatch(injected[0].content, /2030-03-12/);
});

test('短任务紧邻真实当前玩家输入且只注入一次，原生工具调用与签名保持顺序', () => {
  const { p } = harness();
  const source = [{ role: 'system', content: '原系统' },
    { role: 'user', content: '历史', _contextOrigin: 'story_archive' },
    { role: 'user', name: '阿伟', content: '我还在街口，想她。', _worldInfoEntries: [{}] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'native' }], extra_content: { signature: 'signed' } },
    { role: 'tool', tool_call_id: 'native', content: '实际结果' }];
  const before = plain(source), options = { userName: '阿伟', characterName: '林晚' };
  const result = p.appendRpTurnTaskPrompt(source, options);
  assert.equal(result[2].role, 'system');
  assert.match(result[2].content, /已经完整报告的NPC对白或同行经历/);
  assert.match(result[2].content, /若结尾明确向NPC提问/);
  assert.deepEqual(plain(result.filter(m => !String(m.content).includes('<rp_turn_task>'))), before);
  assert.deepEqual(plain(source), before);
  assert.deepEqual(plain(p.appendRpTurnTaskPrompt(result, options)), plain(result));
  assert.match(result[2].content, /初始上下文没有单列的历史微信原文/);
  const wxSource = [{ role: 'user', _contextOrigin: 'story_archive', _storyArchiveKind: 'wechat_originals', content: '已发送原话' }, ...source];
  const withOriginals = p.appendRpTurnTaskPrompt(wxSource, options);
  assert.match(withOriginals[3].content, /历史微信原文已单列/);
  assert.doesNotMatch(withOriginals[3].content, /初始上下文没有单列/);
});

test('历史来源类别经过标准化仍独立，模型请求不能把摘要误标成微信原文', () => {
  const { c, p } = harness();
  vm.runInContext(read('data-services.js'), c);
  const originals = [{ role: 'user', content: '摘要', _contextOrigin: 'story_archive', _storyArchiveKind: 'summary' },
    { role: 'user', content: '当面对话', _contextOrigin: 'story_archive', _storyArchiveKind: 'rp_originals' },
    { role: 'user', content: '真正微信', _contextOrigin: 'story_archive', _storyArchiveKind: 'wechat_originals' }];
  const result = c.window.RPHubContextUtils.getPostprocessedChatMessages(originals);
  assert.equal(result.length, 3);
  assert.deepEqual(plain(result.map(message => message._storyArchiveKind)), ['summary', 'rp_originals', 'wechat_originals']);
  const request = p.appendRpTurnTaskPrompt([...result, { role: 'user', name: '阿伟', content: '继续' }], { userName: '阿伟' });
  assert.match(request.find(message => message.role === 'system').content, /历史微信原文已单列/);
  const summaryOnly = p.appendRpTurnTaskPrompt([...result.slice(0, 2), { role: 'user', content: '微信二字不构成历史证据。继续。' }]);
  assert.match(summaryOnly.find(message => message.role === 'system').content, /初始上下文没有单列的历史微信原文/);
});

test('输出开关只生成短协议，不复制文风或玩家规则，关闭全部开关时不注入空块', () => {
  const { p } = harness();
  assert.equal(p.buildResponseProtocolPrompt(), '');
  const protocol = p.buildResponseProtocolPrompt({ cotEnabled: true, useThinkingTag: true,
    autoImageGenEnabled: true, imageGenCount: 3, uiTemplateEnabled: true, storyPanelsEnabled: true,
    replyInTool: true, writingStylePrompt: '不应复制的文风正文' });
  assert.match(protocol, /<thinking><\/thinking>/);
  assert.match(protocol, /插入3张图片/);
  assert.match(protocol, /当前变量JSON/);
  assert.match(protocol, /剧情面板/);
  assert.match(protocol, /output_reply/);
  assert.doesNotMatch(protocol, /不应复制|<next_response>|<player_turn_boundary>|<player_agency>/);
  const original = [{ role: 'user', name: '阿伟', content: '我还在房间', _sourceIndexes: [0] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'signed' }], extra_content: { signature: 'native' } },
    { role: 'tool', tool_call_id: 'signed', content: '真实工具结果' }];
  const before = plain(original), once = p.appendSystemPrompt(original, protocol);
  assert.deepEqual(plain(original), before);
  assert.deepEqual(plain(once.slice(1)), before);
  assert.deepEqual(plain(p.appendSystemPrompt(once, protocol)), plain(once));
  const systems = [{ role: 'system', content: '地理资料' }, { role: 'system', content: '主系统预设', _worldInfoEntries: ['main'] }, ...original];
  const centralized = p.appendSystemPrompt(systems, protocol);
  assert.deepEqual(plain(centralized[0]), plain(systems[0]));
  assert.ok(centralized[1].content.startsWith('主系统预设'));
  assert.match(centralized[1].content, /<response_protocol>/);
  assert.deepEqual(plain(centralized[1]._worldInfoEntries), ['main']);
  assert.deepEqual(plain(centralized.slice(2)), plain(original));
});

test('实际工具运行时把输出协议追加到system，保留玩家图文、历史档案和工具签名', () => {
  const { s, c } = harness();
  Object.assign(s, { isAutoImageGenEnabled: { value: true }, isTruncationEnabled: { value: true },
    isStoryPanelsEnabled: { value: true }, isUiTemplateAnalysisEnabled: () => true });
  s.settings.imageGenCount = 4;
  vm.runInContext(read('app/14-tools-runtime.js'), c); c.window.RPHubAppSections.toolsRuntime(s);
  const source = [{ role: 'system', content: '唯一文风规则', _worldInfoEntries: ['fixture'] },
    { role: 'user', content: '档案资料', _contextOrigin: 'story_archive', _preventContextMerge: true },
    { role: 'user', content: [{ type: 'text', text: '玩家原话' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] },
    { role: 'assistant', tool_calls: [{ id: 'native' }], extra_content: { signature: 'signed' }, content: '' }];
  const before = plain(source), result = s.appendResponseProtocolPrompt(source, { cotEnabled: true, useThinkingTag: false });
  assert.deepEqual(plain(source), before);
  assert.deepEqual(plain(result.slice(1)), before.slice(1));
  assert.match(result[0].content, /<cot><\/cot>/);
  assert.match(result[0].content, /output_reply/);
  assert.equal((result[0].content.match(/唯一文风规则/g) || []).length, 1);
  assert.deepEqual(plain(s.appendResponseProtocolPrompt(result, { cotEnabled: true })), plain(result));
});
