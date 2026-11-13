const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { profile, patch } = require('../character-cards/patch-suqixue-image-identity.cjs');
const context = vm.createContext({ window: {}, console, TextEncoder, TextDecoder, Uint8Array, Uint32Array });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../assets/js/built-in-content.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../assets/js/core-utils.js'), 'utf8'), context);
const C = context.window.RPHubCardUtils, plain = value => JSON.parse(JSON.stringify(value));

test('v2 fixed appearance imports/exports with disabled state and unrelated content preserved', () => {
    const raw = { data: { name: '苏祈雪', personality: 'original persona', extensions: { rp_hub_image_identity: { ...profile, enabled: false } },
        character_book: { entries: [{ comment: '原世界书', content: 'original worldbook', keys: ['世界'] }] }, uiTemplates: [{ name: 'original UI' }] } };
    const parsed = C.parseImportedCharacterCard(raw);
    assert.deepEqual(plain(parsed.imageIdentity), { ...profile, enabled: false });
    const exported = C.buildCharacterCardData({ ...parsed, worldInfo: parsed.worldInfoEntries });
    const roundtrip = C.parseImportedCharacterCard(exported);
    assert.deepEqual(plain(roundtrip.imageIdentity), { ...profile, enabled: false });
    assert.equal(roundtrip.personality, 'original persona');
    assert.equal(roundtrip.worldInfoEntries[0].content, 'original worldbook');
    assert.equal(roundtrip.uiTemplates[0].name, 'original UI');
    assert.equal(C.parseImportedCharacterCard({ ...raw.data, imageIdentity: null }).imageIdentity, null);
    assert.equal(C.normalizeImageIdentity({ prompt: 'x'.repeat(901) }), null);
});

test('card patch is idempotent, preserves original entries/UI/regex, and adds portable retrieval text', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-card-identity-')), file = path.join(folder, 'fixture.json');
    const data = { name: '苏祈雪', personality: '白，瘦，头发细软，齐肩，总是别在耳后。',
        extensions: { regex_scripts: [{ scriptName: 'keep', findRegex: 'keep' }] }, uiTemplates: [{ name: 'keep' }],
        character_book: { entries: [{ comment: 'keep', content: 'unchanged', keys: ['test'] }] } };
    let backup;
    try {
        fs.writeFileSync(file, JSON.stringify({ data }));
        backup = patch(file).backup;
        const first = fs.readFileSync(file, 'utf8'), updated = JSON.parse(first).data;
        assert.equal(patch(file).changed, false); assert.equal(fs.readFileSync(file, 'utf8'), first);
        assert.deepEqual(updated.character_book.entries[0], data.character_book.entries[0]);
        assert.deepEqual(updated.extensions.regex_scripts, data.extensions.regex_scripts);
        assert.deepEqual(updated.uiTemplates, data.uiTemplates);
        assert.ok(updated.personality.startsWith(data.personality));
        assert.deepEqual(updated.extensions.rp_hub_image_identity, profile);
        const entry = updated.character_book.entries[1];
        assert.ok(entry.keys.includes('苏祈雪')); assert.ok(entry.keys.includes('自拍')); assert.equal(entry.constant, false);
        assert.ok(entry.content.includes(profile.prompt)); assert.ok(entry.content.includes('selfPortrait：本人入镜为true'));
        assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')).data, data);
    } finally { fs.rmSync(file, { force: true }); fs.rmdirSync(folder); if (backup) fs.rmSync(backup, { force: true }); }
});
