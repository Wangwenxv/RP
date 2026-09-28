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
        const fetchImageJobJson = async (url, options) => {
            const response = await fetch(url, options);
            const text = await response.text();
            let payload = {};
            try { payload = text ? JSON.parse(text) : {}; } catch { /* 交给下方统一报错 */ }
            if (!response.ok) throw new Error(payload.error || text || `HTTP ${response.status}`);
            return payload;
        };
        __s.fetchImageJobJson = fetchImageJobJson;
        const renderGeneratedImageJob = (card, task, job) => {
            if (!card?.isConnected) return task.cards.delete(card);
            task.job = job;
            card.dataset.imageJobId = job.id || '';
            const progress = Math.max(0, Math.min(100, Number(job.generationProgress?.percent || 0)));
            const label = card.querySelector('.generated-image-progress-label');
            const bar = card.querySelector('.generated-image-progress-bar');
            card.classList.toggle('is-waiting', job.status === 'queued');
            if (bar) bar.style.width = `${progress}%`;

            if (job.status === 'queued') {
                if (label) label.textContent = job.queuePosition
                    ? `排队中 · 第 ${job.queuePosition} / ${job.queuedCount || job.queuePosition} 个`
                    : '排队中';
                return;
            }
            if (job.status === 'running') {
                if (label) label.textContent = `生成中 ${Math.round(progress)}%`;
                return;
            }

            const imageUrl = job.imageUrl
                ? new URL(job.imageUrl, task.baseUrl).href
                : job.id
                    ? `${task.baseUrl}/api/jobs/${encodeURIComponent(job.id)}/content?token=${encodeURIComponent(task.token)}`
                    : '';
            if (!imageUrl) {
                card.classList.remove('is-generating');
                card.classList.add('is-generation-error');
                if (label) label.textContent = job.error || '生成失败';
                return;
            }

            const image = card.querySelector('img');
            image.style.height = '100%';
            image.src = imageUrl;
            card.classList.remove('is-generating', 'is-generation-error', 'is-waiting');
            card.dataset.imageJobState = job.status;
        };
        __s.renderGeneratedImageJob = renderGeneratedImageJob;
        const startGeneratedImageTask = (requestUrl, fresh = false) => {
            const request = new URL(requestUrl, window.location.href);
            const token = request.searchParams.get('token') || __s.settings.imageGenKey.trim();
            request.searchParams.set('token', token);
            const key = fresh ? `${request.href}#${Date.now()}-${Math.random()}` : request.href;
            if (generatedImageTasks.has(key)) return generatedImageTasks.get(key);
            const task = { key, requestUrl: request.href, baseUrl: request.origin, token, cards: new Set(), job: null };
            const publish = (job) => {
                task.job = job;
                [...task.cards].forEach(card => renderGeneratedImageJob(card, task, job));
            };
            task.promise = (async () => {
                let job = await fetchImageJobJson(`${task.baseUrl}/api/jobs`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(Object.fromEntries(request.searchParams.entries()))
                });
                publish(job);
                let pollFailures = 0;
                while (!['done', 'failed'].includes(job.status)) {
                    await new Promise(resolve => setTimeout(resolve, 150));
                    try {
                        job = await fetchImageJobJson(`${task.baseUrl}/api/jobs/${encodeURIComponent(job.id)}?token=${encodeURIComponent(task.token)}`);
                        pollFailures = 0;
                    } catch (error) {
                        if (++pollFailures < 5) continue;
                        throw error;
                    }
                    publish(job);
                }
                if (fresh && job.status === 'done') {
                    const reusableRequest = new URL(task.requestUrl);
                    reusableRequest.searchParams.set('nocache', '0');
                    generatedImageTasks.delete(task.key);
                    task.key = reusableRequest.href;
                    generatedImageTasks.set(task.key, task);
                }
                return job;
            })().catch((error) => {
                const job = { status: 'failed', error: error.message || '生成失败' };
                publish(job);
                return job;
            });
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
            const task = startGeneratedImageTask(requestUrl, options.fresh === true);
            if (!task.job) {
            if (label) label.textContent = '等待生成';
                if (bar) bar.style.width = '0%';
            }
            task.cards.add(card);
            card.dataset.imageRequest = requestUrl;
            card.dataset.imageJobState = 'loading';
            card.classList.add('is-generating');
            card.classList.remove('is-generation-error');
            const size = new URL(requestUrl, window.location.href).searchParams.get('size');
            card.style.aspectRatio = size === '横图' ? '1216 / 832' : size === '方图' ? '1' : '832 / 1216';
            if (task.job) renderGeneratedImageJob(card, task, task.job);
            return task.promise;
        };
        __s.loadGeneratedImageCard = loadGeneratedImageCard;
        const hydrateGeneratedImages = (root) => {
            const cards = root?.matches?.('.generated-image-card[data-image-request]')
                ? [root]
                : [...(root?.querySelectorAll?.('.generated-image-card[data-image-request]') || [])];
            cards.forEach(card => {
                if (!card.dataset.imageJobState) loadGeneratedImageCard(card);
            });
        };
        __s.hydrateGeneratedImages = hydrateGeneratedImages;
        watch(__s.chatContainer, (container) => {
            __s.generatedImageObserver?.disconnect();
            if (!container) return;
            __s.generatedImageObserver = new MutationObserver(records => {
                records.forEach(record => record.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) hydrateGeneratedImages(node);
                }));
            });
            __s.generatedImageObserver.observe(container, { childList: true, subtree: true });
            hydrateGeneratedImages(container);
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

            const tags = imageMatch[1].split(',').map(tag => tag.trim()).filter(Boolean);
            if (tags.length < 2) {
                __s.showToast('提示词太短，无法重新生成', 'warning');
                return;
            }
            const swapIndex = Math.floor(Math.random() * (tags.length - 1));
            [tags[swapIndex], tags[swapIndex + 1]] = [tags[swapIndex + 1], tags[swapIndex]];
            const updatedToken = `image###${tags.join(', ')}###`;
            const updatedContent = sourceText.slice(0, imageMatch.index)
                + updatedToken
                + sourceText.slice(imageMatch.index + imageMatch[0].length);
            const sourceUrl = card.dataset.imageRequest || card.querySelector('img')?.getAttribute('src');
            if (!sourceUrl) return;
            const nextImageUrl = new URL(sourceUrl, window.location.href);
            nextImageUrl.searchParams.set('tag', tags.join(', '));
            nextImageUrl.searchParams.set('nocache', '1');

            const originalContent = message.content;
            const finishLoading = () => {
                card.classList.remove('is-rerolling');
                button.disabled = false;
            };
            card.classList.add('is-rerolling');
            button.disabled = true;

            const job = await loadGeneratedImageCard(card, nextImageUrl.href, { fresh: true });
            if (job.status === 'done') {
                if (__s.chatHistory.value[messageIndex] !== message || message.content !== originalContent) {
                    finishLoading();
                    return;
                }
                message.content = updatedContent;
                message.shouldAnimate = false;
                __s.scheduleChatHistorySave();
                __s.showToast('已重新生成图片', 'success');
                nextTick(finishLoading);
                return;
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

            const targetArtists = cardUtils.getImageStyleArtists(__s.settings.imageStyle, __s.settings.customImageArtists);
            const styleName = imageStyleOptions.find(option => option.value === __s.settings.imageStyle)?.label
                || imageStyleOptions[0].label;
            const modelName = __s.getImageModelName(__s.settings.imageModel);

            // 动态替换 URL 中的 model、artist 和 size 参数
            const encodedTargetArtists = encodeURIComponent(targetArtists);
            const oldReplacement = regex.replacement;
            let newReplacement = oldReplacement.replace(/artist=[\s\S]*?(&size=)/, 'artist=' + encodedTargetArtists + '$1');
            if (newReplacement === oldReplacement) {
                newReplacement = oldReplacement.replace(/artist=[^&]+/, 'artist=' + encodedTargetArtists);
            }
            newReplacement = newReplacement.replace(/model=[^&]+/, 'model=' + __s.settings.imageModel);
            newReplacement = newReplacement.replace(/size=[^&]+/, 'size=' + __s.settings.imageSize);
            regex.replacement = newReplacement;

            let messages = [];
            // 检查 Artist 变化
            const oldArtist = oldReplacement.match(/artist=([\s\S]*?)&size=/)?.[1] || oldReplacement.match(/artist=([^&]+)/)?.[1];
            if (oldArtist !== encodedTargetArtists) {
                messages.push(styleName);
            }
            const oldModel = oldReplacement.match(/model=([^&]+)/)?.[1];
            if (oldModel !== __s.settings.imageModel) {
                messages.push(modelName);
            }
            // 检查 Size 变化
            const oldSize = oldReplacement.match(/size=([^&]+)/)?.[1];
            if (oldSize !== __s.settings.imageSize) {
                messages.push(`比例: ${__s.settings.imageSize}`);
            }

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
        watch(() => __s.settings.imageModel, (imageModel) => {
            if (imageModel === 'nai-diffusion-5-full' && __s.v5UnsupportedImageStyles.has(__s.settings.imageStyle)) {
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

        // Debounce function
        const debounce = (fn, delay) => {
            let timeoutId;
            return (...args) => {
                clearTimeout(timeoutId);
                timeoutId = setTimeout(() => fn(...args), delay);
            };
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
