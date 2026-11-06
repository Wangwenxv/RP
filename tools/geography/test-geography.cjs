const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const ctx = vm.createContext({ window: {}, console });
for (const name of ['built-in-content.js', 'geography.js', 'world-data.js', 'core-utils.js', 'app/30-geography.js']) vm.runInContext(fs.readFileSync(path.join(root, 'assets/js', name), 'utf8'), ctx);
const G = ctx.window.RPHubGeography, W = ctx.window.RPHubWorlds['jiangnan-south-campus'];
const card = JSON.parse(fs.readFileSync(path.join(root, 'card/suqixue/苏祈雪.json'), 'utf8'));
const bindings = card.data.extensions.rp_hub_geography.bindings;
const json = v => JSON.parse(JSON.stringify(v));
const message = (role, content, id) => ({ role, content, id });
test('用户35分钟路线标定，与旧12分钟相区别；结果包含误差和来源', () => {
    const r = G.route(W, '十三栋', '实验楼A栋');
    assert.equal(r.status, 'ok'); assert.equal(r.duration.typicalMinutes, 35);
    assert.ok(r.duration.rangeMinutes[0] >= 25 && r.duration.rangeMinutes[1] <= 50);
    assert.equal(r.confidence, 'estimated'); assert.match(r.calibration, /用户.*35分钟/);
    assert.ok(r.via.includes('地下隧道教学区入口'));
});
test('骑车单独按可骑道路寻路；时间与找车成本分开说明', () => {
    const r = G.route(W, '13栋', '实验楼A区', { mode: 'bike' });
    assert.ok(r.duration.typicalMinutes < 35); assert.ok(r.warnings.some(n => n.includes('可用性未知')));
    assert.match(r.duration.includes, /找车/);
    assert.match(r.duration.includes, /下车推行/);
});
test('不能用直线跨水；两条独立通路都切断后才不可达', () => {
    const w = json(W); w.edges = w.edges.filter(e => !(e.from === 'tunnel-west' && e.to === 'tunnel-east'));
    // 地下隧道之外，北三路→图书馆→环湖南侧石桥是第二条真实存在的路，切了隧道应走绕行而不是报不可达。
    const detour = G.route(w, '13栋', '实验楼A区');
    assert.equal(detour.status, 'ok'); assert.ok(detour.duration.typicalMinutes > 35); assert.ok(detour.via.some(n => n.includes('图书馆')));
    w.edges = w.edges.filter(e => !(e.from.startsWith('lake-') && e.to.startsWith('lake-')));
    assert.equal(G.route(w, '13栋', '实验楼A区').status, 'unreachable');
    assert.equal(G.route(W, '语心湖', '实验楼A区').status, 'unreachable');
});
test('模糊实验楼、下沉广场、篮球场返回多个候选；唯一别名可解析', () => {
    for (const q of ['实验楼', '下沉广场', '篮球场']) assert.equal(G.resolve(W, q).status, 'ambiguous_place');
    assert.equal(G.resolve(W, 'B栋').place.id, 'teaching-B'); assert.equal(G.resolve(W, '不存在的商场').status, 'unknown_place');
});
test('剧情时间与跨日到达/门禁风险，不采用计算机现实时间', () => {
    const r = G.route(W, '实验楼A区', '13栋', { time: '22:40' });
    assert.ok(r.warnings.some(n => n.includes('23:00')));
    assert.equal(G.route(W, '实验楼A区', '13栋', { time: '23:50' }).arrival[1].dayOffset, 1);
    assert.equal(G.route(W, '13栋', '实验楼A区', { time: '25:90' }).status, 'invalid_time');
});
test('雨天时间增大；未标定地图不发明米数', () => {
    assert.ok(G.route(W, '13栋', '实验楼A区', { weather: 'rain' }).duration.typicalMinutes > 35);
    const w = json(W); delete w.metersPerUnit;
    assert.equal(G.route(w, '13栋', '实验楼A区').status, 'uncalibrated');
});
test('地图验证拒绝非法负长度/端点/重复ID', () => {
    for (const mutate of [w => w.edges[0].meters = -2, w => w.edges[0].from = 'missing', w => w.places.push(w.places[0])]) { const w = json(W); mutate(w); assert.throws(() => G.validate(w)); }
});
test('共址零距离，室内上下楼没有冒充实测', () => {
    const r = G.route(W, '图书馆一楼', '图书馆四楼');
    assert.equal(r.duration.typicalMinutes, 0); assert.match(r.duration.includes, /不含楼内上下楼/);
});
test('宿舍是住址，不自动定位；我在/我到了才形成位置', () => {
    assert.equal(G.project(W, [], bindings).user.status, 'unknown');
    const s = G.project(W, [message('user', '我在13栋', 'u'), message('assistant', '我在实验楼A区', 'a')], bindings);
    assert.equal(s.user.placeId, 'dorm-13'); assert.equal(s.character.placeId, 'lab-A'); assert.equal(s.user.messageId, 'u');
    assert.equal(G.project(W, [message('user', '我在宿舍呢')], bindings).user.placeId, 'dorm-13');
    assert.equal(G.project(W, [message('user', '我在13栋，你能来吗？')], bindings).user.placeId, 'dorm-13');
});
test('计划/条件/疑问/引用/附件/思考/工具均不作为当前地点', () => {
    const base = [message('user', '我在13栋')];
    for (const content of ['我准备去实验楼A区', '我要去实验楼A区', '我到实验楼A区就找你', '我在实验楼A区吗？', '“我在实验楼A区”', '<think>我在实验楼A区</think>好的', '> 我在实验楼A区']) assert.equal(G.project(W, [...base, message('user', content)], bindings).user.placeId, 'dorm-13', content);
    for (const m of [{ role: 'tool', content: '我在实验楼A区' }, { role: 'user', type: 'document', content: '我在实验楼A区' }]) assert.equal(G.project(W, [...base, m], bindings).user.placeId, 'dorm-13');
});
test('离开/在途中/否认/时间跳跃使旧位置失效；未知实验楼需要澄清', () => {
    const base = [message('user', '我在13栋')];
    for (const content of ['我离开了13栋', '我在去实验楼的路上', '我不在13栋了', '第二天']) assert.ok(!G.project(W, [...base, message('user', content)], bindings).user.placeId, content);
    assert.equal(G.project(W, [message('assistant', '我在实验楼')], bindings).character.status, 'ambiguous_place');
});
test('明确角色全名到达可定位；/geo只能由人类设定，不是工具修改位置', () => {
    assert.equal(G.project(W, [message('assistant', '苏祈雪来到实验楼A区')], bindings).character.placeId, 'lab-A');
    assert.equal(G.project(W, [message('assistant', '苏祈雪来到实验楼A区'), message('assistant', '苏祈雪离开了实验楼A区')], bindings).character.status, 'in_transit');
    assert.equal(G.project(W, [message('user', '/geo character 实验楼A区')], bindings).character.placeId, 'lab-A');
    assert.equal(G.project(W, [message('assistant', '/geo user 13栋')], bindings).user.status, 'unknown');
});
test('实际工具查询只返回局部资料；公共世界无角色住址/旧私人经历', () => {
    const r = G.execute(W, { user: {}, character: {} }, { operation: 'place', query: '图书馆' });
    assert.equal(r.access.close, '22:30'); assert.ok(JSON.stringify(r).length < 3500);
    const publicText = JSON.stringify(W.districts); assert.ok(!publicText.includes('她第一次跟他出去住')); assert.ok(!publicText.includes('他的固定位置'));
    assert.equal(G.execute(W, { user: {}, character: {} }, { operation: 'route', from: 'user', to: 'character' }).status, 'needs_location');
    assert.throws(() => G.execute(W, {}, { operation: 'status', mutate: '13栋' }));
});
test('角色卡迁出7个地理条目，17个条目；导入导出保留世界绑定', () => {
    assert.equal(card.data.character_book.entries.length, 17);
    assert.ok(!card.data.character_book.entries.some(e => e.comment.startsWith('地理·')));
    const U = ctx.window.RPHubCardUtils;
    const imported = U.parseImportedCharacterCard(card);
    assert.equal(imported.geography.worldId, W.id);
    assert.equal(U.buildCharacterCardData({ ...imported, worldInfo: imported.worldInfoEntries }).data.extensions.rp_hub_geography.worldId, W.id);
});
function adapter() {
    let scope = 'a', loaded = 'a';
    const s = { currentCharacter: { value: { geography: json(card.data.extensions.rp_hub_geography) } }, chatHistory: { value: [] }, wechatTimeline: { value: [] }, getCurrentStoryBranchScopeId: () => scope, getLoadedWechatScopeId: () => loaded,
        getEnabledActiveTools: () => [], buildActiveToolDefinitions: () => [], parseNativeActiveToolCall: () => ({}), shouldRequireActiveToolCall: () => false, getActiveToolInvocationReminder: () => '' };
    ctx.window.RPHubAppSections.geography(s);
    return { s, switchScope() { scope = 'b'; }, setLoaded() { loaded = scope; }, status() { return s.executeGeographyTool({ function: { name: 'tool_geo', arguments: '{"operation":"status"}' } }).locations; } };
}

test('楼名加房号仅定位所属建筑；精确房间条目优先，问句与计划不设位置', () => {
    for (const query of ['B栋401', 'B栋 401教室', 'B栋-401室']) {
        const hit = G.resolve(W, query); assert.equal(hit.place.id, 'teaching-B'); assert.equal(hit.subLocation.room, '401');
    }
    const state = G.project(W, [message('user', '我在B栋401'), message('user', '你在图书馆吗？')]);
    assert.equal(state.user.placeId, 'teaching-B'); assert.equal(state.user.subLocation.room, '401'); assert.equal(state.character.status, 'unknown');
    assert.equal(G.project(W, [message('user', '我要去B栋401')]).user.status, 'unknown');
    assert.equal(G.project(W, [message('user', '我在B栋401吗？')]).user.status, 'unknown');
    assert.equal(G.resolve(W, '陌生B栋401').status, 'unknown_place');
    const w = json(W); w.places.push({ id: 'room-b401', name: 'B栋401', point: [100, 100], kind: 'room' });
    assert.equal(G.resolve(w, 'B栋401').place.id, 'room-b401');
    assert.ok(G.route(W, 'B栋401', '图书馆').warnings.some(s => s.includes('楼内')));
});

test('微信本次连发同时预取B栋和图书馆简介，不把图书馆问句变成角色位置', () => {
    const h = adapter(); h.s.wechatTimeline.value = ['8点左右', '多穿衣服了没', '你在图书馆吗？', '我在B栋401'].map((content, i) => ({ channel: 'wechat', ...message('user', content, 'w' + i) }));
    const prompt = h.s.buildGeographyPrompt(); const result = JSON.parse(prompt.split('）：').at(-1).trim());
    assert.deepEqual(json(result.mentionedPlaces.map(p => p.id)), ['teaching-B', 'library']);
    assert.equal(result.mentionedPlaces[1].function, '借阅与自习'); assert.equal(result.mentionedPlaces[1].access.close, '22:30');
    assert.equal(result.locations.user.placeId, 'teaching-B'); assert.equal(result.locations.character.status, 'unknown');
    assert.ok(!prompt.includes('【空间性格】')); assert.ok(prompt.length < 6000);
    h.s.wechatTimeline.value.push({ channel: 'wechat', ...message('assistant', '我不在图书馆'), }, { channel: 'wechat', ...message('user', '谢谢啦') });
    assert.ok(!h.s.buildGeographyPrompt().includes('本轮地理速查'));
    h.s.wechatTimeline.value.push({ channel: 'wechat', role: 'user', type: 'image', content: 'attachment' });
    assert.ok(!h.s.buildGeographyPrompt().includes('本轮地理速查'));
});

test('同条多个地点预取与长别名去重，不超过四个；RP也读取本轮多个提及地点', () => {
    assert.deepEqual(json(G.mentions(W, '图书馆和B栋')), ['图书馆', 'B栋']);
    assert.ok(G.mentions(W, '图书馆一楼通宵自习室').length <= 1);
    assert.ok(G.mentions(W, 'B栋 图书馆 13栋 3栋 一饭 二饭 实验楼A区').length <= 4);
    const h = adapter(); h.s.chatHistory.value = [message('assistant', '好'), message('user', '你在图书馆吗？我在B栋401')];
    const result = JSON.parse(h.s.buildGeographyPrompt().split('）：').at(-1).trim());
    assert.equal(result.mentionedPlaces.length, 2); assert.equal(result.locations.character.status, 'unknown');
});
test('微信和RP按镜像锚点重放，后续RP不能被较早微信位置覆盖', () => {
    const h = adapter(), s = h.s;
    s.chatHistory.value = [message('user', '我在13栋', 'r1'), message('user', '我在图书馆', 'r2')];
    s.wechatTimeline.value = [{ channel: 'rp', rpMsgId: 'r1' }, { channel: 'wechat', ...message('user', '我在3栋', 'w1') }, { channel: 'rp', rpMsgId: 'r2' }];
    assert.equal(h.status().user.placeId, 'library');
    s.chatHistory.value[1].content = '我在二饭'; assert.equal(h.status().user.placeId, 'canteen-2');
    s.chatHistory.value.pop(); assert.equal(h.status().user.placeId, 'dorm-3');
});
test('分支切换不继承旧微信位置；重新载入/无地图角色不会出现工具', () => {
    const h = adapter(); h.s.wechatTimeline.value = [{ channel: 'wechat', ...message('user', '我在13栋') }];
    assert.equal(h.status().user.placeId, 'dorm-13');
    h.switchScope(); assert.equal(h.status().user.status, 'unknown');
    h.s.currentCharacter.value = {}; assert.equal(h.s.geographyTools().length, 0); assert.equal(h.s.getEnabledActiveTools().length, 0);
});
test('两边已确认时自动注入35分钟约束；个人地点记忆只由本角色读取', () => {
    const h = adapter(); h.s.chatHistory.value = [message('user', '我在13栋'), message('assistant', '我在实验楼A区')];
    assert.match(h.s.buildGeographyPrompt(), /typicalMinutes":35/);
    const r = h.s.executeGeographyTool({ function: { name: 'tool_geo', arguments: '{"operation":"place","query":"图书馆"}' } });
    assert.match(r.characterContext, /她下午在四楼/);
    assert.equal(h.s.getEnabledActiveTools()[0].callName, 'tool_geo'); assert.equal(h.s.buildActiveToolDefinitions(h.s.getEnabledActiveTools())[0].function.name, 'tool_geo');
});
test('context一次返回风采园功能、位置、步行与骑车时间，默认只给片区与坐标，不传区域长文', () => {
    const locations = G.project(W, [message('user', '我在风采园，你在哪里？'), message('assistant', '我在实验楼A区')], bindings);
    const r = G.execute(W, locations, { operation: 'context', query: '风采园' });
    assert.equal(r.status, 'ok'); assert.equal(r.places.to.id, 'canteen-3');
    assert.match(r.places.to.function, /食堂/); assert.match(r.places.to.scene, /南苑西南/);
    assert.equal(r.locations.character.placeId, 'lab-A'); assert.equal(r.routes.walk.status, 'ok'); assert.equal(r.routes.bike.status, 'ok');
    assert.ok(r.routes.bike.duration.typicalMinutes < r.routes.walk.duration.typicalMinutes);
    assert.equal(r.locations.user.zone, '生活区'); assert.equal(r.locations.user.point.length, 2);
    assert.equal(r.locations.relation.userToCharacter.bearing, '东北方'); assert.ok(r.locations.relation.userToCharacter.straightMeters > 0);
    assert.ok(r.reach.rows.length > 0); assert.ok(r.reach.rows.every(row => Number.isFinite(row.walk)));
    assert.ok(JSON.stringify(r).length < 3000); assert.ok(!JSON.stringify(r).includes('coordinateSystem')); assert.ok(!JSON.stringify(r).includes('district'));
});
test('一方位置未知时，速查给出从已确认一方到常去地点的分钟表', () => {
    const locations = G.project(W, [message('user', '我在13栋，你能来吗？')], bindings);
    const r = G.execute(W, locations, { operation: 'context', query: '13栋' });
    assert.equal(r.status, 'needs_location'); assert.equal(r.reach.from, '南苑13栋');
    assert.equal(r.reach.rows.find(x => x.name === '实验楼A区').walk, 35);
    assert.ok(!r.reach.rows.some(x => x.name === '南苑13栋'));
    assert.equal(G.execute(W, { user: {}, character: {} }, { operation: 'context' }).reach, undefined);
});
test('batch一次取多个独立查询，保留未知地点结果，并拒绝嵌套/超额/非法参数', () => {
    const r = G.execute(W, {}, { operation: 'batch', requests: [{ operation: 'place', query: '风采园' }, { operation: 'route', from: '13栋', to: '实验楼A区' }, { operation: 'place', query: '不存在' }] });
    assert.equal(r.results.length, 3); assert.equal(r.results[1].result.duration.typicalMinutes, 35); assert.equal(r.results[2].result.status, 'unknown_place');
    for (const requests of [[], Array(5).fill({ operation: 'status' }), [{ operation: 'batch', requests: [{ operation: 'status' }] }], [{ operation: 'status', mutate: '13栋' }]]) assert.throws(() => G.execute(W, {}, { operation: 'batch', requests }));
});
test('full按需返回坐标与丰富背景；brief返回预算内的行动事实', () => {
    const brief = G.execute(W, {}, { operation: 'place', query: '风采园' });
    const full = G.execute(W, {}, { operation: 'place', query: '风采园', detail: 'full' });
    assert.ok(!brief.coordinates); assert.equal(full.coordinates.point.length, 2); assert.ok(full.district.length > 300);
    const r = G.boundResult({ status: 'ok', scene: '背景'.repeat(6000), duration: { typicalMinutes: 35 }, access: { close: '23:00' }, warnings: ['门禁'] });
    assert.equal(r.duration.typicalMinutes, 35); assert.equal(r.access.close, '23:00'); assert.equal(r.warnings[0], '门禁'); assert.ok(JSON.stringify(r).length < 6000);
});
test('明确地理问题预取无需模型查询；普通确认不注入区域资料，预取不修改位置', () => {
    const h = adapter(); h.s.chatHistory.value = [message('assistant', '我在实验楼A区'), message('user', '我在风采园，你在哪里？')];
    const p = h.s.buildGeographyPrompt(); assert.match(p, /本轮地理速查/); assert.match(p, /南苑西南/); assert.match(p, /"bike"/);
    h.s.chatHistory.value.push(message('user', '谢谢啦')); assert.ok(!h.s.buildGeographyPrompt().includes('本轮地理速查'));
    assert.equal(h.status().user.placeId, 'canteen-3');
});
test('同轮重复查询引用已有结果，参数键序不同也去重；下一轮预算重置', () => {
    const h = adapter();
    const call = (id, args) => ({ id, function: { name: 'tool_geo', arguments: JSON.stringify(args) } });
    assert.equal(h.s.executeGeographyTool(call('first', { operation: 'place', query: '风采园' })).id, 'canteen-3');
    const duplicate = h.s.executeGeographyTool(call('second', { query: '风采园', operation: 'place' }));
    assert.equal(duplicate.status, 'already_returned'); assert.equal(duplicate.referenceCallId, 'first');
    h.s.resetGeographyBudget(); assert.equal(h.s.executeGeographyTool(call('third', { operation: 'place', query: '风采园' })).status, 'ok');
});
test('同轮4次调用与12000字符成功资料预算；scope变化不会引用旧查询', () => {
    const h = adapter(); const call = { id: 'a', function: { name: 'tool_geo', arguments: '{"operation":"status"}' } };
    h.s.geographyToolBudget.used = 11999; assert.equal(h.s.executeGeographyTool(call).status, 'budget_exhausted');
    h.s.resetGeographyBudget(); assert.equal(h.s.executeGeographyTool(call).status, 'ok'); h.switchScope(); assert.equal(h.s.executeGeographyTool(call).status, 'ok');
    h.s.executeGeographyTool(call); h.s.executeGeographyTool(call); assert.equal(h.s.executeGeographyTool(call).status, 'budget_exhausted');
});
