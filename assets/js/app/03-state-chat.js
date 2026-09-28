/**
 * RP-Hub 应用模块 03 · 角色 / 聊天记录 / 预设 / 正则 / 世界书等数据状态
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 896–1108 行。
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
    window.RPHubAppSections.stateChat = function (__s) {
        const characters = ref([]);
        __s.characters = characters;
        const showAddCharacterMenu = ref(false);
        __s.showAddCharacterMenu = showAddCharacterMenu;
        const currentCharacterIndex = ref(-1);
        __s.currentCharacterIndex = currentCharacterIndex;
        const switchingCharacterIndex = ref(-1);
        __s.switchingCharacterIndex = switchingCharacterIndex;
        const chatHistory = ref([]);
        __s.chatHistory = chatHistory;
        const CHAT_RENDER_INITIAL_LIMIT = 20;
        __s.CHAT_RENDER_INITIAL_LIMIT = CHAT_RENDER_INITIAL_LIMIT;
        const CHAT_RENDER_BATCH_SIZE = 10;
        __s.CHAT_RENDER_BATCH_SIZE = CHAT_RENDER_BATCH_SIZE;
        const chatRenderLimit = ref(CHAT_RENDER_INITIAL_LIMIT);
        __s.chatRenderLimit = chatRenderLimit;
        __s.isLoadingEarlierChatMessages = false;
        __s.isChatTopUnlockArmed = true;
        const lastActiveCharacterId = ref(null);
        __s.lastActiveCharacterId = lastActiveCharacterId;

 // For persistence
        function hasActiveToolContinuationWork() {
            return !!(__s.activeToolContinuationPending.value || (
                __s.activeToolContinuationMessageId.value
                && (__s.isGenerating.value || __s.isRemoteGenerating.value)
            ));
        }
        __s.hasActiveToolContinuationWork = hasActiveToolContinuationWork;
        const hasActiveToolInlineWork = computed(() => {
            if (__s.activeToolHandoffPending.value || hasActiveToolContinuationWork() || __s.activeToolQueueRunning.value) return true;
            if (!__s.isGenerating.value && !__s.isRemoteGenerating.value) return false;
            return chatHistory.value.some(msg => (
                msg?.role === 'assistant'
                && Array.isArray(msg.toolCalls)
                && msg.toolCalls.some(toolCall => ['receiving', 'queued', 'running'].includes(toolCall?.status))
            ));
        });
        __s.hasActiveToolInlineWork = hasActiveToolInlineWork;
        const isConversationBusy = computed(() => __s.isGenerating.value || __s.isRemoteGenerating.value || hasActiveToolInlineWork.value);
        __s.isConversationBusy = isConversationBusy;
        const presets = ref([]);
        __s.presets = presets;

        // 抗截断只临时停用 COT，不改写用户保存的开关状态。
        const isPresetEnabled = preset => preset.enabled !== false
            && (preset.name !== 'COT' || !__s.isTruncationEnabled.value);
        __s.isPresetEnabled = isPresetEnabled;
        const isStoryPanelsEnabled = computed(() => presets.value.some(preset => preset.name === BUILTIN_PRESETS.storyPanels.name
            && preset.enabled !== false && String(preset.content || '').trim()));
        __s.isStoryPanelsEnabled = isStoryPanelsEnabled;
        const normalizePresetRole = (role) => (
            ['system', 'user', 'assistant'].includes(role) ? role : 'system'
        );
        __s.normalizePresetRole = normalizePresetRole;
        const normalizePreset = (preset = {}) => ({
            ...preset,
            name: preset.name || 'New Preset',
            content: String(preset.content || ''),
            // 微信版文案：与 content 同一预设的两种写法，RP 用 content，微信侧用这份。
            // 留空表示该预设不适用于微信，微信抽屉里不会列出来。
            wechatContent: String(preset.wechatContent || ''),
            enabled: preset.enabled !== false,
            role: normalizePresetRole(preset.role || preset.presetRole || preset.type)
        });
        __s.normalizePreset = normalizePreset;
        const syncBuiltinPreset = ({
            name,
            content,
            wechatContent,
            aliases = [],
            role,
            enabled = true,
            syncEnabled = false,
            before,
            after,
            move = false
        }) => {
            const names = new Set([name, ...aliases]);
            let index = presets.value.findIndex(preset => names.has(preset?.name));
            const preset = index === -1 ? { name, content, enabled } : presets.value[index];

            preset.name = name;
            preset.content = content;
            // 内置预设整份覆盖，避免改掉 wechatContent 后残留上一版文案。
            preset.wechatContent = String(wechatContent || '');
            if (role) preset.role = role;
            if (syncEnabled) preset.enabled = enabled;

            if (index === -1 || move) {
                if (index !== -1) presets.value.splice(index, 1);
                const beforeIndex = before ? presets.value.findIndex(item => item?.name === before) : -1;
                const afterIndex = after ? presets.value.findIndex(item => item?.name === after) : -1;
                index = beforeIndex !== -1
                    ? beforeIndex
                    : afterIndex !== -1 ? afterIndex + 1 : presets.value.length;
                presets.value.splice(index, 0, normalizePreset(preset));
            }
            return preset;
        };
        __s.syncBuiltinPreset = syncBuiltinPreset;
        const getPresetRoleLabel = (preset) => {
            const role = normalizePresetRole(preset?.role);
            return presetRoleOptions.find(option => option.value === role)?.label || '系统提示词';
        };
        __s.getPresetRoleLabel = getPresetRoleLabel;
        const getPresetRoleDisplayLabel = (preset) => {
            const role = normalizePresetRole(preset?.role);
            return presetRoleDisplayLabels[role] || '系统';
        };
        __s.getPresetRoleDisplayLabel = getPresetRoleDisplayLabel;
        const getPresetRoleBadgeClass = (preset) => {
            return `meta-badge--${normalizePresetRole(preset?.role)}`;
        };
        __s.getPresetRoleBadgeClass = getPresetRoleBadgeClass;
        const blockedStyleSentencePattern = /[^。！？!?\n]*(?:不容置疑|(?:不易|难以)(?:察觉|觉察)|(?:微|几)不可察|一抹|弧度|生理性|微微泛|因为用力|像在|风箱|手术刀|上扬|带着一种|语气很平|声音很平|(?:指尖|指节|指关节)[^。！？!?\n]*(?:发白|泛白)|像(?:是)?[^。！？!?\n]*?[，,]\s*又像(?:是)?|不是[^。！？!?\n]*?(?:而是|就是|[，,]\s*(?:是|(?:更|倒|反倒)?像是)))[^。！？!?\n]*(?:[。！？!?]+[”’」』】）)]*(?:\*\*|__)?)?/g;
        __s.blockedStyleSentencePattern = blockedStyleSentencePattern;
        const standaloneWordCountSentencePattern = /(^|[。！？!?\n]+[”’」』】）)]*)[ \t]*(?:\*\*|__)?(?:\d+|[零〇一二两三四五六七八九十百千万]+)个字[^。！？!?\n]*(?:[。！？!?]+[”’」』】）)]*(?:\*\*|__)?)?/gm;
        __s.standaloneWordCountSentencePattern = standaloneWordCountSentencePattern;
        const paleFingerClausePattern = /(?:^|[，,；;])[^，,。！？!?；;\n]*(?:指尖|指节|指关节)[^，,。！？!?；;\n]*(?:发白|泛白)[^，,。！？!?；;\n]*(?=$|[，,。！？!?；;\n])/gm;
        __s.paleFingerClausePattern = paleFingerClausePattern;
        const blockedStyleClausePattern = /(?:^|[，,；;])[^，,。！？!?；;\n*_]*(?:微微泛|因为用力|像在|风箱|手术刀|上扬|带着一种)[^，,。！？!?；;\n*_]*(?=(?:\*\*|__)?[ \t]*(?:$|[，,。！？!?；;\n]))/gm;
        __s.blockedStyleClausePattern = blockedStyleClausePattern;
        const blockedStyleWordPattern = /极其/g;
        __s.blockedStyleWordPattern = blockedStyleWordPattern;
        const quotedDialoguePattern = /(“[\s\S]*?”|『[\s\S]*?』|"[\s\S]*?")/g;
        __s.quotedDialoguePattern = quotedDialoguePattern;
        const standaloneRenderedContentPattern = /^(?:\s|<!--[\s\S]*?-->)*(?:```|<!doctype\b|<\?xml\b|<html\b|<(?:head|body|style|script|template|svg|canvas|iframe|div|section|article|aside|header|footer|main|nav|form|table|ul|ol|pre|p|img)\b)/i;
        __s.standaloneRenderedContentPattern = standaloneRenderedContentPattern;
        const isStandaloneRenderedContent = text => standaloneRenderedContentPattern.test(String(text || ''));
        __s.isStandaloneRenderedContent = isStandaloneRenderedContent;
        const loggedBlockedStyleFragments = new Set();
        __s.loggedBlockedStyleFragments = loggedBlockedStyleFragments;
        const openStyleFilterMessageKey = ref('');
        __s.openStyleFilterMessageKey = openStyleFilterMessageKey;
        const getStyleFilterMessageKey = (message, index) => String(message?.id || `message-${index}`);
        __s.getStyleFilterMessageKey = getStyleFilterMessageKey;
        const isStyleFilterDetailsOpen = (message, index) => (
            openStyleFilterMessageKey.value === getStyleFilterMessageKey(message, index)
        );
        __s.isStyleFilterDetailsOpen = isStyleFilterDetailsOpen;
        const toggleStyleFilterDetails = (message, index) => {
            const key = getStyleFilterMessageKey(message, index);
            openStyleFilterMessageKey.value = openStyleFilterMessageKey.value === key ? '' : key;
        };
        __s.toggleStyleFilterDetails = toggleStyleFilterDetails;
        const normalizeStyleFilterHit = fragment => String(fragment || '')
            .trim()
            .replace(/^[，,；;]\s*/, '')
            .replace(/^(?:\*\*|__)/, '')
            .replace(/(?:\*\*|__)$/, '')
            .trim();
        __s.normalizeStyleFilterHit = normalizeStyleFilterHit;
        const styleFilterHighlightPattern = /(?:不容置疑|(?:不易|难以)(?:察觉|觉察)|(?:微|几)不可察|一抹|弧度|生理性|微微泛|因为用力|像在|风箱|手术刀|上扬|带着一种|语气很平|声音很平|(?:\d+|[零〇一二两三四五六七八九十百千万]+)个字|指尖|指节|指关节|发白|泛白|不是|而是|就是|又像(?:是)?|(?:更|倒|反倒)?像是|极其)/g;
        __s.styleFilterHighlightPattern = styleFilterHighlightPattern;
        const getStyleFilterHitSegments = fragment => {
            const text = String(fragment || '');
            const segments = [];
            let lastIndex = 0;
            for (const match of text.matchAll(styleFilterHighlightPattern)) {
                if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index), matched: false });
                segments.push({ text: match[0], matched: true });
                lastIndex = match.index + match[0].length;
            }
            if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), matched: false });
            return segments.length ? segments : [{ text, matched: false }];
        };
        __s.getStyleFilterHitSegments = getStyleFilterHitSegments;
        const filterBlockedStyleText = (text, { log = false, collect = null } = {}) => {
            const source = String(text || '');
            if (!__s.settings.styleFilterEnabled) return source;
            if (isStandaloneRenderedContent(source)) return source;
            const removedFragments = [];
            const updateBlock = findUiTemplateUpdateBlock(source);
            const filterEnd = updateBlock?.index ?? source.length;
            const filtered = cardUtils.transformUnprotectedText(source.slice(0, filterEnd), part => part
                .split(quotedDialoguePattern)
                .map((fragment, index) => index % 2 ? fragment : fragment
                    .replace(standaloneWordCountSentencePattern, (match, prefix = '') => {
                        removedFragments.push(match.slice(prefix.length).trim());
                        return prefix;
                    })
                    .replace(blockedStyleSentencePattern, match => { removedFragments.push(match.trim()); return ''; })
                    .replace(paleFingerClausePattern, match => { removedFragments.push(match.trim()); return ''; })
                    .replace(blockedStyleClausePattern, match => { removedFragments.push(match.trim()); return ''; })
                    .replace(blockedStyleWordPattern, match => { removedFragments.push(match); return ''; })
                    .replace(/^[ \t]*[，,；;]+/gm, '')
                    .replace(/[，,；;]{2,}/g, marks => marks.at(-1))
                    .replace(/[，,；;]+([。！？!?])/g, '$1')
                    .replace(/[ \t]+\n/g, '\n')
                    .replace(/\n{3,}/g, '\n\n'))
                .join(''));
            if (Array.isArray(collect)) {
                collect.push(...removedFragments.map(normalizeStyleFilterHit).filter(Boolean));
            }
            if (log) {
                const newFragments = removedFragments.filter(fragment => fragment && !loggedBlockedStyleFragments.has(fragment));
                newFragments.forEach(fragment => loggedBlockedStyleFragments.add(fragment));
                if (newFragments.length) console.info(`[文风过滤] 已过滤 ${newFragments.length} 处`, newFragments);
            }
            return filtered + source.slice(filterEnd);
        };
        __s.filterBlockedStyleText = filterBlockedStyleText;
        const getPostprocessedChatMessages = (messages = chatHistory.value, options = {}) => (
            postprocessChatHistory(messages, options).map(message => message.role === 'assistant'
                ? { ...message, content: filterBlockedStyleText(message.content) }
                : message)
        );
        __s.getPostprocessedChatMessages = getPostprocessedChatMessages;
        const buildConversationTurnSnapshot = (messages = chatHistory.value, options = {}) => (
            createConversationTurnSnapshot(messages, options)
        );
        __s.buildConversationTurnSnapshot = buildConversationTurnSnapshot;
        const getConversationTurnAtIndex = (index) => {
            return getConversationTurnAtIndexFromSnapshot(buildConversationTurnSnapshot(), index);
        };
        __s.getConversationTurnAtIndex = getConversationTurnAtIndex;
        const getLatestCompleteConversationTurn = () => {
            const snapshot = buildConversationTurnSnapshot();
            return snapshot.turns[snapshot.turns.length - 1] || null;
        };
        __s.getLatestCompleteConversationTurn = getLatestCompleteConversationTurn;
        const latestDeletableMessageIndexes = computed(() => {
            let latestUserIndex = -1;
            for (let index = chatHistory.value.length - 1; index >= 0; index--) {
                if (chatHistory.value[index]?.role === 'user') {
                    latestUserIndex = index;
                    break;
                }
            }
            if (latestUserIndex < 0) return new Set();
            const indexes = new Set([latestUserIndex]);
            for (let index = latestUserIndex + 1; index < chatHistory.value.length; index++) {
                if (['assistant', 'system'].includes(chatHistory.value[index]?.role)) indexes.add(index);
            }
            return indexes;
        });
        __s.latestDeletableMessageIndexes = latestDeletableMessageIndexes;
        const canDeleteMessage = (index) => latestDeletableMessageIndexes.value.has(index);
        __s.canDeleteMessage = canDeleteMessage;
        const regexScripts = ref([]);
        __s.regexScripts = regexScripts;
        const globalRegexScripts = ref([]);
        __s.globalRegexScripts = globalRegexScripts;
        const LEGACY_USER_REGEX_NAME = 'Auto Replace {{user}}';
        __s.LEGACY_USER_REGEX_NAME = LEGACY_USER_REGEX_NAME;
        const isLegacyUserRegex = (script) => (script?.name || script?.scriptName) === LEGACY_USER_REGEX_NAME;
        __s.isLegacyUserRegex = isLegacyUserRegex;
        const removeLegacyUserRegex = () => {
            regexScripts.value = regexScripts.value.filter(script => !isLegacyUserRegex(script));
            globalRegexScripts.value = globalRegexScripts.value.filter(script => !isLegacyUserRegex(script));
            characters.value.forEach(character => {
                if (Array.isArray(character.regexScripts)) {
                    character.regexScripts = character.regexScripts.filter(script => !isLegacyUserRegex(script));
                }
            });
        };
        __s.removeLegacyUserRegex = removeLegacyUserRegex;
        const globalWorldInfo = ref([]);
        __s.globalWorldInfo = globalWorldInfo;
        const worldInfo = ref([]);
        __s.worldInfo = worldInfo;
        const globalUiTemplates = ref([]);
        __s.globalUiTemplates = globalUiTemplates;
        const recentGenerationTimes = ref([]);
        __s.recentGenerationTimes = recentGenerationTimes;
        const currentWaitTime = ref('0.0');
        __s.currentWaitTime = currentWaitTime;
        __s.waitTimer = null;
    };
})();
