/** Shared world geography. Pure functions; no model, network or storage dependency. */
(function () {
    'use strict';
    const norm = value => String(value || '').trim().toLowerCase().replace(/\s+/g, '');
    const unknown = (status, extra = {}) => ({ status, ...extra });
    const names = place => [place.id, place.name, ...(place.aliases || [])];
    const validate = world => {
        if (!world || world.version !== 1 || !world.id || !Array.isArray(world.places) || !Array.isArray(world.edges)) throw new Error('地图需要 version:1、id、places、edges');
        if (world.places.length > 2000 || world.edges.length > 10000) throw new Error('地图超过试点容量');
        const ids = new Set();
        for (const p of world.places) {
            if (!p.id || !p.name || ids.has(p.id) || !Array.isArray(p.point) || p.point.length !== 2 || !p.point.every(Number.isFinite)) throw new Error('地点 ID/名称/坐标不合法或重复');
            ids.add(p.id);
        }
        const edgeIds = new Set();
        for (const e of world.edges) {
            if (!e.id || edgeIds.has(e.id)) throw new Error('道路ID不能为空或重复');
            edgeIds.add(e.id);
            if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to || !Array.isArray(e.modes) || !e.modes.length || e.modes.some(m => !['walk', 'bike'].includes(m))) throw new Error('道路端点或交通方式不合法');
            if (e.meters !== undefined && (!Number.isFinite(e.meters) || e.meters <= 0)) throw new Error('道路长度必须为正数');
            if (e.points && (!Array.isArray(e.points) || !e.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) throw new Error('道路折线坐标不合法');
        }
        if (world.metersPerUnit !== undefined && (!Number.isFinite(world.metersPerUnit) || world.metersPerUnit <= 0)) throw new Error('地图比例必须为正数');
        if (world.calibration?.uncertainty !== undefined && (!Number.isFinite(world.calibration.uncertainty) || world.calibration.uncertainty < 0 || world.calibration.uncertainty > 1)) throw new Error('地图估算误差应为0至1');
        return world;
    };
    const resolve = (world, query) => {
        const q = norm(query);
        if (!q) return unknown('unknown_place');
        const exact = world.places.filter(p => names(p).some(n => norm(n) === q));
        const hits = exact.length ? exact : world.places.filter(p => p.kind !== 'junction' && names(p).some(n => norm(n).includes(q)));
        if (hits.length !== 1) return unknown(hits.length ? 'ambiguous_place' : 'unknown_place', { query, candidates: hits.slice(0, 8).map(p => ({ id: p.id, name: p.name })) });
        return { status: 'ok', place: hits[0] };
    };
    const edgeUnits = (world, edge) => {
        const a = world.places.find(p => p.id === edge.from).point;
        const b = world.places.find(p => p.id === edge.to).point;
        const points = [a, ...(edge.points || []), b];
        return points.slice(1).reduce((total, p, i) => total + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);
    };
    const path = (world, start, end, mode = 'walk', closed = []) => {
        const blocked = new Set(closed);
        const distance = new Map([[start, 0]]), previous = new Map(), done = new Set();
        while (true) {
            const next = [...distance].filter(([id]) => !done.has(id)).sort((a, b) => a[1] - b[1])[0];
            if (!next) return null;
            const [id, cost] = next;
            if (id === end) break;
            done.add(id);
            for (const edge of world.edges) {
                if (edge.closed || blocked.has(edge.id) || !edge.modes.includes(mode)) continue;
                const target = edge.from === id ? edge.to : (!edge.oneWay && edge.to === id ? edge.from : null);
                if (!target || done.has(target)) continue;
                const length = edge.meters ?? edgeUnits(world, edge) * (world.metersPerUnit || 1);
                const proposal = cost + length;
                if (proposal < (distance.get(target) ?? Infinity)) { distance.set(target, proposal); previous.set(target, { id, edge }); }
            }
        }
        const nodes = [end], edges = [];
        let cursor = end;
        while (cursor !== start) { const prev = previous.get(cursor); edges.unshift(prev.edge); nodes.unshift(prev.id); cursor = prev.id; }
        return { nodes, edges, length: distance.get(end) };
    };
    const route = (world, from, to, options = {}) => {
        const a = resolve(world, from), b = resolve(world, to);
        if (a.status !== 'ok' || b.status !== 'ok') return unknown('needs_location', { from: a.status === 'ok' ? { id: a.place.id, name: a.place.name } : a, to: b.status === 'ok' ? { id: b.place.id, name: b.place.name } : b });
        const mode = options.mode || 'walk';
        if (!['walk', 'bike'].includes(mode)) return unknown('unsupported_mode');
        const found = path(world, a.place.id, b.place.id, mode, options.closedEdges);
        if (!found) return unknown('unreachable', { from: a.place.name, to: b.place.name, mode });
        const measured = found.edges.every(e => e.meters !== undefined && e.provenance === 'measured');
        if (!world.metersPerUnit && found.edges.some(e => e.meters === undefined)) return unknown('uncalibrated', { from: a.place.name, to: b.place.name, via: found.nodes });
        const meters = found.length;
        const rain = options.weather === 'rain';
        const speeds = mode === 'bike' ? [180, 240] : [65, 85];
        const setup = mode === 'bike' && meters > 0 ? [2, 4] : [0, 0];
        const uncertainty = measured ? 0 : Number(world.calibration?.uncertainty ?? 0.15);
        const factor = rain ? 1.2 : 1;
        const pushMeters = mode === 'bike' ? found.edges.filter(e => e.bikeDismount).reduce((sum, e) => sum + (e.meters ?? edgeUnits(world, e) * world.metersPerUnit), 0) : 0;
        const ridingMeters = meters - pushMeters;
        const minutes = [Math.max(0, Math.floor((ridingMeters / speeds[1] + pushMeters / 85) * (1 - uncertainty) * factor + setup[0])), Math.ceil((ridingMeters / speeds[0] + pushMeters / 65) * (1 + uncertainty) * factor + setup[1])];
        const typical = Math.round((ridingMeters / (mode === 'bike' ? 210 : 75) + pushMeters / 75) * factor + (mode === 'bike' && meters ? 3 : 0));
        const result = {
            status: 'ok', worldId: world.id, from: a.place.name, to: b.place.name, mode,
            distance: { estimatedMeters: Math.round(meters / 10) * 10, source: measured ? 'measured_edges' : world.calibration?.autoScale ? 'RP路线时间标定推算；不是实测米数' : '按地图比例/非实测道路估算；不是实测米数' },
            duration: { typicalMinutes: typical, rangeMinutes: minutes, includes: mode === 'bike' ? `低速骑行及找车/停车2—4分钟${pushMeters ? '，隧道/台阶路段下车推行' : ''}；没有保证有车` : '楼外步行；不含楼内上下楼和排队' },
            confidence: measured ? 'measured' : 'estimated', calibration: world.calibration?.source || '未提供来源',
            via: found.nodes.map(id => world.places.find(p => p.id === id).name),
            warnings: [...new Set(found.edges.map(e => e.note).filter(Boolean))]
        };
        if (rain) result.warnings.push('雨天按1.2倍时间估算，湿滑/人流情况未实测');
        if (options.time) {
            const match = /^(\d{2}):(\d{2})$/.exec(options.time);
            if (!match || +match[1] > 23 || +match[2] > 59) return unknown('invalid_time');
            const departure = +match[1] * 60 + +match[2];
            result.arrival = minutes.map(m => { const n = departure + m; return { dayOffset: Math.floor(n / 1440), time: `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}` }; });
            const close = b.place.access?.close;
            if (close && close !== '24:00') {
                const deadline = close.split(':').map(Number).reduce((h, m) => h * 60 + m);
                if (departure + minutes[1] >= deadline) result.warnings.push(`最晚估计到达已触及或超过${b.place.name} ${close}的限制；需核对开放/门禁，不能保证可进入`);
            }
        }
        if (mode === 'bike') result.warnings.push('共享单车可用性未知；道路骑行权限按试点假设，需校准');
        return result;
    };
    const placeInfo = (world, query) => {
        const hit = resolve(world, query);
        if (hit.status !== 'ok') return hit;
        const p = hit.place;
        return { status: 'ok', worldId: world.id, id: p.id, name: p.name, function: p.function || '', access: p.access || {},
            scene: String(p.scene || '').slice(0, 1200), district: String(world.districts?.[p.district]?.scene || '').slice(0, 1500),
            culture: (world.culture || []).slice(0, 6), provenance: '建筑位置来自示意图；功能、文化与开放规则来自RP设定，不是现实校园调查' };
    };
    const textLimit = (value, max) => String(value || '').slice(0, max);
    const briefPlace = result => result.status !== 'ok' ? result : ({
        status: 'ok', id: result.id, name: result.name, function: textLimit(result.function, 120), access: result.access,
        ...(result.scene ? { scene: textLimit(result.scene, 180) } : {})
    });
    const briefRoute = result => result.status !== 'ok' ? result : ({
        status: 'ok', from: result.from, to: result.to, mode: result.mode, duration: result.duration,
        estimatedMeters: result.distance.estimatedMeters, confidence: result.confidence,
        ...(result.arrival ? { arrival: result.arrival } : {}), warnings: result.warnings.slice(0, 4).map(n => textLimit(n, 160))
    });
    const briefState = state => Object.fromEntries(['user', 'character'].map(key => {
        const s = state[key] || { status: 'unknown' };
        return [key, { status: s.status, ...(s.placeId ? { placeId: s.placeId, name: s.name } : {}),
            ...(s.messageId ? { source: { messageId: s.messageId, channel: s.channel } } : {}), ...(s.candidates?.length ? { candidates: s.candidates.slice(0, 5) } : {}) }];
    }));
    const endpoint = (state, value) => ['user', 'character'].includes(value) ? state[value]?.placeId || '' : value;
    const contextInfo = (world, state, args = {}) => {
        const from = endpoint(state, args.from || 'character'), to = endpoint(state, args.to || args.query || 'user');
        const detail = args.detail === 'full';
        const routes = {};
        for (const mode of args.mode && args.mode !== 'compare' ? [args.mode] : ['walk', 'bike']) {
            const value = route(world, from, to, { ...args, mode });
            routes[mode] = detail ? value : briefRoute(value);
        }
        const a = placeInfo(world, from), b = placeInfo(world, to);
        return { status: a.status === 'ok' && b.status === 'ok' ? 'ok' : 'needs_location', worldId: world.id,
            locations: briefState(state), places: { from: detail ? a : briefPlace(a), to: detail ? b : briefPlace(b) }, routes,
            culture: (world.culture || []).slice(0, 2).map(n => textLimit(n, 120)),
            note: '路线是行动成本，估算不是实测；只使用明确位置证据，计划不算到达。' };
    };
    // Render JSON without cutting its syntax or discarding duration, arrival, access and warnings.
    const boundResult = (result, detail = 'brief') => {
        const copy = JSON.parse(JSON.stringify(result));
        const limit = detail === 'full' ? 12000 : 6000;
        if (JSON.stringify(copy).length <= limit) return copy;
        const trim = value => {
            if (!value || typeof value !== 'object') return;
            for (const key of ['district', 'scene', 'characterContext', 'culture', 'provenance', 'calibration', 'via']) delete value[key];
            Object.values(value).forEach(v => Array.isArray(v) ? v.forEach(trim) : trim(v));
        };
        trim(copy); copy.omittedDetails = '结果超过预算，省略场景长文；路线时间、开放限制及错误状态保留。';
        if (JSON.stringify(copy).length > limit) return { status: 'result_too_large', note: '结果仍超过资料预算，请缩小查询范围。' };
        return copy;
    };
    const mention = (world, text) => {
        const source = norm(text);
        const hits = world.places.flatMap(p => p.kind === 'junction' ? [] : names(p).filter(n => norm(n).length >= 2 && source.includes(norm(n))).map(n => ({ name: n, length: norm(n).length })));
        return hits.sort((a, b) => b.length - a.length)[0]?.name || '';
    };
    // Conservative evidence replay. Commands are accepted only in HUMAN messages.
    // No memory summaries, attachments, tools, CoT, quotations or future plans are location evidence.
    const project = (world, messages, bindings = {}) => {
        const state = { user: { status: 'unknown' }, character: { status: 'unknown' } };
        for (const [index, msg] of messages.entries()) {
            if (!['user', 'assistant'].includes(msg.role) || (msg.type && msg.type !== 'text')) continue;
            let text = String(msg.content || '').replace(/<(think|thinking|cot)\b[^>]*>[\s\S]*?<\/\1>/gi, '').trim();
            // WeChat RP replay stores narrative JSON; extract only text bubbles, not image captions.
            if (text.startsWith('{')) { try { const data = JSON.parse(text); text = (data.messages || []).filter(p => p.type === 'text').map(p => p.content).join('\n'); } catch (_) { continue; } }
            const source = { messageId: msg.id || String(index), channel: msg.channel || 'rp', evidence: '' };
            const command = msg.role === 'user' && /^\/geo\s+(user|character)\s+([^\n]+)$/i.exec(text);
            const speaker = command ? command[1].toLowerCase() : msg.role === 'user' ? 'user' : 'character';
            let location = command ? command[2].trim() : '';
            if (!command) {
                const sentences = text.match(/[^。！？!?\n]+[。！？!?]?/g) || [];
                for (const raw of sentences) {
                    let sentence = raw.trim();
                    if (/^[>“"「『]/.test(sentence)) continue;
                    if (/[？?]$/.test(sentence)) {
                        const compound = /^([^，,]+)[，,]\s*(?:你|能|可以|要不要)/.exec(sentence);
                        if (!compound) continue;
                        sentence = compound[1];
                    }
                    sentence = sentence.replace(/[。！!]$/, '');
                    if (msg.role === 'assistant' && bindings.character?.name) sentence = sentence.replace(new RegExp('^' + bindings.character.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '我');
                    if (/^(?:第二天|次日|翌日|(?:几|半|一|两|三|四|五|六|七|八|九|十|\d+)个?小时后|(?:几|一|两|三|\d+)天后)/.test(sentence)) {
                        state.user = { status: 'unknown', ...source, evidence: '剧情时间跳跃，需重新确认' };
                        state.character = { status: 'unknown', ...source, evidence: '剧情时间跳跃，需重新确认' };
                        continue;
                    }
                    if (/^我不在/.test(sentence)) { state[speaker] = { status: 'unknown', ...source, evidence: sentence.slice(0, 80) }; continue; }
                    if (/^我在(?:去|前往).*(?:路上|途中)/.test(sentence)) { state[speaker] = { status: 'in_transit', ...source, evidence: sentence.slice(0, 80) }; continue; }
                    if (/^(?:我)?(?:已经)?(?:出发了|离开了|在路上|走出)/.test(sentence)) { state[speaker] = { status: 'in_transit', ...source, evidence: sentence.slice(0, 80) }; continue; }
                    const hit = /^(?:我现在在|我目前在|我还在|我在|我已经到了|我走到了|我来到|我到了|我到)([^，,；;]+)/.exec(sentence);
                    if (!hit) continue;
                    if (/^我到[^，,；;]*(?:就|再|以后|之后)/.test(sentence)) continue;
                    location = hit[1].replace(/(?:等你|等着|呢|啦|了|啊|哦|呀|这边|这里).*$/, '').trim();
                    source.evidence = sentence.slice(0, 80);
                    // Resolve at most one statement; never use substring containment to guess a building.
                    if (location === '宿舍' || location === '寝室') location = bindings[speaker]?.home || '';
                    const result = resolve(world, location);
                    state[speaker] = result.status === 'ok' ? { status: 'last_confirmed', placeId: result.place.id, name: result.place.name, ...source } : { status: result.status, ...source, candidates: result.candidates || [] };
                }
                continue;
            }
            source.evidence = text.slice(0, 80);
            if (['unknown', '未知'].includes(location)) { state[speaker] = { status: 'unknown', ...source }; continue; }
            const hit = resolve(world, location);
            state[speaker] = hit.status === 'ok' ? { status: 'last_confirmed', placeId: hit.place.id, name: hit.place.name, ...source } : { status: hit.status, ...source, candidates: hit.candidates || [] };
        }
        return state;
    };
    const properties = {
        operation: { type: 'string', enum: ['context', 'search', 'place', 'route', 'status'], description: '优先context一次查地点用途/环境、双方位置、步行与骑车耗时；其他操作仅用于补充细节' },
        query: { type: 'string', description: '例如风采园；context中作为目的地，省略使用user最近位置' },
        from: { type: 'string', description: '地点名/ID或user、character；context默认character' }, to: { type: 'string' },
        mode: { type: 'string', enum: ['walk', 'bike', 'compare'], description: 'context默认同时比较walk和bike' },
        weather: { type: 'string', enum: ['normal', 'rain'] }, time: { type: 'string', description: '剧情出发时间HH:MM，不能用系统时间' },
        detail: { type: 'string', enum: ['brief', 'full'], description: '默认brief只取行动需要的短结果；要丰富场景描写才选full' }
    };
    const definition = { type: 'function', function: { name: 'tool_geo', description: '地理问题优先context一查取齐地点功能/环境、位置证据、两种交通路程；已提供本轮地理速查时不重复查。同次需要多地点用batch。只读，不改变位置，未知会澄清。', parameters: { type: 'object', properties: {
        ...properties, operation: { ...properties.operation, enum: [...properties.operation.enum, 'batch'] },
        requests: { type: 'array', minItems: 1, maxItems: 4, description: 'batch最多4个独立查询，一次返回；不许嵌套batch', items: { type: 'object', properties, required: ['operation'], additionalProperties: false } }
    }, required: ['operation'], additionalProperties: false } } };
    const validateArgs = (args, allowBatch = true) => {
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !Object.keys(allowBatch ? definition.function.parameters.properties : properties).includes(k))) throw new Error('地理工具参数不合法');
        for (const [key, value] of Object.entries(args)) {
            const rule = definition.function.parameters.properties[key];
            if (key === 'requests') {
                if (!allowBatch || args.operation !== 'batch' || !Array.isArray(value) || value.length < 1 || value.length > 4) throw new Error('batch需要1—4个独立查询');
                value.forEach(item => validateArgs(item, false)); continue;
            }
            if (typeof value !== 'string' || value.length > 200 || (rule.enum && !rule.enum.includes(value))) throw new Error('地理工具字段类型/取值不合法');
        }
        if (!args.operation || (!allowBatch && args.operation === 'batch') || (args.operation === 'batch' && !args.requests)) throw new Error('需要合法operation；batch不可嵌套且必须有requests');
        if (args.operation === 'route' && args.mode === 'compare') throw new Error('比较两种交通请用context');
    };
    const execute = (world, state, args) => {
        validateArgs(args);
        if (args.operation === 'batch') return boundResult({ status: 'ok', worldId: world.id, results: args.requests.map((item, index) => ({ index, result: execute(world, state, item) })) }, args.detail);
        if (args.operation === 'context') return boundResult(contextInfo(world, state, args), args.detail);
        if (args.operation === 'status') return { status: 'ok', worldId: world.id, locations: args.detail === 'full' ? state : briefState(state), note: '最近确认位置不是GPS；工具知道不等于人物获知。' };
        if (args.operation === 'place') {
            const result = placeInfo(world, args.query);
            if (args.detail === 'full' && result.status === 'ok') result.coordinates = { system: world.coordinateSystem || 'world_coordinates', point: resolve(world, args.query).place.point };
            return args.detail === 'full' ? result : briefPlace(result);
        }
        if (args.operation === 'search') return { status: 'ok', results: world.places.filter(p => p.kind !== 'junction' && names(p).some(n => norm(n).includes(norm(args.query)))).slice(0, 8).map(p => ({ id: p.id, name: p.name, function: p.function })) };
        if (args.operation === 'route') {
            const result = route(world, endpoint(state, args.from), endpoint(state, args.to), args);
            return args.detail === 'full' ? result : briefRoute(result);
        }
        throw new Error('需要 operation: search/place/route/status');
    };
    window.RPHubGeography = { validate, resolve, path, edgeUnits, route, placeInfo, briefPlace, briefRoute, briefState, contextInfo, boundResult, mention, project, definition, execute };
})();
