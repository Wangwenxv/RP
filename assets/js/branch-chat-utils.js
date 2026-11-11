// Versioned branch-chat packages. File data never supplies a database key to write.
(function () {
    const TYPE = 'rp-hub-chat-resource';
    const CONFIG = {
        image: { prefix: 'wechat_media', required: ['blob', 'thumb'] },
        voice: { prefix: 'wechat_voice', required: ['blob'] },
        document: { prefix: 'wechat_document', required: ['blob', 'toc'] }
    };
    const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const copy = value => JSON.parse(JSON.stringify(value));
    const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,180}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
    const key = (kind, id, part) => {
        const prefix = CONFIG[kind].prefix;
        return part.startsWith('chunk_') ? `${prefix}_chunk_${id}_${part.slice(6)}` : `${prefix}_${part}_${id}`;
    };
    const refs = branch => (branch.wechatTimeline || []).flatMap(item => {
        if (item.type === 'image' && item.media?.assetId) return [{ kind: 'image', id: item.media.assetId, branchId: branch.branchId }];
        if (item.type === 'voice' && item.media?.assetId) return [{ kind: 'voice', id: item.media.assetId, branchId: branch.branchId }];
        if (item.type === 'document' && item.document?.id) return [{ kind: 'document', id: item.document.id, branchId: branch.branchId }];
        return [];
    });
    const encode = async value => {
        if (!(value instanceof Blob)) return { encoding: 'json', data: copy(value) };
        const bytes = new Uint8Array(await value.arrayBuffer()); let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return { encoding: 'base64', data: btoa(binary), bytes: bytes.length, mime: value.type };
    };
    const decode = value => {
        if (!object(value)) throw new Error('聊天附件内容无效');
        if (value.encoding === 'json') {
            if (!object(value.data) && !Array.isArray(value.data)) throw new Error('聊天附件 JSON 无效');
            if (Object.keys(value).some(name => !['encoding', 'data'].includes(name))) throw new Error('未知聊天附件字段');
            return copy(value.data);
        }
        if (value.encoding !== 'base64' || Object.keys(value).some(name => !['encoding', 'data', 'bytes', 'mime'].includes(name))
            || typeof value.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
            || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 100 * 1024 * 1024 || typeof value.mime !== 'string') throw new Error('聊天附件编码无效');
        const binary = atob(value.data);
        if (binary.length !== value.bytes || btoa(binary) !== value.data) throw new Error('聊天附件字节长度错误');
        return new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: value.mime });
    };
    async function collectResources(branches, ownerId, storage, builtins = []) {
        const resources = [], seen = new Set(), builtinIds = new Set(builtins.map(item => item.id));
        const indexes = new Map();
        for (const ref of branches.flatMap(refs)) {
            if (ref.kind === 'image' && builtinIds.has(ref.id)) continue;
            const token = `${ref.kind}:${ref.id}`; if (seen.has(token)) continue; seen.add(token);
            if (!indexes.has(ref.kind)) indexes.set(ref.kind, await storage.getStoredValue(`${CONFIG[ref.kind].prefix}_index`) || []);
            const metadata = indexes.get(ref.kind).find(item => item?.id === ref.id);
            if (!metadata || (metadata.ownerId && metadata.ownerId !== ownerId)) throw new Error(`聊天附件已丢失或不属于当前角色：${ref.id}`);
            const parts = [...CONFIG[ref.kind].required];
            if (ref.kind === 'document') {
                if (!Number.isSafeInteger(metadata.chunkCount) || metadata.chunkCount < 0 || metadata.chunkCount > 100000) throw new Error('文档分块目录无效');
                const reader = await storage.getStoredValue(key(ref.kind, ref.id, 'reader'));
                if (reader !== undefined && reader !== null) parts.push('reader');
                for (let i = 0; i < metadata.chunkCount; i++) parts.push(`chunk_${i}`);
            }
            const entries = [];
            for (const part of parts) {
                const value = await storage.getStoredValue(key(ref.kind, ref.id, part));
                if (value === undefined || value === null || (['blob', 'thumb'].includes(part) && !(value instanceof Blob))) throw new Error(`聊天附件已丢失：${ref.id}/${part}`);
                entries.push([part, await encode(value)]);
            }
            resources.push({ type: TYPE, kind: ref.kind, id: ref.id, branchId: ref.branchId, metadata: copy(metadata), entries });
        }
        return resources;
    }
    function parse(records, version, branchIds, builtins = []) {
        if (![1, 2].includes(Number(version))) throw new Error(`不支持的分支聊天版本：${version}`);
        const chats = new Map(), resources = [], resourceIds = new Set(), builtinIds = new Set(builtins.map(item => item.id));
        for (const record of records) {
            if (!object(record)) throw new Error('分支聊天数据无效');
            if (record.type === TYPE) {
                if (Number(version) !== 2 || !Object.hasOwn(CONFIG, record.kind) || !validId(record.id) || !branchIds.has(record.branchId)
                    || !object(record.metadata) || record.metadata.id !== record.id || !Array.isArray(record.entries)
                    || Object.keys(record).some(name => !['type', 'kind', 'id', 'branchId', 'metadata', 'entries'].includes(name))) throw new Error('聊天附件目录无效');
                const token = `${record.kind}:${record.id}`;
                if (resourceIds.has(token)) throw new Error('聊天附件重复'); resourceIds.add(token);
                const allowed = new Set([...CONFIG[record.kind].required]);
                if (record.kind === 'document') {
                    if (!Number.isSafeInteger(record.metadata.chunkCount) || record.metadata.chunkCount < 0 || record.metadata.chunkCount > 100000) throw new Error('文档分块目录无效');
                    allowed.add('reader'); for (let i = 0; i < record.metadata.chunkCount; i++) allowed.add(`chunk_${i}`);
                }
                const parts = new Map();
                for (const entry of record.entries) {
                    if (!Array.isArray(entry) || entry.length !== 2 || !allowed.has(entry[0]) || parts.has(entry[0])) throw new Error('未知或重复聊天附件字段');
                    const value = decode(entry[1]);
                    if (['blob', 'thumb'].includes(entry[0]) !== (value instanceof Blob)) throw new Error('聊天附件类型错误');
                    parts.set(entry[0], value);
                }
                for (const part of allowed) if (part !== 'reader' && !parts.has(part)) throw new Error('缺少聊天附件内容');
                resources.push({ ...copy(record), decoded: parts });
                continue;
            }
            if (!branchIds.has(record.branchId) || chats.has(record.branchId) || !Array.isArray(record.messages)
                || record.messages.some(message => !object(message))) throw new Error('未知、重复或不完整的分支聊天');
            if (Number(version) === 2 && (!Array.isArray(record.wechatTimeline) || record.wechatTimeline.some(item => !object(item) || !['rp', 'wechat'].includes(item.channel)))) throw new Error('分支缺少微信时间线或包含无效消息');
            if (record.classicMemories !== undefined && (!Array.isArray(record.classicMemories) || record.classicMemories.some(item => !object(item)))) throw new Error('分支总结数据无效');
            if (record.storyRecap !== undefined && record.storyRecap !== null && !object(record.storyRecap)) throw new Error('分支提要数据无效');
            chats.set(record.branchId, { ...copy(record), wechatTimeline: Number(version) === 2 ? copy(record.wechatTimeline) : [], classicMemories: copy(record.classicMemories || []), storyRecap: copy(record.storyRecap || null) });
        }
        for (const id of branchIds) if (!chats.has(id)) throw new Error(`缺少分支 ${id}`);
        const references = [...chats.values()].flatMap(refs);
        for (const ref of references) if (!(ref.kind === 'image' && builtinIds.has(ref.id)) && !resourceIds.has(`${ref.kind}:${ref.id}`)) throw new Error(`缺少聊天附件：${ref.id}`);
        for (const resource of resources) if (!references.some(ref => ref.kind === resource.kind && ref.id === resource.id && ref.branchId === resource.branchId)) throw new Error('聊天附件没有对应的消息引用');
        return { version: Number(version), chats, resources };
    }
    async function prepareResources(parsed, ownerId, storage, makeId = () => crypto.randomUUID()) {
        const entries = [], chats = new Map([...parsed.chats].map(([id, branch]) => [id, copy(branch)])), mappings = new Map(), indexes = new Map();
        const scope = branchId => branchId === 'main' ? ownerId : `${ownerId}__branch__${branchId}`;
        const mapKey = (kind, id, branchId) => `${kind}:${id}${kind === 'image' ? '' : ':' + branchId}`;
        const references = [...chats.values()].flatMap(refs);
        for (const resource of parsed.resources) {
            const config = CONFIG[resource.kind], indexKey = `${config.prefix}_index`;
            if (!indexes.has(indexKey)) indexes.set(indexKey, copy(await storage.getStoredValue(indexKey) || []));
            // Image pixels can be shared; voice/document readers authorize the exact branch scope.
            const branchIds = resource.kind === 'image' ? [resource.branchId] : [...new Set(references.filter(ref => ref.kind === resource.kind && ref.id === resource.id).map(ref => ref.branchId))];
            for (const branchId of branchIds) {
                const id = makeId(); if (!validId(id) || [...mappings.values()].includes(id)) throw new Error('附件新标识无效或重复');
                mappings.set(mapKey(resource.kind, resource.id, branchId), id);
                if (indexes.get(indexKey).some(item => item.id === id)) throw new Error('附件新标识与现有资源冲突');
                indexes.get(indexKey).push({ ...copy(resource.metadata), id, ownerId, scopeId: scope(branchId) });
                for (const [part, value] of resource.decoded) entries.push([key(resource.kind, id, part), value instanceof Blob ? value : copy(value)]);
            }
        }
        for (const branch of chats.values()) for (const item of branch.wechatTimeline) {
            const kind = item.type === 'image' ? 'image' : item.type === 'voice' ? 'voice' : null;
            if (kind && item.media?.assetId && mappings.has(mapKey(kind, item.media.assetId, branch.branchId))) item.media.assetId = mappings.get(mapKey(kind, item.media.assetId, branch.branchId));
            if (item.document?.id && mappings.has(mapKey('document', item.document.id, branch.branchId))) item.document.id = mappings.get(mapKey('document', item.document.id, branch.branchId));
        }
        for (const pair of indexes) entries.push(pair);
        return { chats, entries };
    }
    window.RPHubBranchChat = Object.freeze({ collectResources, parse, prepareResources });
})();
