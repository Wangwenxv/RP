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
                ...(s.note ? { note: s.note } : {}),
                ...(s.arrivalAt ? { arrivalAt: s.arrivalAt, departureAt: s.departureAt, fromId: s.fromId, destinationId: s.destinationId } : {}),
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
    const messageText = msg => {
        if (!['user', 'assistant'].includes(msg?.role) || (msg.type && msg.type !== 'text')) return '';
        let text = String(msg.content || '').replace(/<(think|thinking|cot)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '').trim();
        if (text.startsWith('{')) {
            try { text = (JSON.parse(text).messages || []).filter(p => p.type === 'text').map(p => p.content).join('\n'); }
            catch (_) { return ''; }
        }
        return text;
    };
    // A model may annotate an actual sentence, but cannot supply its own location evidence.
    const verifyLocationUpdate = (world, msg, args, bindings = {}) => {
        const text = messageText(msg), quote = String(args.evidence || '').trim();
        const unwrap = s => s.replace(/^\*+|\*+$/g, '').trim();
        const sentences = unwrap(text).match(/[^。！？!?\n]+[。！？!?]?/g) || [];
        if (!quote || !text.includes(quote) || !sentences.some(s => s.trim() === unwrap(quote)) || /^[>“"「『]/.test(unwrap(quote))) throw new Error('依据必须是当前分支正文中的完整原句，不能来自推理、引用或附件');
        let sentence = unwrap(quote);
        const name = String(bindings.character?.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const subject = msg.role === 'assistant' ? [name, '她', '他'].filter(Boolean).join('|') : name;
        const namedHuman = msg.role === 'user' && name && new RegExp('^(?:' + name + ')').test(sentence);
        if (subject) sentence = sentence.replace(new RegExp('^(?:' + subject + ')'), '我');
        // Human first-person text always belongs to the player, except an explicit /geo character command.
        if (msg.role === 'user' && !/^\/geo\s+character\s+/i.test(sentence) && !subject) throw new Error('玩家位置只能由玩家决定');
        if (msg.role === 'user' && !namedHuman && !/^\/geo\s+character\s+/i.test(sentence)) throw new Error('不能把玩家自述当成角色位置');
        sentence = sentence.replace(/^我(?:推门)?(?:走进|进入)(?:了)?/, '我到了');
        const inferred = project(world, [{ role: /^\/geo/.test(sentence) ? 'user' : 'assistant', content: sentence, id: msg.id, channel: msg.channel }], bindings).character;
        if (!inferred.messageId || inferred.status !== args.locationStatus) throw new Error('依据未确认这个位置状态；计划、疑问和猜测不能更新位置');
        if (args.locationStatus === 'last_confirmed') {
            const hit = resolve(world, args.query);
            if (hit.status !== 'ok' || inferred.placeId !== hit.place.id) throw new Error('目标地点必须唯一且与原文确认的地点一致');
        } else if (args.query) throw new Error('在途或未知状态不能带到达地点');
        return { ...inferred, channel: msg.channel || 'rp', evidence: quote, origin: 'model_tool' };
    };
    // Conservative evidence replay. Commands are accepted only in HUMAN messages.
    // No memory summaries, attachments, tools, CoT, quotations or future plans are location evidence.
    const decidePosition = (world, previous, decision, storyAt) => {
        if (!decision || typeof decision !== 'object' || Array.isArray(decision)
            || Object.keys(decision).some(k => !['action', 'placeId', 'to', 'mode', 'detail'].includes(k))
            || !['present', 'stay', 'depart', 'continue'].includes(decision.action)
            || !Number.isFinite(storyAt)) throw new Error('自身位置需要合法position对象和剧情时间');
        for (const value of Object.values(decision)) if (typeof value !== 'string' || value.length > 100) throw new Error('位置字段须为不超过100字的字符串');
        const before = previous || { status: 'unknown' };
        if (Number.isFinite(before.confirmedAt) && storyAt < before.confirmedAt || Number.isFinite(before.departureAt) && storyAt < before.departureAt) throw new Error('自身位置不能倒退剧情时间');
        if (decision.action === 'continue') {
            if (before.status !== 'in_transit' || decision.placeId || decision.to || decision.mode) throw new Error('continue仅保持已记录的在途行程');
            return { ...before, ...(decision.detail?.trim() ? { subLocation: { detail: decision.detail.trim() } } : {}) };
        }
        const placeId = decision.placeId || (decision.action !== 'present' ? before.placeId : '');
        const place = world.places.find(p => p.id === placeId && p.kind !== 'junction');
        if (!place) throw new Error('请选择地图中具体的自身地点placeId，不能用片区或住址自动代填');
        if (decision.action === 'stay' && (before.status !== 'last_confirmed' || before.placeId !== place.id)) throw new Error('尚未确认自身位置，先自主建立present场景；在途不能stay成在场');
        if (decision.action === 'present' && before.status === 'in_transit') {
            if (before.destinationId !== place.id || !Number.isFinite(before.arrivalAt) || storyAt < before.arrivalAt) throw new Error('尚未走完路程，不能提前到达；保持在途');
        } else if (decision.action === 'present' && before.status === 'last_confirmed' && before.placeId !== place.id) {
            const cost = route(world, before.placeId, place.id, { mode: decision.mode || 'walk' });
            if (cost.status !== 'ok' || !Number.isFinite(before.confirmedAt) || storyAt - before.confirmedAt < cost.duration.typicalMinutes * 60000) throw new Error('切换地点必须先depart，或有足够已推进的剧情时间，不能瞬移');
        }
        if (decision.action === 'depart') {
            if (before.status !== 'last_confirmed' || before.placeId !== place.id) throw new Error('出发必须从自己已确认的位置开始');
            if (!decision.to || decision.to === place.id) throw new Error('出发需要不同的明确目的地to');
            const cost = route(world, place.id, decision.to, { mode: decision.mode || 'walk' });
            if (cost.status !== 'ok') throw new Error('目的地或通行路程尚未确认，不能提交移动');
            const destination = resolve(world, decision.to).place;
            if (destination.kind === 'junction') throw new Error('目的地需要地图中具体地点，不能用路网节点');
            return { status: 'in_transit', fromId: place.id, destinationId: resolve(world, decision.to).place.id, departureAt: storyAt,
                arrivalAt: storyAt + cost.duration.typicalMinutes * 60000, ...(decision.detail?.trim() ? { subLocation: { detail: decision.detail.trim() } } : {}),
                note: `已从${place.name}前往${destination.name}，预计${cost.duration.typicalMinutes}分钟；到达待剧情时间确认`, origin: 'model_position' };
        }
        if (decision.to || decision.mode) throw new Error('在场/停留不应附带行程；计划不作为已出发');
        const sceneDetail = decision.detail?.trim() || (before.placeId === place.id ? before.subLocation?.detail : '');
        // Refining an indoor description is not a new arrival. Keep the original
        // arrival time so repeated stationary replies do not reset travel history.
        return { status: 'last_confirmed', placeId: place.id, name: place.name,
            confirmedAt: before.placeId === place.id && Number.isFinite(before.confirmedAt) ? before.confirmedAt : storyAt,
            ...(sceneDetail ? { subLocation: { detail: sceneDetail } } : before.placeId === place.id && before.subLocation ? { subLocation: before.subLocation } : {}), origin: 'model_position' };
    };
    const project = (world, messages, bindings = {}) => {
        const state = { user: { status: 'unknown' }, character: { status: 'unknown' } };
        let locationQuestion = false;
        let positionOwner = null;
        for (const [index, msg] of messages.entries()) {
            // The character-card opening is an already authored scene. A timed
            // opening with exactly one mapped building and visibly present named
            // actors can establish both positions without treating their homes
            // as current locations or granting later narration control of a player.
            if (index === 0 && msg.role === 'assistant' && (msg.channel || 'rp') === 'rp') {
                const opening = messageText(msg).replaceAll('{{user}}', bindings.user?.name || '').replaceAll('{{char}}', bindings.character?.name || '');
                const header = opening.split(/\r?\n/)[0];
                const scene = [...new Map(mentions(world, opening).map(q => resolve(world, q)).filter(r => r.status === 'ok' && r.place.kind !== 'junction').map(r => [r.place.id, r.place])).values()];
                if (scene.length === 1 && mentions(world, header).some(q => resolve(world, q).place?.id === scene[0].id)
                    && /下午|上午|早晨|清晨|傍晚|夜晚|凌晨|\d+[时点:]|[一二三四五六七八九十]+[时点]/.test(header)
                    && !/^[>“"「『]|[？?]|明天|昨天|回忆|曾经|打算|计划/.test(header)) {
                    const prose = opening.replace(/“[^”]*”|"[^"\n]*"|「[^」]*」/g, '');
                    for (const actor of ['character', 'user']) {
                        const name = String(bindings[actor]?.name || '');
                        const sentence = (prose.match(/[^。！？!?\n]+/g) || []).find(s => name && s.includes(name));
                        const action = sentence?.slice(sentence.indexOf(name) + name.length);
                        const present = actor === 'user' ? /站在|坐在|靠在|等在|躺在/ : /站|坐|靠|等|蹲|躺|捂着|抬起|走|抱着/;
                        if (action && present.test(action) && !/打算|准备|想去|可能|曾经|回忆/.test(action)) state[actor] = {
                            status: 'last_confirmed', placeId: scene[0].id, name: scene[0].name,
                            messageId: msg.id || String(index), channel: 'rp', origin: 'opening_scene', evidence: sentence.trim().slice(0, 100)
                        };
                    }
                }
            }
            for (const update of (Array.isArray(msg.geographyUpdates) ? msg.geographyUpdates : []).slice(-4)) {
                if (update.worldId !== world.id) continue;
                try { state.character = verifyLocationUpdate(world, msg, update, bindings); } catch (_) { /* Edited/deleted evidence invalidates the annotation. */ }
            }
            const ownPosition = msg.role === 'assistant' ? msg.geographyPosition : msg.role === 'user' ? msg.geographyReplyPosition : null;
            if (ownPosition?.worldId === world.id && ownPosition.sourceContent === msg.content) {
                try {
                    state.character = { ...decidePosition(world, state.character, ownPosition.decision, ownPosition.storyAt), messageId: msg.id || String(index), channel: msg.channel || 'rp' };
                    positionOwner = msg.id || String(index);
                } catch (_) { /* Invalid decisions or edited source messages do not resurrect a position. */ }
            }
            if (msg.role === 'assistant' && (ownPosition && positionOwner === (msg.id || String(index)) || msg.geographyPositionRef && msg.geographyPositionRef === positionOwner)) continue;
            if (!['user', 'assistant'].includes(msg.role) || (msg.type && msg.type !== 'text')) continue;
            const text = messageText(msg);
            if (!text) continue;
            if (msg.role === 'user') locationQuestion = /你(?:现在|目前)?在哪|哪一栋|在哪栋|在哪个(?:地方|位置)/.test(text) && !/明天|后天|打算|准备|想去|要去/.test(text);
            const source = { messageId: msg.id || String(index), channel: msg.channel || 'rp', evidence: '' };
            const command = msg.role === 'user' && /^\/geo\s+(user|character)\s+([^\n]+)$/i.exec(text);
            const speaker = command ? command[1].toLowerCase() : msg.role === 'user' ? 'user' : 'character';
            let location = command ? command[2].trim() : '';
            if (!command) {
                const sentences = text.match(/[^。！？!?\n]+[。！？!?]?/g) || [];
                for (const raw of sentences) {
                    let sentence = raw.trim().replace(/^\*+|\*+$/g, '').trim();
                    if (/^[>“"「『]/.test(sentence)) continue;
                    if (/[？?]$/.test(sentence)) {
                        const compound = /^([^，,]+)[，,]\s*(?:你|能|可以|要不要)/.exec(sentence);
                        if (!compound) continue;
                        sentence = compound[1];
                    }
                    sentence = sentence.replace(/[。！!]$/, '');
                    let sentenceSpeaker = speaker;
                    const characterName = String(bindings.character?.name || '');
                    const userName = String(bindings.user?.name || '');
                    if (characterName && sentence.startsWith(characterName)) {
                        sentence = '我' + sentence.slice(characterName.length);
                        sentenceSpeaker = 'character';
                    } else if (msg.role === 'user' && userName && sentence.startsWith(userName)) {
                        sentence = '我' + sentence.slice(userName.length);
                    }
                    // Only explicit player-authored facts locate the player. A named
                    // character in a player scene direction still belongs to that character.
                    sentence = sentence.replace(/^我(?:仍然|依然|仍|正)?(?:留在|坐在|站在|待在|停在)/, '我在');
                    // A single-card WeChat bubble commonly omits its first-person subject.
                    // Keep this restricted to that channel; bare destinations require a current-location question.
                    const spoken = msg.channel === 'wechat' && msg.role === 'assistant';
                    if (spoken && /^(?:现在|目前|还|已经|刚刚|刚)?(?:在|到|回|走进|进入|离开|出发)/.test(sentence)) sentence = '我' + sentence;
                    const factClause = sentence.split(/[，,；;]/)[0];
                    if (/[？?]/.test(sentence) || /(?:吗|么|了没|是不是|是否|会不会|要不要|如果|假如|可能|也许|大概在|打算|准备|想去|要去|要回|才到|到时候|的话|以后|之后)/.test(factClause)) continue;
                    if (/^(?:第二天|次日|翌日|(?:几|半|一|两|三|四|五|六|七|八|九|十|\d+)个?小时后|(?:几|一|两|三|\d+)天后)/.test(sentence)) {
                        state.user = { status: 'unknown', ...source, evidence: '剧情时间跳跃，需重新确认' };
                        state.character = { status: 'unknown', ...source, evidence: '剧情时间跳跃，需重新确认' };
                        continue;
                    }
                    if (/^我不在/.test(sentence)) { state[sentenceSpeaker] = { status: 'unknown', ...source, evidence: sentence.slice(0, 80) }; continue; }
                    if (/^我在(?:去|前往).*(?:路上|途中)/.test(sentence)) { state[sentenceSpeaker] = { status: 'in_transit', ...source, evidence: sentence.slice(0, 80) }; continue; }
                    if (/^(?:我)?(?:已经|刚刚|刚)?(?:出发了|离开了|在路上|走出)/.test(sentence)) { state[sentenceSpeaker] = { status: 'in_transit', ...source, evidence: sentence.slice(0, 80) }; continue; }
                    const hit = /^我(?:现在|目前|还|已经|刚刚|刚)?(?:在|走到了?|来到了?|到了?|回到了?|回|走进了?|进入了?)([^，,；;]+)/.exec(sentence);
                    if (!hit && spoken && locationQuestion && sentence.length <= 40) {
                        const answer = resolve(world, sentence.replace(/[呢啦啊哦呀]+$/, ''));
                        if (answer.status === 'ok') state.character = { status: 'last_confirmed', placeId: answer.place.id, name: answer.place.name,
                            ...(answer.subLocation ? { subLocation: answer.subLocation } : {}), ...source, evidence: raw.trim().slice(0, 80) };
                        continue;
                    }
                    if (!hit) continue;
                    if (/^我到[^，,；;]*(?:就|再|以后|之后)/.test(sentence)) continue;
                    location = hit[1].replace(/(?:等你|等着|呢|啦|了|啊|哦|呀|这边|这里).*$/, '').trim();
                    // Activity text can follow a stated place, but cannot itself identify one.
                    location = location.replace(/(?:看书|看小说|自习|写作业|吃饭|吃晚饭|吃午饭|吃早饭)$/, '').trim();
                    if (!location || /^[来回]+$/.test(location)) continue;
                    source.evidence = sentence.slice(0, 80);
                    // Resolve at most one statement; never use substring containment to guess a building.
                    if (location === '宿舍' || location === '寝室') location = bindings[sentenceSpeaker]?.home || '';
                    let result = resolve(world, location);
                    // A known building followed by an indoor scene locates that
                    // building; arbitrary substrings and ambiguous building names do not.
                    if (result.status !== 'ok') {
                        const indoor = world.places.flatMap(p => p.kind === 'junction' ? [] : names(p).filter(n => location.startsWith(n)
                            && /^(?:的)?(?:一楼|二楼|三楼|楼内|楼下|楼上|门口|门外|走廊|诊室|房间|大厅|前台|入口)/.test(location.slice(n.length))).map(n => ({ p, n })))
                            .sort((a, b) => b.n.length - a.n.length);
                        if (indoor.length && new Set(indoor.filter(x => x.n.length === indoor[0].n.length).map(x => x.p.id)).size === 1)
                            result = { status: 'ok', place: indoor[0].p, subLocation: { detail: location.slice(indoor[0].n.length).slice(0, 100) } };
                    }
                    // Descriptive repetitions preserve an established position decision.
                    const before = state[sentenceSpeaker];
                    if (result.status === 'unknown_place' && before.placeId
                        && /^(?:这里|那里|那儿|门口|门外|走廊|长椅|座位|楼上|楼下|房间|观察室|值班室|办公室|诊室|床边|床上)/.test(location)) {
                        state[sentenceSpeaker] = { ...before, subLocation: { detail: location.slice(0, 100) } };
                        continue;
                    }
                    if (result.status === 'ok' && before.placeId === result.place.id) {
                        if (result.subLocation) state[sentenceSpeaker] = { ...before, subLocation: result.subLocation };
                        continue;
                    }
                    state[sentenceSpeaker] = result.status === 'ok' ? { status: 'last_confirmed', placeId: result.place.id, name: result.place.name, ...(result.subLocation ? { subLocation: result.subLocation } : {}), ...source } : { status: result.status, ...source, candidates: result.candidates || [],
                        note: result.status === 'ambiguous_place' ? `只确认了${location}，具体地点待确认` : '提到的地点未能在地图中确认' };
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
        operation: { type: 'string', enum: ['context', 'search', 'place', 'route', 'status', 'update_location', 'set_position'], description: '查询地点/路程；set_position自主维护角色自身位置，update_location核对已有原文；均不能决定玩家位置' },
        action: { type: 'string', enum: ['present', 'stay', 'depart', 'continue'], description: 'set_position：自主确定当前实际场景present，停留stay，实际出发depart，保持在途continue；计划不是出发' },
        placeId: { type: 'string', description: 'set_position：自身当前地图地点ID，不能填玩家位置' },
        sceneDetail: { type: 'string', description: 'set_position可选：具体室内位置，如314室书桌前；原地描述变化无需调用工具，不发送给用户' },
        locationStatus: { type: 'string', enum: ['last_confirmed', 'in_transit', 'unknown'], description: 'update_location必填：已确认在场、已经离开在途、位置未知；到达才带query' },
        sourceMessageId: { type: 'string', description: 'update_location必填：位置依据原文消息ID；RP本轮已写出的正文用current，微信用已有正文ID' },
        evidence: { type: 'string', description: 'update_location必填：逐字复制该消息里不超过200字的完整事实原句；禁止推理、引用、疑问、计划' },
        query: { type: 'string', description: '地点名称或用途，如快递、取包裹、吃饭、买日用品；search返回多个候选及简介，context中作为目的地，省略使用user最近位置' },
        from: { type: 'string', description: '地点名/ID或user、character；context默认character' }, to: { type: 'string' },
        mode: { type: 'string', enum: ['walk', 'bike', 'compare'], description: 'context默认同时比较walk和bike' },
        weather: { type: 'string', enum: ['normal', 'rain'] }, time: { type: 'string', description: '剧情出发时间HH:MM，不能用系统时间' },
        detail: { type: 'string', enum: ['brief', 'full'], description: '默认brief只取行动需要的短结果；要丰富场景描写才选full' }
    };
    const definition = { type: 'function', function: { name: 'tool_geo', description: '本地地图：search检索用途候选，context查询环境、双方位置与通行耗时；已有速查不重复查，多地点可batch。set_position仅在初次场景或实际移动时记录角色自身位置（只用action、placeId、可选sceneDetail；depart用to和mode）；原地自动继承，楼内描述变化不重复登记。set_position不要附带actor、query、sourceMessageId、evidence。update_location用当前分支正文中的完整事实原句核对位置（query地点、locationStatus、sourceMessageId、evidence）。两者均不能按计划或住址瞬移；玩家明确给出的位置自动回放，不用工具代玩家选择去向。不提供取件码、库存等未知事实。', parameters: { type: 'object', properties: {
        ...properties, operation: { ...properties.operation, enum: [...properties.operation.enum, 'batch'] },
        requests: { type: 'array', minItems: 1, maxItems: 4, description: 'batch最多4个独立查询，一次返回；不许嵌套batch', items: { type: 'object', properties, required: ['operation'], additionalProperties: false } }
    }, required: ['operation'], additionalProperties: false } } };
    const queryProperties = Object.fromEntries(Object.entries(properties).filter(([key]) => !['action', 'placeId', 'sceneDetail', 'locationStatus', 'sourceMessageId', 'evidence'].includes(key)));
    queryProperties.operation = { type: 'string', enum: ['context', 'search', 'place', 'route', 'status'], description: '只查询地点与路程；角色位置通过最终JSON的position提交' };
    const queryDefinition = { type: 'function', function: { name: 'tool_geo', description: '查询地图资料，不更改位置。search检索地点，context获取地点和路程；速查够用不重复查，多地点可batch。角色自身场景仅在最终JSON的position提交。', parameters: { type: 'object', properties: {
        ...queryProperties, operation: { ...queryProperties.operation, enum: [...queryProperties.operation.enum, 'batch'] },
        requests: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: queryProperties, required: ['operation'], additionalProperties: false } }
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
        if (args.operation === 'set_position' && (!allowBatch || !args.action || args.requests)) throw new Error('set_position需要action且不能放入batch');
        if (args.operation === 'update_location' && (!allowBatch || !args.sourceMessageId || !args.evidence || !args.locationStatus)) throw new Error('位置更新需要sourceMessageId、完整原句evidence和locationStatus，不能放入batch');
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
    window.RPHubGeography = { validate, validateArgs, messageText, verifyLocationUpdate, decidePosition, resolve, path, edgeUnits, route, placeInfo, briefPlace, briefRoute, briefState, contextInfo, boundResult, mention, mentions, needs, search, everydayContext, project, definition, queryDefinition, execute, compass, relation, reachability };
})();
