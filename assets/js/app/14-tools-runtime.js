/**
 * RP-Hub 应用模块 14 · 主动工具：定义装配与系统提示词
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 4208–4304 行。
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
    window.RPHubAppSections.toolsRuntime = function (__s) {
        const isWechatActiveTool = (tool) => tool?.type === ACTIVE_TOOL_WECHAT_TYPE
            || __s.normalizeActiveToolBaseCallName(tool?.callName) === 'tool_wechat'
            || tool?.id === 'tool_wechat';
        __s.isWechatActiveTool = isWechatActiveTool;
        const getEnabledActiveTools = () => __s.normalizeActiveTools()
            .filter(tool => tool.enabled !== false && tool.callName)
            // 主动发微信依赖角色开着微信才有落点，未开启时不向模型暴露该工具。
            .filter(tool => !isWechatActiveTool(tool) || __s.currentCharacter.value?.wechatEnabled);
        __s.getEnabledActiveTools = getEnabledActiveTools;
        const isWebActiveTool = (tool) => tool?.type === ACTIVE_TOOL_WEB_TYPE
            || __s.normalizeActiveToolBaseCallName(tool?.callName) === 'tool_web'
            || ['tool_web', 'tool_web_add', 'tool_web_cover'].includes(tool?.id)
            || /tavily|联网搜索/i.test(String(tool?.name || ''));
        __s.isWebActiveTool = isWebActiveTool;
        const getActiveToolDisplayDescription = (tool) => tool?.displayDescription || '暂无说明';
        __s.getActiveToolDisplayDescription = getActiveToolDisplayDescription;
        const appendActiveToolReminderToLatestUserMessage = (msgArray) => {
            if (getEnabledActiveTools().length === 0) return msgArray;
            const reminder = __s.getActiveToolLatestUserReminder();
            const latestUserMessage = [...msgArray].reverse().find(message => {
                const content = String(message?.content || '');
                return message?.role === 'user'
                    && content.trim()
                    && !isRoleMemoryContextContent(content);
            });
            if (!latestUserMessage) return msgArray;

            const currentContent = String(latestUserMessage.content || '').trimEnd();
            if (!currentContent.includes(reminder)) {
                latestUserMessage.content = currentContent
                    ? `${currentContent}\n${reminder}`
                    : reminder;
            }
            return msgArray;
        };
        __s.appendActiveToolReminderToLatestUserMessage = appendActiveToolReminderToLatestUserMessage;
        const buildActiveToolDefinitions = (tools) => tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.callName,
                description: tool.resultCount ? `${tool.description} 每次最多返回 ${tool.resultCount} 条。` : tool.description,
                parameters: tool.type === ACTIVE_TOOL_WECHAT_TYPE ? {
                    type: 'object',
                    properties: {
                        content: { type: 'string', description: '这条微信的正文：真人微信口吻的短消息，口语、可带语气词，不要写成旁白、括号动作或小说描写。' },
                        reason: { type: 'string', description: '可选，一句话说明为什么现在发这条微信。' }
                    },
                    required: ['content'],
                    additionalProperties: false
                } : tool.type === ACTIVE_TOOL_RANDOM_TYPE ? {
                    type: 'object',
                    properties: {
                        min: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, description: '随机整数的下限，包含该值。' },
                        max: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, description: '随机整数的上限，包含该值，不小于 min。' },
                        reason: { type: 'string', description: '可选，一句话说明随机判定的用途。' }
                    },
                    required: ['min', 'max'],
                    additionalProperties: false
                } : {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: isWebActiveTool(tool) ? '具体搜索词，或需要读取的真实网页 URL。' : '前文原文中可能出现的关键词。' },
                        reason: { type: 'string', description: '可选，一句话说明检索用途。' }
                    },
                    required: ['query'],
                    additionalProperties: false
                }
            }
        }));
        __s.buildActiveToolDefinitions = buildActiveToolDefinitions;
        const buildActiveToolSystemPrompt = (tools) => {
            if (tools.length === 0) return '';
            return BUILTIN_PROMPTS.buildActiveToolSystemPrompt({
                tools,
                reminder: __s.getActiveToolLatestUserReminder(),
                aggressivenessLabel: __s.getActiveToolAggressivenessLabel(),
                maxRounds: ACTIVE_TOOL_MAX_AUTO_CONTINUE
            });
        };
        __s.buildActiveToolSystemPrompt = buildActiveToolSystemPrompt;
        const usesThinkingCotTag = (model) => /(?:deepseek|glm|kimi)/i.test(String(model || ''));
        __s.usesThinkingCotTag = usesThinkingCotTag;
        const getMessageThinkingText = (message, includeNativeReasoning = true) => {
            const parts = includeNativeReasoning ? [String(message?.reasoning || '').trim()] : [];
            parts.push(parseCot(message?.content || '').rawCot);
            return [...new Set(parts)].filter(Boolean).join('\n\n');
        };
        __s.getMessageThinkingText = getMessageThinkingText;
        const wrapAnalysis = (tag, text) => text
            ? `<${tag}>\n${text.replace(/<\s*\/?\s*(?:thinking|think|cot)\s*>/gi, '')}\n</${tag}>\n`
            : '';
        __s.wrapAnalysis = wrapAnalysis;
        const appendNextResponsePrompt = (messageList, { cotEnabled = false, useThinkingTag = false, writingStylePrompt = '' } = {}) => {
            const target = [...messageList].reverse().find(message => (
                message?.role === 'user'
                && Array.isArray(message._sourceIndexes)
                && message._sourceIndexes.length > 0
            ));
            if (!target) return;

            const prompt = BUILTIN_PROMPTS.buildNextResponsePrompt({
                autoImageGenEnabled: __s.isAutoImageGenEnabled.value,
                cotEnabled,
                imageGenCount: __s.settings.imageGenCount,
                memoryEnabled: __s.memorySettings.enabled,
                useThinkingTag,
                writingStylePrompt,
                storyPanelsEnabled: __s.isStoryPanelsEnabled.value,
                uiTemplateEnabled: __s.isUiTemplateAnalysisEnabled()
            });
            const replyToolReminder = __s.isTruncationEnabled.value
                ? `(${BUILTIN_PROMPTS.replyToolInstruction.replace(/。$/, '')})` : '';
            target.content = `${String(target.content || '').trimEnd()}${replyToolReminder}\n\n${prompt}`;
        };
        __s.appendNextResponsePrompt = appendNextResponsePrompt;
        const usedGeminiPromptNonces = new Set();
        __s.usedGeminiPromptNonces = usedGeminiPromptNonces;
    };
})();
