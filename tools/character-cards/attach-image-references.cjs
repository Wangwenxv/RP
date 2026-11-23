// Portable reference pixels, independent of persona and provider-specific prompts.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const marker = '【本人生图外貌基线】';
function cleanLegacy(data) {
    delete data.imageIdentity;
    if (data.extensions) delete data.extensions.rp_hub_image_identity;
    // Remove only the known appended paragraph, never ordinary character appearance.
    if (typeof data.personality === 'string') data.personality = data.personality.replace(/\n\n【本人生图外貌基线】\n[^]*?需要绘图时参照世界书“苏祈雪·本人生图外貌”；这些是画面资料，不作为聊天台词，也不代表已发送过照片。(?=\n\n|$)/g, '');
    if (Array.isArray(data.character_book?.entries)) data.character_book.entries = data.character_book.entries.filter(e =>
        !(e.comment === '苏祈雪·本人生图外貌' && String(e.content || '').startsWith(marker)));
}
function attach(file, images = []) {
    file = path.resolve(file);
    const bytes = fs.readFileSync(file), card = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), data = card.data || card;
    cleanLegacy(data);
    data.extensions ||= {};
    const refs = (data.extensions.rp_hub_image_references || data.imageReferences || []).map(r => ({ ...r }));
    for (const image of images) {
        const pixel = fs.readFileSync(image), ext = path.extname(image).toLowerCase();
        const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext];
        if (!mime || pixel.length > 6 * 1024 * 1024) throw new Error('Reference must be PNG/JPEG/WebP, at most 6MB');
        const id = 'ref-' + crypto.createHash('sha256').update(pixel).digest('hex').slice(0, 16);
        if (!refs.some(r => r.id === id)) refs.push({ id, name: path.basename(image), kind: 'character', description: `${data.name || '角色'}人物参考照片`, dataUrl: `data:${mime};base64,${pixel.toString('base64')}` });
    }
    if (refs.length > 16 || refs.reduce((n, r) => n + r.dataUrl.length, 0) > 32 * 1024 * 1024) throw new Error('Too many or oversized references');
    if (refs.length) data.extensions.rp_hub_image_references = refs;
    if (Object.hasOwn(data, 'imageReferences')) data.imageReferences = refs;
    const output = JSON.stringify(card, null, 2) + '\n';
    if (output === bytes.toString('utf8')) return { changed: false, references: refs.length };
    const folder = path.join(ROOT, '.refactor-tmp/character-card-backups'); fs.mkdirSync(folder, { recursive: true });
    const backup = path.join(folder, `${path.basename(file)}.${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.bak`);
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, bytes);
    fs.writeFileSync(file, output);
    return { changed: true, references: refs.length, backup };
}
if (require.main === module) console.log(JSON.stringify(attach(process.argv[2] || path.join(ROOT, 'card/suqixue/苏祈雪v2.json'), process.argv.slice(3))));
module.exports = { attach, cleanLegacy };
