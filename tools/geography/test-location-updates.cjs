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
