const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const context = vm.createContext({ window: {}, console });
for (const name of ['geography.js', 'world-data.js', 'app/30-geography.js']) vm.runInContext(fs.readFileSync(path.join(root, 'assets/js', name), 'utf8'), context);
const G = context.window.RPHubGeography, world = context.window.RPHubWorlds['jiangnan-south-campus'];
const bindings = { character: { name: '苏祈雪', home: 'dorm-3' }, user: { home: 'dorm-13' } };
const args = (evidence, extra = {}) => ({ operation: 'update_location', locationStatus: 'last_confirmed', query: '图书馆', sourceMessageId: 'a1', evidence, ...extra });
const msg = (content, role = 'assistant', extra = {}) => ({ id: 'a1', role, content, ...extra });
const call = params => ({ id: 'update-1', function: { name: 'tool_geo', arguments: JSON.stringify(params) } });
function adapter() {
    let scope = 'branch-a', saves = 0;
    const s = { currentCharacter: { value: { name: '苏祈雪', geography: { enabled: true, worldId: world.id, bindings } } },
        chatHistory: { value: [] }, wechatTimeline: { value: [] }, conversationRevision: 0,
        getCurrentStoryBranchScopeId: () => scope, getLoadedWechatScopeId: () => scope,
        getEnabledActiveTools: () => [], buildActiveToolDefinitions: () => [], parseNativeActiveToolCall: () => ({}),
        shouldRequireActiveToolCall: () => false, getActiveToolInvocationReminder: () => '',
        saveChatHistoryNow: async () => { saves++; return true; }, saveWechatTimelineNow: async () => { saves++; return true; } };
    context.window.RPHubAppSections.geography(s);
    return { s, saved: () => saves, switchBranch: () => { scope = 'branch-b'; s.chatHistory.value = []; s.wechatTimeline.value = []; } };
}

test('角色自述、角色姓名和明确第三人称到达均可按完整原句定位', () => {
    for (const text of ['我在图书馆。', '苏祈雪到了图书馆。', '她走进了图书馆。', '*她现在在图书馆。*']) {
        assert.equal(G.verifyLocationUpdate(world, msg(text), args(text), bindings).placeId, 'library');
    }
    assert.equal(G.verifyLocationUpdate(world, msg('苏祈雪走进了图书馆。', 'user'), args('苏祈雪走进了图书馆。'), bindings).placeId, 'library');
});

test('计划、条件、疑问、引用、推理、附件和工具结果不能作为到达事实', () => {
    for (const text of ['我要去图书馆。', '如果我到了图书馆就给你发消息。', '我在图书馆吗？', '她可能在图书馆。', '她到图书馆以后再说。', '“我在图书馆。”', '>我在图书馆。']) {
        assert.throws(() => G.verifyLocationUpdate(world, msg(text), args(text), bindings));
    }
    assert.throws(() => G.verifyLocationUpdate(world, msg('我在图书馆吗？'), args('我在图书馆'), bindings));
    for (const source of [msg('<think>我在图书馆。</think>好了。'), msg('我在图书馆。', 'tool'), msg('我在图书馆。', 'assistant', { type: 'image' }), msg('<think>我在图书馆。')]) {
        assert.throws(() => G.verifyLocationUpdate(world, source, args('我在图书馆。'), bindings));
    }
});

test('模型不能将玩家第一人称、自创依据、歧义地点或不同目的地变成角色位置', () => {
    for (const text of ['我在图书馆。', '*我在图书馆。', '/geo user library']) {
        assert.throws(() => G.verifyLocationUpdate(world, msg(text, 'user'), args(text), bindings));
    }
    assert.throws(() => G.verifyLocationUpdate(world, msg('我在13栋。'), args('我在图书馆。'), bindings));
    assert.throws(() => G.verifyLocationUpdate(world, msg('我在图书馆。'), args('我在图书馆。', { query: '13栋' }), bindings));
    assert.throws(() => G.verifyLocationUpdate(world, msg('我在实验楼。'), args('我在实验楼。', { query: '实验楼' }), bindings));
    assert.throws(() => G.validateArgs({ ...args('我在图书馆。'), actor: 'user' }));
    assert.throws(() => G.validateArgs({ operation: 'batch', requests: [args('我在图书馆。')] }));
});

test('未闭合推理与图片描述在位置重放中同样不能成为坐标', () => {
    for (const content of ['<think>分析\n我在图书馆。', '<thinking>分析\n我在图书馆。', '<cot>分析\n我在图书馆。', '{"messages":[{"type":"image","content":"我在图书馆。"}]}']) {
        assert.equal(G.project(world, [msg(content)], bindings).character.status, 'unknown');
    }
    assert.equal(G.project(world, [msg('<think>我在13栋。</think>我在图书馆。')], bindings).character.placeId, 'library');
});

test('已离开必须设为在途；否认在场可清为未知，不伪造抵达目标', () => {
    assert.equal(G.verifyLocationUpdate(world, msg('她已经离开了图书馆。'), args('她已经离开了图书馆。', { query: '', locationStatus: 'in_transit' }), bindings).status, 'in_transit');
    assert.equal(G.verifyLocationUpdate(world, msg('我不在图书馆。'), args('我不在图书馆。', { query: '', locationStatus: 'unknown' }), bindings).status, 'unknown');
    assert.throws(() => G.verifyLocationUpdate(world, msg('她已经离开了图书馆。'), args('她已经离开了图书馆。'), bindings));
});

test('位置标注持久化在原文上，修改/删除依据和切换分支后不会残留', async () => {
    const h = adapter(); h.s.chatHistory.value = [msg('她走进了图书馆。')];
    const result = await h.s.executeGeographyTool(call(args('她走进了图书馆。')));
    assert.equal(result.locations.character.placeId, 'library'); assert.equal(h.saved(), 1);
    const stored = JSON.parse(JSON.stringify(h.s.chatHistory.value));
    assert.equal(G.project(world, stored, bindings).character.placeId, 'library');
    stored[0].content = '她打算去图书馆。';
    assert.equal(G.project(world, stored, bindings).character.status, 'unknown');
    assert.equal(G.project(world, [], bindings).character.status, 'unknown');
    h.switchBranch();
    assert.equal(h.s.getChatGeographyState().character.status, 'unknown');
    await assert.rejects(h.s.executeGeographyTool(call(args('她走进了图书馆。'))));
});

test('保存失败回滚标注，旧证据不能覆盖更新的事实', async () => {
    const h = adapter(); const source = msg('她走进了图书馆。'); h.s.chatHistory.value = [source];
    h.s.saveChatHistoryNow = async () => false;
    await assert.rejects(h.s.executeGeographyTool(call(args(source.content))), /保存/);
    assert.equal(source.geographyUpdates, undefined);
    h.s.saveChatHistoryNow = async () => true;
    h.s.chatHistory.value.push(msg('我在13栋。', 'assistant', { id: 'a2' }));
    await assert.rejects(h.s.executeGeographyTool(call(args(source.content))), /更新的位置/);
    assert.equal(h.s.getChatGeographyState().character.placeId, 'dorm-13');
});

test('RP本轮current绑定真实正文，微信原句更新共用同一状态', async () => {
    const h = adapter(); h.s.chatHistory.value = [msg('她走进了图书馆。')];
    const result = await h.s.executeGeographyTool(call(args('她走进了图书馆。', { sourceMessageId: 'current' })), undefined, { sourceMessageId: 'a1' });
    assert.equal(result.locations.character.placeId, 'library');
    h.s.chatHistory.value = [];
    h.s.wechatTimeline.value = [msg('我在13栋。', 'assistant', { channel: 'wechat', id: 'wx1' })];
    h.s.resetGeographyBudget();
    const wx = await h.s.executeGeographyTool(call(args('我在13栋。', { sourceMessageId: 'wx1', query: '13栋' })));
    assert.equal(wx.locations.character.placeId, 'dorm-13'); assert.equal(h.saved(), 2);
    assert.equal(h.s.wechatTimeline.value.length, 1);
    assert.equal(G.project(world, [msg('{"messages":[{"type":"image","content":"我在图书馆。"}]}')], bindings).character.status, 'unknown');
});

const wx = (content, role = 'assistant', id = 'wx') => msg(content, role, { id, channel: 'wechat' });
test('真实微信省略主语的到达和地点加活动无需补工具也即时定位', () => {
    for (const [text, place] of [['在图书馆看书', 'library'], ['现在在图书馆', 'library'], ['刚回北苑3栋', 'dorm-3'], ['已经到宿舍了', 'dorm-3'], ['我已经到宿舍了', 'dorm-3'], ['刚回宿舍', 'dorm-3']]) {
        assert.equal(G.project(world, [wx(text)], bindings).character.placeId, place, text);
    }
    assert.equal(G.project(world, [wx('已经到宿舍了')], bindings).user.status, 'unknown');
    assert.equal(G.project(world, [wx('我在图书馆，准备去食堂')], bindings).character.placeId, 'library');
    assert.equal(G.project(world, [msg('已经到宿舍了')], bindings).character.status, 'unknown');
    assert.equal(G.verifyLocationUpdate(world, wx('已经到宿舍了'), args('已经到宿舍了', { query: 'dorm-3' }), bindings).placeId, 'dorm-3');
});

test('刚才吃饭不推定食堂；仅北苑保留歧义提示而不猜住址', () => {
    assert.equal(G.project(world, [wx('刚才在吃饭')], bindings).character.status, 'unknown');
    const partial = G.project(world, [wx('刚回北苑')], bindings).character;
    assert.equal(partial.status, 'ambiguous_place'); assert.equal(partial.placeId, undefined);
    assert.match(G.briefState({ character: partial }, world).character.note, /北苑.*待确认/);
});

test('裸地点只回答当前位置问题时定位，计划和疑问不能借口语解析定位', () => {
    assert.equal(G.project(world, [wx('北苑哪一栋？', 'user', 'question'), wx('3栋')], bindings).character.placeId, 'dorm-3');
    for (const question of ['等会儿想去哪？', '明天你在哪一栋？']) {
        assert.equal(G.project(world, [wx(question, 'user', 'question'), wx('图书馆')], bindings).character.status, 'unknown');
    }
    for (const text of ['图书馆', '准备回宿舍', '刚才在图书馆', '已经到宿舍了吗', '已经到宿舍了没', '到宿舍以后再说', '在图书馆的话', '“已经到宿舍了”']) {
        assert.equal(G.project(world, [wx(text)], bindings).character.placeId, undefined, text);
    }
});

test('微信口语离开使旧位置在途，撤销或编辑到达原文后自动回退', () => {
    const arrival = wx('已经到宿舍了', 'assistant', 'arrival');
    for (const acknowledgement of ['到啦', '到了', '在呢', '回来了']) {
        assert.equal(G.project(world, [arrival, wx(acknowledgement)], bindings).character.placeId, 'dorm-3');
        assert.equal(G.project(world, [wx(acknowledgement)], bindings).character.placeId, undefined);
    }
    assert.equal(G.project(world, [arrival, wx('刚离开了宿舍')], bindings).character.status, 'in_transit');
    arrival.content = '准备到宿舍';
    assert.equal(G.project(world, [arrival], bindings).character.status, 'unknown');
});

test('模型自主场景不需要对玩家公开地点，也不按住址或用户位置代填', () => {
    const source = wx('刚回北苑', 'assistant', 'own');
    source.geographyPosition = { worldId: world.id, storyAt: 1000, sourceContent: source.content, decision: { action: 'present', placeId: 'dorm-4', detail: '一楼门口台阶' } };
    const follow = wx('吃过了', 'assistant', 'follow'); follow.geographyPositionRef = 'own';
    const result = G.project(world, [source, follow], bindings);
    assert.equal(result.character.placeId, 'dorm-4'); assert.equal(result.character.subLocation.detail, '一楼门口台阶'); assert.equal(result.user.status, 'unknown');
    const restored = JSON.parse(JSON.stringify([source, follow]));
    assert.equal(G.project(world, restored, bindings).character.placeId, 'dorm-4');
    restored[0].content = '准备回北苑';
    assert.equal(G.project(world, restored, bindings).character.status, 'unknown');
    assert.equal(G.project(world, [follow], bindings).character.status, 'unknown');
});

test('自身移动尊重路程与剧情时间；计划和原地回复不导致瞬移', () => {
    const initial = G.decidePosition(world, null, { action: 'present', placeId: 'dorm-13', detail: '宿舍楼门口' }, 1000);
    const move = G.decidePosition(world, initial, { action: 'depart', to: 'lab-A', mode: 'walk' }, 1000);
    assert.equal(move.status, 'in_transit'); assert.equal(move.arrivalAt, 1000 + 35 * 60000);
    assert.throws(() => G.decidePosition(world, move, { action: 'present', placeId: 'lab-A' }, 1000));
    assert.equal(G.decidePosition(world, move, { action: 'continue' }, 1000).status, 'in_transit');
    assert.equal(G.decidePosition(world, move, { action: 'present', placeId: 'lab-A', detail: '一楼实验室门口' }, move.arrivalAt).placeId, 'lab-A');
    assert.throws(() => G.decidePosition(world, initial, { action: 'present', placeId: 'library' }, 1000));
    assert.equal(G.decidePosition(world, initial, { action: 'stay' }, 1000).placeId, 'dorm-13');
    assert.throws(() => G.decidePosition(world, null, { action: 'present', placeId: '北苑' }, 1000));
    assert.equal(G.decidePosition(world, null, { action: 'present', placeId: 'library' }, 1000).placeId, 'library');
    assert.throws(() => G.decidePosition(world, null, { action: 'present', placeId: 'library', actor: 'user' }, 1000));
});

test('自主位置工具绑定RP正文，微信工具先提案，失败不写入玩家或分支', async () => {
    const h = adapter(); h.s.wechatClock = { value: { time: 1000 } }; h.s.chatHistory.value = [msg('今晚有点冷。')];
    const request = { operation: 'set_position', action: 'present', placeId: 'dorm-4', sceneDetail: '门口台阶' };
    await h.s.executeGeographyTool(call(request), undefined, { sourceMessageId: 'a1' });
    assert.equal(h.s.getChatGeographyState().character.placeId, 'dorm-4'); assert.equal(h.s.getChatGeographyState().user.status, 'unknown');
    const budget = h.s.createGeographyBudget();
    await h.s.executeGeographyTool(call({ operation: 'set_position', action: 'stay' }), budget, { channel: 'wechat', storyAt: 1000 });
    assert.equal(budget.positionDecision.action, 'stay'); assert.equal(h.saved(), 1);
    h.switchBranch(); assert.equal(h.s.getChatGeographyState().character.status, 'unknown');
});

test('最终自身场景优先于兼容工具暂存；推理中的JSON不参与位置决定', () => {
    const h = adapter();
    vm.runInContext(fs.readFileSync(path.join(root, 'assets/js/wechat-protocol.js'), 'utf8'), context);
    const raw = '<think>{"position":{"action":"present","placeId":"dorm-3","detail":"旧想法"}}</think>'
        + '{"messages":[{"type":"text","content":"晚点聊"}],"position":{"action":"present","placeId":"library","detail":"靠窗座位"}}';
    const decision = h.s.readWechatPositionDecision(raw, { positionDecision: { action: 'present', placeId: 'dorm-4', detail: '旧提案' } }, 1000);
    assert.equal(decision.placeId, 'library');
    assert.equal(h.s.getChatGeographyState().character.status, 'unknown');
});

test('遗漏在途position只保持行程，不自动到达或决定新的目的地', () => {
    const h = adapter();
    const start = msg('出门前', 'assistant', { id: 'start', channel: 'wechat' });
    start.geographyPosition = { worldId: world.id, storyAt: 1000, sourceContent: start.content, decision: { action: 'present', placeId: 'dorm-3', detail: '楼门口' } };
    const move = msg('走了', 'assistant', { id: 'move', channel: 'wechat' });
    move.geographyPosition = { worldId: world.id, storyAt: 1000, sourceContent: move.content, decision: { action: 'depart', to: 'canteen-2' } };
    h.s.wechatTimeline.value = [start, move];
    const decision = h.s.readWechatPositionDecision('{"messages":[{"type":"text","content":"还在走"}]}', null, 1000);
    assert.equal(decision.action, 'continue');
    assert.equal(h.s.getChatGeographyState().character.status, 'in_transit');
    assert.equal(h.s.getChatGeographyState().character.destinationId, 'canteen-2');
});

test('江拾门口场景方向自动定位角色，玩家具名场景只定位玩家，微信原地无需工具', () => {
    const h = adapter();
    h.s.currentCharacter.value.name = '江拾'; h.s.user = { name: '陆清淮' };
    h.s.chatHistory.value = [msg('陆清淮在门诊部诊室里。江拾留在门诊部门口，用微信给陆清淮发消息。', 'user')];
    assert.equal(h.s.getChatGeographyState().character.placeId, 'clinic');
    assert.equal(h.s.getChatGeographyState().user.placeId, 'clinic');
    const decision = h.s.readWechatPositionDecision('{"messages":[{"type":"text","content":"好嘛"}]}', null, 1000);
    assert.equal(decision.action, 'stay');
    h.s.chatHistory.value = [msg('江拾打算去门诊部。陆清淮在图书馆吗？', 'user')];
    assert.equal(h.s.getChatGeographyState().character.status, 'unknown');
    assert.equal(h.s.getChatGeographyState().user.status, 'unknown');
    assert.equal(h.s.readWechatPositionDecision('{"messages":[{"type":"text","content":"好嘛"}]}', null, 1000), null);
});

test('江拾原始开场建立双方门诊部位置；其他地点、未来场景和住址不代填', () => {
    const card = JSON.parse(fs.readFileSync(path.join(root, 'card/jiangshi/江拾.json'), 'utf8'));
    const link = { character: { name: '江拾', home: 'clinic' }, user: { name: '陆清淮' } };
    const opening = card.data.first_mes;
    const locations = G.project(world, [msg(opening)], link);
    assert.equal(locations.character.placeId, 'clinic'); assert.equal(locations.user.placeId, 'clinic');
    assert.equal(G.project(world, [], link).character.status, 'unknown');
    for (const text of ['下午四点，江拾准备去门诊部。', '“下午四点，我在门诊部。”', '下午四点，图书馆里。\n江拾坐在门诊部。'])
        assert.equal(G.project(world, [msg(text)], link).user.status, 'unknown');
    assert.equal(G.project(world, [msg('下午四点，图书馆里。\n江拾坐在长椅上。')], link).character.placeId, 'library');
});

test('同一RP气泡工具续写保留位置，手工编辑仍使旧决定失效；原地描述不重置到达时刻', async () => {
    const h = adapter(); h.s.wechatClock = { value: { time: 1000 } };
    const source = msg('她拿起手机。'); h.s.chatHistory.value = [source];
    await h.s.executeGeographyTool(call({ operation: 'set_position', action: 'present', placeId: 'clinic', sceneDetail: '诊室门口' }), undefined, { sourceMessageId: source.id });
    h.s.preserveRpPositionDuringAppend(source);
    source.content += '\n她仍站在门口。';
    h.s.finalizeRpPosition(source);
    assert.equal(h.s.getChatGeographyState().character.placeId, 'clinic');
    const before = G.project(world, [source], bindings).character;
    const after = G.decidePosition(world, before, { action: 'stay', detail: '走廊长椅上' }, 1000 + 60000);
    assert.equal(after.confirmedAt, 1000);
    assert.equal(after.subLocation.detail, '走廊长椅上');
    source.content = '她打算去门诊部。';
    h.s.finalizeRpPosition(source);
    assert.equal(h.s.getChatGeographyState().character.status, 'unknown');
    assert.doesNotMatch(h.s.buildCharacterPositionPrompt(), /微信回复JSON|空回也带position/);
    assert.match(h.s.buildCharacterPositionPrompt('wechat'), /原地回复可省略position/);
});
