/** Portable map packages. Images stay in local storage, outside the world/tool payload. */
(function () {
    'use strict';
    const MAX_IMAGE = 12 * 1024 * 1024, MAX_FILE = 20 * 1024 * 1024;
    const clone = value => JSON.parse(JSON.stringify(value));
    const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, clone(value[k])]));
    const prepareWorld = source => {
        if (JSON.stringify(source).length > 2 * 1024 * 1024) throw new Error('地点和道路数据不能超过2MB');
        const w = pick(source, ['version', 'id', 'name', 'imageSize', 'coordinateSystem', 'culture', 'districts', 'metersPerUnit', 'calibration']);
        if (typeof w.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(w.id) || typeof w.name !== 'string' || !w.name.trim()) throw new Error('地图需要名称，以及字母/数字/横线组成的ID');
        if (!Array.isArray(w.imageSize) || w.imageSize.length !== 2 || !w.imageSize.every(n => Number.isFinite(n) && n > 0 && n <= 50000)) throw new Error('地图需要有效的imageSize坐标尺寸');
        w.places = (source.places || []).map(p => pick(p, ['id', 'name', 'point', 'kind', 'district', 'aliases', 'function', 'scene', 'access']));
        w.edges = (source.edges || []).map(e => pick(e, ['id', 'from', 'to', 'modes', 'points', 'meters', 'oneWay', 'closed', 'bikeDismount', 'provenance', 'note']));
        const text = (v, label) => { if (v !== undefined && (typeof v !== 'string' || v.length > 30000)) throw new Error(label + '应为不超过30000字的文本'); };
        text(w.name, '名称');
        if (w.culture !== undefined && (!Array.isArray(w.culture) || w.culture.some(v => typeof v !== 'string' || v.length > 30000))) throw new Error('文化背景需要文本数组');
        if (w.districts !== undefined) {
            if (!w.districts || typeof w.districts !== 'object' || Array.isArray(w.districts)) throw new Error('片区背景需要对象');
            w.districts = Object.fromEntries(Object.entries(w.districts).map(([id, d]) => { text(d.scene, '片区背景'); text(d.source, '背景来源'); return [id, pick(d, ['scene', 'source'])]; }));
        }
        for (const p of w.places) {
            for (const k of ['id', 'name', 'kind', 'district', 'function', 'scene']) text(p[k], '地点' + k);
            if (p.aliases !== undefined && (!Array.isArray(p.aliases) || p.aliases.some(v => typeof v !== 'string'))) throw new Error('别名需要文本数组');
            if (p.point?.some((n, i) => n < 0 || n > w.imageSize[i])) throw new Error('地点坐标超出底图');
            if (p.access !== undefined) {
                if (!p.access || typeof p.access !== 'object' || Array.isArray(p.access)) throw new Error('开放规则需要对象');
                p.access = pick(p.access, ['open', 'close', 'check', 'note', 'restriction', 'sessions']);
                for (const k of ['open', 'close', 'check']) {
                    if (p.access[k] === '') delete p.access[k];
                    if (p.access[k] !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(p.access[k])) throw new Error('开放/关闭时间使用HH:MM');
                }
                text(p.access.note, '开放说明'); text(p.access.restriction, '进入限制');
                if (p.access.sessions !== undefined && (!Array.isArray(p.access.sessions) || p.access.sessions.some(v => typeof v !== 'string'))) throw new Error('开放时段需要文本数组');
            }
        }
        window.RPHubGeography.validate(w);
        if (w.calibration?.autoScale) {
            if (w.edges.some(e => e.meters !== undefined)) throw new Error('时间标定不能混用道路米数；请选择比例/道路长度方式');
            const c = w.calibration;
            const found = window.RPHubGeography.path({ ...w, metersPerUnit: 1 }, c.anchorFrom, c.anchorTo, 'walk');
            if (!found || !found.length || !Number.isFinite(c.walkMinutes) || c.walkMinutes <= 0 || !Number.isFinite(c.assumedWalkMetersPerMinute) || c.assumedWalkMetersPerMinute <= 0) throw new Error('步行标定需要连通的起终点和正数分钟/步速');
            w.metersPerUnit = c.walkMinutes * c.assumedWalkMetersPerMinute / found.length;
        }
        return window.RPHubGeography.validate(w);
    };
    const checkImage = data => {
        if (typeof data !== 'string') throw new Error('地图包缺少原图；请选择底图后保存');
        const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
        if (!m || m[2].length % 4 || m[2].length * 3 / 4 > MAX_IMAGE) throw new Error('底图仅支持12MB以内的PNG/JPEG/WebP');
        const bytes = atob(m[2]);
        const valid = m[1] === 'png' ? bytes.startsWith('\x89PNG\r\n\x1a\n') : m[1] === 'jpeg' ? bytes.startsWith('\xff\xd8\xff') : bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP';
        if (!valid) throw new Error('底图内容与图片格式不符');
        return data;
    };
    const imageSize = data => new Promise((resolve, reject) => {
        checkImage(data);
        const img = new Image();
        img.onload = () => { if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 50000000) reject(new Error('图片过大或无法解码')); else resolve([img.naturalWidth, img.naturalHeight]); };
        img.onerror = () => reject(new Error('无法解码底图')); img.src = data;
    });
    const encode = (world, imageData) => ({ format: 'rp-hub-map', version: 1, world: prepareWorld(world), image: { dataUrl: checkImage(imageData) } });
    const decode = async value => {
        if (value?.format !== 'rp-hub-map' || value.version !== 1) throw new Error('请选择RP-Hub地图包（rp-hub-map v1），普通图片请用“上传底图”');
        const result = { world: prepareWorld(value.world), imageData: checkImage(value.image?.dataUrl) };
        await imageSize(result.imageData);
        return result;
    };
    const readImage = async file => {
        if (!file || file.size > MAX_IMAGE) throw new Error('请选择12MB以内的底图');
        const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('读取图片失败')); r.readAsDataURL(file); });
        return { data, size: await imageSize(data) };
    };
    window.RPHubMapPackages = Object.freeze({ prepareWorld, encode, decode, checkImage, imageSize, readImage, MAX_FILE, clone });
})();
