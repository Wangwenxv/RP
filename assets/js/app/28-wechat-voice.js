/** WeChat voice settings, synthesis and a single, user-initiated audio player. */
(function () {
    window.RPHubAppSections = window.RPHubAppSections || {};
    window.RPHubAppSections.wechatVoice = function (__s) {
        const V = window.RPHubWeChatVoice;
        const library = V.createLibrary(window.RPHubStorage);
        const sessionValue = key => { try { return sessionStorage.getItem(key) || ''; } catch (_) { return ''; } };
        const key = ref(sessionValue('rphub_wechat_voice_key'));
        const service = ref(sessionValue('rphub_wechat_voice_service'));
        const draft = reactive({ enabled: false, voiceId: '', style: '', key: '', service: '' });
        __s.wechatVoiceDraft = draft;
        __s.wechatVoiceCatalog = ref([]);
        __s.wechatVoiceCatalogLoading = ref(false);
        __s.wechatVoiceCatalogStatus = ref('');
        __s.wechatVoicePlayingId = ref('');
        __s.wechatVoiceLoadingId = ref('');
        __s.wechatVoiceExpanded = reactive({});
        let audio = null, objectUrl = '', playEpoch = 0, catalogController = null;
        const scope = () => __s.getCurrentStoryBranchScopeId();
        const config = () => __s.currentCharacter.value?.wechatVoice || {};
        __s.isWechatVoiceReady = () => {
            try { V.serviceBase(service.value); } catch (_) { return false; }
            return config().enabled === true && /^voc_[a-zA-Z0-9_-]{1,100}$/.test(config().voiceId || '') && !!key.value.trim();
        };
        __s.buildWechatVoicePrompt = () => V.buildPrompt(__s.isWechatVoiceReady());
        __s.wechatVoiceRecordText = V.recordText;
        __s.getWechatVoiceConfig = () => ({ voiceId: config().voiceId, style: String(config().style || '').slice(0, 300) });
        __s.openWechatVoiceSettings = () => {
            draft.enabled = config().enabled === true; draft.voiceId = config().voiceId || ''; draft.style = config().style || '';
            draft.key = key.value; draft.service = service.value;
            __s.wechatVoiceCatalog.value = [];
            __s.wechatVoiceCatalogStatus.value = '';
        };
        __s.saveWechatVoiceSettings = () => {
            // Keep unrelated WeChat settings saveable while voice is disabled or not yet configured.
            if (draft.service.trim() || (draft.enabled && draft.key.trim() && draft.voiceId.trim())) {
                try { V.serviceBase(draft.service); } catch (error) { __s.showToast(error.message, 'warning'); return false; }
            }
            if (draft.voiceId.trim() && !/^voc_[a-zA-Z0-9_-]{1,100}$/.test(draft.voiceId.trim())) { __s.showToast('请填写有效的 voc_ 音色 ID', 'warning'); return false; }
            // Blank voice/key is allowed while preparing settings; it never exposes voice capability to the model.
            __s.currentCharacter.value.wechatVoice = { enabled: draft.enabled === true, voiceId: draft.voiceId.trim(), style: draft.style.trim().slice(0, 300) };
            key.value = draft.key.trim(); service.value = draft.service.trim();
            try {
                if (key.value) sessionStorage.setItem('rphub_wechat_voice_key', key.value); else sessionStorage.removeItem('rphub_wechat_voice_key');
                sessionStorage.setItem('rphub_wechat_voice_service', service.value);
            } catch (_) { __s.showToast('当前浏览器仅在页面内存中保留语音配置，刷新后需重填 Key', 'info'); }
            draft.key = '';
            return true;
        };
        __s.loadWechatVoiceCatalog = async () => {
            if (__s.wechatVoiceCatalogLoading.value) return;
            const controller = new AbortController(); catalogController = controller;
            __s.wechatVoiceCatalogLoading.value = true;
            __s.wechatVoiceCatalogStatus.value = '';
            __s.wechatVoiceCatalog.value = [];
            try {
                const result = await V.request(draft.service, draft.key, 'voices', null, controller.signal);
                if (catalogController === controller) {
                    __s.wechatVoiceCatalog.value = result.voices;
                    __s.wechatVoiceCatalogStatus.value = result.voices.length ? `已读取 ${result.voices.length} 个中文公共音色，选择后保存即可` : '服务已连接，但当前没有可用的中文公共音色';
                }
            } catch (error) {
                if (error.name !== 'AbortError' && catalogController === controller) {
                    __s.wechatVoiceCatalogStatus.value = error.message;
                    __s.showToast(error.message, 'warning');
                }
            }
            finally { if (catalogController === controller) { __s.wechatVoiceCatalogLoading.value = false; catalogController = null; } }
        };
        __s.resolveWechatVoice = async (message, signal, snapshot) => {
            const value = V.normalizeIntent(message);
            if (!__s.isWechatVoiceReady()) throw new Error('请先在微信设置开启语音并填写 Key 和音色 ID');
            const targetScope = scope(), ownerId = __s.currentCharacter.value.uuid, epoch = __s.wechatMediaEpoch;
            const check = () => { if (signal?.aborted || scope() !== targetScope || epoch !== __s.wechatMediaEpoch) throw new DOMException('会话已变化', 'AbortError'); };
            const voice = snapshot || __s.getWechatVoiceConfig();
            const instructions = [voice.style, value.instructions].filter(Boolean).join('。');
            const blob = await V.request(service.value, key.value, 'synthesize', { voiceId: voice.voiceId, text: value.content, instructions }, signal);
            check();
            const duration = await V.durationOf(blob); check();
            const asset = await library.save(blob, { ownerId, scopeId: targetScope, duration, voiceId: voice.voiceId }, signal); check();
            return { assetId: asset.id, duration, voiceId: voice.voiceId, instructions, source: 'breezeblue' };
        };
        __s.readWechatVoice = (voice, scopeId) => library.read(voice.assetId, scopeId);
        __s.deleteWechatVoiceOwner = ownerId => library.purgeOwner(ownerId);
        __s.stopWechatVoice = () => {
            playEpoch++;
            if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio = null; }
            if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = ''; }
            __s.wechatVoicePlayingId.value = ''; __s.wechatVoiceLoadingId.value = '';
        };
        __s.toggleWechatVoice = async displayItem => {
            if (__s.wechatVoicePlayingId.value === displayItem.id || __s.wechatVoiceLoadingId.value === displayItem.id) { __s.stopWechatVoice(); return; }
            __s.stopWechatVoice();
            // Resolve from the active timeline, never trust a resource ID supplied by a caller.
            const item = __s.findWechatMessage(displayItem.id);
            if (item?.type !== 'voice' || !item.voice?.assetId) return;
            const epoch = playEpoch, targetScope = scope();
            __s.wechatVoiceLoadingId.value = item.id;
            try {
                const blob = await library.read(item.voice.assetId, targetScope);
                if (epoch !== playEpoch || targetScope !== scope() || !__s.showWechatPanel.value) return;
                objectUrl = URL.createObjectURL(blob); audio = new Audio(objectUrl);
                audio.onended = () => { if (epoch === playEpoch) __s.stopWechatVoice(); };
                audio.onerror = () => { if (epoch === playEpoch) { __s.stopWechatVoice(); __s.showToast('语音无法播放，可以展开文字查看', 'warning'); } };
                await audio.play();
                if (epoch !== playEpoch) return;
                __s.wechatVoiceLoadingId.value = ''; __s.wechatVoicePlayingId.value = item.id;
            } catch (error) {
                if (epoch !== playEpoch) return;
                __s.stopWechatVoice(); __s.showToast(`播放失败：${error.message}，可以展开文字查看`, 'warning');
            }
        };
        __s.invalidateWechatVoice = () => {
            __s.stopWechatVoice(); catalogController?.abort(); catalogController = null;
            __s.wechatVoiceCatalogLoading.value = false; __s.wechatVoiceCatalog.value = []; draft.key = '';
            __s.wechatVoiceCatalogStatus.value = '';
            for (const id of Object.keys(__s.wechatVoiceExpanded)) delete __s.wechatVoiceExpanded[id];
        };
        watch(() => __s.showWechatSettings.value, visible => { if (!visible) { draft.key = ''; catalogController?.abort(); } });
        watch(() => __s.wechatTimeline.value.map(item => item.id).join('|'), () => {
            const id = __s.wechatVoicePlayingId.value || __s.wechatVoiceLoadingId.value;
            if (id && !__s.findWechatMessage(id)) __s.stopWechatVoice();
        });
    };
})();
