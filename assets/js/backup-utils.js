// Portable RP Hub snapshot: checked JSON manifest + original binary resources, no CDN/library dependency.
(function () {
    const MAGIC = new TextEncoder().encode('RPHUB_BACKUP_V1\n'), PREFIX = MAGIC.length + 8;
    const MAX_HEADER = 128 * 1024 * 1024, MAX_FILE = 2 * 1024 * 1024 * 1024;
    const pause = () => new Promise(resolve => setTimeout(resolve, 0));
    const table = Uint32Array.from({ length: 256 }, (_, n) => {
        for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
        return n >>> 0;
    });
    const crcBytes = (bytes, crc = 0xffffffff) => {
        for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
        return crc;
    };
    const checksum = async blob => {
        let crc = 0xffffffff;
        for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
            crc = crcBytes(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()), crc);
            await pause();
        }
        return (crc ^ 0xffffffff) >>> 0;
    };
    const secretKey = key => /^(?:apiKey|apiProviderKeys|imageGenKey|tavilyKey|tavilyApiKey|accessToken|authToken|authorization)$/i.test(key);
    const stripCredentials = (value, seen = new WeakSet(), depth = 0) => {
        if (depth > 128) throw new Error('数据嵌套过深，无法完整备份');
        if (!value || typeof value !== 'object' || value instanceof Blob || value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
        if (!Array.isArray(value) && Object.prototype.toString.call(value) !== '[object Object]') return value;
        if (seen.has(value)) throw new Error('备份包含循环引用，无法完整保存');
        seen.add(value);
        const result = Array.isArray(value) ? value.map(item => stripCredentials(item, seen, depth + 1))
            : Object.fromEntries(Object.entries(value).filter(([key]) => !secretKey(key)).map(([key, item]) => [key, stripCredentials(item, seen, depth + 1)]));
        seen.delete(value); return result;
    };
    const removeCredentials = (entries, browser = {}) => {
        const secrets = new Set();
        const seen = new WeakSet();
        const collect = (value, secret = false) => {
            if (typeof value === 'string') { if (secret && value) secrets.add(value); return; }
            if (!value || typeof value !== 'object' || value instanceof Blob || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || seen.has(value)) return;
            seen.add(value);
            for (const [key, item] of Object.entries(value)) collect(item, secret || secretKey(key));
        };
        entries.forEach(([, value]) => collect(value));
        if (browser.session?.rphub_wechat_voice_key) secrets.add(browser.session.rphub_wechat_voice_key);
        const replacements = [...secrets].flatMap(secret => [secret, encodeURIComponent(secret)]).sort((a, b) => b.length - a.length);
        const redact = value => {
            if (typeof value === 'string') { for (const secret of replacements) value = value.split(secret).join(''); return value; }
            if (Array.isArray(value)) return value.map(redact);
            if (!value || typeof value !== 'object' || value instanceof Blob || value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
            if (Object.prototype.toString.call(value) !== '[object Object]') return value;
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
        };
        return entries.map(([key, value]) => [key, redact(stripCredentials(value))]);
    };
    const encode = (value, binaries, seen = new WeakSet(), depth = 0) => {
        if (depth > 128) throw new Error('数据嵌套过深，无法完整备份');
        if (value === undefined) return ['undefined'];
        if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return ['value', value];
        if (typeof value !== 'object') throw new Error('备份包含不支持的数据类型');
        if (value instanceof Blob) { const index = binaries.push(value) - 1; return ['blob', index]; }
        if (value instanceof Date) return ['date', value.toISOString()];
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            const blob = new Blob([value]), index = binaries.push(blob) - 1;
            return ['bytes', index, value instanceof ArrayBuffer ? 'ArrayBuffer' : value.constructor.name];
        }
        if (seen.has(value)) throw new Error('备份包含循环引用，无法完整保存');
        seen.add(value);
        let result;
        if (Array.isArray(value)) result = ['array', value.map(item => encode(item, binaries, seen, depth + 1))];
        else if (Object.prototype.toString.call(value) === '[object Object]') result = ['object', Object.entries(value).map(([key, item]) => [key, encode(item, binaries, seen, depth + 1)])];
        else throw new Error('备份包含不支持的存储对象');
        seen.delete(value);
        return result;
    };
    const decode = async (node, binaries, depth = 0) => {
        if (depth > 128 || !Array.isArray(node)) throw new Error('备份数据结构无效');
        const [tag, value, type] = node;
        if (tag === 'value' && node.length === 2 && (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value))) return value;
        if (tag === 'undefined' && node.length === 1) return undefined;
        if (tag === 'date' && node.length === 2 && typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value);
        if ((tag === 'blob' || tag === 'bytes') && Number.isInteger(value) && value >= 0 && value < binaries.length) {
            if (tag === 'blob' && node.length === 2) return binaries[value];
            const constructors = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, DataView };
            if (tag === 'bytes' && node.length === 3 && (type === 'ArrayBuffer' || Object.hasOwn(constructors, type))) {
                const buffer = await binaries[value].arrayBuffer();
                return type === 'ArrayBuffer' ? buffer : new constructors[type](buffer);
            }
        }
        if (tag === 'array' && node.length === 2 && Array.isArray(value)) {
            const result = []; for (const item of value) result.push(await decode(item, binaries, depth + 1)); return result;
        }
        if (tag === 'object' && node.length === 2 && Array.isArray(value)) {
            const result = {}, keys = new Set();
            for (const pair of value) {
                if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(pair[0]) || keys.has(pair[0])) throw new Error('备份对象字段无效或重复');
                keys.add(pair[0]);
                // 不通过属性赋值解码 __proto__ 等名称。
                Object.defineProperty(result, pair[0], { value: await decode(pair[1], binaries, depth + 1), enumerable: true, writable: true, configurable: true });
            }
            return result;
        }
        throw new Error('备份包含未知或损坏的数据类型');
    };
    const browserKeys = { local: ['rphub-appearance', 'ai_chargen_options', 'ai_chargen_active_index'], session: ['rphub_wechat_voice_service', 'rphub_wechat_voice_key'] };
    const sanitizeBrowser = (browser = {}, credentials = false) => Object.fromEntries(Object.entries(browserKeys).map(([area, allowed]) => [area,
        Object.fromEntries(allowed.filter(key => credentials || key !== 'rphub_wechat_voice_key')
            .filter(key => typeof browser[area]?.[key] === 'string').map(key => {
                let value = browser[area][key];
                if (key === 'ai_chargen_options' && !credentials) {
                    try { value = JSON.stringify(removeCredentials([['options', JSON.parse(value)]], browser)[0][1]); }
                    catch (_) { throw new Error('角色工坊偏好设置无效，请在工坊重新保存设置后重试'); }
                }
                return [key, value];
            }))]));
    const validateEntries = entries => {
        const keys = new Set();
        for (const pair of entries) {
            if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[0] || pair[0].length > 1024 || keys.has(pair[0])) throw new Error('备份存储键无效或重复');
            keys.add(pair[0]);
            const [key, value] = pair;
            const arrayKeys = ['characters', 'presets', 'regex', 'global_regex', 'worldinfo', 'global_worldinfo', 'global_ui_templates', 'user_profiles', 'wechat_stickers', 'active_tools', 'token_usage_history', 'geographyMaps'];
            if ((arrayKeys.includes(key) || /^(?:chat|classic_memories|wechat_timeline|wechat_media_tasks)_/.test(key)) && !Array.isArray(value)) throw new Error(`备份中的 ${key} 应为列表`);
            if (['settings', 'memory_settings', 'user', 'worldinfo_settings'].includes(key) && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error(`备份中的 ${key} 设置无效`);
            if (key === 'workshop_characters' && (typeof value !== 'string' || !Array.isArray(JSON.parse(value)))) throw new Error('备份中的角色工坊草稿无效');
        }
        const characters = entries.find(([key]) => key === 'characters')?.[1];
        if (!Array.isArray(characters)) throw new Error('这不是包含全部角色的完整备份');
        const ids = new Set();
        for (const char of characters) {
            if (!char || typeof char !== 'object' || Array.isArray(char) || typeof char.name !== 'string') throw new Error('备份中的角色数据无效');
            if (char.uuid && ids.has(char.uuid)) throw new Error('备份中存在重复角色ID');
            if (char.uuid) ids.add(char.uuid);
        }
    };
    const summarize = entries => {
        const result = { characters: 0, branches: 0, rp: 0, wechat: 0, memories: 0, images: 0, voices: 0, documents: 0, maps: 0, workshop: 0, novels: 0, entries: entries.length };
        for (const [key, value] of entries) {
            if (key === 'characters') result.characters = value.length;
            else if (/^branches_/.test(key)) result.branches += value?.branches?.length || 0;
            else if (/^chat_/.test(key)) result.rp += value.length;
            else if (/^wechat_timeline_/.test(key)) result.wechat += value.filter(item => item?.channel === 'wechat').length;
            else if (/^classic_memories_/.test(key)) result.memories += value.length;
            else if (/^wechat_media_blob_/.test(key)) result.images++;
            else if (/^wechat_voice_blob_/.test(key)) result.voices++;
            else if (/^wechat_document_blob_/.test(key)) result.documents++;
            else if (key === 'geographyMaps') result.maps = value.length;
            else if (key === 'workshop_characters') result.workshop = JSON.parse(value).length;
            else if (key === 'novel_library') result.novels = value?.books?.length || 0;
        }
        return result;
    };
    const create = async (entries, { credentials = false, browser = {}, onProgress = () => {} } = {}) => {
        validateEntries(entries);
        const binaries = [], cleaned = credentials ? entries : removeCredentials(entries, browser);
        const records = cleaned.map(([key, value]) => [key, encode(value, binaries)]);
        if (binaries.reduce((total, blob) => total + blob.size, 0) > MAX_FILE) throw new Error('备份附件过大，单文件上限为2GB');
        const resources = []; let offset = 0;
        for (const [index, blob] of binaries.entries()) {
            onProgress(`正在打包附件 ${index + 1}/${binaries.length}`);
            resources.push({ offset, size: blob.size, type: blob.type, crc: await checksum(blob) }); offset += blob.size;
        }
        const manifest = { type: 'rp-hub-full-backup', version: 1, createdAt: new Date().toISOString(), credentials,
            browser: sanitizeBrowser(browser, credentials), records, resources };
        const header = new TextEncoder().encode(JSON.stringify(manifest));
        if (header.length > MAX_HEADER || PREFIX + header.length + offset > MAX_FILE) throw new Error('备份过大，当前单文件备份上限为2GB、记录目录128MB');
        const prefix = new Uint8Array(PREFIX); prefix.set(MAGIC);
        const view = new DataView(prefix.buffer); view.setUint32(MAGIC.length, header.length, true); view.setUint32(MAGIC.length + 4, (crcBytes(header) ^ 0xffffffff) >>> 0, true);
        return new Blob([prefix, header, ...binaries], { type: 'application/octet-stream' });
    };
    const inspect = async (file, onProgress = () => {}) => {
        if (!(file instanceof Blob) || file.size < PREFIX || file.size > MAX_FILE) throw new Error('备份文件大小无效，单文件上限为2GB');
        const prefix = new Uint8Array(await file.slice(0, PREFIX).arrayBuffer());
        if (MAGIC.some((byte, index) => prefix[index] !== byte)) throw new Error('请选择 RP Hub「导出全部内容」生成的 .rphub 文件；角色卡和聊天 JSONL 请使用原导入入口');
        const view = new DataView(prefix.buffer), size = view.getUint32(MAGIC.length, true);
        if (!size || size > MAX_HEADER || PREFIX + size > file.size) throw new Error('备份目录长度无效或文件不完整');
        const bytes = new Uint8Array(await file.slice(PREFIX, PREFIX + size).arrayBuffer());
        if (((crcBytes(bytes) ^ 0xffffffff) >>> 0) !== view.getUint32(MAGIC.length + 4, true)) throw new Error('备份目录校验失败，文件可能已损坏');
        const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (manifest.type !== 'rp-hub-full-backup' || manifest.version !== 1 || typeof manifest.credentials !== 'boolean' || !Array.isArray(manifest.records) || !Array.isArray(manifest.resources)) throw new Error('备份版本不支持或目录无效');
        const binaries = []; let offset = 0;
        for (const [index, resource] of manifest.resources.entries()) {
            if (!resource || resource.offset !== offset || !Number.isSafeInteger(resource.size) || resource.size < 0 || typeof resource.type !== 'string'
                || !Number.isInteger(resource.crc) || resource.crc < 0 || resource.crc > 0xffffffff || PREFIX + size + offset + resource.size > file.size) throw new Error('备份附件目录无效或文件不完整');
            const blob = file.slice(PREFIX + size + offset, PREFIX + size + offset + resource.size, resource.type);
            onProgress(`正在校验附件 ${index + 1}/${manifest.resources.length}`);
            if (await checksum(blob) !== resource.crc) throw new Error(`附件 ${index + 1} 校验失败，文件可能已损坏`);
            binaries.push(blob); offset += resource.size;
        }
        if (PREFIX + size + offset !== file.size) throw new Error('备份长度不匹配，文件可能已损坏');
        const entries = [];
        for (const record of manifest.records) {
            if (!Array.isArray(record) || record.length !== 2) throw new Error('备份记录无效');
            entries.push([record[0], await decode(record[1], binaries)]);
            if (entries.length % 128 === 0) { onProgress(`正在检查记录 ${entries.length}/${manifest.records.length}`); await pause(); }
        }
        validateEntries(entries);
        return { entries, browser: sanitizeBrowser(manifest.browser, manifest.credentials), credentials: manifest.credentials, createdAt: manifest.createdAt, summary: summarize(entries) };
    };
    window.RPHubBackup = Object.freeze({ create, inspect, summarize, stripCredentials, removeCredentials, sanitizeBrowser, browserKeys });
})();
