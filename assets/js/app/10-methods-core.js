/**
 * RP-Hub 应用模块 10 · 通用方法：Toast / 确认框 / 正则处理 / Markdown 渲染
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 3124–3348 行。
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
    window.RPHubAppSections.methodsCore = function (__s) {

        // --- Methods ---

        // Toast Notification
        const showToast = (message, type = 'info', duration = 2000) => {
            const id = `${Date.now()}-${__s.toastIdSeed++}`;
            __s.toasts.value.push({ id, message, type });
            setTimeout(() => {
                __s.toasts.value = __s.toasts.value.filter(t => t.id !== id);
            }, duration);
        };
        __s.showToast = showToast;

        // Confirmation Dialog
        const yieldToUi = () => new Promise(resolve => {
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => setTimeout(resolve, 0));
            } else {
                setTimeout(resolve, 0);
            }
        });
        __s.yieldToUi = yieldToUi;
        const confirmAction = (message, callback) => {
            __s.confirmMessage.value = message;
            __s.confirmCallback.value = callback;
            __s.showConfirmModal.value = true;
        };
        __s.confirmAction = confirmAction;
        const runConfirmCallback = async (callback) => {
            try {
                await yieldToUi();
                await callback();
            } catch (error) {
                console.error('Confirm action failed:', error);
                showToast(error?.message || '操作失败', 'error');
            }
        };
        __s.runConfirmCallback = runConfirmCallback;
        const handleConfirm = () => {
            const callback = __s.confirmCallback.value;
            __s.showConfirmModal.value = false;
            __s.confirmCallback.value = null;
            document.activeElement?.blur?.();
            if (callback) runConfirmCallback(callback);
        };
        __s.handleConfirm = handleConfirm;
        const handleCancel = () => {
            __s.showConfirmModal.value = false;
            __s.confirmCallback.value = null;
            document.activeElement?.blur?.();
        };
        __s.handleCancel = handleCancel;

        // Regex Processing
        // 辅助函数：当自动生图关闭时，只从发送给模型的上下文里移除可生图替换的内容
        const stripDisabledImageGenContext = (text) => {
            if (!text) return text;
            if (__s.isAutoImageGenEnabled.value) return text; // 生图开启时保留
            return String(text)
                .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, '')
                .replace(getImageTagRegex(), '')
                .replace(/[ \t]+\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        };
        __s.stripDisabledImageGenContext = stripDisabledImageGenContext;
        const processRegex = (text, options = {}) => {
            if (!text) return '';
            // options: { isDisplay, isPrompt, role, depth }
            const { isDisplay = false, isPrompt = false, role = null, depth = 0 } = options;
            let result = __s.replaceUserNamePlaceholder(text);
            if (role === 'system') return result;
            const orderedScripts = [...__s.regexScripts.value].sort((a, b) => {
                const aIsImageGen = (a.name || a.scriptName) === 'NAI画图正则';
                const bIsImageGen = (b.name || b.scriptName) === 'NAI画图正则';
                return aIsImageGen === bIsImageGen ? 0 : (aIsImageGen ? 1 : -1);
            });

            orderedScripts.forEach(script => {
                // 明确检查 enabled 字段：只有显式设置为 false 才跳过
                if (script.enabled === false) return;

                // Placement Check (1=User, 2=AI)
                // 如果 placement 未定义，默认为全部生效 (兼容旧数据)
                const placement = script.placement || [1, 2];
                if (role === 'user' && !placement.includes(1)) return;
                if (role === 'assistant' && !placement.includes(2)) return;

                // Mode Check
                const userOnly = script.markdownOnly || (!script.markdownOnly && !script.promptOnly);
                if (isDisplay && script.promptOnly) return; // 显示模式下，跳过仅AI可见的正则
                if (isPrompt && userOnly) return; // 发送给AI前，跳过仅用户可见的正则；两项都没勾也按仅用户可见处理

                // Depth Check
                if (script.minDepth !== null && script.minDepth !== undefined && depth < script.minDepth) return;
                if (script.maxDepth !== null && script.maxDepth !== undefined && depth > script.maxDepth) return;

                try {
                    // 兼容外部正则字段：findRegex/regex, replaceString/replacement
                    let regexPattern = script.regex || script.findRegex;
                    let flags = script.flags || script.regexFlags || 'g';
                    const replacement = script.hasOwnProperty('replacement')
                        ? script.replacement
                        : (script.replaceString || '');

                    if (!regexPattern) return;
                    const isImageGenScript = (script.name || script.scriptName) === 'NAI画图正则';

                    // 解析 /pattern/flags 格式
                    if (regexPattern.startsWith('/') && regexPattern.lastIndexOf('/') > 0) {
                        const lastSlash = regexPattern.lastIndexOf('/');
                        const potentialFlags = regexPattern.substring(lastSlash + 1);
                        // 简单的 flags 验证
                        if (/^[gimsuy]*$/.test(potentialFlags)) {
                            flags = potentialFlags;
                            regexPattern = regexPattern.substring(1, lastSlash);
                        }
                    }

                    ({ pattern: regexPattern, flags } = cardUtils.normalizeRegexModifiers(regexPattern, flags));
                    const re = isImageGenScript
                        ? getImageTagRegex()
                        : new RegExp(regexPattern, flags);

                    // 普通正则保护 HTML/代码；明确匹配标签或代码围栏的规则仍直接执行。
                    if (!/[<>]/.test(regexPattern) && !regexPattern.includes('```')) {
                        const wholeMatch = re.exec(result);
                        re.lastIndex = 0;
                        const wrapped = wholeMatch?.[0] === result ? result.replace(re, replacement) : null;
                        re.lastIndex = 0;
                        // 完整保留原文的整条包裹只执行一次，避免给面板内每段文字重复套壳。
                        result = wrapped !== null && wrapped.includes(result)
                            ? wrapped
                            : cardUtils.transformUnprotectedText(result, part => part.replace(re, replacement));
                    } else {
                        result = result.replace(re, replacement);
                    }

                } catch (e) {
                    console.error(`Regex error in script "${script.name || 'Unnamed'}":`, e.message);
                }
            });
            return role === 'assistant' ? __s.filterBlockedStyleText(result) : result;
        };
        __s.processRegex = processRegex;
        const {
            clearCaches: clearMessageRenderCaches,
            contentUsesHtmlFrame,
            renderMarkdown
        } = createMessageRenderer({
            processRegex,
            replaceUserPlaceholder: __s.replaceUserNamePlaceholder,
            createExecutableHtmlIframe,
            marked,
            DOMPurify
        });
        __s.clearMessageRenderCaches = clearMessageRenderCaches;
        __s.contentUsesHtmlFrame = contentUsesHtmlFrame;
        __s.renderMarkdown = renderMarkdown;
        watch(() => [__s.settings.disableImages, __s.settings.styleFilterEnabled, __s.regexScripts.value, __s.user.name], () => {
            clearMessageRenderCaches();
        }, { deep: true });
        const messageUsesHtmlFrame = (msg) => {
            if (!msg || !msg.content) return false;
            if (msg.isTriggered) return msg.showRaw && contentUsesHtmlFrame(msg.content, msg.role);
            const parsed = parseCot(msg.content);
            return contentUsesHtmlFrame(parsed.main || msg.content, msg.role);
        };
        __s.messageUsesHtmlFrame = messageUsesHtmlFrame;
        const messageHasUiTemplateBlocks = (msg) => {
            const blocks = msg?.uiTemplateBlocks;
            if (!blocks) return false;
            return (Array.isArray(blocks.top) && blocks.top.length > 0)
                || (Array.isArray(blocks.bottom) && blocks.bottom.length > 0);
        };
        __s.messageHasUiTemplateBlocks = messageHasUiTemplateBlocks;
        const messageHasPendingUiTemplate = (msg) => (
            !!msg
            && __s.uiTemplateUpdateStatus.state === 'running'
            && __s.uiTemplateUpdateStatus.targetMessageId === msg.id
            && __s.activeUiTemplates.value.length > 0
        );
        __s.messageHasPendingUiTemplate = messageHasPendingUiTemplate;
        const messageUsesWideLayout = (msg) => {
            if (!msg) return false;
            return !!(
                msg.reasoning
                || parseCot(msg.content || '').cot
                || (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0)
                || messageUsesHtmlFrame(msg)
                || messageHasUiTemplateBlocks(msg)
                || messageHasPendingUiTemplate(msg)
            );
        };
        __s.messageUsesWideLayout = messageUsesWideLayout;
        const collapseNativeReasoning = (message) => {
            if (message && message.role === 'assistant' && typeof message.reasoning === 'string' && message.reasoning.trim()) {
                if (message.isReasoningUserToggled || message.isReasoningAutoCollapsed) return;
                message.isReasoningOpen = false;
                message.isReasoningAutoCollapsed = true;
            }
        };
        __s.collapseNativeReasoning = collapseNativeReasoning;
        const appendAssistantResponseError = (message, errorMessage) => {
            if (!message) return;
            message.responseError = [
                message.responseError,
                String(errorMessage || '生成失败')
            ].filter(Boolean).join('\n\n');
            message.shouldAnimate = false;
            collapseNativeReasoning(message);
        };
        __s.appendAssistantResponseError = appendAssistantResponseError;
        const collapseActiveNativeReasoning = () => {
            collapseNativeReasoning(__s.chatHistory.value[__s.chatHistory.value.length - 1]);
        };
        __s.collapseActiveNativeReasoning = collapseActiveNativeReasoning;

        // API & Models
        const fetchModels = async (isManual = false) => {
            const apiKey = String(__s.settings.apiKey || '').trim();
            if (!apiKey) {
                if (isManual) showToast('请先填写当前 API 预设的 Key', 'info');
                return;
            }
            try {
                if (isManual) showToast('正在获取模型列表...', 'info');
                const url = buildApiEndpoint(__s.settings.apiUrl, 'models');
                const data = await requestJson({ url, apiKey });
                __s.availableModels.value = data.data || [];
                if (isManual) showToast(`成功获取 ${__s.availableModels.value.length} 个模型`, 'success');
            } catch (error) {
                console.error(error);
                showToast('获取模型失败: ' + error.message, 'error');
            }
        };
        __s.fetchModels = fetchModels;
    };
})();
