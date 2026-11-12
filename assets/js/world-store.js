// One authoritative world-session record. Each mutation uses storage CAS in IDB.
(function () {
    const M = () => window.RPHubWorldModel, P = () => window.RPHubWorldProjections, S = () => window.RPHubStorage;
    const PREFIX = 'world_session_v1:';
    const key = sessionId => PREFIX + encodeURIComponent(M().assertId(sessionId, '世界存档 ID'));
    const remapBranchSession = (branch, oldId, newId) => {
        const visit = value => {
            if (!value || typeof value !== 'object') return;
            if (value.sessionId === oldId) value.sessionId = newId;
            for (const item of Object.values(value)) if (item && typeof item === 'object') visit(item);
        };
        visit(branch);
    };
    const metadata = session => ({ sessionId: session.sessionId, name: session.definition.name,
        versionLabel: '版本 ' + (session.definition.revision || 1),
        activeBranchId: session.activeBranchId, recordedAt: session.recordedAt,
        branches: Object.values(session.branches).map(b => ({ branchId: b.branchId, name: b.name, revision: b.revision,
            parentBranchId: b.parentBranchId || null, forkAtSeq: b.forkAtSeq ?? null, eventCount: b.events.length, storyTime: b.storyTime })) });
    const flatten = (session, branchId) => {
        const branch = session.branches[branchId || session.activeBranchId];
        if (!branch) M().fail('世界分支不存在', 'WORLD_NOT_FOUND');
        return { ...M().clone(branch), schemaVersion: M().SCHEMA_VERSION, sessionId: session.sessionId,
            definition: M().clone(session.definition), branches: metadata(session).branches };
    };
    const create = async ({ definition, storyTime = '2026-05-12T17:00:00', sessionId, conversations = [], actorStates = {}, initialEvents = [] } = {}) => {
        const normalized = M().normalizeDefinition(definition), sid = sessionId || M().id('session');
        if (!Number.isFinite(M().storyTimeNumber(storyTime))) M().fail('剧情时间无效');
        for (const actor of normalized.actors) if (actor.card) {
            const value = await M().hash(actor.card, actor.cardHash?.split(':')[0]);
            if (actor.cardHash && actor.cardHash !== value) M().fail('角色卡快照与摘要不匹配');
            actor.cardHash = value;
        }
        if (normalized.map && !normalized.mapHash) normalized.mapHash = await M().hash(normalized.map);
        const states = { ...Object.fromEntries(normalized.actors.map(a => [a.actorId, M().clone(a.initialState || {})])), ...M().clone(actorStates) };
        const initialConversations = conversations.map(c => M().normalizeConversation(c, normalized, 0));
        const baseState = { conversations: initialConversations, actorStates: states, turns: {}, pendingActions: [], storyTime };
        const session = { schemaVersion: M().SCHEMA_VERSION, sessionId: sid, definition: normalized,
            activeBranchId: 'main', recordedAt: new Date().toISOString(), branches: { main: {
                branchId: 'main', name: '主线', revision: 0, storyTime, events: [], ...M().clone(baseState), baseState,
                idempotency: {}, parentBranchId: null, forkAtSeq: null
            } } };
        // Conversations and the card opening are part of the first atomic write.
        // Do not rewrite the full map/card snapshot once for each setup step.
        const snapshot = flatten(session, 'main');
        for (const draft of initialEvents) {
            const event = { ...M().clone(draft), eventId: draft.eventId || M().id('event'), seq: snapshot.events.length + 1,
                sessionId: sid, branchId: 'main', storyTime: draft.storyTime || storyTime, recordedAt: new Date().toISOString() };
            if (event.storyTime !== storyTime || snapshot.events.some(e => e.eventId === event.eventId)) M().fail('开局事件时间或 ID 无效');
            M().validateEvent(event, snapshot, { persisted: true }); P().applyEvent(snapshot, event); snapshot.events.push(event);
        }
        session.branches.main.events = snapshot.events;
        session.branches.main.conversations = snapshot.conversations;
        session.branches.main.actorStates = snapshot.actorStates;
        session.branches.main.turns = snapshot.turns;
        session.branches.main.pendingActions = snapshot.pendingActions;
        await S().updateStoredValue(key(sid), old => { if (old) M().fail('世界存档 ID 已存在', 'WORLD_EXISTS'); return session; });
        return flatten(session, 'main');
    };
    const load = async (sessionId, branchId) => {
        const session = await S().getStoredValue(key(sessionId));
        if (!session) M().fail('世界存档不存在', 'WORLD_NOT_FOUND');
        if (session.schemaVersion !== M().SCHEMA_VERSION) M().fail('世界存档版本不兼容');
        return flatten(session, branchId);
    };
    const list = async () => {
        // The fallback is retained for lightweight pure-function test harnesses.
        const entries = S().getStoredEntriesByPrefix ? await S().getStoredEntriesByPrefix(PREFIX)
            : (await S().readStorageSnapshot()).filter(([k]) => k.startsWith(PREFIX));
        return entries.map(([, session]) => metadata(session)).sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)));
    };
    const patchEvents = (snapshot, patch, turnId) => {
        const result = [], admin = snapshot.definition.playerActorId;
        const hidden = { principals: [] };
        if (patch.conversations) for (const conversation of patch.conversations) result.push({ kind: 'conversation.created', actorId: admin,
            conversationId: conversation.conversationId, access: hidden, payload: { conversation: M().normalizeConversation(conversation, snapshot.definition, snapshot.events.length + 1) }, turnId });
        if (patch.actorStates) for (const [actorId, state] of Object.entries(patch.actorStates)) result.push({ kind: 'actor.state_changed', actorId, access: { principals: [actorId] }, payload: { state }, turnId });
        if (patch.turns) for (const [tid, turn] of Object.entries(patch.turns)) result.push({ kind: 'turn.updated', actorId: admin, access: hidden, turnId: tid, payload: { turnId: tid, turn } });
        if (patch.pendingActions) result.push({ kind: 'pending.replaced', actorId: admin, access: hidden, payload: { pendingActions: patch.pendingActions }, turnId });
        if (patch.storyTime != null && patch.storyTime !== snapshot.storyTime) {
            if (!Number.isFinite(M().storyTimeNumber(patch.storyTime)) || M().storyTimeNumber(patch.storyTime) < M().storyTimeNumber(snapshot.storyTime)) M().fail('剧情时间不能无效或倒退，请建立历史分支');
            result.push({ kind: 'world.clock_advanced', actorId: admin, access: hidden, payload: { storyTime: patch.storyTime }, turnId });
        }
        return result;
    };
    const commit = async ({ sessionId, branchId, expectedRevision, idempotencyKey, events = [], patch = {}, turnId } = {}) => {
        if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 500) M().fail('世界提交缺少幂等键');
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) M().fail('世界提交缺少预期版本');
        let committedIds = [];
        const session = await S().updateStoredValue(key(sessionId), current => {
            if (!current) M().fail('世界存档不存在', 'WORLD_NOT_FOUND');
            const b = current.branches[branchId || current.activeBranchId];
            if (!b) M().fail('世界分支不存在', 'WORLD_NOT_FOUND');
            if (Object.prototype.hasOwnProperty.call(b.idempotency || {}, idempotencyKey)) {
                committedIds = b.idempotency[idempotencyKey].eventIds; return current;
            }
            if (b.revision !== expectedRevision) M().fail('世界已被其他操作更新，请重新读取后继续', 'WORLD_CONFLICT');
            const snapshot = flatten(current, b.branchId);
            const generated = patchEvents(snapshot, patch, turnId);
            // New conversations must exist before messages in this same batch.
            const accepted = [...generated.filter(e => e.kind === 'conversation.created'), ...events,
                ...generated.filter(e => e.kind !== 'conversation.created')];
            for (let i = 0; i < accepted.length; i++) {
                const draft = M().clone(accepted[i]);
                const event = { ...draft, eventId: draft.eventId || M().id('event'), seq: snapshot.events.length + 1,
                    sessionId, branchId: b.branchId, storyTime: draft.storyTime || patch.storyTime || snapshot.storyTime,
                    recordedAt: new Date().toISOString(), causedBy: draft.causedBy || [], source: draft.source || { kind: 'program' } };
                if (snapshot.events.some(e => e.eventId === event.eventId)) M().fail('事件 ID 重复');
                if (!Number.isFinite(M().storyTimeNumber(event.storyTime))) M().fail('事件剧情时间无效');
                if (M().storyTimeNumber(event.storyTime) < M().storyTimeNumber(snapshot.storyTime)
                    || M().storyTimeNumber(event.storyTime) > M().storyTimeNumber(patch.storyTime || snapshot.storyTime)) M().fail('事件超出本轮剧情时间边界');
                M().validateEvent(event, snapshot, { persisted: true });
                P().applyEvent(snapshot, event); snapshot.events.push(event); committedIds.push(event.eventId);
            }
            snapshot.revision++;
            snapshot.idempotency[idempotencyKey] = { revision: snapshot.revision, eventIds: committedIds };
            delete snapshot.definition; delete snapshot.sessionId; delete snapshot.schemaVersion; delete snapshot.branches;
            current.branches[b.branchId] = snapshot;
            return current;
        });
        return { ...flatten(session, branchId), commitEventIds: committedIds };
    };
    const fork = async ({ sessionId, branchId, atSeq, name = '新分支', newBranchId } = {}) => {
        const target = newBranchId || M().id('branch');
        const session = await S().updateStoredValue(key(sessionId), current => {
            if (!current) M().fail('世界存档不存在');
            const snapshot = flatten(current, branchId), throughSeq = atSeq == null ? snapshot.events.length : atSeq;
            if (current.branches[target]) M().fail('分支 ID 已存在');
            const copy = P().replay(snapshot, { throughSeq });
            copy.branchId = target; copy.parentBranchId = snapshot.branchId; copy.forkAtSeq = throughSeq;
            copy.name = String(name || '新分支').slice(0, 120); copy.revision = 0; copy.idempotency = {}; copy.turns = {};
            copy.events = copy.events.map(e => ({ ...e, branchId: target }));
            // Resuming an old generation on a new branch is never permitted.
            copy.baseState.turns = {};
            delete copy.definition; delete copy.sessionId; delete copy.schemaVersion; delete copy.branches; delete copy.commitEventIds;
            current.branches[target] = copy; current.activeBranchId = target;
            return current;
        });
        return flatten(session, target);
    };
    const selectBranch = async (sessionId, branchId) => {
        const session = await S().updateStoredValue(key(sessionId), current => {
            if (!current?.branches[branchId]) M().fail('世界分支不存在');
            current.activeBranchId = branchId; return current;
        });
        return flatten(session, branchId);
    };
    const validateSession = session => {
        if (!session || session.schemaVersion !== M().SCHEMA_VERSION || !session.branches || typeof session.branches !== 'object') M().fail('世界包版本或结构不兼容');
        M().assertId(session.sessionId, '世界存档 ID');
        session.definition = M().normalizeDefinition(session.definition);
        if (!session.branches[session.activeBranchId]) M().fail('世界包活动分支无效');
        for (const [branchId, branch] of Object.entries(session.branches)) {
            M().assertId(branchId, '分支 ID');
            if (branch.branchId !== branchId || !Array.isArray(branch.events) || !branch.baseState || !Number.isSafeInteger(branch.revision) || branch.revision < 0) M().fail('世界分支结构无效');
            if (branch.parentBranchId && (!session.branches[branch.parentBranchId] || branch.parentBranchId === branchId
                || !Number.isSafeInteger(branch.forkAtSeq) || branch.forkAtSeq < 0 || branch.forkAtSeq > session.branches[branch.parentBranchId].events.length)) M().fail('世界分支父节点或分叉位置无效');
            const seenParents = new Set([branchId]); let parent = branch.parentBranchId;
            while (parent) { if (seenParents.has(parent)) M().fail('世界分支存在循环'); seenParents.add(parent); parent = session.branches[parent]?.parentBranchId; }
            const base = { ...M().clone(branch), definition: session.definition, sessionId: session.sessionId, events: [],
                conversations: (branch.baseState.conversations || []).map(c => M().normalizeConversation(c, session.definition, 0)),
                actorStates: M().clone(branch.baseState.actorStates || {}), turns: {}, pendingActions: [], storyTime: branch.baseState.storyTime };
            const ids = new Set();
            if (!Number.isFinite(M().storyTimeNumber(base.storyTime))) M().fail('世界包开局剧情时间无效');
            let lastTime = M().storyTimeNumber(base.storyTime);
            for (let i = 0; i < branch.events.length; i++) {
                const event = branch.events[i];
                if (event.seq !== i + 1 || ids.has(event.eventId)) M().fail('世界事件序列或 ID 重复');
                const eventTime = M().storyTimeNumber(event.storyTime);
                if (!Number.isFinite(eventTime) || eventTime < lastTime) M().fail('事件剧情时间无效或倒退');
                lastTime = eventTime;
                M().validateEvent(event, base, { persisted: true }); ids.add(event.eventId);
                P().applyEvent(base, event); base.events.push(event);
            }
            if (branch.pendingActions?.some(a => a.actorId && !session.definition.actors.some(actor => actor.actorId === a.actorId))) M().fail('待办引用不存在的人物');
            for (const record of Object.values(branch.idempotency || {})) if (!Array.isArray(record.eventIds) || record.eventIds.some(e => !ids.has(e))) M().fail('幂等记录来源无效');
            // Required projections are rebuilt from events rather than trusting a package cache.
            branch.conversations = base.conversations; branch.actorStates = base.actorStates; branch.pendingActions = base.pendingActions;
            branch.storyTime = base.storyTime; branch.turns = base.turns;
        }
        return session;
    };
    const exportSession = async sessionId => {
        const session = await S().getStoredValue(key(sessionId));
        if (!session) M().fail('世界存档不存在');
        return { format: 'rphub-world', schemaVersion: M().SCHEMA_VERSION, exportedAt: new Date().toISOString(), session: M().clone(session) };
    };
    const importSession = async (pkg, options = {}) => {
        if (pkg?.format !== 'rphub-world' || pkg.schemaVersion !== M().SCHEMA_VERSION) M().fail('请选择兼容的世界存档包');
        const session = validateSession(M().clone(pkg.session));
        for (const actor of session.definition.actors) if (actor.card && actor.cardHash && actor.cardHash !== await M().hash(actor.card, actor.cardHash.split(':')[0])) M().fail('世界包角色卡校验失败');
        if (session.definition.map && session.definition.mapHash && session.definition.mapHash !== await M().hash(session.definition.map, session.definition.mapHash.split(':')[0])) M().fail('世界包地图校验失败');
        if (options.asNew !== false) {
            const oldId = session.sessionId;
            session.sessionId = M().id('session');
            for (const branch of Object.values(session.branches)) remapBranchSession(branch, oldId, session.sessionId);
        }
        await S().updateStoredValue(key(session.sessionId), old => { if (old) M().fail('世界存档 ID 已存在；请作为新存档导入', 'WORLD_EXISTS'); return session; });
        return flatten(session);
    };
    // Card/map changes create a separate session. Existing worlds keep the exact
    // definition that generated their history, including every previous branch.
    const reviseDefinition = async ({ sessionId, definition, expectedDefinitionRevision, branchId, expectedRevision } = {}) => {
        const original = await S().getStoredValue(key(sessionId));
        if (!original) M().fail('世界存档不存在', 'WORLD_NOT_FOUND');
        const old = original.definition;
        if ((expectedDefinitionRevision != null && expectedDefinitionRevision !== old.revision)
            || (expectedRevision != null && original.branches[branchId]?.revision !== expectedRevision))
            M().fail('世界在编辑期间发生变化，请重新打开编辑页', 'WORLD_CONFLICT');
        const oldIds = old.actors.map(a => a.actorId).sort(), nextIds = (definition?.actors || []).map(a => a.actorId).sort();
        if (definition?.playerActorId !== old.playerActorId || JSON.stringify(oldIds) !== JSON.stringify(nextIds)) M().fail('更新卡牌必须保留玩家身份和全部人物 ID；新增或删除人物请另建世界');
        const next = M().normalizeDefinition(definition);
        if (next.worldId !== old.worldId) M().fail('卡牌修订必须属于同一个世界定义');
        next.revision = (Number(old.revision) || 1) + 1;
        for (const actor of next.actors) {
            const before = old.actors.find(a => a.actorId === actor.actorId);
            if (actor.card) actor.cardHash = await M().hash(actor.card);
            actor.cardRevision = (Number(before.cardRevision) || 1) + (actor.cardHash !== before.cardHash ? 1 : 0);
        }
        if (next.map) next.mapHash = await M().hash(next.map);
        else delete next.mapHash;
        const copy = M().clone(original), newId = M().id('session');
        copy.sessionId = newId; copy.definition = next; copy.recordedAt = new Date().toISOString();
        copy.sourceSessionId = sessionId; copy.sourceDefinitionRevision = old.revision || 1;
        for (const branch of Object.values(copy.branches)) remapBranchSession(branch, sessionId, newId);
        validateSession(copy);
        // Detect a source-world update during preparation; an old snapshot must
        // never be presented as a copy of the latest source world.
        const oldKey = key(sessionId), newKey = key(newId);
        await S().updateStoredValues([oldKey, newKey], records => {
            const latest = records[oldKey];
            if (!latest || latest.definition.revision !== old.revision || JSON.stringify(Object.values(latest.branches).map(b => [b.branchId, b.revision])) !==
                JSON.stringify(Object.values(original.branches).map(b => [b.branchId, b.revision]))) M().fail('原世界在卡牌准备期间发生变化，请重新打开更新界面', 'WORLD_CONFLICT');
            if (records[newKey]) M().fail('新存档 ID 已存在');
            return { [newKey]: copy };
        });
        return flatten(copy);
    };
    // An avatar change stays in the same save and leaves every event/card hash intact.
    const updateActorAvatar = async ({ sessionId, branchId, actorId, avatar, expectedDefinitionRevision } = {}) => {
        if (avatar !== '' && M().normalizeAvatar(avatar) !== avatar) M().fail('头像格式无效，请使用 JPG、PNG、WebP 或 GIF 图片');
        const session = await S().updateStoredValue(key(sessionId), current => {
            if (!current) M().fail('世界存档不存在', 'WORLD_NOT_FOUND');
            if (expectedDefinitionRevision != null && current.definition.revision !== expectedDefinitionRevision)
                M().fail('世界资料已更新，请重新打开后设置头像', 'WORLD_CONFLICT');
            const actor = current.definition.actors.find(a => a.actorId === actorId);
            if (!actor) M().fail('人物不在当前世界');
            actor.avatar = avatar;
            current.definition.revision = (current.definition.revision || 1) + 1;
            current.recordedAt = new Date().toISOString();
            return current;
        });
        return flatten(session, branchId);
    };
    window.RPHubWorldStore = Object.freeze({ PREFIX, key, create, list, load, commit, fork, selectBranch,
        validateSession, exportSession, importSession, reviseDefinition, updateActorAvatar });
})();
