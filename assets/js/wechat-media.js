// WeChat media: small metadata in messages, pixels in independent IndexedDB keys.
(function () {
    const MAX_FILE_BYTES = 12 * 1024 * 1024;
    const MAX_PIXELS = 24 * 1024 * 1024;
    const INDEX_KEY = 'wechat_media_index';
    const MODES = ['album', 'draw', 'search', 'generate', 'describe'];
    const USAGES = ['scene_photo', 'album_photo', 'reference', 'drawing'];
    const shortText = (value, max = 120) => typeof value === 'string'
        ? value.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';
    const assertActive = signal => { if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError'); };
    const BUILTINS = Object.freeze([
        { id: 'builtin-salad', title: '蔬菜沙拉', caption: '灰木桌上的一碗蔬菜沙拉，有小番茄、牛油果、鹰嘴豆、生菜和紫甘蓝，淋着白色酱汁。', tags: '吃饭 饭菜 沙拉 午餐 晚餐 蔬菜', path: 'assets/images/wechat/salad.jpg', sourceUrl: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd' },
        { id: 'builtin-desk', title: '窗边书桌', caption: '落地窗旁的长桌上有一台打开的笔记本电脑，桌边是白椅子和高大的绿植，窗外有楼房。', tags: '桌面 书桌 办公 工作 窗边 窗景 电脑', path: 'assets/images/wechat/desk.jpg', sourceUrl: 'https://images.unsplash.com/photo-1497215728101-856f4ea42174' },
        { id: 'builtin-cat', title: '黑白猫', caption: '绿背景前一只黑白猫，白色胸口与前爪，绿色眼睛，两只前爪搭在木头边缘上。', tags: '猫 宠物 动物 猫咪', path: 'assets/images/wechat/cat.jpg', sourceUrl: 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba' }
    ].map(item => Object.freeze({ ...item, source: 'album', captionSource: 'curated', builtin: true, license: 'Unsplash License' })));

    function normalizeIntent(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !MODES.includes(value.mode)) throw new Error('图片来源无效');
        const usage = value.usage === undefined ? (value.mode === 'draw' ? 'drawing' : value.mode === 'describe' ? 'scene_photo' : 'reference') : value.usage;
        if (!USAGES.includes(usage)) throw new Error('图片用途无效');
        const result = { mode: value.mode, usage };
        if (value.selfPortrait !== undefined) {
            if (value.mode !== 'generate' || typeof value.selfPortrait !== 'boolean') throw new Error('selfPortrait 只能是生图模式的布尔值，表示当前角色本人入镜');
            result.selfPortrait = value.selfPortrait;
        }
        if (value.description !== undefined) {
            if (typeof value.description !== 'string' || value.description.trim().length > 240) throw new Error('图片画面描述须为 240 字以内的文字');
            result.description = shortText(value.description, 240);
        }
        if (value.mode === 'describe') {
            if (!result.description) throw new Error('描述型图片需要非空画面描述');
        } else if (value.mode === 'album') {
            result.assetId = shortText(value.assetId, 100);
            if (!/^[\w-]+$/.test(result.assetId)) throw new Error('相册图片 ID 无效');
        } else if (value.mode === 'draw') {
            if (!['note', 'doodle'].includes(value.template)) throw new Error('不支持的绘图模板');
            result.template = value.template;
            result.text = shortText(value.text, 100);
            result.subject = value.subject || 'heart';
            if (!['heart', 'cat', 'flower', 'meal'].includes(result.subject)) throw new Error('不支持的简笔画主题');
            result.tone = ['warm', 'cool', 'plain'].includes(value.tone) ? value.tone : 'warm';
            result.decorations = Array.isArray(value.decorations) ? value.decorations.filter(item => ['heart', 'star'].includes(item)).slice(0, 3) : [];
            if (result.template === 'note' && !result.text) throw new Error('纸条文字不能为空');
        } else {
            const field = value.mode === 'search' ? 'query' : 'prompt';
            result[field] = shortText(value[field], field === 'query' ? 100 : 1500);
            if (!result[field]) throw new Error('图片请求内容不能为空');
        }
        return result;
    }

    function imageRecordText(item) {
        const caption = shortText(item?.media?.caption || item?.caption, item?.media?.descriptionOnly ? 240 : 120);
        if (item?.media?.descriptionOnly) return `[图片${item?.id ? ` #${item.id}` : ''}｜画面描述：${caption}｜叙述画面，无实际像素；不是发送者的文字配文]`;
        if (item?.media?.captionSource === 'generation_prompt') return `[图片${item?.id ? ` #${item.id}` : ''}｜生成画面：${caption}｜依据生图提示，像素细节尚未核对；不是文字配文]`;
        return `[图片${item?.id ? ` #${item.id}` : ''}｜${caption || '画面尚未识别，可用查看图片工具核对'}]`;
    }

    const blobToDataURL = blob => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(blob);
    });
    const canvasBlob = (canvas, type = 'image/webp', quality = 0.84) => new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('导出图片失败')), type, quality);
    });
    const bundledLoads = new Map();
    function readBundledPixels(item) {
        if (bundledLoads.has(item.id)) return bundledLoads.get(item.id);
        // file:// cannot export a Canvas drawn from a separate local file. Load the
        // fixed bundled pixel bytes lazily through a classic script instead.
        const pending = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = new URL(item.path.replace(/\.jpg$/, '.js'), window.location.href).href;
            const finish = () => { clearTimeout(timer); script.remove(); };
            const timer = setTimeout(() => { finish(); reject(new Error('内置图片读取超时')); }, 10000);
            script.onload = () => {
                const blob = window.RPHubWeChatBundledPixels?.[item.id];
                if (window.RPHubWeChatBundledPixels) delete window.RPHubWeChatBundledPixels[item.id];
                finish(); if (blob instanceof Blob) resolve(blob); else reject(new Error('内置图片内容无效'));
            };
            script.onerror = () => { finish(); reject(new Error('内置图片读取失败')); };
            document.head.appendChild(script);
        }).catch(error => { bundledLoads.delete(item.id); throw error; });
        bundledLoads.set(item.id, pending); return pending;
    }

    async function rasterize(source, { edge = 1600, signal } = {}) {
        assertActive(signal);
        if (source instanceof Blob && (source.size > MAX_FILE_BYTES || !/^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(source.type))) throw new Error('请使用 12 MB 以内的常见图片文件');
        const objectUrl = source instanceof Blob ? URL.createObjectURL(source) : null;
        const img = new Image();
        const url = objectUrl || String(source || '');
        if (/^https?:/i.test(url)) img.crossOrigin = 'anonymous';
        let timer;
        let onAbort;
        try {
            await new Promise((resolve, reject) => {
                const fail = error => { img.src = ''; reject(error); };
                onAbort = () => fail(new DOMException('操作已取消', 'AbortError'));
                signal?.addEventListener('abort', onAbort, { once: true });
                timer = setTimeout(() => fail(new Error('图片读取超时')), 20000);
                img.onload = resolve;
                img.onerror = () => fail(new Error('图片不可用或来源不允许跨域读取'));
                img.src = url;
            });
            assertActive(signal);
            if (!img.width || !img.height || img.width * img.height > MAX_PIXELS) throw new Error('图片像素过大，请先缩小图片');
            const scale = Math.min(1, edge / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            const blob = await canvasBlob(canvas);
            const thumbnail = document.createElement('canvas');
            const thumbScale = Math.min(1, 320 / Math.max(canvas.width, canvas.height));
            thumbnail.width = Math.max(1, Math.round(canvas.width * thumbScale));
            thumbnail.height = Math.max(1, Math.round(canvas.height * thumbScale));
            thumbnail.getContext('2d').drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
            const thumb = await canvasBlob(thumbnail);
            const dimensions = { width: canvas.width, height: canvas.height };
            canvas.width = canvas.height = thumbnail.width = thumbnail.height = 1;
            assertActive(signal);
            return { blob, thumb, ...dimensions };
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            img.onload = img.onerror = null;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        }
    }

    async function draw(intent, signal) {
        const value = normalizeIntent(intent);
        assertActive(signal);
        const canvas = document.createElement('canvas');
        canvas.width = 800; canvas.height = 800;
        const c = canvas.getContext('2d');
        // Artwork palette, independent from the application's UI theme.
        const hue = value.tone === 'cool' ? 210 : value.tone === 'plain' ? 40 : 340;
        c.fillStyle = `hsl(${hue} 48% 95%)`; c.fillRect(0, 0, 800, 800);
        c.fillStyle = 'white'; c.fillRect(65, 65, 670, 670);
        c.strokeStyle = `hsl(${hue} 35% 38%)`; c.fillStyle = c.strokeStyle;
        c.lineWidth = 9; c.lineCap = 'round'; c.lineJoin = 'round';
        const heart = (x, y, size) => {
            c.beginPath(); c.moveTo(x, y + size);
            c.bezierCurveTo(x - size * 1.9, y - size * 0.2, x - size, y - size, x, y - size * 0.3);
            c.bezierCurveTo(x + size, y - size, x + size * 1.9, y - size * 0.2, x, y + size); c.stroke();
        };
        const circle = (x, y, r) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke(); };
        if (value.template === 'doodle') {
            if (value.subject === 'heart') heart(400, 310, 115);
            if (value.subject === 'cat') {
                c.beginPath(); c.moveTo(260, 340); c.lineTo(260, 190); c.lineTo(350, 250); c.lineTo(450, 250); c.lineTo(540, 190); c.lineTo(540, 340); c.bezierCurveTo(540, 460, 260, 460, 260, 340); c.stroke();
                circle(340, 325, 8); circle(460, 325, 8);
                c.beginPath(); c.moveTo(385, 355); c.lineTo(400, 370); c.lineTo(415, 355); c.stroke();
                [315, 345].forEach(y => { c.beginPath(); c.moveTo(300, y); c.lineTo(205, y - 20); c.moveTo(500, y); c.lineTo(595, y - 20); c.stroke(); });
            }
            if (value.subject === 'flower') {
                for (let i = 0; i < 6; i++) circle(400 + Math.cos(i * Math.PI / 3) * 66, 290 + Math.sin(i * Math.PI / 3) * 66, 43);
                circle(400, 290, 27); c.beginPath(); c.moveTo(400, 390); c.lineTo(400, 495); c.moveTo(400, 450); c.lineTo(460, 410); c.stroke();
            }
            if (value.subject === 'meal') {
                c.beginPath(); c.ellipse(390, 305, 135, 35, 0, 0, Math.PI * 2); c.moveTo(255, 305); c.bezierCurveTo(285, 470, 495, 470, 525, 305); c.moveTo(330, 205); c.lineTo(345, 160); c.moveTo(405, 205); c.lineTo(420, 160); c.stroke();
            }
        }
        c.font = '42px "Microsoft YaHei", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        const rows = []; let line = '';
        for (const char of value.text) { if (c.measureText(line + char).width > 550) { rows.push(line); line = ''; } line += char; }
        if (line) rows.push(line);
        const start = value.template === 'note' ? 360 - (rows.length - 1) * 32 : 570 - (rows.length - 1) * 25;
        rows.forEach((row, i) => c.fillText(row, 400, start + i * 62));
        if (value.template === 'note' || value.decorations.includes('heart')) heart(400, 675, 24);
        if (value.decorations.includes('star')) { c.font = '44px sans-serif'; c.fillText('☆', 660, 135); }
        const blob = await canvasBlob(canvas, 'image/png');
        canvas.width = canvas.height = 1;
        const image = await rasterize(blob, { signal });
        const subjects = { heart: '爱心', cat: '猫', flower: '花', meal: '一碗饭' };
        return { ...image, caption: shortText(`${value.template === 'note' ? '手绘纸条' : `简笔画：${subjects[value.subject]}`}；${value.text ? `图中文字：${value.text}；` : ''}${value.decorations.length ? '附小装饰。' : ''}`), captionSource: 'renderer' };
    }

    function createLibrary(storage) {
        let metadata = [];
        let loadPromise;
        let writes = Promise.resolve();
        const load = () => loadPromise || (loadPromise = storage.getStoredValue(INDEX_KEY).then(value => { metadata = Array.isArray(value) ? value.filter(item => item?.id && !item.builtin) : []; }).catch(error => { loadPromise = null; throw error; }));
        const serial = operation => { const pending = writes.then(operation); writes = pending.catch(() => {}); return pending; };
        const list = async ownerId => { await load(); return [...BUILTINS, ...metadata.filter(item => item.album && (!item.ownerId || item.ownerId === ownerId))]; };
        const get = async id => { await load(); return BUILTINS.find(item => item.id === id) || metadata.find(item => item.id === id) || null; };
        const save = (image, info = {}, signal) => serial(async () => {
            await load(); assertActive(signal);
            const id = `media-${crypto.randomUUID()}`;
            const item = { id, title: shortText(info.title, 40), caption: shortText(info.caption || image.caption), captionSource: info.captionSource || image.captionSource || 'unknown', source: info.source || 'upload', album: info.album === true, ownerId: info.ownerId || '', scopeId: info.scopeId || '', createdAt: Date.now(), width: image.width, height: image.height, bytes: image.blob.size, sourceUrl: info.sourceUrl || '', license: info.license || '' };
            // Blob never passes through cloneForStorage's plain-object conversion.
            try {
                await storage.setStoredValue(`wechat_media_blob_${id}`, image.blob, { clone: false });
                await storage.setStoredValue(`wechat_media_thumb_${id}`, image.thumb, { clone: false });
                assertActive(signal);
                const next = [...metadata, item];
                await storage.setStoredValue(INDEX_KEY, next); metadata = next;
                return item;
            } catch (error) {
                await Promise.allSettled([storage.deleteStoredValue(`wechat_media_blob_${id}`), storage.deleteStoredValue(`wechat_media_thumb_${id}`)]);
                throw error;
            }
        });
        const read = async (id, thumbnail = false, signal) => {
            const item = await get(id); assertActive(signal);
            if (!item) throw new Error('图片资源已不存在');
            if (item.builtin) {
                const source = window.location.protocol === 'file:' ? await readBundledPixels(item) : new URL(item.path, window.location.href).href;
                const image = await rasterize(source, { signal });
                return thumbnail ? image.thumb : image.blob;
            }
            const blob = await storage.getStoredValue(`wechat_media_${thumbnail ? 'thumb' : 'blob'}_${id}`);
            assertActive(signal);
            if (!(blob instanceof Blob)) throw new Error('图片文件已丢失');
            return blob;
        };
        const remove = id => serial(async () => {
            await load();
            if (BUILTINS.some(item => item.id === id)) return;
            const next = metadata.filter(item => item.id !== id);
            await storage.setStoredValue(INDEX_KEY, next); metadata = next;
            await storage.deleteStoredValue(`wechat_media_blob_${id}`);
            await storage.deleteStoredValue(`wechat_media_thumb_${id}`);
        });
        const candidates = async (query, ownerId) => {
            const words = shortText(query, 600).toLowerCase().split(/[\s，。！？、:：]+/).filter(Boolean);
            return (await list(ownerId)).map(item => ({ item, score: words.reduce((score, word) => score + (`${item.title} ${item.caption} ${item.tags || ''}`.toLowerCase().includes(word) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score).slice(0, 6).map(({ item }) => item);
        };
        const purgeOwner = async ownerId => {
            await load();
            for (const item of metadata.filter(item => item.ownerId === ownerId)) await remove(item.id);
        };
        const reload = async () => { await writes; loadPromise = null; await load(); };
        return { list, get, save, read, remove, candidates, purgeOwner, reload };
    }

    window.RPHubWeChatMedia = Object.freeze({ BUILTINS, MAX_FILE_BYTES, normalizeIntent, imageRecordText, shortText, assertActive, blobToDataURL, rasterize, draw, createLibrary });
})();
