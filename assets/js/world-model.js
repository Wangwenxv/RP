// Versioned world contracts. No Vue state or active-character lookup is used.
(function () {
    const SCHEMA_VERSION = 1;
    const EVENT_KINDS = Object.freeze([
        'player.input', 'message.sent', 'message.delivered', 'message.read',
        'observation.acquired', 'action.committed', 'world.fact_asserted',
        'world.fact_corrected', 'narration.published', 'belief.adopted',
        'conversation.created', 'conversation.member_joined', 'conversation.member_left',
        'actor.state_changed', 'turn.updated', 'pending.created', 'pending.updated',
        'pending.completed', 'pending.replaced', 'world.clock_advanced', 'memory.summarized'
    ]);
    const clone = value => JSON.parse(JSON.stringify(value));
    const fail = (message, code = 'WORLD_INVALID') => { const e = new Error(message); e.code = code; throw e; };
    const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
        && !['__proto__', 'constructor', 'prototype'].includes(value);
    const assertId = (value, label = 'ID') => { if (!validId(value)) fail(`${label}无效`); return value; };
    const id = (prefix = 'world') => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
    const cardData = card => card?.data && typeof card.data === 'object' ? card.data : card || {};
    // Avatars are presentation data, never character knowledge or model input.
    const normalizeAvatar = value => typeof value === 'string' && value.length <= 2000000
        && (/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=\r\n]+$/i.test(value)
            || /^https?:\/\/[^\s<>"']+$/i.test(value)) ? value : '';
    const storyTimeNumber = value => {
        const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
        if (!match) return NaN;
        const [year, month, day, hour, minute, second] = match.slice(1).map(n => Number(n || 0));
        if (year < 100 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return NaN;
        const stamp = Date.UTC(year, month - 1, day, hour, minute, second), date = new Date(stamp);
        return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? stamp : NaN;
    };
    const hash = async (value, algorithm) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        if (algorithm !== 'fnv1a' && globalThis.crypto?.subtle && typeof TextEncoder !== 'undefined') {
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
            return `sha256:${Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')}`;
        }
        if (algorithm === 'sha256') fail('当前浏览器不能校验 SHA-256 世界包，请使用支持安全摘要的浏览器环境');
        // A labelled fallback remains available for browsers opening local files.
        let n = 2166136261;
        for (let i = 0; i < text.length; i++) { n ^= text.charCodeAt(i); n = Math.imul(n, 16777619); }
        return `fnv1a:${(n >>> 0).toString(16).padStart(8, '0')}`;
    };
    const preflightCard = (card, options = {}) => {
        const data = cardData(card), text = JSON.stringify(data), conflicts = [];
        const add = (code, message, blocking = true) => conflicts.push({ code, message, blocking });
        if (!String(data.name || '').trim()) add('missing-name', '角色卡缺少姓名');
        if (!String(data.personality || data.description || '').trim()) add('missing-personality', '角色卡缺少人格或人物描述');
        if (/\{\{user\}\}/i.test(text) && !options.bindings?.user) add('unresolved-user', '请明确 {{user}} 在这张卡中绑定玩家还是独立 NPC');
        if (options.actorId === 'linwan' || /林晚/.test(String(data.name || ''))) {
            if (/毕业[约大概\s]*[一1]年|校外同居|大企业.{0,10}HR|商学院.{0,12}毕业|镜湖校区/.test(text))
                add('timeline-conflict', '这张林晚卡包含毕业、同居或镜湖校区设定，与苏祈雪在校时间线冲突，请先适配');
        }
        if (/\{\{(?:partner|lover)\}\}/i.test(text) && !options.bindings?.partner)
            add('unresolved-partner', '人物恋人槽位尚未绑定');
        return { ok: !conflicts.some(c => c.blocking), conflicts, warnings: conflicts.filter(c => !c.blocking), name: data.name || '', sourcePreserved: true };
    };
    const normalizeDefinition = definition => {
        if (!definition || typeof definition !== 'object' || !Array.isArray(definition.actors)) fail('世界定义无效');
        const result = clone(definition);
        result.worldId = assertId(result.worldId || id('world'), '世界 ID');
        result.name = String(result.name || '新世界').trim().slice(0, 120);
        result.revision = Number.isSafeInteger(result.revision) ? result.revision : 1;
        result.playerActorId = assertId(result.playerActorId || 'player', '玩家 ID');
        if (result.openingText !== undefined) {
            if (typeof result.openingText !== 'string' || result.openingText.length > 30000) fail('世界开场白须为不超过 30000 字的文字');
            result.openingText = result.openingText.trim();
        }
        const seen = new Set();
        result.actors = result.actors.map(actor => {
            if (!actor || typeof actor !== 'object') fail('人物定义无效');
            assertId(actor.actorId, '人物 ID');
            if (seen.has(actor.actorId)) fail('世界中存在重复人物 ID');
            seen.add(actor.actorId);
            const a = clone(actor);
            a.name = String(a.name || cardData(a.card).name || a.actorId).trim().slice(0, 100);
            a.bindings = a.bindings || {};
            a.enabled = a.actorId === result.playerActorId ? true : a.enabled !== false;
            a.cardRevision = a.cardRevision || 1;
            if (a.avatar !== undefined) a.avatar = normalizeAvatar(a.avatar);
            return a;
        });
        if (!seen.has(result.playerActorId)) fail('世界缺少玩家人物');
        for (const actor of result.actors) for (const target of Object.values(actor.bindings))
            if (!seen.has(target)) fail(`人物 ${actor.name} 的关系槽位绑定了不存在的人物`);
        for (const actor of result.actors) if (actor.knownActorIds && (!Array.isArray(actor.knownActorIds) || actor.knownActorIds.some(target => !seen.has(target)))) fail('人物认识列表引用不存在的人物');
        for (const actor of result.actors) if (actor.actorId !== result.playerActorId && actor.enabled) {
            if (!actor.card || actor.cardStatus === 'missing') fail(`${actor.name} 尚未提供可用角色卡`);
            const report = preflightCard(actor.card, { actorId: actor.actorId, bindings: actor.bindings });
            if (!report.ok) fail(`${actor.name} 的角色卡尚未适配：${report.conflicts.filter(c => c.blocking).map(c => c.message).join('；')}`, 'WORLD_CARD_CONFLICT');
        }
        return result;
    };
    const normalizeConversation = (conversation, definition, seq = 0) => {
        if (!conversation || typeof conversation !== 'object') fail('会话无效');
        const c = clone(conversation), actors = new Set(definition.actors.map(a => a.actorId));
        assertId(c.conversationId, '会话 ID');
        if (!['dm', 'group', 'rp'].includes(c.kind)) fail('会话类型无效');
        if (!Array.isArray(c.participantActorIds) || !c.participantActorIds.length) fail('会话缺少参与者');
        if (new Set(c.participantActorIds).size !== c.participantActorIds.length || c.participantActorIds.some(a => !actors.has(a))) fail('会话参与者无效');
        if (c.kind === 'dm' && c.participantActorIds.length !== 2) fail('私聊必须有两位参与者');
        c.name = String(c.name || '会话').slice(0, 120);
        c.memberships = c.memberships || c.participantActorIds.map(actorId => ({ actorId, joinedAtSeq: seq }));
        for (const m of c.memberships) {
            if (!actors.has(m.actorId) || !Number.isSafeInteger(m.joinedAtSeq) || m.joinedAtSeq < 0
                || (m.leftAtSeq != null && (!Number.isSafeInteger(m.leftAtSeq) || m.leftAtSeq < m.joinedAtSeq))) fail('成员资格区间无效');
        }
        for (const actorId of actors) {
            const ranges = c.memberships.filter(m => m.actorId === actorId).sort((a, b) => a.joinedAtSeq - b.joinedAtSeq);
            for (let i = 1; i < ranges.length; i++) if (ranges[i - 1].leftAtSeq == null || ranges[i].joinedAtSeq < ranges[i - 1].leftAtSeq) fail('成员资格区间重叠');
        }
        return c;
    };
    const activeMembers = (conversation, seq) => (conversation?.memberships || []).filter(m => m.joinedAtSeq <= seq && (m.leftAtSeq == null || seq < m.leftAtSeq)).map(m => m.actorId);
    const eventText = event => event?.payload?.type === 'image'
        ? (window.RPHubWeChatMedia?.imageRecordText({ id: event.eventId, media: event.payload.media }) || `[图片：${event.payload.media?.caption || '未描述'}]`)
        : String(event?.payload?.text || event?.payload?.content || event?.payload?.proposition || '');
    const validateEvent = (event, snapshot, { persisted = false } = {}) => {
        if (!event || typeof event !== 'object' || !EVENT_KINDS.includes(event.kind)) fail('未知或无效的世界事件类型');
        const actors = new Set(snapshot.definition.actors.map(a => a.actorId));
        if (!actors.has(event.actorId)) fail('事件人物不在本世界');
        if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) fail('事件内容无效');
        if (event.kind === 'message.sent' && event.payload.type === 'image'
            && (!/^worldimg-[\w-]+$/.test(event.payload.media?.assetId || '') || event.payload.text)) fail('世界图片必须引用已保存资源，不能混入文字');
        if (!event.access || !Array.isArray(event.access.principals) || event.access.principals.some(a => !actors.has(a))) fail('事件访问权限无效');
        if (new Set(event.access.principals).size !== event.access.principals.length) fail('事件权限人物重复');
        if (event.conversationId) {
            const c = snapshot.conversations.find(c => c.conversationId === event.conversationId);
            if (!c && event.kind !== 'conversation.created') fail('事件引用不存在的会话');
            if (c && event.kind === 'message.sent') {
                const members = activeMembers(c, event.seq || snapshot.events.length + 1);
                if (!members.includes(event.actorId) || event.access.principals.some(a => !members.includes(a))) fail('消息发言人或接收者不具备发送时成员资格');
                if (!event.access.principals.includes(event.actorId)) fail('消息必须保留发件人的访问资格');
            }
        } else if (event.kind.startsWith('message.')) fail('通信事件缺少会话 ID');
        const known = new Set(snapshot.events.map(e => e.eventId));
        if (event.causedBy && (!Array.isArray(event.causedBy) || event.causedBy.some(e => !known.has(e)))) fail('事件因果引用无效');
        if (persisted) {
            assertId(event.eventId, '事件 ID');
            if (!Number.isSafeInteger(event.seq) || event.seq < 1 || event.sessionId !== snapshot.sessionId || event.branchId !== snapshot.branchId) fail('事件所属分支或序列无效');
        }
        if (['message.read', 'message.delivered', 'observation.acquired'].includes(event.kind)) {
            if (!Array.isArray(event.payload.eventIds) || !event.payload.eventIds.length) fail('观察事件缺少来源');
            for (const sourceId of event.payload.eventIds) {
                const source = snapshot.events.find(e => e.eventId === sourceId);
                if (!source || !source.access.principals.includes(event.actorId)) fail('观察来源不存在或未授权');
                if (event.kind.startsWith('message.') && (source.kind !== 'message.sent' || source.conversationId !== event.conversationId)) fail('已读或送达事件引用错误的通信来源');
            }
        }
        if (event.kind === 'conversation.created') normalizeConversation(event.payload.conversation, snapshot.definition, event.seq || 0);
        if (event.kind === 'world.clock_advanced' && (!Number.isFinite(storyTimeNumber(event.payload.storyTime)) || storyTimeNumber(event.payload.storyTime) < storyTimeNumber(snapshot.storyTime))) fail('剧情时钟事件无效或倒退');
        if (event.kind === 'actor.state_changed' && (!event.payload.state || typeof event.payload.state !== 'object' || Array.isArray(event.payload.state))) fail('人物状态事件无效');
        if (event.kind === 'action.committed' && event.payload.targetActorId && !actors.has(event.payload.targetActorId)) fail('动作目标人物无效');
        if (event.kind === 'action.committed' && event.payload.type && !['reply', 'tell', 'speak', 'act', 'move', 'wait', 'departed', 'arrived', 'remember', 'commitment', 'transfer'].includes(event.payload.type)) fail('未知世界动作类型');
        if (event.kind === 'narration.published') {
            const covered = event.payload.coveredEventIds || event.payload.eventIds || [];
            if (!Array.isArray(covered) || covered.some(id => !known.has(id))) fail('叙述引用的场景事件无效');
        }
        if (event.kind === 'memory.summarized') {
            if (typeof event.payload.summary !== 'string' || !event.payload.summary.trim()
                || !Array.isArray(event.payload.sourceEventIds) || !event.payload.sourceEventIds.length
                || event.access.principals.length !== 1 || event.access.principals[0] !== event.actorId) fail('人物记忆缺少正文、来源或独立权限');
            const observed = window.RPHubWorldProjections.knownEventIds(snapshot, event.actorId);
            if (event.payload.sourceEventIds.some(id => !observed.has(id))) fail('人物总结引用了未观察的来源');
        }
        if (event.kind === 'turn.updated' && (!event.payload.turn || typeof event.payload.turn !== 'object' || !(event.payload.turnId || event.turnId))) fail('世界回合事件无效');
        if (event.kind === 'pending.replaced') {
            if (!Array.isArray(event.payload.pendingActions)) fail('世界待办列表无效');
            const ids = new Set();
            for (const task of event.payload.pendingActions) {
                const taskId = task.actionId || task.pendingActionId;
                if (typeof taskId !== 'string' || !taskId || ids.has(taskId) || !actors.has(task.actorId)
                    || (task.type && !['reply', 'tell', 'move', 'wait', 'speak', 'act', 'remember'].includes(task.type))) fail('未知或无效的世界待办');
                ids.add(taskId);
                if (task.sourceEvidenceIds && (!Array.isArray(task.sourceEvidenceIds) || task.sourceEvidenceIds.some(id => !known.has(id)))) fail('待办来源引用无效');
            }
        }
        return event;
    };
    window.RPHubWorldModel = Object.freeze({ SCHEMA_VERSION, EVENT_KINDS, clone, fail, validId, assertId, id, hash,
        cardData, normalizeAvatar, storyTimeNumber, preflightCard, normalizeDefinition, normalizeConversation, activeMembers, eventText, validateEvent });
})();
