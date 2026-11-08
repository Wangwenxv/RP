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
        const strings = (value, count, length) => Array.isArray(value) && value.length <= count && value.every(s => typeof s === 'string' && s.trim() && s.length <= length);
        for (const p of world.places) {
            if (p.keywords !== undefined && !strings(p.keywords, 32, 40)) throw new Error('地点关键词需要最多32个、不超过40字符的短词');
            if (p.services !== undefined && !strings(p.services, 24, 40)) throw new Error('地点服务需要最多24个短名称');
            if (p.usage !== undefined && (typeof p.usage !== 'string' || p.usage.length > 180)) throw new Error('地点使用惯例应为不超过180字符的文本');
        }
        if (world.everyday !== undefined) {
            const e = world.everyday;
            if (!e || typeof e !== 'object' || Array.isArray(e) || !strings(e.knowledge, 4, 160) || !Array.isArray(e.needs) || e.needs.length > 8) throw new Error('生活常识需要knowledge短文本数组与needs需求数组');
            const needIds = new Set();
            for (const n of e.needs) {
                if (!n || typeof n.id !== 'string' || !n.id.trim() || n.id.length > 100 || needIds.has(n.id) || typeof n.label !== 'string' || !n.label.trim() || n.label.length > 80
                    || !strings(n.terms, 24, 40) || !n.terms.length || !strings(n.places, 4, 100) || !n.places.length || n.places.some(id => !ids.has(id))) throw new Error('生活需求需要唯一ID、短标签、触发词与有效候选地点');
                needIds.add(n.id);
            }
        }
        return world;
    };
    const resolve = (world, query) => {
        const q = norm(query);
        if (!q) return unknown('unknown_place');
        const exact = world.places.filter(p => names(p).some(n => norm(n) === q));
        // An exact known building + a room number identifies the building only.
        // Do not infer the room's use, or match an arbitrary substring as a building.
        const room = !exact.length && /^(.*?)[-—]?(\d{3,4})(?:室|教室|寝室|房间)?$/.exec(q);
        if (room && room[1]) {
            const parents = world.places.filter(p => p.kind !== 'junction' && names(p).some(n => norm(n) === room[1]));
            if (parents.length === 1) return { status: 'ok', place: parents[0], subLocation: { room: room[2], note: '房号来自发言；只定位所属地点，房间用途与室内路径未建模' } };
            if (parents.length > 1) return unknown('ambiguous_place', { query, candidates: parents.slice(0, 8).map(p => ({ id: p.id, name: p.name })) });
        }
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
            duration: { typicalMinutes: typical, rangeMinutes: minutes, includes: mode === 'bike' ? `低速骑行及找车/停车2—4分钟${pushMeters ? '，需下车推行的路段按步行计算' : ''}；没有保证有车` : '楼外步行；不含楼内上下楼和排队' },
            confidence: measured ? 'measured' : 'estimated', calibration: world.calibration?.source || '未提供来源',
            via: found.nodes.map(id => world.places.find(p => p.id === id).name),
            warnings: [...new Set(found.edges.map(e => e.note).filter(Boolean))]
        };
        if (a.subLocation || b.subLocation) result.warnings.push('房号仅归属到建筑；该路程不包含楼内上下楼和房间间通行');
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
        return { status: 'ok', worldId: world.id, id: p.id, name: p.name, zone: world.districts?.[p.district]?.label || p.district || '',
            function: p.function || '', access: p.access || {}, ...(hit.subLocation ? { subLocation: hit.subLocation } : {}),
            ...(p.keywords?.length ? { keywords: p.keywords } : {}),
            ...(p.services?.length ? { services: p.services } : {}), ...(p.usage ? { usage: p.usage } : {}),
            scene: String(p.scene || '').slice(0, 1200), district: String(world.districts?.[p.district]?.scene || '').slice(0, 1500),
            culture: (world.culture || []).slice(0, 6), provenance: '建筑位置来自示意图；功能、文化与开放规则来自RP设定，不是现实校园调查' };
    };
    const textLimit = (value, max) => String(value || '').slice(0, max);
    const briefPlace = result => result.status !== 'ok' ? result : ({
        status: 'ok', id: result.id, name: result.name, ...(result.zone ? { zone: result.zone } : {}), function: textLimit(result.function, 120),
        ...(result.services?.length ? { services: result.services.slice(0, 12) } : {}),
        ...(result.usage ? { usage: textLimit(result.usage, 180) } : {}),
        ...(result.subLocation ? { subLocation: result.subLocation } : {}),
        ...(result.access && Object.keys(result.access).length ? { access: result.access } : {}),
        ...(result.scene ? { scene: textLimit(result.scene, 180) } : {})
    });
    const briefRoute = result => result.status !== 'ok' ? result : ({
        status: 'ok', from: result.from, to: result.to, mode: result.mode, duration: result.duration,
        estimatedMeters: result.distance.estimatedMeters, confidence: result.confidence,
        ...(result.arrival ? { arrival: result.arrival } : {}), warnings: result.warnings.slice(0, 4).map(n => textLimit(n, 160))
    });
    // 坐标不是给人看的小数，只用来判断“谁在哪一侧”。八方位按图像坐标：x 向右、y 向下，所以北是 -y。
    const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    const placeOf = (world, id) => (world && id ? world.places.find(p => p.id === id) || null : null);
    const compass = (from, to) => {
        const dx = to[0] - from[0], dy = to[1] - from[1];
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return '';
        return dirs[Math.round((((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360) / 45) % 8];
    };
    const relation = (world, state) => {
        const a = placeOf(world, state.user?.placeId), b = placeOf(world, state.character?.placeId);
        if (!a || !b) return null;
        if (a.id === b.id) return { samePlace: true, place: a.name, note: '两处位置证据指向同一地点' };
        const scale = world.metersPerUnit || 1;
        const straight = Math.round((Math.hypot(b.point[0] - a.point[0], b.point[1] - a.point[1]) * scale) / 10) * 10;
        return { userToCharacter: { bearing: compass(a.point, b.point) + '方', straightMeters: straight, note: '直线距离，不是走动距离；耗时查 route' } };
    };
    const briefState = (state, world) => {
        const out = Object.fromEntries(['user', 'character'].map(key => {
            const s = state[key] || { status: 'unknown' };
            const place = placeOf(world, s.placeId);
            return [key, { status: s.status, ...(s.placeId ? { placeId: s.placeId, name: s.name } : {}),
                ...(s.subLocation ? { subLocation: s.subLocation } : {}),
                ...(place ? { zone: world.districts?.[place.district]?.label || place.district || '', point: place.point } : {}),
                ...(s.messageId ? { source: { messageId: s.messageId, channel: s.channel } } : {}), ...(s.candidates?.length ? { candidates: s.candidates.slice(0, 5) } : {}) }];
        }));
        const pair = relation(world, state);
        if (pair) out.relation = pair;
        return out;
    };
    // 一方位置已确认、另一方还没说时，先把“从这里出发要多久”算出来，
    // 免得模型自己许愿一个地点，再让他毫无代价地“走过去”。
    const reachability = (world, anchorId, exclude = [], limit = 8) => {
        const anchor = placeOf(world, anchorId);
        if (!anchor || !Array.isArray(world.landmarks)) return null;
        const rows = [];
        for (const id of world.landmarks) {
            if (id === anchorId || exclude.includes(id)) continue;
            const walk = route(world, anchorId, id, { mode: 'walk' });
            if (walk.status !== 'ok') continue;
            const bike = route(world, anchorId, id, { mode: 'bike' });
            const minutes = walk.duration.typicalMinutes;
            rows.push({ name: walk.to, walk: minutes, ...(bike.status === 'ok' && bike.duration.typicalMinutes < minutes ? { bike: bike.duration.typicalMinutes } : {}) });
            if (rows.length >= limit) break;
        }
        return rows.length ? { from: anchor.name, unit: '分钟', note: '楼外步行/低速骑行，不含楼内上下楼、找车与排队', rows } : null;
    };
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
        const anchor = a.status === 'ok' ? a.id : b.status === 'ok' ? b.id : null;
        const reach = anchor ? reachability(world, anchor, [a.id, b.id].filter(Boolean)) : null;
        return { status: a.status === 'ok' && b.status === 'ok' ? 'ok' : 'needs_location', worldId: world.id,
            locations: briefState(state, world), places: { from: detail ? a : briefPlace(a), to: detail ? b : briefPlace(b) }, routes,
            ...(reach ? { reach } : {}),
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
    const mentions = (world, text, limit = 4) => {
        const source = norm(text);
        const hits = world.places.flatMap(p => p.kind === 'junction' ? [] : names(p).filter(n => norm(n).length >= 2 && source.includes(norm(n))).map(n => ({ id: p.id, name: n, length: norm(n).length })));
        const chosen = [];
        for (const hit of hits.sort((a, b) => b.length - a.length)) {
            if (chosen.some(old => old.id === hit.id || norm(old.name).includes(norm(hit.name)))) continue;
            chosen.push(hit); if (chosen.length >= limit) break;
        }
        return chosen.map(hit => hit.name);
    };
    const mention = (world, text) => mentions(world, text, 1)[0] || '';
    // Broad recall supplies possibilities, never commands or location evidence.
    const needs = (world, text, limit = 2) => {
        const source = norm(text);
        return (world.everyday?.needs || []).filter(n => n.terms.some(term => source.includes(norm(term)))).slice(0, limit);
    };
    // Names locate a place; use keywords discover candidates without establishing location.
    // Only explicit local tags/needs trigger automatic recall. Long scene prose is searched on demand.
    const search = (world, query, options = {}) => {
        const q = norm(query);
        if (!q) return { status: 'needs_query', results: [], note: '请提供地点名称或用途关键词。' };
        const matchedNeeds = needs(world, q, 8);
        const preferred = [...new Set(matchedNeeds.flatMap(n => n.places))];
        const hits = [];
        for (const p of world.places) {
            if (p.kind === 'junction' && !options.includeNodes) continue;
            const matches = []; let score = 0;
            const add = (field, term, weight) => {
                const value = norm(term);
                if (!value) return;
                const exact = value === q, contains = value.includes(q), embedded = value.length >= 2 && q.includes(value);
                if (!exact && !contains && !embedded) return;
                // Descriptions support literal query search, not reverse matching of whole paragraphs.
                if (weight < 40 && !contains) return;
                score = Math.max(score, weight + (exact ? 40 : contains ? 20 : 10) + Math.min(exact || embedded ? value.length : q.length, 20));
                matches.push({ field, term: textLimit(exact || embedded ? term : query, 40) });
            };
            names(p).forEach(term => add('name', term, 100));
            (p.keywords || []).forEach(term => add('keyword', term, 80));
            (p.services || []).forEach(term => add('service', term, 70));
            const priority = preferred.indexOf(p.id);
            if (priority >= 0) {
                score = Math.max(score, 95);
                for (const n of matchedNeeds.filter(n => n.places.includes(p.id))) for (const term of n.terms.filter(t => q.includes(norm(t)))) matches.push({ field: 'need', term });
            }
            if (!options.metadataOnly) for (const field of ['function', 'usage', 'scene']) add(field, p[field], 15);
            if (!score) continue;
            const match = { fields: [...new Set(matches.map(m => m.field))], terms: [...new Set(matches.map(m => m.term))].slice(0, 4) };
            hits.push({ place: p, score, priority: priority < 0 ? preferred.length : priority, match });
        }
        hits.sort((a, b) => b.score - a.score || a.priority - b.priority);
        const limit = Math.max(1, Math.min(2000, options.limit || 8));
        return { status: hits.length ? 'ok' : 'not_found', worldId: world.id, query: textLimit(query, 200), total: hits.length,
            results: hits.slice(0, limit).map(hit => ({ ...(options.detail === 'full' ? placeInfo(world, hit.place.id) : briefPlace(placeInfo(world, hit.place.id))), match: hit.match })),
            note: hits.length ? '按地点名、用途关键词及本图资料匹配的候选，不是唯一目的地，也不是当前位置；选择后按需用context查路程。'
                : '本图没有匹配地点；应澄清或说明资料缺失，不得用超市、活动中心等不相关地点代替。' };
    };
    const everydayContext = (world, state, text) => {
        const matches = needs(world, text);
        if (!matches.length) return null;
        const origin = placeOf(world, state.character?.placeId);
        const cost = (id, mode) => {
            const outward = route(world, origin.id, id, { mode });
            if (outward.status !== 'ok') return { status: outward.status };
            const inward = route(world, id, origin.id, { mode });
            return { status: 'ok', oneWay: outward.duration.typicalMinutes, range: outward.duration.rangeMinutes, confidence: outward.confidence === 'measured' && inward.confidence === 'measured' ? 'measured' : 'estimated',
                ...(inward.status === 'ok' ? { roundTrip: outward.duration.typicalMinutes + inward.duration.typicalMinutes }
                    : { returnStatus: inward.status }),
                warnings: [...new Set([...outward.warnings, ...(inward.warnings || [])])].slice(0, 4) };
        };
        const ids = [...new Set(matches.flatMap(n => n.places))].slice(0, 3);
        return { possibleNeeds: matches.map(n => ({ id: n.id, label: n.label })),
            origin: origin ? { status: 'last_confirmed', actor: 'character', name: origin.name } : { status: 'needs_location', actor: 'character' },
            unit: '分钟', candidates: ids.map(id => {
                const p = briefPlace(placeInfo(world, id));
                return { id: p.id, name: p.name, function: p.function, ...(p.usage ? { usage: p.usage } : {}),
                    ...(p.scene ? { scene: p.scene } : {}), ...(p.zone ? { zone: p.zone } : {}),
                    ...(p.access ? { access: p.access } : {}), forNeeds: matches.filter(n => n.places.includes(id)).map(n => n.id),
                    ...(origin ? { costs: { walk: cost(id, 'walk'), bike: cost(id, 'bike') } } : {}) };
            }), note: '只是可能相关的地点，不代表请求代办、已经出发或到达。往返只含通行，不含活动、楼内时间和排队；库存与临时占用未知，营业按剧情时间核对。' };
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
                    state[speaker] = result.status === 'ok' ? { status: 'last_confirmed', placeId: result.place.id, name: result.place.name, ...(result.subLocation ? { subLocation: result.subLocation } : {}), ...source } : { status: result.status, ...source, candidates: result.candidates || [] };
                }
                continue;
            }
            source.evidence = text.slice(0, 80);
            if (['unknown', '未知'].includes(location)) { state[speaker] = { status: 'unknown', ...source }; continue; }
            const hit = resolve(world, location);
            state[speaker] = hit.status === 'ok' ? { status: 'last_confirmed', placeId: hit.place.id, name: hit.place.name, ...(hit.subLocation ? { subLocation: hit.subLocation } : {}), ...source } : { status: hit.status, ...source, candidates: hit.candidates || [] };
        }
        return state;
    };
    const properties = {
        operation: { type: 'string', enum: ['context', 'search', 'place', 'route', 'status'], description: '不知道目的地时先search用途（如取快递、吃饭、打印）；已知地点用context一次查用途/环境、位置与交通耗时' },
        query: { type: 'string', description: '地点名称或用途，如快递、取包裹、吃饭、买日用品；search返回多个候选及简介，context中作为目的地，省略使用user最近位置' },
        from: { type: 'string', description: '地点名/ID或user、character；context默认character' }, to: { type: 'string' },
        mode: { type: 'string', enum: ['walk', 'bike', 'compare'], description: 'context默认同时比较walk和bike' },
        weather: { type: 'string', enum: ['normal', 'rain'] }, time: { type: 'string', description: '剧情出发时间HH:MM，不能用系统时间' },
        detail: { type: 'string', enum: ['brief', 'full'], description: '默认brief只取行动需要的短结果；要丰富场景描写才选full' }
    };
    const definition = { type: 'function', function: { name: 'tool_geo', description: '本地地图检索：不知道去哪就search用途关键词（快递、吃饭、打印等），返回候选地点、简介、开放规则与匹配原因；名称歧义或无结果应澄清，不用缺少对应业务资料的地点代替。已知地点用context一查取齐环境、双方位置、步行/骑车路程。已有本轮速查不重复查，多地点可batch。只读，不改变位置，不提供取件码、库存等未知事实。', parameters: { type: 'object', properties: {
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
        if (args.operation === 'status') return { status: 'ok', worldId: world.id, locations: args.detail === 'full' ? state : briefState(state, world), note: '最近确认位置不是GPS；工具知道不等于人物获知。' };
        if (args.operation === 'place') {
            const result = placeInfo(world, args.query);
            if (args.detail === 'full' && result.status === 'ok') result.coordinates = { system: world.coordinateSystem || 'world_coordinates', point: resolve(world, args.query).place.point };
            return args.detail === 'full' ? result : briefPlace(result);
        }
        if (args.operation === 'search') {
            return boundResult(search(world, args.query, { detail: args.detail }), args.detail);
        }
        if (args.operation === 'route') {
            const result = route(world, endpoint(state, args.from), endpoint(state, args.to), args);
            return args.detail === 'full' ? result : briefRoute(result);
        }
        throw new Error('需要 operation: search/place/route/status');
    };
    window.RPHubGeography = { validate, resolve, path, edgeUnits, route, placeInfo, briefPlace, briefRoute, briefState, contextInfo, boundResult, mention, mentions, needs, search, everydayContext, project, definition, execute, compass, relation, reachability };
})();
