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
        __s.getExplicitWechatToolName = tools => {
            const tool = tools.find(t => t.enabled !== false && isWechatActiveTool(t));
            if (!tool || !__s.currentCharacter.value?.wechatEnabled) return null;
            const name = __s.currentCharacter.value.name;
            const input = String((__s.chatHistory.value || []).findLast(m => m.role === 'user')?.content || '')
                .replace(/<(think|thinking|cot)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '')
                .replace(/“[^”]*”|"[^"\n]*"|「[^」]*」/g, '');
            const explicit = (input.match(/[^。！？!?\n]+[。！？!?]?/g) || []).some(clause => {
                const recipient = /给([^，,：:\s]{1,20}?)(?:发|发送|联系)/.exec(clause)?.[1];
                if (recipient && !['我', '玩家', '{{user}}', __s.user?.name].includes(recipient)) return false;
                return name && clause.includes(name)
                && /(?:发(?:送|来|出|了)?(?:一条|条|个)?(?:微信|消息|信息)|微信.{0,30}(?:发|联系))/.test(clause)
                && !/[？?]|不要|别发|不发|没发|尚未|未发|想|考虑|打算|准备|如果|假如|等到|明天|后天|曾经|之前|刚才|给(?:外卖|商家|骑手|同学|朋友)|群聊|群里/.test(clause);
            });
            return explicit ? tool.callName : null;
        };
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
        // 主动微信是人物行动，不能因全局「强制工具」策略每轮强迫发一条。
        const shouldRequireActiveToolCall = (tools) => __s.getActiveToolAggressiveness() === 'force'
            && tools.some(tool => !isWechatActiveTool(tool));
        __s.shouldRequireActiveToolCall = shouldRequireActiveToolCall;
        const getActiveToolInvocationReminder = (tools) => [
            tools.every(isWechatActiveTool)
                ? '主动微信由人物处境和意愿决定：只有能安全通信且想发送时才调用；没有条件或意愿时直接继续 RP 正文，不必调用工具。'
                : __s.getActiveToolLatestUserReminder(),
            tools.some(isWechatActiveTool)
                ? `微信工具只执行「${__s.currentCharacter.value?.name || '角色'}」→「${__s.user?.name || '用户'}」的角色消息；玩家自己的草稿、想说的话或发送意图不触发角色代发。`
                    + '玩家明确指定当前角色用微信给玩家发消息，或本轮剧情写到角色实际按下发送时，必须调用tool_wechat发送那条消息并结束本轮；门口、隔着门或同一建筑也可用微信。仅掏手机、考虑联系或给外卖商家发消息不触发。不要只在旁白写“发送了”而漏掉工具。'
                : ''
        ].filter(Boolean).join('\n');
        __s.getActiveToolInvocationReminder = getActiveToolInvocationReminder;
        const buildActiveToolDefinitions = (tools) => tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.callName,
                description: isWechatActiveTool(tool)
                    ? `只发送本体角色「${__s.currentCharacter.value?.name || '角色'}」给玩家「${__s.user?.name || '用户'}」的一条新微信。玩家“我想给她发”的草稿属于玩家，不得搬作角色发送；不是玩家代发器或其他NPC发送工具。${tool.description || ''}`
                    : tool.resultCount ? `${tool.description} 每次最多返回 ${tool.resultCount} 条。` : tool.description,
                parameters: tool.type === ACTIVE_TOOL_WECHAT_TYPE ? {
                    type: 'object',
                    properties: {
                        content: { type: 'string', description: `「${__s.currentCharacter.value?.name || '角色'}」本人发给「${__s.user?.name || '用户'}」的一条纯文本消息，表达角色自己的话；不能复制玩家准备发给角色的草稿、属于玩家的引语或其他NPC台词。玩家明确指定由本体角色说的台词按该归属处理。与 image 二选一，不接受JSON消息列表或发送者字段。本RP回合只可调用一次，成功即交给玩家回应。` },
                        image: {
                            type: 'object', description: __s.isWechatImageGenerationReady?.()
                                ? '发送一张真实图片，与 content 二选一。复杂画面、自拍或没有匹配素材时用 generate 并提供具体英文 prompt；description 是中文画面说明，不是角色配文。新图片不能使用 describe。'
                                : '发送一张图片，与 content 二选一。复杂画面或没有匹配素材时用 describe；description 是画面，不是角色的文字配文。',
                            properties: {
                                mode: { type: 'string', enum: ['album', 'draw', ...(__s.isWechatImageGenerationReady?.() ? ['generate'] : ['describe'])] },
                                prompt: { type: 'string', maxLength: 1500, description: '生图模式必填，符合当前剧情的具体画面提示词。' },
                                selfPortrait: { type: 'boolean', description: '仅generate使用。有本人人物参考图时不可省略：当前角色本人入镜填true，饭菜、风景或他人填false。程序按所选服务加入参考图，prompt描述当前场景。' },
                                referenceIds: { type: 'array', items: { type: 'string' }, maxItems: 16, description: '本轮匹配的地点参考图 ID；人物参考图在 selfPortrait=true 时自动加入。' },
                                scene: { ...window.RPHubImageGeneration.SCENE_SCHEMA, description: '自然语言生图的画面计划，先核对本轮地点、服装、动作、机位和道具，再写prompt。参考照片中的设备和服装不能默认继承。' },
                                description: { type: 'string', maxLength: 240, description: '中文画面说明，不是角色配文。未配置生图时才可用于描述兜底。' },
                                assetId: { type: 'string', description: '相册模式使用本轮目录里的真实 ID。' },
                                usage: { type: 'string', enum: ['scene_photo', 'album_photo', 'reference', 'drawing'] },
                                template: { type: 'string', enum: ['note', 'doodle'] },
                                text: { type: 'string', maxLength: 100 },
                                subject: { type: 'string', enum: ['heart', 'cat', 'flower', 'meal'] },
                                tone: { type: 'string', enum: ['warm', 'cool', 'plain'] },
                                decorations: { type: 'array', items: { type: 'string', enum: ['heart', 'star'] }, maxItems: 3 }
                            }, required: ['mode'], additionalProperties: false
                        },
                        sendAt: { type: 'string', description: '可选，实际新发消息的剧情日期时间；不要用它补造过去未记录的联系。' },
                        reason: { type: 'string', description: '可选，一句话说明为什么现在发这条微信。' }
                    },
                    anyOf: [{ required: ['content'] }, { required: ['image'] }],
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
                reminder: getActiveToolInvocationReminder(tools),
                aggressivenessLabel: tools.every(isWechatActiveTool) ? '按人物处境自主决定' : __s.getActiveToolAggressivenessLabel(),
                maxRounds: ACTIVE_TOOL_MAX_AUTO_CONTINUE,
                userName: __s.user?.name,
                characterName: __s.currentCharacter.value?.name
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
        const appendResponseProtocolPrompt = (messageList, { cotEnabled = false, useThinkingTag = false } = {}) => {
            const prompt = BUILTIN_PROMPTS.buildResponseProtocolPrompt({
                autoImageGenEnabled: __s.isAutoImageGenEnabled.value,
                cotEnabled,
                imageGenCount: __s.settings.imageGenCount,
                useThinkingTag,
                replyInTool: __s.isTruncationEnabled.value,
                storyPanelsEnabled: __s.isStoryPanelsEnabled.value,
                uiTemplateEnabled: __s.isUiTemplateAnalysisEnabled()
            });
            const G = window.RPHubImageGeneration;
            const imageGuide = __s.isAutoImageGenEnabled.value ? '\n' + G.formatPrompt(G.config(__s.settings)) + '\n'
                + G.identityPrompt(__s.currentCharacter.value, G.config(__s.settings)) : '';
            return BUILTIN_PROMPTS.appendSystemPrompt(messageList, prompt + imageGuide);
        };
        __s.appendResponseProtocolPrompt = appendResponseProtocolPrompt;
        const usedGeminiPromptNonces = new Set();
        __s.usedGeminiPromptNonces = usedGeminiPromptNonces;
    };
})();
