/** World UI adapter. Legacy character histories are never used as world evidence. */
(function () {
    window.RPHubAppSections.worldSession = function (__s) {
        const { ref, reactive, computed, watch, nextTick } = Vue;
        const S = window.RPHubWorldStore, M = window.RPHubWorldModel, P = window.RPHubWorldProjections;
        const worldSnapshot = ref(null), worldSessions = ref([]), worldBranches = ref([]);
        const worldBusy = ref(false), worldError = ref(''), worldInput = ref(''), worldConversationId = ref('');
        const worldActorSelection = ref([]), worldShowSetup = ref(false), worldShowEvidence = ref(false);
        const worldEvidenceActor = ref('player'), worldGroupName = ref('朋友们'), worldGroupMembers = ref([]);
        const worldGroupEditor = ref(false), worldCheckpointSeq = ref(0), worldBranchName = ref('');
        const worldStateActor = ref(''), worldStatePhone = ref('unknown'), worldStateActivity = ref('');
        const worldStatePlace = ref(''), worldStateUntil = ref(''), worldNextTime = ref('');
        const worldTranscript = ref(null), worldSourceCardId = ref(''), worldImportPreview = ref(null);
        const worldUpdateActor = ref(''), worldUpdateCard = ref(null), worldUpdateSource = ref(''), worldInputMode = ref('player_action');
        const worldBurstMode = ref(false), worldMemoryEnabled = ref(true), worldContextBudget = ref(60000), worldProgress = ref('');
        let controller = null, viewEpoch = 0, opened = false;
        const draftActor = (actorId, name, userBinding = 'player') => ({ actorId, name, card: null, sourcePath: '', bindings: { user: userBinding, partner: userBinding }, enabled: true });
        const worldDraft = reactive({ name: '江南大学', playerName: '', playerDescription: '', storyTime: '2025-03-11T18:30', mapId: 'jiangnan-south-campus', publicLore: '',
            actors: [draftActor('suqixue', '苏祈雪'), draftActor('linwan', '林晚', 'qing'), draftActor('qing', '卿')] });
        const worldActors = computed(() => worldSnapshot.value?.definition.actors || []);
        const worldNpcs = computed(() => worldActors.value.filter(a => a.actorId !== worldSnapshot.value.definition.playerActorId && a.enabled !== false));
        const worldConversations = computed(() => (worldSnapshot.value?.conversations || []).filter(c => c.kind === 'rp' || c.participantActorIds.includes(worldSnapshot.value.definition.playerActorId)));
        const worldConversation = computed(() => worldConversations.value.find(c => c.conversationId === worldConversationId.value));
        const worldMessages = computed(() => {
            const s = worldSnapshot.value, c = worldConversation.value;
            if (!s || !c) return [];
            if (c.kind === 'rp') return s.events.filter(e => e.conversationId === c.conversationId && (e.kind === 'player.input' || e.kind === 'narration.published'));
            return P.conversationMessages(s, c.conversationId, s.definition.playerActorId);
        });
        const worldRetryable = computed(() => Object.values(worldSnapshot.value?.turns || {}).filter(t => !['completed', 'complete', 'cancelled'].includes(t.status)));
        const worldEvidence = computed(() => worldSnapshot.value ? P.observedEvents(worldSnapshot.value, worldEvidenceActor.value) : []);
        const worldMemories = computed(() => worldSnapshot.value ? window.RPHubWorldMemory.records(worldSnapshot.value, worldEvidenceActor.value) : []);
        const worldUnansweredCount = computed(() => worldSnapshot.value ? window.RPHubWeChatProtocol.countUnanswered(
            window.RPHubWorldChat.pendingInputs(worldSnapshot.value, worldConversationId.value).map(() => ({ isUser: true }))) : 0);
        const worldMemoryWarning = computed(() => Object.values(worldSnapshot.value?.turns || {}).at(-1)?.memoryWarning || '');
        const actorName = id => worldActors.value.find(a => a.actorId === id)?.name || id;
        const eventText = e => e.payload?.text || e.payload?.content || e.payload?.narration || '';
        const worldSpeaker = e => e.kind === 'narration.published' ? '叙述' : actorName(e.actorId);
        const worldIsSelf = e => e.actorId === worldSnapshot.value?.definition.playerActorId && e.kind !== 'narration.published';
        const worldCardIssues = actor => {
            if (!actor.card) return ['尚未提供角色卡，暂不参与模拟'];
            const report = M.preflightCard(actor.card, { actorId: actor.actorId, bindings: actor.bindings, baseline: 'suqixue' });
            return Array.isArray(report) ? report.map(i => typeof i === 'string' ? i : i.message) : [...(report.conflicts || []), ...(report.warnings || [])].map(i => typeof i === 'string' ? i : i.message);
        };
        const fail = e => { worldError.value = e?.message || String(e); };
        const cancel = () => { viewEpoch++; controller?.abort(); controller = null; worldBusy.value = false; };
        const scroll = async () => { await nextTick(); const node = worldTranscript.value; if (node) node.scrollTop = node.scrollHeight; };
        const accept = async snapshot => {
            worldSnapshot.value = snapshot;
            if (!worldConversation.value) worldConversationId.value = worldConversations.value[0]?.conversationId || '';
            worldCheckpointSeq.value = snapshot.events.length;
            worldNextTime.value = String(snapshot.storyTime || '').slice(0, 16);
            await scroll();
        };
        const refreshList = async () => { worldSessions.value = await S.list(); };
        const refreshBranches = async () => {
            if (!worldSnapshot.value) return;
            worldBranches.value = worldSnapshot.value.branches || [];
        };
        const worldOpen = async (sessionId, branchId) => {
            cancel(); worldError.value = '';
            const epoch = viewEpoch;
            try {
                let snapshot = branchId ? await S.selectBranch(sessionId, branchId) : await S.load(sessionId);
                snapshot = await window.RPHubWorldChat.ensureOpening(snapshot);
                if (epoch !== viewEpoch) return;
                await accept(snapshot); await refreshBranches(); worldShowSetup.value = false;
                worldActorSelection.value = worldActorSelection.value.filter(id => worldNpcs.value.some(a => a.actorId === id));
                if (!worldActorSelection.value.length) worldActorSelection.value = worldNpcs.value.slice(0, 1).map(a => a.actorId);
            }
            catch (e) { fail(e); }
        };
        const worldNew = () => {
            cancel(); worldShowSetup.value = true; worldError.value = '';
            worldDraft.playerName = __s.user.name === '请前往设置自定义你的名称' ? '' : __s.user.name;
            worldDraft.playerDescription = __s.user.description || '';
        };
        const worldAddActor = () => worldDraft.actors.push(draftActor(M.id('actor'), '新人物'));
        const worldUseCard = (actor, cardId) => {
            const source = __s.characters.value.find(c => c.uuid === cardId);
            if (!source) return;
            actor.card = JSON.parse(JSON.stringify(source)); actor.name = source.name; actor.sourcePath = '角色管理/' + source.uuid;
        };
        const worldReadCard = async (event, actor) => {
            const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
            try {
                const raw = JSON.parse(await file.text()), parsed = window.RPHubCardUtils.parseImportedCharacterCard(raw);
                if (!parsed.name || parsed.name === 'Unknown') throw new Error('角色卡缺少姓名');
                actor.card = { ...parsed, worldInfo: parsed.worldInfoEntries, originalCard: raw };
                actor.name = parsed.name; actor.sourcePath = file.name; worldError.value = '';
            } catch (e) { fail(e); }
        };
        const worldCreate = async () => {
            if (worldBusy.value) return;
            worldBusy.value = true; worldError.value = '';
            try {
                if (!worldDraft.playerName.trim() || !worldDraft.storyTime) throw new Error('请填写玩家姓名和开局剧情时间');
                if (!worldDraft.actors.some(a => a.card && a.enabled)) throw new Error('至少需要一张已启用的适配角色卡');
                const actors = [{ actorId: 'player', name: worldDraft.playerName.trim(), kind: 'player', publicProfile: worldDraft.playerDescription,
                    card: { name: worldDraft.playerName.trim(), personality: worldDraft.playerDescription } }];
                for (const a of worldDraft.actors) {
                    if (a.card && a.enabled) {
                        const report = M.preflightCard(a.card, { actorId: a.actorId, bindings: a.bindings });
                        if (!report.ok) throw new Error(a.name + '：' + report.conflicts.filter(i => i.blocking).map(i => i.message).join('；'));
                    }
                    actors.push({ actorId: a.actorId, name: a.name, kind: 'npc', enabled: !!a.card && a.enabled,
                    card: a.card ? JSON.parse(JSON.stringify(a.card)) : { name: a.name, personality: '' }, sourcePath: a.sourcePath,
                    bindings: { ...a.bindings }, cardStatus: a.card ? 'provided' : 'missing' });
                }
                const map = worldDraft.mapId ? __s.getGeographyWorld(worldDraft.mapId) : null;
                let mapImageData = null;
                if (map) mapImageData = await __s.getMapImage(map.id);
                const definition = { worldId: M.id('world'), name: worldDraft.name.trim() || '江南大学', baseline: 'suqixue', playerActorId: 'player', actors,
                    map: map ? JSON.parse(JSON.stringify(map)) : null, mapImageData,
                    publicLore: worldDraft.publicLore, rules: { playerDriven: true, npcCamera: true, maxActors: 3, maxCalls: 6, maxDepth: 2 } };
                let snapshot = await S.create({ definition, storyTime: worldDraft.storyTime });
                const conversations = [{ conversationId: 'rp-main', kind: 'rp', name: '世界剧情', participantActorIds: actors.map(a => a.actorId) },
                    ...actors.filter(a => a.kind === 'npc' && a.enabled).map(a => ({ conversationId: 'dm-' + a.actorId, kind: 'dm', name: a.name, participantActorIds: ['player', a.actorId] }))];
                snapshot = await S.commit({ sessionId: snapshot.sessionId, branchId: snapshot.branchId, expectedRevision: snapshot.revision,
                    idempotencyKey: 'setup-conversations', events: [], patch: { conversations } });
                snapshot = await window.RPHubWorldChat.ensureOpening(snapshot);
                await accept(snapshot); await refreshList(); await refreshBranches(); worldShowSetup.value = false;
                worldActorSelection.value = actors.filter(a => a.kind === 'npc' && a.enabled).slice(0, 1).map(a => a.actorId);
            } catch (e) { fail(e); }
            finally { worldBusy.value = false; }
        };
        const apiConfig = () => ({ apiUrl: __s.settings.apiUrl, apiKey: __s.settings.apiKey,
            model: __s.settings.model || __s.settings.qualityModel || __s.settings.balancedModel || __s.settings.fastModel,
            temperature: __s.settings.temperature, stream: __s.settings.stream, reasoningEffort: __s.settings.reasoningEffort,
            contextBudget: Math.max(12000, Number(worldContextBudget.value) || 60000), memoryEnabled: worldMemoryEnabled.value,
            summaryModel: __s.memorySettings?.classicModel,
            onPhase: purpose => { worldProgress.value = purpose === 'memory' ? '正在整理人物记忆…' : purpose === 'narrator' ? '正在组织剧情…' : '人物正在回应…'; },
            onUsage: (usage, metadata) => __s.recordApiUsage?.(usage, { type: 'world', model: __s.settings.model,
                apiUrl: __s.settings.apiUrl, apiKey: __s.settings.apiKey, ...metadata }),
            logRequest: __s.settings.debugModelRequests === true });
        const validateApi = () => {
            const config = apiConfig();
            if (!config.apiUrl || !config.apiKey || !config.model) throw new Error('请在设置中配置 API 地址、密钥，并选择聊天模型；只有识图模型不能生成世界对话');
        };
        const execute = async args => {
            if (worldBusy.value || !worldSnapshot.value) return;
            controller = new AbortController(); const epoch = ++viewEpoch, captured = worldSnapshot.value;
            worldBusy.value = true; worldError.value = '';
            try {
                validateApi();
                const options = { sessionId: captured.sessionId, branchId: captured.branchId, apiConfig: apiConfig(), signal: controller.signal,
                    onUpdate: snapshot => { if (epoch === viewEpoch) { worldSnapshot.value = snapshot; if (args.text !== undefined) worldInput.value = ''; scroll(); } }, ...args };
                const snapshot = args.turnId ? await window.RPHubWorldOrchestrator.retryTurn(options) : await window.RPHubWorldOrchestrator.runTurn(options);
                if (epoch === viewEpoch) { await accept(snapshot); if (args.text !== undefined) worldInput.value = ''; await recordPlayerRead(epoch); }
            } catch (e) {
                if (epoch === viewEpoch) { fail(e); try { await accept(await S.load(captured.sessionId, captured.branchId)); } catch (_) {} }
            } finally { if (epoch === viewEpoch) { worldBusy.value = false; controller = null; } }
        };
        const worldSend = async () => {
            const c = worldConversation.value, text = worldInput.value.trim();
            if (!c || !text || worldBusy.value) return;
            if (worldRetryable.value.length) { fail(new Error('请先继续或结束未完成回合，再发送新的消息')); return; }
            if (c.kind === 'rp' && !worldActorSelection.value.length) { fail(new Error('请选出本轮在场或能听到玩家输入的人物')); return; }
            if (c.kind !== 'rp' && worldBurstMode.value) {
                worldBusy.value = true; worldError.value = '';
                try {
                    const s = worldSnapshot.value;
                    await accept(await window.RPHubWorldChat.send({ sessionId: s.sessionId, branchId: s.branchId, conversationId: c.conversationId, text }));
                    worldInput.value = '';
                } catch (e) { fail(e); } finally { worldBusy.value = false; }
                return;
            }
            await execute({ kind: c.kind === 'rp' ? 'rp' : 'wechat', conversationId: c.conversationId, text, actorIds: [...worldActorSelection.value], inputMode: worldInputMode.value });
        };
        const worldRequestReply = () => worldUnansweredCount.value ? execute({ kind: 'wechat', conversationId: worldConversationId.value, replyOnly: true }) : undefined;
        const worldSummarizeMemories = async () => {
            if (worldBusy.value || !worldSnapshot.value) return;
            controller = new AbortController(); const epoch = ++viewEpoch;
            worldBusy.value = true; worldError.value = '';
            try {
                validateApi();
                const budget = { callsUsed: 0, maxCalls: 6 };
                for (const a of worldNpcs.value) {
                    if (controller.signal.aborted || budget.callsUsed >= budget.maxCalls) break;
                    const captured = worldSnapshot.value;
                    const draft = await window.RPHubWorldMemory.summarize({ snapshot: captured, actorId: a.actorId,
                        apiConfig: apiConfig(), signal: controller.signal, budget });
                    if (epoch !== viewEpoch) return;
                    if (draft) await accept(await S.commit({ sessionId: captured.sessionId, branchId: captured.branchId,
                        expectedRevision: captured.revision, idempotencyKey: M.id('memory-summary'), events: [draft] }));
                }
            } catch (e) { if (epoch === viewEpoch) fail(e); }
            finally { if (epoch === viewEpoch) { worldBusy.value = false; controller = null; } }
        };
        const worldRetry = turnId => execute({ turnId });
        const worldAdvance = () => execute({ kind: 'advance', storyTime: worldNextTime.value, actorIds: [...worldActorSelection.value], conversationId: worldConversationId.value });
        const recordPlayerRead = async epoch => {
            const s = worldSnapshot.value, c = worldConversation.value;
            if (!s || !c || c.kind === 'rp' || (epoch !== undefined && epoch !== viewEpoch)) return;
            const unread = P.conversationMessages(s, c.conversationId, s.definition.playerActorId).filter(e => !P.hasObserved(s, e.eventId, s.definition.playerActorId));
            if (!unread.length) return;
            const updated = await S.commit({ sessionId: s.sessionId, branchId: s.branchId, expectedRevision: s.revision,
                idempotencyKey: M.id('player-read'), events: [{ kind: 'message.read', actorId: s.definition.playerActorId, conversationId: c.conversationId,
                    access: { principals: [s.definition.playerActorId] }, payload: { eventIds: unread.map(e => e.eventId) } }] });
            if (epoch === undefined || epoch === viewEpoch) await accept(updated);
        };
        const worldSelectConversation = async conversationId => {
            if (worldBusy.value) return;
            cancel(); worldConversationId.value = conversationId; worldInput.value = ''; worldError.value = '';
            try { await recordPlayerRead(viewEpoch); } catch (e) { fail(e); }
        };
        const worldEndTurn = async turnId => {
            if (worldBusy.value) return;
            const s = worldSnapshot.value, turn = s?.turns[turnId]; if (!turn) return;
            try {
                await accept(await S.commit({ sessionId: s.sessionId, branchId: s.branchId, expectedRevision: s.revision,
                    idempotencyKey: M.id('turn-end'), events: [], patch: { turns: { [turnId]: { ...turn, status: 'cancelled', endedByPlayer: true } } } }));
                worldError.value = '';
            } catch (e) { fail(e); }
        };
        const worldCreateGroup = async () => {
            const s = worldSnapshot.value; if (!s || worldBusy.value) return;
            if (!worldGroupMembers.value.length) { fail(new Error('请至少选择一个群成员')); return; }
            try {
                const c = { conversationId: M.id('group'), kind: 'group', name: worldGroupName.value.trim() || '朋友们',
                    participantActorIds: [s.definition.playerActorId, ...worldGroupMembers.value] };
                await accept(await S.commit({ sessionId: s.sessionId, branchId: s.branchId, expectedRevision: s.revision, idempotencyKey: M.id('group-create'), events: [], patch: { conversations: [c] } }));
                worldConversationId.value = c.conversationId; worldGroupEditor.value = false;
            } catch (e) { fail(e); }
        };
        const worldSaveActorState = async () => {
            const s = worldSnapshot.value; if (!s || !worldStateActor.value || worldBusy.value) return;
            try {
                const state = { ...(s.actorStates[worldStateActor.value] || {}), phoneAccess: worldStatePhone.value,
                    activity: worldStateActivity.value || 'unknown', position: worldStatePlace.value || null,
                    phoneRestrictedUntil: worldStateUntil.value || null, source: 'player_author', updatedAt: s.storyTime };
                await accept(await S.commit({ sessionId: s.sessionId, branchId: s.branchId, expectedRevision: s.revision,
                    idempotencyKey: M.id('actor-state'), events: [], patch: { actorStates: { [worldStateActor.value]: state } } }));
            } catch (e) { fail(e); }
        };
        const worldFork = async () => {
            const s = worldSnapshot.value; if (!s) return; cancel();
            try { const next = await S.fork({ sessionId: s.sessionId, branchId: s.branchId, atSeq: Number(worldCheckpointSeq.value), name: worldBranchName.value.trim() || '新分支' }); await accept(next); await refreshBranches(); }
            catch (e) { fail(e); }
        };
        const download = (data, filename) => {
            const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
            const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        const worldExport = async () => { try { download(await S.exportSession(worldSnapshot.value.sessionId), (worldSnapshot.value.definition.name || 'world') + '.rpworld.json'); } catch (e) { fail(e); } };
        const worldReadReplacement = async event => {
            const target = { card: null, name: '', sourcePath: '', bindings: {} };
            await worldReadCard(event, target);
            worldUpdateCard.value = target.card; worldUpdateSource.value = target.sourcePath;
        };
        const worldApplyReplacement = async () => {
            const s = worldSnapshot.value;
            if (!s || worldBusy.value || !worldUpdateActor.value || !worldUpdateCard.value) return;
            worldBusy.value = true; worldError.value = '';
            try {
                const definition = JSON.parse(JSON.stringify(s.definition)), a = definition.actors.find(a => a.actorId === worldUpdateActor.value);
                if (!a || a.actorId === definition.playerActorId) throw new Error('请选择要更新卡牌的 NPC');
                a.card = JSON.parse(JSON.stringify(worldUpdateCard.value)); a.sourcePath = worldUpdateSource.value;
                a.name = a.card.name || a.name; a.enabled = true; a.cardStatus = 'provided';
                const report = M.preflightCard(a.card, { actorId: a.actorId, bindings: a.bindings });
                if (!report.ok) throw new Error(report.conflicts.filter(i => i.blocking).map(i => i.message).join('；'));
                let snapshot = await S.reviseDefinition({ sessionId: s.sessionId, definition });
                const conversationId = 'dm-' + a.actorId;
                if (!snapshot.conversations.some(c => c.conversationId === conversationId)) snapshot = await S.commit({
                    sessionId: snapshot.sessionId, branchId: snapshot.branchId, expectedRevision: snapshot.revision, idempotencyKey: M.id('card-conversation'),
                    events: [], patch: { conversations: [{ conversationId, kind: 'dm', name: a.name, participantActorIds: [definition.playerActorId, a.actorId] }] } });
                await accept(snapshot); await refreshList(); await refreshBranches(); worldUpdateCard.value = null; worldUpdateSource.value = '';
                __s.showToast('角色卡已更新到新世界副本，原世界保留', 'success');
            } catch (e) { fail(e); }
            finally { worldBusy.value = false; }
        };
        const worldImport = async event => {
            const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
            try { const pkg = JSON.parse(await file.text()); S.validateSession(pkg.session); worldImportPreview.value = pkg; worldError.value = ''; }
            catch (e) { fail(e); }
        };
        const worldConfirmImport = async () => {
            if (!worldImportPreview.value) return; cancel();
            try { const snapshot = await S.importSession(worldImportPreview.value); await refreshList(); await accept(snapshot); await refreshBranches(); worldImportPreview.value = null; worldShowSetup.value = false; }
            catch (e) { fail(e); }
        };
        const load = __s.loadData;
        __s.loadData = async (...args) => { await load(...args); try { await refreshList(); } catch (e) { fail(e); } };
        watch(__s.currentView, async view => {
            if (view !== 'world') { if (opened) cancel(); return; }
            opened = true;
            if (__s.showWechatPanel) __s.showWechatPanel.value = false;
            if (!worldSnapshot.value && !worldShowSetup.value) { if (worldSessions.value.length) await worldOpen(worldSessions.value[0].sessionId); else worldNew(); }
        });
        watch(worldStateActor, actorId => {
            const state = worldSnapshot.value?.actorStates[actorId] || {};
            worldStatePhone.value = state.phoneAccess || 'unknown'; worldStateActivity.value = state.activity === 'unknown' ? '' : state.activity || '';
            worldStatePlace.value = typeof state.position === 'string' ? state.position : state.position?.placeId || ''; worldStateUntil.value = state.phoneRestrictedUntil || '';
        });
        const worldExports = { worldSnapshot, worldSessions, worldBranches, worldBusy, worldError, worldInput, worldConversationId, worldConversation, worldActorSelection,
            worldDraft, worldActors, worldNpcs, worldConversations, worldMessages, worldRetryable, worldEvidence, worldEvidenceActor, worldShowSetup, worldShowEvidence,
            worldGroupName, worldGroupMembers, worldGroupEditor, worldCheckpointSeq, worldBranchName, worldStateActor, worldStatePhone, worldStateActivity, worldStatePlace,
            worldStateUntil, worldNextTime, worldTranscript, worldSourceCardId, worldImportPreview, worldOpen, worldNew, worldAddActor, worldUseCard, worldReadCard,
            worldCreate, worldSend, worldRetry, worldEndTurn, worldAdvance, worldSelectConversation, worldCreateGroup, worldSaveActorState, worldFork, worldExport, worldImport,
            worldConfirmImport, worldStop: cancel, worldSpeaker, worldIsSelf, worldEventText: eventText, worldCardIssues, worldActorName: actorName };
        Object.assign(worldExports, { worldUpdateActor, worldUpdateCard, worldUpdateSource, worldReadReplacement, worldApplyReplacement, worldInputMode,
            worldBurstMode, worldUnansweredCount, worldRequestReply, worldMemoryEnabled, worldMemories, worldSummarizeMemories,
            worldContextBudget, worldProgress, worldMemoryWarning });
        Object.assign(__s, worldExports); __s.worldExports = worldExports;
        __s.worldUi = reactive(worldExports);
    };
})();
