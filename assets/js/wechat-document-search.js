/** Grep-style query engine for text attachments. No storage, DOM or Vue dependency. */
(function () {
    const LIMITS = Object.freeze({ query: 300, terms: 8, pattern: 160, occurrences: 20000, perChunk: 40, excerpt: 900, budget: 4000 });
    const MERGE_GAP = 220, BEFORE = 160, AFTER = 240;
    const SPACE = /[\s,，、;；|｜]/;
    const QUOTES = { '"': '"', '“': '”', '「': '」' };
    const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    const cancelled = () => new DOMException('文档处理已取消', 'AbortError');

    /**
     * Supported syntax, all optional and space separated:
     * - `词` any of the words may match; `+词` every required word must appear; `-词` rejects that window
     * - `"短语"` must appear as a whole phrase
     * - `A ~30 B` requires A and B to be within 30 characters
     * - `/正则/i` JavaScript regex; flags g/i/m/s/u/y allowed, g is always added
     * - `case:on` / `case:off` toggles case sensitivity of literal words
     * Chinese punctuation also separates words, so models that type `钥匙，地下室` still work.
     */
    function parseQuery(raw) {
        const source = String(raw == null ? '' : raw).trim();
        if (!source) throw new Error('请提供搜索表达式');
        if (source.length > LIMITS.query) throw new Error(`搜索表达式不能超过 ${LIMITS.query} 字符`);
        const terms = [], links = [];
        let caseSensitive = false, i = 0, gap = 0, previous = -1;
        const push = (text, options = {}) => {
            if (!text) throw new Error('搜索词不能为空');
            if (terms.length >= LIMITS.terms) throw new Error(`一次最多 ${LIMITS.terms} 个搜索词，请拆成多次搜索`);
            if (options.regex && text.length > LIMITS.pattern) throw new Error(`正则表达式不能超过 ${LIMITS.pattern} 字符`);
            const term = { text, phrase: !!options.phrase, required: !!options.required, excluded: !!options.excluded, regex: null, lower: text.toLowerCase() };
            if (options.regex) {
                try { term.regex = new RegExp(text, String(options.flags || '').replace(/[gy]/g, '') + 'g'); }
                catch (_) { throw new Error(`正则表达式无效：${text}`); }
            }
            terms.push(term);
            const index = terms.length - 1;
            if (options.gap && previous >= 0) links.push({ left: previous, right: index, distance: Math.max(1, Math.min(2000, options.gap)) });
            previous = index;
            return index;
        };
        while (i < source.length) {
            const char = source[i];
            if (SPACE.test(char)) { i++; continue; }
            if (char === '~') {
                const match = /^~(\d{1,4})/.exec(source.slice(i));
                if (!match) throw new Error('"~" 后面要写距离数字，例如：钥匙 ~30 地下室');
                if (!terms.length) throw new Error('"~" 前面要先有一个搜索词');
                gap = Number(match[1]); i += match[0].length; continue;
            }
            let required = false, excluded = false;
            if (char === '+' || char === '-') { if (char === '+') required = true; else excluded = true; i++; }
            if (i >= source.length || SPACE.test(source[i])) throw new Error(`"${char}" 后面缺少搜索词`);
            if (source[i] === '/') {
                let end = i + 1, body = '', closed = false;
                while (end < source.length) {
                    if (source[end] === '\\') { body += source[end] + (source[end + 1] || ''); end += 2; continue; }
                    if (source[end] === '/') { closed = true; break; }
                    body += source[end]; end++;
                }
                if (!closed) throw new Error('正则表达式缺少结束的 /');
                const flags = /^[a-z]*/.exec(source.slice(end + 1))[0];
                if (!/^[gimsuy]*$/.test(flags)) throw new Error(`不支持的正则标记：${flags}`);
                i = end + 1 + flags.length;
                push(body, { regex: true, flags, required, excluded, gap }); gap = 0; continue;
            }
            const quoted = Object.prototype.hasOwnProperty.call(QUOTES, source[i]);
            let text;
            if (quoted) {
                const end = source.indexOf(QUOTES[source[i]], i + 1);
                if (end < 0) throw new Error('引号没有闭合');
                text = source.slice(i + 1, end); i = end + 1;
            } else {
                let end = i;
                while (end < source.length && !SPACE.test(source[end]) && source[end] !== '/') end++;
                text = source.slice(i, end); i = end;
            }
            if (!quoted && /^case:(on|off)$/i.test(text)) { caseSensitive = /on$/i.test(text); continue; }
            push(text.trim(), { phrase: quoted, required, excluded, gap }); gap = 0;
        }
        if (!terms.some(term => !term.excluded)) throw new Error('请至少提供一个要搜索的关键词或 /正则/');
        return { source, terms, links, caseSensitive };
    }

    // Overlapping matches are not reported twice; a chunk cap bounds pathological patterns.
    function matchesIn(text, lower, faithful, term, caseSensitive) {
        const found = [];
        if (term.regex) {
            term.regex.lastIndex = 0;
            let match;
            while (found.length < LIMITS.perChunk && (match = term.regex.exec(text))) {
                if (!match[0].length) { term.regex.lastIndex += 1; continue; }
                found.push([match.index, match[0].length]);
            }
            return found;
        }
        const needle = caseSensitive ? term.text : term.lower;
        const hay = caseSensitive || !faithful ? text : lower;
        let at = hay.indexOf(needle);
        while (at >= 0 && found.length < LIMITS.perChunk) { found.push([at, needle.length]); at = hay.indexOf(needle, at + Math.max(1, needle.length)); }
        return found;
    }

    async function scan(options) {
        const spec = parseQuery(options && options.query);
        const chunkCount = Math.max(0, Number(options.chunkCount) || 0);
        if (!chunkCount) throw new Error('文档没有可搜索的正文');
        const getText = options.getText, signal = options.signal;
        const chars = Number(options.chars) || 0;
        const limit = Math.max(1, Math.min(8, Number(options.limit) || 5));
        const first = Math.max(0, Math.min(chunkCount - 1, Number.isInteger(options.start) ? options.start : 0));
        const last = Math.max(first, Math.min(chunkCount - 1, Number.isInteger(options.end) ? options.end : chunkCount - 1));
        const positive = spec.terms.map((term, index) => ({ term, index })).filter(item => !item.term.excluded);
        const required = positive.filter(item => item.term.required || item.term.phrase).map(item => item.index);
        const deadline = nowMs() + LIMITS.budget;
        const occurrences = [], starts = [], lastAbs = new Map();
        const df = new Int32Array(spec.terms.length);
        let scanned = 0, truncated = false, tail = '';

        for (let index = first; index <= last; index++) {
            if (signal && signal.aborted) throw cancelled();
            const part = await getText(index);
            if (!part || typeof part.text !== 'string') throw new Error('文档分块已丢失，请重新上传');
            scanned++;
            const prefix = index > first ? tail : '';
            const text = prefix + part.text, base = part.offset - prefix.length;
            const lower = text.toLowerCase(), faithful = lower.length === text.length;
            starts.push({ index, offset: part.offset, length: part.text.length, heading: part.heading || '' });
            for (const item of positive) {
                const found = matchesIn(text, lower, faithful, item.term, spec.caseSensitive);
                if (!found.length) continue;
                let own = false;
                for (const pair of found) {
                    const abs = base + pair[0];
                    // The 80 character overlap re-reports the previous chunk's tail once.
                    if (lastAbs.get(item.index) === abs) continue;
                    lastAbs.set(item.index, abs);
                    if (abs >= part.offset) own = true;
                    occurrences.push({ ti: item.index, abs, len: pair[1] });
                    if (occurrences.length >= LIMITS.occurrences) { truncated = true; break; }
                }
                if (own) df[item.index]++;
                if (occurrences.length >= LIMITS.occurrences) break;
            }
            if (occurrences.length >= LIMITS.occurrences) break;
            tail = part.text.slice(-80);
            if (nowMs() > deadline) { truncated = true; break; }
        }

        // idf is only known after the scan, so scoring happens once on the compact occurrence list.
        const weight = ti => Math.max(0.35, Math.log(1 + Math.max(1, scanned) / Math.max(1, df[ti])));
        const counts = spec.terms.map((term, ti) => ({ text: term.text, regex: !!term.regex, count: 0, chunks: df[ti], excluded: term.excluded }));
        occurrences.sort((a, b) => a.abs - b.abs || a.ti - b.ti);
        for (const item of occurrences) counts[item.ti].count++;

        const clusters = [];
        for (const item of occurrences) {
            const current = clusters[clusters.length - 1];
            if (current && item.abs - current.end <= MERGE_GAP && item.abs + item.len - current.start <= LIMITS.excerpt) {
                current.end = Math.max(current.end, item.abs + item.len);
                current.items.push(item);
            } else clusters.push({ start: item.abs, end: item.abs + item.len, items: [item] });
        }
        const scored = clusters.map(cluster => {
            const per = new Map();
            for (const item of cluster.items) {
                const entry = per.get(item.ti) || { tf: 0, first: item.abs, last: item.abs + item.len };
                entry.tf++; entry.first = Math.min(entry.first, item.abs); entry.last = Math.max(entry.last, item.abs + item.len);
                per.set(item.ti, entry);
            }
            let score = 0;
            for (const [ti, entry] of per) {
                score += weight(ti) * (1 + 0.35 * Math.log2(1 + entry.tf));
                if (spec.terms[ti].required || spec.terms[ti].phrase) score += 0.4;
            }
            if (per.size > 1) score += 0.3 * (per.size - 1);
            for (const link of spec.links) {
                const left = per.get(link.left), right = per.get(link.right);
                if (left && right && right.first - left.last <= link.distance) score += 1.4;
            }
            const complete = required.length > 0 && required.every(ti => per.has(ti));
            return { cluster, per, score: complete ? score + 1.2 : score, complete };
        });
        // `+词` prefers windows holding every required word; a scattered document falls back to ranking.
        const strict = required.length && scored.some(item => item.complete);
        const pool = (strict ? scored.filter(item => item.complete) : scored)
            .sort((a, b) => b.score - a.score || a.cluster.start - b.cluster.start);

        const locate = offset => {
            let low = 0, high = starts.length - 1, best = 0;
            while (low <= high) { const mid = (low + high) >> 1; if (starts[mid].offset <= offset) { best = mid; low = mid + 1; } else high = mid - 1; }
            return best;
        };
        const textOf = async (from, to) => {
            let out = '', cursor = locate(from);
            for (let i = cursor; i < starts.length && from + out.length < to; i++) {
                const part = await getText(starts[i].index);
                if (signal && signal.aborted) throw cancelled();
                const begin = Math.max(0, from - part.offset), end = Math.min(part.text.length, to - part.offset);
                if (end > begin) out += part.text.slice(begin, end);
            }
            return out;
        };

        const hits = [], scannedEnd = starts.length ? starts[starts.length - 1].offset + starts[starts.length - 1].length : 0;
        for (const item of pool.slice(0, Math.min(24, limit * 4))) {
            if (signal && signal.aborted) throw cancelled();
            const start = Math.max(starts[0].offset, item.cluster.start - BEFORE);
            const end = Math.min(chars || Infinity, scannedEnd, start + LIMITS.excerpt, Math.max(item.cluster.end + AFTER, start + 1));
            const excerpt = await textOf(start, end);
            if (!excerpt) continue;
            const rejected = spec.terms.some(term => term.excluded && (term.regex
                ? new RegExp(term.regex.source, term.regex.flags.replace('g', '')).test(excerpt)
                : excerpt.toLowerCase().includes(term.lower)));
            if (rejected) continue;
            const at = starts[locate(item.cluster.start)];
            hits.push({
                chunk: at.index, offset: start, end, heading: at.heading, score: Math.round(item.score * 100) / 100,
                terms: [...item.per.keys()].map(ti => ({ text: spec.terms[ti].text, count: item.per.get(ti).tf })),
                count: item.cluster.items.length, excerpt
            });
            if (hits.length >= limit) break;
        }
        const complete = !truncated && first === 0 && last === chunkCount - 1;
        return {
            source: spec.source, hits, matched: clusters.length, scanned, total: chunkCount,
            start: first, end: last, truncated, complete,
            // `relaxed`: required words exist somewhere but no single window holds them all.
            relaxed: required.length > 0 && scored.length > 0 && !strict,
            absent: complete ? counts.filter(item => !item.excluded && !item.count).map(item => item.text) : [],
            counts
        };
    }

    window.RPHubWeChatSearch = Object.freeze({ LIMITS, parseQuery, scan });
})();
