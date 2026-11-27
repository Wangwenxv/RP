/**
 * RP-Hub 应用模块 07 · 自动生图任务、生成图重抽与防抖自动保存
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 1909–2302 行。
 * 本文件是一个 App 模块函数，在 app.js 的 setup() 里按序号依次调用。
 *
 * 约定：
 * - 模块内顶层的 const/let 就是原 setup() 的顶层声明，语义保持不变；
 * - 每个声明会镜像到共享上下文 __s（return 给模板用的也是它）；
 * - 跨模块引用统一写作 __s.<name>；可被重新赋值的变量直接驻留在 __s 上；
 * - 文件顶部的全局辅助（ref/computed、RPHubXxx、bootstrap 常量）由 app.js
 *   顶部与 7 个基础 JS 提供，经典 script 共享全局词法作用域，直接用即可。
 */
(function () {
    window.RPHubAppSections = window.RPHubAppSections || {};
    window.RPHubAppSections.imageGenAutosave = function (__s) {

        // Auto Image Gen & Stream Linkage
        const isAutoImageGenEnabled = computed({
            get: () => {
                const entry = __s.worldInfo.value.find(w => w.comment === '自动生图');
                return entry ? entry.enabled : false;
            },
            set: (val) => {
                const entry = __s.worldInfo.value.find(w => w.comment === '自动生图');
                if (entry) {
                    entry.enabled = val;
                } else {
                    __s.showToast('未找到“自动生图”世界书条目，请确认配置', 'warning');
                }
            }
        });
        __s.isAutoImageGenEnabled = isAutoImageGenEnabled;
        const showAutoImageGenToggleToast = (enabled) => {
            __s.showToast(enabled ? '自动生图已开启' : '自动生图已关闭', enabled ? 'success' : 'info');
        };
        __s.showAutoImageGenToggleToast = showAutoImageGenToggleToast;
        const setAutoImageGenEnabled = (enabled) => {
            isAutoImageGenEnabled.value = enabled;
            const changed = isAutoImageGenEnabled.value === enabled;
            if (changed) showAutoImageGenToggleToast(enabled);
            return changed;
        };
        __s.setAutoImageGenEnabled = setAutoImageGenEnabled;
        const toggleAutoImageGen = () => {
            setAutoImageGenEnabled(!isAutoImageGenEnabled.value);
        };
        __s.toggleAutoImageGen = toggleAutoImageGen;
        const setWorldInfoEnabled = (entry, enabled, event) => {
            if (entry?.comment === '自动生图') {
                const changed = setAutoImageGenEnabled(enabled);
                if (!changed && event?.target) event.target.checked = isAutoImageGenEnabled.value;
                return;
            }

            if (entry) entry.enabled = enabled;
        };
        __s.setWorldInfoEnabled = setWorldInfoEnabled;
        const generatedImageTasks = new Map();
        __s.generatedImageTasks = generatedImageTasks;
        __s.generatedImageObserver = null;
        __s.isAutoImageGenerating = ref(false);
        __s.generatedImageActiveCount = 0;
        __s.generatedImageEpoch = 0;
        const buildGeneratedImageCardMarkup = (tags) => {
            const request = new URL('rp-image', window.location.href);
            request.searchParams.set('tag', tags);
            return `<div class="generated-image-card is-generating" data-image-request="${request.href}" style="width:100%;max-width:100%;padding:2px;border:1px solid rgba(255,255,255,.58);position:relative;border-radius:12px;overflow:hidden;display:flex;justify-content:center;align-items:center"><img alt="" style="width:100%;height:100%;object-fit:contain;border-radius:9px"><button type="button" class="generated-image-reroll" title="重新生成图片" aria-label="重新生成图片"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg></button></div>`;
        };
        __s.buildGeneratedImageCardMarkup = buildGeneratedImageCardMarkup;
        const generatedImageBinding = card => {
            const row = card.closest('[data-chat-index]');
            const message = __s.chatHistory.value[Number(row?.dataset.chatIndex)];
            if (!row || !message || message.role !== 'assistant') return null;
            const cards = [...row.querySelectorAll('.generated-image-card')];
            const index = cards.indexOf(card);
            const matches = cardUtils.findUnprotectedMatches(String(message.content || ''), getImageTagRegex());
            const prompt = matches[index]?.[1]?.trim();
            return prompt ? { message, index, prompt } : null;
        };
        __s.generatedImageBinding = generatedImageBinding;
        const renderGeneratedImageJob = (card, task, job) => {
            if (!card?.isConnected) return task.cards.delete(card);
            const label = card.querySelector('.generated-image-progress-label');
            const bar = card.querySelector('.generated-image-progress-bar');
            card.dataset.imageJobState = job.status;
            card.classList.toggle('is-generating', job.status === 'running');
            card.classList.toggle('is-generation-error', job.status === 'failed');
            card.classList.remove('is-waiting');
            if (label) {
                const text = job.status === 'running' ? job.label || '生成中…' : job.status === 'failed' ? job.error || '生成失败，请点击重新生成' : '';
                if (label.textContent !== text) label.textContent = text;
            }
            if (bar) bar.style.width = job.status === 'done' ? '100%' : `${(job.fraction || 0) * 100}%`;
            if (job.status === 'done') {
                card.querySelector('img').src = task.imageUrl;
                card.style.aspectRatio = `${job.width} / ${job.height}`;
            }
        };
        __s.renderGeneratedImageJob = renderGeneratedImageJob;
        const cancelGeneratedImageTasks = () => {
            __s.generatedImageEpoch++;
            for (const task of generatedImageTasks.values()) {
                task.controller.abort();
                if (task.imageUrl) URL.revokeObjectURL(task.imageUrl);
                for (const card of task.cards) {
                    if (task.job?.status === 'done') card.dataset.imageJobState = '';
                    else renderGeneratedImageJob(card, task, { status: 'failed', error: '生成已取消，请手动重试' });
                }
                task.cards.clear();
            }
            generatedImageTasks.clear();
            nextTick(() => hydrateGeneratedImages(__s.chatContainer.value));
        };
        __s.cancelGeneratedImageTasks = cancelGeneratedImageTasks;
        const startGeneratedImageTask = (requestUrl, fresh = false, binding) => {
            const { message, index, prompt } = binding;
            const scopeId = __s.getCurrentStoryBranchScopeId();
            const revision = __s.conversationRevision, epoch = __s.generatedImageEpoch;
            const key = JSON.stringify([scopeId, revision, __s.chatHistory.value.indexOf(message), index, prompt]);
            const existing = generatedImageTasks.get(key);
            if (existing && (!fresh || !existing.job || existing.job.status === 'running')) return existing;
            if (existing?.imageUrl) URL.revokeObjectURL(existing.imageUrl);
            const controller = new AbortController();
            const task = { key, requestUrl, message, index, controller, cards: new Set(), job: null, imageUrl: '' };
            const check = () => {
                const matches = cardUtils.findUnprotectedMatches(String(message.content || ''), getImageTagRegex());
                if (controller.signal.aborted || epoch !== __s.generatedImageEpoch || revision !== __s.conversationRevision
                    || scopeId !== __s.getCurrentStoryBranchScopeId() || !__s.chatHistory.value.includes(message)
                    || matches[index]?.[1]?.trim() !== prompt) throw new DOMException('会话或插图已变化', 'AbortError');
            };
            const publish = job => {
                task.job = job;
                for (const card of task.cards) renderGeneratedImageJob(card, task, job);
            };
            const save = async () => {
                check();
                if (await __s.saveChatHistoryNow(scopeId) === false) throw new Error('插图记录保存失败，请不要刷新，稍后重试');
                check();
            };
            // A pending checkpoint prevents refresh/navigation from silently repeating a paid request.
            const previous = message.generatedImages?.[index];
            task.promise = (async () => {
                check();
                const G = window.RPHubImageGeneration, M = window.RPHubWeChatMedia;
                const library = __s.wechatMediaLibrary;
                let asset = previous?.prompt === prompt && previous.assetId && (!fresh || previous.status !== 'done')
                    ? await library.get(previous.assetId) : null;
                let pixels;
                if (asset) {
                    try { pixels = await library.read(asset.id, false, controller.signal); }
                    catch (error) {
                        check();
                        if (!fresh || !/图片文件已丢失|图片资源已不存在/.test(error.message)) throw error;
                        asset = null; // Explicit manual retry may replace missing pixels.
                    }
                }
                if (!fresh && previous?.prompt === prompt && !asset) {
                    throw new Error(previous.error || (previous.assetId ? '图片原件已丢失，请手动重新生成' : '上次生图未完成，请手动重试；服务端可能已计费'));
                }
                check();
                if (!asset) {
                    const config = { ...G.config(__s.settings), artists: cardUtils.getImageStyleArtists(__s.settings.imageStyle, __s.settings.customImageArtists) };
                    if (!G.ready(config)) throw new Error('请在设置 → 生图服务（RP / 微信共用）中填写 API Key 并开启生图');
                    // Validate before saving a pending task or paying.
                    const intent = G.inlineIntent(prompt);
                    const request = G.characterRequest(config, intent, __s.currentCharacter.value);
                    request.config.referenceImages = await G.resolveReferences(request.config.referenceImages, controller.signal);
                    check();
                    G.payload(request.config, request.prompt);
                    message.generatedImages = [...(message.generatedImages || [])];
                    message.generatedImages[index] = { prompt, status: 'pending' };
                    await save();
                    publish({ status: 'running' });
                    const blob = await G.generate(request.config, request.prompt, controller.signal, progress => {
                        check();
                        publish({ status: 'running', ...progress });
                    }); check();
                    const image = await M.rasterize(blob, { signal: controller.signal }); check();
                    asset = await library.save(image, { source: 'generate', ownerId: __s.currentCharacter.value.uuid,
                        scopeId, caption: 'RP 剧情插图', captionSource: 'generation_prompt' }, controller.signal); check();
                }
                const blob = pixels || await library.read(asset.id, false, controller.signal); check();
                // Keep the saved pixels on a failed chat write so manual retry reuses them.
                message.generatedImages = [...(message.generatedImages || [])];
                message.generatedImages[index] = { prompt, assetId: asset.id, status: 'done', width: asset.width, height: asset.height };
                await save();
                task.imageUrl = URL.createObjectURL(blob);
                const job = { status: 'done', width: asset.width, height: asset.height };
                publish(job); return job;
            })().catch(async error => {
                const job = { status: 'failed', error: error.name === 'AbortError' ? '生成已取消，请手动重试' : error.message || '生成失败，请手动重试' };
                if (error.name !== 'AbortError') {
                    try {
                        check();
                        message.generatedImages = [...(message.generatedImages || [])];
                        message.generatedImages[index] = { ...(message.generatedImages[index]?.prompt === prompt ? message.generatedImages[index] : {}), prompt, status: 'failed', error: job.error };
                        await save();
                    } catch (_) { /* An obsolete task cannot write to a new conversation. */ }
                }
                publish(job); return job;
            }).finally(() => {
                __s.isAutoImageGenerating.value = --__s.generatedImageActiveCount > 0;
            });
            __s.isAutoImageGenerating.value = ++__s.generatedImageActiveCount > 0;
            generatedImageTasks.set(key, task);
            return task;
        };
        __s.startGeneratedImageTask = startGeneratedImageTask;
        const ensureGeneratedImageProgressUi = (card) => {
            if (card.querySelector('.generated-image-progress')) return;
            const progress = document.createElement('div');
            progress.className = 'generated-image-progress';
            progress.setAttribute('aria-live', 'polite');
            progress.innerHTML = '<svg class="generated-image-spinner" viewBox="0 0 50 50" aria-hidden="true"><circle class="generated-image-spinner-path" cx="25" cy="25" r="20" fill="none" stroke-width="2"></circle></svg><span class="generated-image-progress-label">等待生成</span><span class="generated-image-progress-track"><i class="generated-image-progress-bar"></i></span>';
            card.appendChild(progress);
        };
        __s.ensureGeneratedImageProgressUi = ensureGeneratedImageProgressUi;
        const loadGeneratedImageCard = (card, requestUrl = card?.dataset.imageRequest, options = {}) => {
            if (!card || !requestUrl) return Promise.resolve({ status: 'failed' });
            ensureGeneratedImageProgressUi(card);
            generatedImageTasks.forEach(task => task.cards.delete(card));
            card.querySelector('img')?.setAttribute('alt', '');
            const animationTime = performance.now();
            card.querySelector('.generated-image-spinner')?.style.setProperty('animation-delay', `-${animationTime % 2000}ms`);
            card.querySelector('.generated-image-spinner-path')?.style.setProperty('animation-delay', `-${animationTime % 1500}ms`);
            const label = card.querySelector('.generated-image-progress-label');
            const bar = card.querySelector('.generated-image-progress-bar');
            const binding = generatedImageBinding(card);
            if (!binding) return Promise.resolve({ status: 'failed' });
            const task = startGeneratedImageTask(requestUrl, options.fresh === true, binding);
            if (!task.job) {
                if (label) label.textContent = '正在准备图片…';
                if (bar) bar.style.width = '0%';
            }
            task.cards.add(card);
            card.dataset.imageRequest = requestUrl;
            card.dataset.imageJobState = 'loading';
            card.classList.add('is-generating');
            card.classList.remove('is-generation-error');
            const size = window.RPHubImageGeneration.config(__s.settings).size;
            const dimensions = /^(\d+)x(\d+)$/.exec(size);
            card.style.aspectRatio = dimensions ? `${dimensions[1]} / ${dimensions[2]}` : '1';
            if (task.job) renderGeneratedImageJob(card, task, task.job);
            return task.promise;
        };
        __s.loadGeneratedImageCard = loadGeneratedImageCard;
        const hydrateGeneratedImages = (root) => {
            if (__s.isConversationClearing?.value || __s.storyBranchSwitching?.value || __s._isApplyingCharacterScopedData) return;
            const cards = root?.matches?.('.generated-image-card[data-image-request]')
                ? [root]
                : [...(root?.querySelectorAll?.('.generated-image-card[data-image-request]') || [])];
            cards.forEach(card => {
                if (__s.isConversationBusy.value) {
                    if (!card.dataset.imageJobState) {
                        ensureGeneratedImageProgressUi(card);
                        card.dataset.imageJobState = 'waiting';
                        card.querySelector('.generated-image-progress-label').textContent = '等待正文完成…';
                    }
                    return;
                }
                if (!card.dataset.imageJobState || card.dataset.imageJobState === 'waiting') loadGeneratedImageCard(card);
            });
        };
        __s.hydrateGeneratedImages = hydrateGeneratedImages;
        watch(__s.chatContainer, (container) => {
            __s.generatedImageObserver?.disconnect();
            if (!container) { cancelGeneratedImageTasks(); return; }
            __s.generatedImageObserver = new MutationObserver(records => {
                records.forEach(record => record.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) hydrateGeneratedImages(node);
                }));
                for (const [key, task] of generatedImageTasks) {
                    for (const card of task.cards) if (!card.isConnected) task.cards.delete(card);
                    if (!task.cards.size && ['done', 'failed'].includes(task.job?.status)) {
                        if (task.imageUrl) URL.revokeObjectURL(task.imageUrl);
                        generatedImageTasks.delete(key);
                    }
                }
            });
            __s.generatedImageObserver.observe(container, { childList: true, subtree: true });
            hydrateGeneratedImages(container);
        });
        watch(__s.isConversationBusy, busy => {
            if (!busy) nextTick(() => hydrateGeneratedImages(__s.chatContainer.value));
        });
        watch(() => [__s.storyBranchSwitching?.value, __s.switchingCharacterIndex?.value], () => {
            nextTick(() => hydrateGeneratedImages(__s.chatContainer.value));
        });
        const handleGeneratedImageReroll = async (event, messageIndex) => {
            const button = event.target.closest('.generated-image-reroll');
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            if (__s.isConversationBusy.value) {
                __s.showToast('请等待当前回复完成后再重新生成图片', 'warning');
                return;
            }

            const card = button.closest('.generated-image-card');
            const cards = [...event.currentTarget.querySelectorAll('.generated-image-card')];
            const imageIndex = cards.indexOf(card);
            const message = __s.chatHistory.value[messageIndex];
            const sourceText = String(message?.content || '');
            const imageMatches = cardUtils.findUnprotectedMatches(sourceText, getImageTagRegex());
            const imageMatch = imageMatches[imageIndex];
            if (!message || imageIndex < 0 || !imageMatch) return;
            if (card.classList.contains('is-rerolling')) return;

            const sourceUrl = card.dataset.imageRequest;
            if (!sourceUrl) return;
            const finishLoading = () => {
                card.classList.remove('is-rerolling');
                button.disabled = false;
            };
            card.classList.add('is-rerolling');
            button.disabled = true;

            const job = await loadGeneratedImageCard(card, sourceUrl, { fresh: true });
            if (job.status === 'done') {
                __s.showToast('已重新生成图片', 'success');
            }
            finishLoading();
        };
        __s.handleGeneratedImageReroll = handleGeneratedImageReroll;
        const updateImageGenRegexState = ({ enableRegex = false } = {}) => {
            const imageGenRegexName = 'NAI画图正则';
            let regex = __s.regexScripts.value.find(r => r.name === imageGenRegexName);
            if (!regex) {
                __s.enforceSpecialRules();
                regex = __s.regexScripts.value.find(r => r.name === imageGenRegexName);
                if (!regex) return [];
            }

            regex.replacement = buildGeneratedImageCardMarkup('$1');
            const messages = [];
            if (enableRegex && !regex.enabled) {
                regex.enabled = true;
                messages.push(`${imageGenRegexName} 已启用`);
            }

            return messages;
        };
        __s.updateImageGenRegexState = updateImageGenRegexState;
        watch(isAutoImageGenEnabled, (newVal) => {
            if (newVal) {
                let messages = [];
                const regexMessages = updateImageGenRegexState({ enableRegex: true });
                if (regexMessages && regexMessages.length > 0) {
                    messages.push(...regexMessages);
                }

                if (messages.length > 0) {
                    __s.showToast('为适配生图：' + messages.join('，'), 'info');
                }
            }
        });
        watch(() => __s.settings.imageStyle, () => {
            const messages = updateImageGenRegexState({ enableRegex: isAutoImageGenEnabled.value });
            if (isAutoImageGenEnabled.value && messages && messages.length > 0) {
                __s.showToast('生图风格已切换：' + messages.join('，'), 'success');
            }
        });
        watch(() => __s.settings.customImageArtists, () => {
            if (__s.settings.imageStyle === 'custom') {
                updateImageGenRegexState({ enableRegex: isAutoImageGenEnabled.value });
            }
        });
        watch(() => __s.settings.wechatImageApi.model, (imageModel) => {
            if (String(imageModel || '').split(':')[0] === 'nai-diffusion-5-full' && __s.v5UnsupportedImageStyles.has(__s.settings.imageStyle)) {
                __s.settings.imageStyle = 'vertical';
            }
            const messages = updateImageGenRegexState({ enableRegex: isAutoImageGenEnabled.value });
            if (isAutoImageGenEnabled.value && messages && messages.length > 0) {
                __s.showToast(`生图版本已切换：${__s.getImageModelName(imageModel)}`, 'success');
            }
        }, { flush: 'sync' });
        watch(() => __s.settings.imageSize, () => {
            const messages = updateImageGenRegexState({ enableRegex: isAutoImageGenEnabled.value });
            if (isAutoImageGenEnabled.value && messages && messages.length > 0) {
                __s.showToast('生图比例已切换：' + messages.join('，'), 'success');
            }
        });
        watch(() => __s.settings.imageGenCount, () => {
            __s.enforceSpecialRules();
        });
        watch(() => __s.settings.wechatImageApi.protocol, () => __s.enforceSpecialRules());

        // Debounce function
        const debounce = (fn, delay) => {
            let timeoutId;
            const debounced = (...args) => {
                clearTimeout(timeoutId);
                timeoutId = setTimeout(() => fn(...args), delay);
            };
            debounced.cancel = () => { clearTimeout(timeoutId); timeoutId = null; };
            return debounced;
        };
        __s.debounce = debounce;

        // Debounced Save
        const debouncedSave = debounce(() => {
            __s.saveData({ saveMemories: false, saveCharacters: false });
        }, 1000);
        __s.debouncedSave = debouncedSave;
        const debouncedCharacterSave = debounce(() => {
            __s.saveCharactersNow().catch(error => console.error('Save characters failed:', error));
        }, 1000);
        __s.debouncedCharacterSave = debouncedCharacterSave;
        __s.suspendCharacterAutoSave = false;

        // Watch for changes to auto-save
        watch(() => __s.characters.value.map(char => [
            char,
            char?.uuid,
            char?.favoriteAt,
            char?.worldInfo,
            char?.regexScripts,
            char?.uiTemplates,
            char?.recentGenerationTimes
        ]), () => {
            if (__s._initComplete && !__s.suspendCharacterAutoSave) debouncedCharacterSave();
        });
        watch([__s.settings, __s.presets, __s.regexScripts, __s.globalRegexScripts, __s.worldInfo, __s.globalWorldInfo, __s.globalUiTemplates, __s.activeTools, __s.user, __s.recentGenerationTimes], () => {
            if (!__s._initComplete) return;
            debouncedSave();
        }, { deep: true });

        // Watch chat history length only so large histories do not get traversed on load.
        // Message edits and generation completion still call saveData/saveChatHistoryNow directly.
        watch(() => __s.chatHistory.value.length, () => {
            if (__s._isApplyingCharacterScopedData) return;
            __s.scheduleChatHistorySave();
        });
    };
})();
