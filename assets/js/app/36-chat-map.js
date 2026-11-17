/** Live map UI uses the same branch evidence as the model's geography tool. */
(function () {
    window.RPHubAppSections.chatMap = function (__s) {
        const { ref, computed, watch } = Vue;
        __s.showChatMap = ref(false);
        __s.chatMapPinned = ref(true);
        __s.chatMapSaving = ref(false);
        __s.chatMapWorldMode = computed(() => __s.currentView.value === 'world');
        __s.chatMapFocusActor = ref('');
        const snapshot = () => __s.worldSnapshot.value;
        __s.chatMapWorld = computed(() => __s.chatMapWorldMode.value
            ? snapshot()?.definition.map?.data || snapshot()?.definition.map || null : __s.getChatGeographyWorld());
        __s.chatMapPlayer = computed(() => __s.chatMapWorldMode.value
            ? snapshot()?.definition.actors.find(a => a.actorId === snapshot().definition.playerActorId) : __s.user);
        __s.chatMapActorOptions = computed(() => __s.chatMapWorldMode.value
            ? (snapshot()?.definition.actors || []).filter(a => a.actorId !== snapshot().definition.playerActorId && a.enabled !== false) : []);
        __s.chatMapCharacter = computed(() => __s.chatMapWorldMode.value
            ? __s.chatMapActorOptions.value.find(a => a.actorId === __s.chatMapFocusActor.value) || __s.chatMapActorOptions.value[0] || null : __s.currentCharacter.value);
        const worldLocation = actor => {
            const state = snapshot()?.actorStates?.[actor?.actorId] || {};
            const position = state.position !== undefined ? state.position : state.location;
            if (position?.status === 'travelling') return { status: 'in_transit' };
            if (position?.status && !['confirmed', 'last_confirmed'].includes(position.status)) return { status: 'unknown' };
            const id = typeof position === 'string' ? position : position?.placeId;
            const place = __s.chatMapWorld.value?.places.find(p => p.id === id);
            return place ? { status: 'last_confirmed', placeId: place.id, name: place.name } : { status: 'unknown' };
        };
        __s.chatMapLocations = computed(() => __s.chatMapWorldMode.value
            ? { user: worldLocation(__s.chatMapPlayer.value), character: worldLocation(__s.chatMapCharacter.value) } : __s.getChatGeographyState());
        __s.chatMapActors = computed(() => {
            if (!__s.chatMapWorldMode.value || !snapshot()) return null;
            const ordered = [__s.chatMapPlayer.value, __s.chatMapCharacter.value, ...__s.chatMapActorOptions.value.filter(a => a !== __s.chatMapCharacter.value)].filter(Boolean);
            return ordered.map(a => ({ key: a.actorId === snapshot().definition.playerActorId ? 'user' : a.actorId, isPlayer: a.actorId === snapshot().definition.playerActorId,
                name: a.name, avatar: __s.worldAvatar(a.actorId), location: worldLocation(a) }));
        });
        __s.getChatMapImage = async id => __s.chatMapWorldMode.value && snapshot()?.definition.mapImageData
            ? snapshot().definition.mapImageData : __s.getMapImage(id);
        __s.chatMapDisabled = computed(() => __s.chatMapSaving.value || __s.isGenerating.value || __s.isRemoteGenerating.value
            || __s.activeToolQueueRunning.value || __s.isWechatGenerating.value || __s.storyBranchSwitching.value
            || __s.switchingCharacterIndex.value >= 0 || __s.isConversationClearing.value || (__s.chatMapWorldMode.value && __s.worldBusy.value));
        __s.openChatMap = () => {
            __s.closeNavigation();
            __s.showDescriptionPanel.value = false;
            if (!['chat', 'world'].includes(__s.currentView.value)) {
                __s.currentView.value = 'chat';
                Vue.nextTick(() => { if (__s.currentView.value === 'chat') __s.showChatMap.value = true; });
                return;
            }
            __s.showChatMap.value = true;
        };
        __s.configureChatMap = () => {
            __s.showChatMap.value = false;
            if (__s.chatMapWorldMode.value) { if (snapshot()) __s.worldEdit(); else __s.worldNew(); return; }
            if (__s.currentCharacter.value) { __s.editCharacter(__s.currentCharacterIndex.value); __s.editorTab.value = 'geography'; }
            else __s.currentView.value = 'characters';
        };
        __s.openChatMapManager = () => {
            __s.showChatMap.value = false;
            if (__s.showWechatPanel.value) __s.closeWechat();
            __s.currentView.value = 'maps';
        };
        __s.setPlayerMapLocation = async query => {
            if (__s.chatMapDisabled.value || !__s.chatMapWorld.value) return;
            const data = __s.chatMapWorld.value, hit = query ? window.RPHubGeography.resolve(data, query) : null;
            if (hit && hit.status !== 'ok') { __s.showToast('请选择地图中唯一的地点', 'warning'); return; }
            if (__s.chatMapWorldMode.value) {
                const captured = snapshot(), actorId = captured.definition.playerActorId;
                __s.chatMapSaving.value = true; __s.worldBusy.value = true;
                try {
                    const state = { ...captured.actorStates[actorId], position: hit ? { status: 'confirmed', placeId: hit.place.id, source: 'player_author', storyTime: captured.storyTime } : null };
                    const saved = await window.RPHubWorldStore.commit({ sessionId: captured.sessionId, branchId: captured.branchId, expectedRevision: captured.revision,
                        idempotencyKey: window.RPHubWorldModel.id('map-position'), events: [], patch: { actorStates: { [actorId]: state } } });
                    if (snapshot()?.sessionId === captured.sessionId && snapshot()?.branchId === captured.branchId) {
                        __s.worldSnapshot.value = saved; __s.worldCheckpointSeq.value = saved.events.length;
                        __s.showToast(hit ? `你的位置已设为${hit.place.name}` : '你的位置已设为未知', 'success');
                    }
                } catch (error) { __s.showToast(error.message, 'error'); }
                finally { __s.chatMapSaving.value = false; __s.worldBusy.value = false; }
                return;
            }
            const scope = __s.getCurrentStoryBranchScopeId();
            const message = { id: generateUUID(), role: 'user', name: __s.user.name, avatar: __s.user.avatar, isSelf: true, content: `/geo user ${hit ? hit.place.id : 'unknown'}`, geographySceneSetting: true, skipReveal: true };
            const history = __s.chatHistory.value;
            __s.chatMapSaving.value = true;
            history.push(message);
            try {
                if (await __s.saveChatHistoryNow(scope, history) === false) throw new Error('位置设定保存失败，请重试');
                __s.showToast(hit ? `你的位置已设为${hit.place.name}` : '你的位置已设为未知', 'success');
            } catch (error) {
                const index = history.indexOf(message);
                if (index >= 0) history.splice(index, 1);
                __s.showToast(error.message, 'error');
            } finally { __s.chatMapSaving.value = false; }
        };
        __s.formatPlayerMapSetting = message => {
            const match = /^\/geo user ([^\n]+)$/.exec(message.content || '');
            if (!message.geographySceneSetting || !match) return message.content;
            const query = match[1];
            return query === 'unknown' ? '📍 我的位置：未知' : `📍 我的位置：${__s.chatMapWorld.value?.places.find(p => p.id === query)?.name || query}`;
        };
        watch(__s.currentView, () => { __s.showChatMap.value = false; });
        watch(() => __s.worldConversationId.value, () => {
            const c = __s.worldConversation.value;
            if (c?.kind === 'dm') __s.chatMapFocusActor.value = __s.worldConversationActor(c);
        });
        __s.chatMapExports = Object.fromEntries(['showChatMap', 'chatMapPinned', 'chatMapSaving', 'chatMapWorld', 'chatMapLocations', 'chatMapDisabled', 'openChatMap', 'configureChatMap', 'openChatMapManager', 'setPlayerMapLocation', 'formatPlayerMapSetting',
            'chatMapWorldMode', 'chatMapFocusActor', 'chatMapPlayer', 'chatMapCharacter', 'chatMapActorOptions', 'chatMapActors', 'getChatMapImage'].map(key => [key, __s[key]]));
    };
})();
