const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict'), { test } = require('node:test');
const root = path.resolve(__dirname, '../..'), window = {};
const ctx = vm.createContext({ window, atob: v => Buffer.from(v, 'base64').toString('binary') });
for (const file of ['geography.js', 'map-packages.js']) vm.runInContext(fs.readFileSync(path.join(root, 'assets/js', file), 'utf8'), ctx);
const P = window.RPHubMapPackages, G = window.RPHubGeography;
const world = JSON.parse(fs.readFileSync(path.join(root, 'worlds/jiangnan-south-campus.json'), 'utf8'));
const image = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(root, 'card/江大南校区.jpeg')).toString('base64');
test('自包含地图包原图字节、坐标/用途/道路/文化/开放规则往返，35分钟标定保留', () => {
    const value = JSON.parse(JSON.stringify(P.encode(world, image)));
    assert.equal(Buffer.compare(Buffer.from(value.image.dataUrl.split(',')[1], 'base64'), fs.readFileSync(path.join(root, 'card/江大南校区.jpeg'))), 0);
    assert.equal(value.world.places.length, 71); assert.equal(value.world.edges.length, 72);
    assert.deepEqual(value.world.districts, world.districts); assert.deepEqual(value.world.culture, world.culture);
    assert.deepEqual(value.world.places.find(p => p.id === 'dorm-13').access, world.places.find(p => p.id === 'dorm-13').access);
    assert.equal(G.route(value.world, '13栋', '实验楼A区').duration.typicalMinutes, 35);
    assert.ok(!value.world.image && !JSON.stringify(G.execute(value.world, {}, { operation: 'place', query: '13栋', detail: 'full' })).includes('base64'));
});
test('拒绝非法ID、越界地点、非法开放时间和图片格式，图片不混入world', () => {
    const copy = () => JSON.parse(JSON.stringify(world));
    let w = copy(); w.id = '../evil'; assert.throws(() => P.prepareWorld(w), /ID/);
    w = copy(); w.places[0].point[0] = -1; assert.throws(() => P.prepareWorld(w), /坐标/);
    w = copy(); w.places[0].access.close = '25:00'; assert.throws(() => P.prepareWorld(w), /时间/);
    assert.throws(() => P.checkImage('data:image/svg+xml;base64,PHN2Zz4='), /支持/);
    assert.throws(() => P.checkImage('data:image/png;base64,ZmFrZQ=='), /格式不符/);
    w = copy(); w.imageData = 'data:image/png;base64,ignored'; w.places[0].imageData = w.imageData; assert.ok(!JSON.stringify(P.prepareWorld(w)).includes('base64'));
});
test('编辑路网后重新标定，混合长度拒绝，未标定地图返回未知时间', () => {
    const w = JSON.parse(JSON.stringify(world)); w.calibration.walkMinutes = 40;
    assert.equal(G.route(P.prepareWorld(w), '13栋', '实验楼A区').duration.typicalMinutes, 40);
    w.edges[0].meters = 20; assert.throws(() => P.prepareWorld(w), /混用/);
    delete w.edges[0].meters; delete w.metersPerUnit; delete w.calibration;
    assert.equal(G.route(P.prepareWorld(w), '13栋', '实验楼A区').status, 'uncalibrated');
});
