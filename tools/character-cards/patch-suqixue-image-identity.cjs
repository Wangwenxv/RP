// Idempotently add the image appearance baseline, preserving all existing card fields.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const profile = {
    version: 1, enabled: true,
    description: '苏祈雪，18岁成年女生；瘦鹅蛋脸、柔和收窄的下颌、小巧下巴，正常大小的深棕杏眼，细直鼻梁、小巧鼻尖与淡玫瑰色嘴唇。白皙自然肤质；细软齐肩深棕发，常别在耳后，轻薄碎刘海。以写实手机照片为目标。',
    prompt: 'original, adult woman, slim oval face, softly tapered jawline, small delicate chin, natural-sized almond-shaped dark brown eyes, defined eyelids, subtly upturned outer eye corners, natural straight eyebrows with tapered ends, slender straight nose bridge, small natural nose tip, small mouth, subtle cupid\'s bow, muted rose lips, fair skin with natural skin texture, shoulder-length fine dark brown hair tucked behind ears, soft wispy bangs, face-framing strands, subtle eyeliner, understated makeup, photorealistic portrait, candid smartphone photography, natural facial proportions, realistic skin detail',
    negative: 'anime, manga, illustration, cartoon, 3d render, doll-like face, oversized eyes, exaggerated facial proportions, plastic skin, excessive skin smoothing'
};
const marker = '【本人生图外貌基线】';
const note = `${marker}\n${profile.description}\n本人照片复用上述面部特征，仅随剧情调整服装、表情、姿势、环境和光线。需要绘图时参照世界书“苏祈雪·本人生图外貌”；这些是画面资料，不作为聊天台词，也不代表已发送过照片。`;
const entry = {
    comment: '苏祈雪·本人生图外貌', enabled: true, scope: 'character',
    keys: ['苏祈雪', '自拍', '拍照', '照片', '生图', '绘图', '本人入镜'],
    useRegex: false, constant: false, position: 'before_char', order: 90,
    scanDepth: 2, probability: 100, useProbability: false,
    content: `${marker}\n${profile.description}\n\n本人入镜时固定英文特征：\n${profile.prompt}\n\n本人图片负面提示词：\n${profile.negative}\n\n生成本人自拍或生活照时复用固定特征，另加本轮服装、表情、姿势、地点、镜头和光线。RP Hub 的发图工具在 generate 请求中必须明确填写 selfPortrait：本人入镜为true，饭菜、风景或他人为false，不可省略。本人图片只在 prompt 填本轮场景，程序自动拼入固定特征。其他客户端若不支持此字段，可将固定英文特征与场景提示一起交给其生图功能。饭菜、风景、他人不套这份外貌。实际拍摄意愿仍按人设与剧情决定；不能将这些资料当作聊天台词、已发图记录或实际识图结果。写实风格与面孔相似度取决于所用生图模型。`
};
function patch(file) {
    const bytes = fs.readFileSync(file), card = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    const data = card.data || card;
    if (data.name !== '苏祈雪') throw new Error('Expected Su Qixue card; refusing to modify a different character');
    if (!Array.isArray(data.character_book?.entries)) throw new Error('Expected character_book.entries array');
    data.extensions ||= {};
    data.extensions.rp_hub_image_identity = { ...profile };
    if (Object.hasOwn(data, 'imageIdentity')) data.imageIdentity = { ...profile };
    if (!String(data.personality || '').includes(marker)) data.personality = `${data.personality || ''}\n\n${note}`;
    const index = data.character_book.entries.findIndex(value => value.comment === entry.comment);
    if (index >= 0) data.character_book.entries[index] = entry;
    else data.character_book.entries.push(entry);
    const output = JSON.stringify(card, null, 2) + '\n';
    if (output === bytes.toString('utf8')) return { changed: false, entries: data.character_book.entries.length };
    const backupDir = path.join(ROOT, '.refactor-tmp/character-card-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `${path.basename(file)}.${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.bak`);
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, bytes);
    fs.writeFileSync(file, output, 'utf8');
    return { changed: true, entries: data.character_book.entries.length, backup };
}
if (require.main === module) console.log(JSON.stringify(patch(path.resolve(process.argv[2] || path.join(ROOT, 'card/suqixue/苏祈雪v2.json')))));
module.exports = { profile, patch };
