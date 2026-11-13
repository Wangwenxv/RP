// World pixels live outside event/actor context; portable packages include referenced assets.
(function () {
    const prefix = 'world_media_';
    const key = id => prefix + id;
    const storage = () => window.RPHubStorage;
    const validData = value => typeof value === 'string' && value.length < 18 * 1024 * 1024
        && /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value);
    const read = async id => {
        if (!/^worldimg-[\w-]+$/.test(id || '')) throw new Error('世界图片 ID 无效');
        const value = await storage().getStoredValue(key(id));
        if (!value || !validData(value.dataUrl) || !validData(value.thumbUrl)) throw new Error('图片原件已丢失，请从包含图片的世界备份恢复');
        return value;
    };
    async function prepare({ id, intent, config, signal }) {
        window.RPHubWeChatMedia.assertActive(signal);
        const saved = await storage().getStoredValue(key(id));
        if (saved) { await read(id); return saved.media; }
        const M = window.RPHubWeChatMedia, clean = M.normalizeIntent(intent);
        if (clean.mode !== 'generate') throw new Error('世界图片目前使用 generate 生图模式');
        const image = await M.rasterize(await window.RPHubImageGeneration.generate(config, clean.prompt, signal), { signal });
        const media = { assetId: id, source: 'generate', caption: M.shortText(clean.description || '生成的场景图片'),
            captionSource: 'generation_prompt', usage: clean.usage };
        const asset = { media, dataUrl: await M.blobToDataURL(image.blob), thumbUrl: await M.blobToDataURL(image.thumb) };
        M.assertActive(signal);
        await storage().setStoredValue(key(id), asset);
        M.assertActive(signal); return media;
    }
    const referencedIds = session => [...new Set(Object.values(session.branches).flatMap(b => b.events
        .filter(e => e.kind === 'message.sent' && e.payload.type === 'image').map(e => e.payload.media?.assetId)).filter(Boolean))];
    async function exportAssets(session) {
        const assets = {};
        for (const id of referencedIds(session)) assets[id] = await read(id);
        return assets;
    }
    async function importAssets(session, assets = {}) {
        // Validate every referenced entry before writing any of them. Ignore unreferenced content.
        const ids = referencedIds(session), replacements = new Map();
        for (const id of ids) {
            const a = assets[id];
            if (!/^worldimg-[\w-]+$/.test(id) || !a || !validData(a.dataUrl) || !validData(a.thumbUrl)) throw new Error('世界包缺少有效图片原件');
            replacements.set(id, 'worldimg-' + crypto.randomUUID());
        }
        for (const id of ids) {
            const a = assets[id], next = replacements.get(id);
            await storage().setStoredValue(key(next), { dataUrl: a.dataUrl, thumbUrl: a.thumbUrl,
                media: { assetId: next, source: 'generate', caption: window.RPHubWeChatMedia.shortText(a.media?.caption), captionSource: 'generation_prompt', usage: 'scene_photo' } });
        }
        const remap = value => {
            if (!value || typeof value !== 'object') return;
            if (replacements.has(value.assetId)) value.assetId = replacements.get(value.assetId);
            Object.values(value).forEach(remap);
        };
        remap(session);
    }
    window.RPHubWorldMedia = Object.freeze({ prefix, read, prepare, exportAssets, importAssets });
})();
