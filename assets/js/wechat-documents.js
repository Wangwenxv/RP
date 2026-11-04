/** Text attachments live outside conversation state. No full-file strings or embeddings. */
(function () {
    const INDEX = 'wechat_document_index';
    const MAX_BYTES = 20 * 1024 * 1024;
    const CHUNK_CHARS = 2400;
    const short = (text, size = 100) => String(text || '').replace(/[\r\n\t\x00-\x1f]/g, ' ').slice(0, size);
    const active = signal => { if (signal?.aborted) throw new DOMException('文档处理已取消', 'AbortError'); };
    const key = (id, kind, index = '') => `wechat_document_${kind}_${id}${index === '' ? '' : '_' + index}`;
    const recordText = item => `[文件 #${short(item.id)}｜${short(item.document?.name)}｜${Number(item.document?.chars) || 0} 字符，${Number(item.document?.chunkCount) || 0} 块；附件可检索，收到不代表已读]`;
    const heading = line => /^(?:#{1,6}\s+.{1,100}|第[零〇一二三四五六七八九十百千万两\d]+[章回节卷部篇].{0,80}|(?:chapter|part)\s+[\divxlc]+\b.{0,80})$/i.test(line.trim());

    async function detectEncoding(file) {
        const bytes = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
        if (bytes[0] === 255 && bytes[1] === 254) return 'utf-16le';
        if (bytes[0] === 254 && bytes[1] === 255) return 'utf-16be';
        try { new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: file.size > bytes.length }); return 'utf-8'; }
        catch (_) { return 'gb18030'; }
    }

    function createLibrary(storage) {
        // Serialize writes to keep the global lightweight index consistent.
        let writes = Promise.resolve();
        const serial = fn => { const pending = writes.then(fn); writes = pending.catch(() => {}); return pending; };
        const list = async () => { const items = await storage.getStoredValue(INDEX); return Array.isArray(items) ? items : []; };
        const get = async id => (await list()).find(item => item.id === id) || null;
        const removeFiles = async item => {
            await storage.deleteStoredValue(key(item.id, 'blob'));
            await storage.deleteStoredValue(key(item.id, 'toc'));
            await storage.deleteStoredValue(key(item.id, 'reader'));
            for (let i = 0; i < item.chunkCount; i++) {
                await storage.deleteStoredValue(key(item.id, 'chunk', i));
            }
        };
        const remove = id => serial(async () => {
            const items = await list(), item = items.find(doc => doc.id === id);
            if (!item) return;
            await removeFiles(item);
            await storage.setStoredValue(INDEX, items.filter(doc => doc.id !== id));
        });
        const save = (file, info, signal, onProgress = () => {}) => serial(async () => {
            if (!/\.(txt|md|markdown|log|csv|tsv)$/i.test(file.name || '')) throw new Error('第一版支持 TXT、Markdown、LOG、CSV、TSV 纯文本文件');
            if (!file.size || file.size > MAX_BYTES) throw new Error('文件不能为空，且不能超过 20 MiB');
            active(signal);
            const items = await list();
            if (items.filter(item => item.ownerId === info.ownerId).length >= 50) throw new Error('每个角色最多保存 50 个文件，请先移除不需要的附件');
            if (items.filter(item => item.ownerId === info.ownerId).reduce((n, item) => n + item.bytes, file.size) > 100 * 1024 * 1024) throw new Error('该角色的文档已达到 100 MiB，请先移除不需要的文件');
            const id = `doc-${crypto.randomUUID()}`;
            const encoding = await detectEncoding(file);
            const decoder = new TextDecoder(encoding, { fatal: true });
            const item = { id, name: short(file.name, 160), bytes: file.size, ownerId: info.ownerId, scopeId: info.scopeId, encoding, chars: 0, chunkCount: 0, createdAt: Date.now() };
            let pending = '', offset = 0, currentHeading = '', lineTail = '', lineStart = 0, tocTruncated = false;
            const toc = [];
            const emit = async text => {
                active(signal);
                if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('文件含二进制控制字符，请转换为纯文本');
                const chunkIndex = item.chunkCount;
                // Heading scanner also handles lines split across chunks, without retaining long lines.
                const lines = (lineTail + text).split('\n');
                let pos = lineStart;
                lineTail = lines.pop();
                for (const line of lines) {
                    if (heading(line)) {
                        currentHeading = short(line.trim(), 100);
                        if (toc.length < 2000) toc.push({ title: currentHeading, start: pos < offset ? Math.max(0, chunkIndex - 1) : chunkIndex }); else tocTruncated = true;
                    }
                    pos += line.length + 1;
                }
                lineStart = pos;
                if (lineTail.length > 200) { lineStart += lineTail.length; lineTail = ''; }
                item.chunkCount++; // Include an interrupted put in rollback cleanup.
                await storage.setStoredValue(key(id, 'chunk', chunkIndex), { index: chunkIndex, offset, heading: currentHeading, text });
                offset += text.length; item.chars = offset;
                onProgress({ chars: offset, chunkCount: item.chunkCount });
            };
            try {
                // Slice decoding bounds memory even for very large files and old browser Blob APIs.
                for (let start = 0; start < file.size; start += 65536) {
                    active(signal);
                    pending += decoder.decode(await file.slice(start, start + 65536).arrayBuffer(), { stream: true });
                    while (pending.length >= CHUNK_CHARS) {
                        let end = CHUNK_CHARS;
                        // Keep surrogate pairs intact; offsets remain explicit for exact source lookup.
                        if (/[\uD800-\uDBFF]/.test(pending[end - 1])) end--;
                        await emit(pending.slice(0, end)); pending = pending.slice(end);
                    }
                }
                pending += decoder.decode();
                if (pending) await emit(pending);
                if (!item.chars) throw new Error('文件没有可读取的正文');
                if (heading(lineTail) && toc.length < 2000) toc.push({ title: short(lineTail.trim()), start: item.chunkCount - 1 });
                active(signal);
                await storage.setStoredValue(key(id, 'toc'), { entries: toc, truncated: tocTruncated });
                await storage.setStoredValue(key(id, 'blob'), file.slice(0, file.size, file.type), { clone: false });
                active(signal);
                await storage.setStoredValue(INDEX, [...items, item]);
                return item;
            } catch (error) { await removeFiles(item).catch(() => {}); throw error; }
        });
        const chunk = async (id, index, signal) => {
            active(signal);
            const value = await storage.getStoredValue(key(id, 'chunk', index)); active(signal);
            if (!value || typeof value.text !== 'string') throw new Error('文档分块已丢失，请重新上传');
            return value;
        };
        const read = async (item, start, count = 2, signal) => {
            if (!Number.isInteger(start) || start < 0 || start >= item.chunkCount) throw new Error('分块位置超出文档范围');
            const result = [];
            for (let i = start; i < Math.min(item.chunkCount, start + Math.min(2, count)); i++) result.push(await chunk(item.id, i, signal));
            return { chunks: result, next: start + result.length < item.chunkCount ? start + result.length : null };
        };
        // Locate a chunk by absolute character offset; search results hand back exact offsets.
        const locate = async (item, offset, signal) => {
            const target = Math.max(0, Math.min(Math.max(0, item.chars - 1), Math.floor(Number(offset) || 0)));
            let guess = Math.max(0, Math.min(item.chunkCount - 1, Math.floor(target / CHUNK_CHARS)));
            for (let step = 0; step < 4; step++) {
                const part = await chunk(item.id, guess, signal);
                if (target < part.offset) { if (!guess) return 0; guess--; continue; }
                if (target >= part.offset + part.text.length) { if (guess >= item.chunkCount - 1) return guess; guess++; continue; }
                return guess;
            }
            return guess;
        };
        const search = async (item, query, options = {}) => {
            const engine = window.RPHubWeChatSearch;
            if (!engine) throw new Error('检索模块未加载，请刷新页面');
            return engine.scan({
                query, chars: item.chars, chunkCount: item.chunkCount,
                start: options.start, end: options.end, limit: options.limit, signal: options.signal,
                getText: index => chunk(item.id, index, options.signal)
            });
        };
        const toc = async id => await storage.getStoredValue(key(id, 'toc')) || { entries: [], truncated: false };
        const reader = async id => await storage.getStoredValue(key(id, 'reader')) || { next: 0, summary: '', batches: 0 };
        const saveReader = (id, value) => storage.setStoredValue(key(id, 'reader'), value);
        const blob = async id => {
            const value = await storage.getStoredValue(key(id, 'blob'));
            if (!(value instanceof Blob)) throw new Error('原文件已丢失');
            return value;
        };
        const purgeOwner = async ownerId => { for (const item of (await list()).filter(item => item.ownerId === ownerId)) await remove(item.id); };
        const purgeScope = async scopeId => { for (const item of (await list()).filter(item => item.scopeId === scopeId)) await remove(item.id); };
        return { list, get, save, remove, chunk, read, search, locate, toc, reader, saveReader, blob, purgeOwner, purgeScope };
    }
    window.RPHubWeChatDocuments = Object.freeze({ MAX_BYTES, CHUNK_CHARS, short, active, recordText, createLibrary });
})();
