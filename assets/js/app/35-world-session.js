/** World UI adapter. Legacy character histories are never used as world evidence. */
(function () {
    window.RPHubAppSections.worldSession = function (__s) {
        const { ref, reactive, computed, watch, nextTick, markRaw } = Vue;
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
        const worldEditing = ref(false), worldEditSource = ref(null);
        const cardIssueCache = new WeakMap();
        let preparedMap = null;
        const prepareMap = id => {
            if (!preparedMap || preparedMap.id !== id) {
                const promise = __s.getMapImage(id); preparedMap = { id, promise };
                promise.catch(() => { if (preparedMap?.promise === promise) preparedMap = null; });
            }
            return preparedMap.promise;
        };
        let controller = null, viewEpoch = 0, opened = false;
        const draftActor = (actorId, name, userBinding = 'player') => ({ actorId, name, card: null, avatar: '', sourcePath: '', bindings: { user: userBinding, partner: userBinding }, enabled: true });
        const freshDraft = () => ({ name: '江南大学', playerName: '', playerDescription: '', playerAvatar: '', storyTime: '2025-03-11T18:30', mapId: 'jiangnan-south-campus', publicLore: '',
            actors: [draftActor('suqixue', '苏祈雪'), draftActor('linwan', '林晚', 'qing'), draftActor('qing', '卿')] });
        const worldDraft = reactive(freshDraft());
        const worldActors = computed(() => worldSnapshot.value?.definition.actors || []);
        const worldNpcs = computed(() => worldActors.value.filter(a => a.actorId !== worldSnapshot.value.definition.playerActorId && a.enabled !== false));
        const worldConversations = computed(() => (worldSnapshot.value?.conversations || []).filter(c => c.kind === 'rp'
            || (c.participantActorIds.includes(worldSnapshot.value.definition.playerActorId) && (c.kind !== 'dm'
                || c.participantActorIds.some(id => id !== worldSnapshot.value.definition.playerActorId && worldNpcs.value.some(a => a.actorId === id)))))
            .map(c => c.kind === 'dm' ? { ...c, name: worldActors.value.find(a => c.participantActorIds.includes(a.actorId) && a.actorId !== worldSnapshot.value.definition.playerActorId)?.name || c.name } : c));
        const worldConversation = computed(() => worldConversations.value.find(c => c.conversationId === worldConversationId.value));
        const worldMessages = computed(() => {
            const s = worldSnapshot.value, c = worldConversation.value;
            if (!s || !c) return [];
            if (c.kind === 'rp') return s.events.filter(e => e.conversationId === c.conversationId
                && (e.kind === 'narration.published' || (e.kind === 'player.input' && String(e.payload?.text || '').trim())));
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
        const worldSpeaker = e => e.kind === 'narration.published' ? '叙述' : e.payload?.inputMode === 'author_premise' ? '剧情前提' : actorName(e.actorId);
        const worldIsSelf = e => e.actorId === worldSnapshot.value?.definition.playerActorId && e.kind !== 'narration.published';
        const avatarOf = a => M.normalizeAvatar(a?.avatar !== undefined ? a.avatar : M.cardData(a?.card).avatar);
        const worldAvatar = actorId => avatarOf(worldActors.value.find(a => a.actorId === actorId));
        const worldConversationActor = c => c?.kind === 'dm' ? c.participantActorIds.find(id => id !== worldSnapshot.value?.definition.playerActorId) : '';
        const worldConversationPreview = c => {
            const s = worldSnapshot.value;
            if (!s) return '';
            const messages = c.kind === 'rp' ? s.events.filter(e => e.conversationId === c.conversationId && e.kind === 'narration.published')
                : P.conversationMessages(s, c.conversationId, s.definition.playerActorId);
            return String(eventText(messages.at(-1) || {}) || (c.kind === 'rp' ? '写下行动，继续故事' : c.kind === 'group' ? '一起聊点什么' : '开始一段对话')).replace(/\s+/g, ' ').slice(0, 48);
        };
        const worldFormatTime = value => String(value || '').slice(5, 16).replace('T', ' · ');
        const worldRenderText = text => window.DOMPurify && window.marked
            ? window.DOMPurify.sanitize(window.marked.parse(String(text || '')), { FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button'] })
            : String(text || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
        const worldCardIssues = actor => {
            if (!actor.card) return ['尚未提供角色卡，暂不参与模拟'];
            const key = JSON.stringify([actor.actorId, actor.bindings]);
            const cached = cardIssueCache.get(actor.card); if (cached?.key === key) return cached.issues;
            const report = M.preflightCard(actor.card, { actorId: actor.actorId, bindings: actor.bindings, baseline: 'suqixue' });
            const issues = [...(report.conflicts || [])].map(i => typeof i === 'string' ? i : i.message);
            cardIssueCache.set(actor.card, { key, issues }); return issues;
        };
        const fail = e => { worldError.value = e?.message || String(e); };
        const cancel = () => { viewEpoch++; controller?.abort(); controller = null; worldBusy.value = false; };
        const scroll = async () => { await nextTick(); const node = worldTranscript.value; if (node) node.scrollTop = node.scrollHeight; };
        const accept = async snapshot => {
            markRaw(snapshot.definition);
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
                await accept(snapshot); await refreshBranches(); worldShowSetup.value = false; worldEditing.value = false; worldEditSource.value = null;
                worldActorSelection.value = worldActorSelection.value.filter(id => worldNpcs.value.some(a => a.actorId === id));
                if (!worldActorSelection.value.length) worldActorSelection.value = worldNpcs.value.slice(0, 1).map(a => a.actorId);
            }
            catch (e) { fail(e); }
        };
        const worldNew = () => {
            if (worldBusy.value) return;
            cancel(); Object.assign(worldDraft, freshDraft()); worldEditing.value = false; worldEditSource.value = null;
            worldShowSetup.value = true; worldError.value = '';
            worldDraft.playerName = __s.user.name === '请前往设置自定义你的名称' ? '' : __s.user.name;
            worldDraft.playerDescription = __s.user.description || '';
            worldDraft.playerAvatar = M.normalizeAvatar(__s.user.avatar);
        };
        const worldEdit = () => {
            const s = worldSnapshot.value; if (!s || worldBusy.value) return;
            worldEditSource.value = M.clone(s); worldEditing.value = true; worldError.value = '';
            const player = s.definition.actors.find(a => a.actorId === s.definition.playerActorId);
            Object.assign(worldDraft, { name: s.definition.name, playerName: player.name, playerDescription: player.publicProfile || M.cardData(player.card).personality || '',
                playerAvatar: avatarOf(player), storyTime: s.storyTime.slice(0, 16), mapId: s.definition.map?.id || '', publicLore: s.definition.publicLore || '',
                actors: s.definition.actors.filter(a => a.actorId !== s.definition.playerActorId).map(a => ({ ...M.clone(a), avatar: avatarOf(a),
                    card: a.cardStatus === 'missing' ? null : a.card ? markRaw(M.clone(a.card)) : null, sourcePath: a.sourcePath || '', bindings: { user: 'player', ...a.bindings } })) });
            worldShowSetup.value = true;
        };
        const worldCancelSetup = () => { if (worldBusy.value) return; worldShowSetup.value = false; worldEditing.value = false; worldEditSource.value = null; worldError.value = ''; };
        const worldAddActor = () => { if (!worldEditing.value) worldDraft.actors.push(draftActor(M.id('actor'), '新人物')); };
        const worldRemoveDraftActor = actorId => {
            if (worldEditing.value) return;
            worldDraft.actors = worldDraft.actors.filter(a => a.actorId !== actorId);
            for (const a of worldDraft.actors) for (const slot of Object.keys(a.bindings)) if (a.bindings[slot] === actorId) a.bindings[slot] = 'player';
        };
        const worldUseCard = (actor, cardId) => {
            const source = __s.characters.value.find(c => c.uuid === cardId);
            if (!source) return;
            actor.card = markRaw(JSON.parse(JSON.stringify(source))); actor.name = source.name; actor.sourcePath = '角色管理/' + source.uuid;
            actor.avatar = M.normalizeAvatar(source.avatar) || actor.avatar; actor.enabled = true;
        };
        const worldReadCard = async (event, actor) => {
            const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
            try {
                const raw = JSON.parse(await file.text()), parsed = window.RPHubCardUtils.parseImportedCharacterCard(raw);
                if (!parsed.name || parsed.name === 'Unknown') throw new Error('角色卡缺少姓名');
                actor.card = markRaw({ ...parsed, worldInfo: parsed.worldInfoEntries, originalCard: raw });
                actor.name = parsed.name; actor.sourcePath = file.name; actor.enabled = true;
                actor.avatar = M.normalizeAvatar(raw.avatar || raw.data?.avatar || raw.data?.extensions?.rp_hub_avatar) || actor.avatar || '';
                worldError.value = '';
            } catch (e) { fail(e); }
        };
        const readAvatar = async file => {
            if (!/^image\/(png|jpeg|webp|gif|avif)$/i.test(file.type)) throw new Error('请选择 JPG、PNG、WebP 或 GIF 图片');
            if (file.size > 10 * 1024 * 1024) throw new Error('头像图片不能超过 10 MB');
            const url = URL.createObjectURL(file);
            try {
                const img = new Image(); img.src = url; await img.decode();
                const size = Math.min(384, img.naturalWidth, img.naturalHeight);
                if (!size) throw new Error('无法读取这张图片，请换一张头像');
                const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
                const side = Math.min(img.naturalWidth, img.naturalHeight);
                canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
                return canvas.toDataURL('image/png');
            } finally { URL.revokeObjectURL(url); }
        };
        const worldReadAvatar = async (event, actor) => {
            const file = event.target.files?.[0]; event.target.value = ''; if (!file || worldBusy.value) return;
            const epoch = viewEpoch, draft = worldDraft.actors;
            try {
                const avatar = await readAvatar(file);
                if (epoch !== viewEpoch || draft !== worldDraft.actors) return;
                if (actor) actor.avatar = avatar; else worldDraft.playerAvatar = avatar;
                worldError.value = '';
            } catch (e) { fail(e); }
        };
        const worldSaveAvatar = async (event, actorId, remove = false) => {
            const file = event?.target.files?.[0]; if (event) event.target.value = '';
            const s = worldSnapshot.value; if (!s || worldBusy.value || (!file && !remove)) return;
            const epoch = viewEpoch; worldBusy.value = true; worldError.value = '';
            try {
                const avatar = remove ? '' : await readAvatar(file);
                if (epoch !== viewEpoch) return;
                const updated = await S.updateActorAvatar({ sessionId: s.sessionId, branchId: s.branchId, actorId, avatar, expectedDefinitionRevision: s.definition.revision });
                if (epoch !== viewEpoch) return;
                await accept(updated); __s.showToast(remove ? '头像已移除' : '头像已保存', 'success');
            } catch (e) { if (epoch === viewEpoch) fail(e); }
            finally { if (epoch === viewEpoch) worldBusy.value = false; }
        };
        const worldCreate = async () => {
            if (worldBusy.value) return;
            const epoch = ++viewEpoch;
            worldBusy.value = true; worldError.value = ''; worldProgress.value = '正在检查世界与人物…';
            try {
                await nextTick();
                if (epoch !== viewEpoch) return;
                if (!worldDraft.playerName.trim() || !worldDraft.storyTime) throw new Error('请填写玩家姓名和开局剧情时间');
                if (!worldDraft.actors.some(a => a.card && a.enabled)) throw new Error('至少需要一张已启用的适配角色卡');
                const previous = worldEditing.value ? worldEditSource.value : null;
                const playerId = previous?.definition.playerActorId || 'player';
                const previousPlayer = previous?.definition.actors.find(a => a.actorId === playerId);
                const actors = [{ ...previousPlayer, actorId: playerId, name: worldDraft.playerName.trim(), kind: 'player', publicProfile: worldDraft.playerDescription,
                    avatar: worldDraft.playerAvatar, card: { ...M.cardData(previousPlayer?.card), name: worldDraft.playerName.trim(), personality: worldDraft.playerDescription } }];
                for (const a of worldDraft.actors) {
                    if (!a.name.trim()) throw new Error('请为每个人物填写姓名');
                    if (a.card && a.enabled) {
                        const report = M.preflightCard(a.card, { actorId: a.actorId, bindings: a.bindings });
                        if (!report.ok) throw new Error(a.name + '：' + report.conflicts.filter(i => i.blocking).map(i => i.message).join('；'));
                    }
                    actors.push({ ...a, actorId: a.actorId, name: a.name.trim(), avatar: a.avatar, kind: 'npc', enabled: !!a.card && a.enabled,
                    card: a.card ? JSON.parse(JSON.stringify(a.card)) : { name: a.name, personality: '' }, sourcePath: a.sourcePath,
                    bindings: { ...a.bindings }, cardStatus: a.card ? 'provided' : 'missing' });
                }
                const map = worldDraft.mapId ? (previous?.definition.map?.id === worldDraft.mapId ? previous.definition.map : __s.getGeographyWorld(worldDraft.mapId)) : null;
                let mapImageData = null;
                if (map) { worldProgress.value = '正在准备地图…'; mapImageData = previous?.definition.map?.id === map.id ? previous.definition.mapImageData : await prepareMap(map.id); }
                if (epoch !== viewEpoch) return;
                const definition = { ...previous?.definition, worldId: previous?.definition.worldId || M.id('world'), name: worldDraft.name.trim() || '江南大学', baseline: 'suqixue', playerActorId: playerId, actors,
                    map: map ? JSON.parse(JSON.stringify(map)) : null, mapImageData,
                    publicLore: worldDraft.publicLore, rules: previous?.definition.rules || { playerDriven: true, npcCamera: true, maxActors: 3, maxCalls: 6, maxDepth: 2 } };
                if (previous) {
                    worldProgress.value = '正在保存世界新版本…';
                    let revised = await S.reviseDefinition({ sessionId: previous.sessionId, definition, branchId: previous.branchId,
                        expectedRevision: previous.revision, expectedDefinitionRevision: previous.definition.revision });
                    if (epoch !== viewEpoch) return;
                    for (const b of revised.branches) {
                        const branch = await S.load(revised.sessionId, b.branchId);
                        if (epoch !== viewEpoch) return;
                        const missing = actors.filter(a => a.kind === 'npc' && a.enabled && !branch.conversations.some(c => c.kind === 'dm' && c.participantActorIds.includes(a.actorId)))
                            .map(a => ({ conversationId: 'dm-' + a.actorId, kind: 'dm', name: a.name, participantActorIds: [playerId, a.actorId] }));
                        if (missing.length) await S.commit({ sessionId: branch.sessionId, branchId: branch.branchId, expectedRevision: branch.revision,
                            idempotencyKey: M.id('edit-conversations'), events: [], patch: { conversations: missing } });
                    }
                    revised = await S.load(revised.sessionId, previous.branchId);
                    if (epoch !== viewEpoch) return;
                    await accept(revised); await refreshList(); await refreshBranches(); worldCancelSetupAfterSave();
                    worldActorSelection.value = worldActorSelection.value.filter(id => worldNpcs.value.some(a => a.actorId === id));
                    if (!worldActorSelection.value.length) worldActorSelection.value = worldNpcs.value.slice(0, 1).map(a => a.actorId);
                    __s.showToast('世界设置已保存到新版本，剧情与原版本已保留', 'success');
                    return;
                }
                const conversations = [{ conversationId: 'rp-main', kind: 'rp', name: '世界剧情', participantActorIds: actors.map(a => a.actorId) },
                    ...actors.filter(a => a.kind === 'npc' && a.enabled).map(a => ({ conversationId: 'dm-' + a.actorId, kind: 'dm', name: a.name, participantActorIds: [playerId, a.actorId] }))];
                const initialEvents = window.RPHubWorldChat.openingEvents({ definition, conversations, events: [] });
                worldProgress.value = '正在保存世界…';
                const snapshot = await S.create({ definition, storyTime: worldDraft.storyTime, conversations, initialEvents });
                if (epoch !== viewEpoch) return;
                await accept(snapshot); await refreshList(); await refreshBranches(); worldShowSetup.value = false;
                worldActorSelection.value = actors.filter(a => a.kind === 'npc' && a.enabled).slice(0, 1).map(a => a.actorId);
            } catch (e) { if (epoch === viewEpoch) fail(e); }
            finally { if (epoch === viewEpoch) { worldBusy.value = false; worldProgress.value = ''; } }
        };
        const worldCancelSetupAfterSave = () => { worldShowSetup.value = false; worldEditing.value = false; worldEditSource.value = null; };
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
            worldBusy.value = true; worldError.value = '';
            try {
                const c = { conversationId: M.id('group'), kind: 'group', name: worldGroupName.value.trim() || '朋友们',
                    participantActorIds: [s.definition.playerActorId, ...worldGroupMembers.value] };
                await accept(await S.commit({ sessionId: s.sessionId, branchId: s.branchId, expectedRevision: s.revision, idempotencyKey: M.id('group-create'), events: [], patch: { conversations: [c] } }));
                worldConversationId.value = c.conversationId; worldInput.value = ''; worldGroupEditor.value = false; worldGroupMembers.value = [];
            } catch (e) { fail(e); }
            finally { worldBusy.value = false; }
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
                let snapshot = await S.reviseDefinition({ sessionId: s.sessionId, definition, branchId: s.branchId,
                    expectedRevision: s.revision, expectedDefinitionRevision: s.definition.revision });
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
        watch(() => [worldShowSetup.value, worldDraft.mapId], ([setup, id]) => {
            if (setup && id && (!worldEditing.value || worldEditSource.value?.definition.map?.id !== id)) prepareMap(id);
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
        Object.assign(worldExports, { worldEditing, worldEditSource, worldEdit, worldCancelSetup, worldRemoveDraftActor,
            worldReadAvatar, worldSaveAvatar, worldAvatar, worldConversationActor, worldConversationPreview, worldFormatTime, worldRenderText });
        Object.assign(__s, worldExports); __s.worldExports = worldExports;
        __s.worldUi = reactive(worldExports);
    };
})();
