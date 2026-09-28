/**
 * RP-Hub 应用模块 08 · 角色作用域资源辅助与 UI 模板运行时
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 2305–2723 行。
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
    window.RPHubAppSections.scopedUiTemplate = function (__s) {

        // --- Computed ---
        const currentCharacter = computed(() => {
            return __s.currentCharacterIndex.value >= 0 ? __s.characters.value[__s.currentCharacterIndex.value] : null;
        });
        __s.currentCharacter = currentCharacter;
        const scopeOptions = computed(() => [
            { value: 'character', label: '绑定当前角色卡', disabled: !currentCharacter.value },
            { value: 'global', label: '全局生效' }
        ]);
        __s.scopeOptions = scopeOptions;
        const normalizeRegexScript = (script = {}, fallbackScope = 'character') => (
            cardUtils.normalizeRegexScript(script, { fallbackScope, systemNames: systemRegexNames })
        );
        __s.normalizeRegexScript = normalizeRegexScript;
        const toRegexExportEntry = (script = {}, fallbackScope = 'character') => (
            cardUtils.toRegexExportEntry(normalizeRegexScript(script, fallbackScope))
        );
        __s.toRegexExportEntry = toRegexExportEntry;
        const combineRegexScriptsForCharacter = (char = currentCharacter.value) => {
            const globalScripts = JSON.parse(JSON.stringify(__s.globalRegexScripts.value || []))
                .map(script => normalizeRegexScript(script, 'global'));
            const characterScripts = Array.isArray(char?.regexScripts)
                ? JSON.parse(JSON.stringify(char.regexScripts)).map(script => normalizeRegexScript(script, 'character')).filter(script => script.scope !== 'global')
                : [];
            __s.regexScripts.value = [...globalScripts, ...characterScripts];
        };
        __s.combineRegexScriptsForCharacter = combineRegexScriptsForCharacter;
        const finishApplyingCharacterScopedData = () => {
            nextTick(() => {
                __s._isApplyingCharacterScopedData = false;
            });
        };
        __s.finishApplyingCharacterScopedData = finishApplyingCharacterScopedData;
        const toUiTemplateExportEntry = (template = {}) => {
            const normalized = normalizeUiTemplate(template);
            return cardUtils.toUiTemplateExportEntry(normalized);
        };
        __s.toUiTemplateExportEntry = toUiTemplateExportEntry;
        const ensureCurrentUiTemplates = () => {
            if (!currentCharacter.value) return [];
            if (!Array.isArray(currentCharacter.value.uiTemplates)) currentCharacter.value.uiTemplates = [];
            if (currentCharacter.value.uiTemplates.some(template => template.scope !== 'character' || !template.id)) {
                currentCharacter.value.uiTemplates = currentCharacter.value.uiTemplates.map(template => normalizeUiTemplate({ ...template, scope: 'character' }));
            }
            return currentCharacter.value.uiTemplates;
        };
        __s.ensureCurrentUiTemplates = ensureCurrentUiTemplates;
        const ensureGlobalUiTemplates = () => {
            if ((__s.globalUiTemplates.value || []).some(template => template.scope !== 'global' || !template.id)) {
                __s.globalUiTemplates.value = __s.globalUiTemplates.value.map(template => normalizeUiTemplate({ ...template, scope: 'global' }));
            }
            return __s.globalUiTemplates.value;
        };
        __s.ensureGlobalUiTemplates = ensureGlobalUiTemplates;
        const getUiTemplateListByScope = (scope) => scope === 'global' ? ensureGlobalUiTemplates() : ensureCurrentUiTemplates();
        __s.getUiTemplateListByScope = getUiTemplateListByScope;
        const currentUiTemplates = computed(() => [
            ...ensureGlobalUiTemplates(),
            ...ensureCurrentUiTemplates()
        ].map((template, index) => ({ template, index }))
            .sort((a, b) => (Number(b.template.order) || 0) - (Number(a.template.order) || 0) || a.index - b.index)
            .map(item => item.template));
        __s.currentUiTemplates = currentUiTemplates;
        const activeUiTemplates = computed(() => currentUiTemplates.value.filter(t => t.enabled !== false));
        __s.activeUiTemplates = activeUiTemplates;
        const isUiTemplateAnalysisEnabled = () => __s.settings.uiTemplateEnabled
            && __s.settings.uiTemplateMainModelAnalysis
            && activeUiTemplates.value.length > 0;
        __s.isUiTemplateAnalysisEnabled = isUiTemplateAnalysisEnabled;
        const handleUiTemplateClick = (event) => {
            const trigger = event.target?.closest?.('[data-slash]');
            if (!trigger) return;
            const command = trigger.getAttribute('data-slash');
            if (!command) return;
            event.preventDefault();
            event.stopPropagation();
            window.triggerSlash(command);
        };
        __s.handleUiTemplateClick = handleUiTemplateClick;
        const renderEditingUiTemplatePreview = () => {
            let variableState = __s.editingUiTemplate.data.previewVariableState || {};
            try {
                variableState = JSON.parse(__s.editingUiTemplate.data.variableStateText || '{}');
            } catch (e) {
                // 预览里 JSON 写错时，先沿用打开弹窗时的变量，避免整个弹窗空掉。
            }
            return renderUiTemplateHtml({
                htmlTemplate: __s.editingUiTemplate.data.htmlTemplate,
                variableState
            });
        };
        __s.renderEditingUiTemplatePreview = renderEditingUiTemplatePreview;
        const getLastAssistantMessage = () => [...__s.chatHistory.value].reverse().find(msg => msg && msg.role === 'assistant');
        __s.getLastAssistantMessage = getLastAssistantMessage;
        const summarizeUiTemplateFailure = (reason) => {
            const text = String(reason || 'UI模板变量校验失败').replace(/\s+/g, ' ').trim();
            return text.length > 800 ? `${text.slice(0, 797)}...` : text;
        };
        __s.summarizeUiTemplateFailure = summarizeUiTemplateFailure;
        const buildMainModelUiTemplateUpdatePrompt = () => {
            if (!__s.settings.uiTemplateEnabled || !__s.settings.uiTemplateMainModelAnalysis) return '';
            const templates = activeUiTemplates.value;
            if (!templates.length) return '';

            const templatePayload = templates.map(template => ({
                id: template.id,
                name: template.name || 'UI模板',
                currentVariables: template.variableState || {},
                variableSchema: template.variableSchema || ''
            }));

            return __s.replaceUserNamePlaceholder(BUILTIN_PROMPTS.buildMainModelUiTemplatePrompt({
                templatePayload,
                userName: __s.user.name
            }));
        };
        __s.buildMainModelUiTemplateUpdatePrompt = buildMainModelUiTemplateUpdatePrompt;
        const applyMainModelUiTemplateUpdates = (targetMessage, model = __s.settings.model) => {
            const templates = activeUiTemplates.value;
            if (!__s.settings.uiTemplateEnabled || !__s.settings.uiTemplateMainModelAnalysis || !targetMessage || !templates.length) {
                return { handled: false, changed: false };
            }
            delete targetMessage.uiTemplateAnalysisFailure;
            const recordFailure = (reason) => {
                const summary = summarizeUiTemplateFailure(reason);
                targetMessage.uiTemplateAnalysisFailure = {
                    summary,
                    reason: summary,
                    sourceMessageId: targetMessage.id || null
                };
                __s.failUiTemplateAnalysis('变量分析失败，下次请求将自动修正', targetMessage.id || null);
                console.warn('[UI模板] 主模型变量分析失败:', summary);
                return { handled: true, changed: false };
            };
            const match = findUiTemplateUpdateBlock(targetMessage.content);
            if (!match) {
                const missingTemplates = templates
                    .map(template => `模板“${template.name || '未命名'}”（ID：${template.id}）`)
                    .join('；');
                return recordFailure(`未输出UI模板变量块：${missingTemplates}`);
            }

            let updates = [];
            try {
                const updateContent = match[1];
                const parsed = parseUiTemplateUpdates(updateContent, templates);
                updates = normalizeUiTemplateUpdateList(parsed, templates);
            } catch (e) {
                const reason = e instanceof SyntaxError
                    ? `变量块格式错误：${e.message}`
                    : e.message;
                return recordFailure(reason);
            }

            const targetMessageIndex = __s.chatHistory.value.findIndex(msg => msg === targetMessage || (targetMessage.id && msg.id === targetMessage.id));
            const turn = targetMessageIndex >= 0 ? getAssistantTurnAtIndex(targetMessageIndex) : null;
            let changedFieldCount = 0;
            updates.forEach(update => {
                const targets = update?.id
                    ? activeUiTemplates.value.filter(template => template.id === update.id)
                    : (activeUiTemplates.value.length === 1 ? [activeUiTemplates.value[0]] : []);
                targets.forEach(template => {
                    const result = applyUiTemplateUpdateListToTemplate(template, [update], { model, turn, source: 'main_model' });
                    if (result.changed) {
                        changedFieldCount += result.fieldCount;
                    }
                });
            });

            attachUiTemplateBlocksToLastAssistant({ targetMessageId: targetMessage.id });

            if (changedFieldCount > 0) {
                saveGlobalUiTemplateRuntimeForCharacter();
                __s.saveData({ saveMemories: false });
                __s.markUiTemplateStatus('success', `更新 ${changedFieldCount} 项`, 0, targetMessage.id || null);
                return { handled: true, changed: true };
            }

            __s.markUiTemplateStatus('skipped', '无变化', 0, targetMessage.id || null);
            return { handled: true, changed: false };
        };
        __s.applyMainModelUiTemplateUpdates = applyMainModelUiTemplateUpdates;
        const appendPendingUiTemplateCorrection = (messageList) => {
            if (!__s.settings.uiTemplateEnabled || !__s.settings.uiTemplateMainModelAnalysis) return;

            let failureMessage = null;
            let failureIndex = -1;
            for (let index = __s.chatHistory.value.length - 1; index >= 0; index--) {
                const message = __s.chatHistory.value[index];
                if (message?.role === 'assistant' && message.uiTemplateAnalysisFailure) {
                    failureMessage = message;
                    failureIndex = index;
                    break;
                }
            }
            if (!failureMessage) return;

            let userIndex = -1;
            for (let index = __s.chatHistory.value.length - 1; index > failureIndex; index--) {
                if (__s.chatHistory.value[index]?.role === 'user') {
                    userIndex = index;
                    break;
                }
            }
            if (userIndex < 0) return;

            const target = [...messageList].reverse().find(message => (
                message?.role === 'user'
                && Array.isArray(message._sourceIndexes)
                && message._sourceIndexes.includes(userIndex)
            ));
            if (!target) return;

            const userMessage = __s.chatHistory.value[userIndex];
            const failure = failureMessage.uiTemplateAnalysisFailure;
            const correctionPrompt = BUILTIN_PROMPTS.buildMainModelUiTemplateCorrectionPrompt({
                failureSummary: failure.summary || summarizeUiTemplateFailure(failure.reason),
                failureReason: failure.reason
            });
            userMessage.uiTemplateCorrection = {
                summary: failure.summary || summarizeUiTemplateFailure(failure.reason),
                sourceMessageId: failure.sourceMessageId || failureMessage.id || null
            };
            delete failureMessage.uiTemplateAnalysisFailure;
            __s.scheduleChatHistorySave();
            target.content = `${correctionPrompt}\n\n${String(target.content || '').trimStart()}`;
        };
        __s.appendPendingUiTemplateCorrection = appendPendingUiTemplateCorrection;
        const removeOrphanedUiTemplateCorrections = () => {
            const messageIds = new Set(__s.chatHistory.value.map(message => message?.id).filter(Boolean));
            __s.chatHistory.value.forEach(message => {
                const sourceMessageId = message?.uiTemplateCorrection?.sourceMessageId;
                if (sourceMessageId && !messageIds.has(sourceMessageId)) {
                    delete message.uiTemplateCorrection;
                }
            });
        };
        __s.removeOrphanedUiTemplateCorrections = removeOrphanedUiTemplateCorrections;
        const attachUiTemplateBlocksToLastAssistant = ({ excludeTemplateIds = new Set(), targetMessageId = null } = {}) => {
            const targetMessage = targetMessageId
                ? __s.chatHistory.value.find(msg => msg && msg.role === 'assistant' && msg.id === targetMessageId)
                : getLastAssistantMessage();
            if (!targetMessage) return false;
            const top = activeUiTemplates.value
                .filter(template => template.placement === 'top' && !excludeTemplateIds.has(template.id))
                .map(renderUiTemplateHtml)
                .filter(Boolean);
            const bottom = activeUiTemplates.value
                .filter(template => template.placement === 'bottom' && !excludeTemplateIds.has(template.id))
                .map(renderUiTemplateHtml)
                .filter(Boolean);
            targetMessage.uiTemplateBlocks = {
                top,
                bottom,
                updatedAt: Date.now()
            };
            return top.length > 0 || bottom.length > 0;
        };
        __s.attachUiTemplateBlocksToLastAssistant = attachUiTemplateBlocksToLastAssistant;
        const getAssistantTurnAtIndex = (index) => {
            const normalizedIndex = Math.max(0, Math.min(index, __s.chatHistory.value.length - 1));
            return __s.getConversationTurnAtIndex(normalizedIndex);
        };
        __s.getAssistantTurnAtIndex = getAssistantTurnAtIndex;
        const buildUiTemplateStateAtTurn = (template, turn) => {
            let state = cloneUiObject(inferInitialUiTemplateState(template));
            const logs = Array.isArray(template.changeLog)
                ? template.changeLog
                    .filter(log => Number(log.turn || 0) <= turn)
                    .sort((a, b) => (a.turn || 0) - (b.turn || 0) || (a.time || 0) - (b.time || 0))
                : [];
            logs.forEach(log => {
                Object.entries(log.changes || {}).forEach(([key, change]) => {
                    if (change && Object.prototype.hasOwnProperty.call(change, 'to')) {
                        state = setUiTemplateValue(state, key, change.to);
                    }
                });
            });
            return state;
        };
        __s.buildUiTemplateStateAtTurn = buildUiTemplateStateAtTurn;
        const UI_TEMPLATE_CONTEXT_OPEN_TAG = '<ui_template_state_context>';
        __s.UI_TEMPLATE_CONTEXT_OPEN_TAG = UI_TEMPLATE_CONTEXT_OPEN_TAG;
        const UI_TEMPLATE_CONTEXT_CLOSE_TAG = '</ui_template_state_context>';
        __s.UI_TEMPLATE_CONTEXT_CLOSE_TAG = UI_TEMPLATE_CONTEXT_CLOSE_TAG;
        const stripUiTemplateContextInjection = (text) => String(text || '')
            .replace(/<ui_template_state_context>[\s\S]*?<\/ui_template_state_context>/gi, '')
            .replace(/<ui_template_state_context>[\s\S]*$/gi, '');
        __s.stripUiTemplateContextInjection = stripUiTemplateContextInjection;
        const stripNextResponsePrompt = (text) => String(text || '')
            .replace(/<next_response>[\s\S]*?<\/next_response>/gi, '')
            .replace(/<next_response>[\s\S]*$/gi, '');
        __s.stripNextResponsePrompt = stripNextResponsePrompt;
        const buildUiTemplateContextSystemPrompt = () => {
            if (!__s.settings.uiTemplateEnabled || !__s.settings.uiTemplateInjectContext || __s.settings.uiTemplateMainModelAnalysis) return '';
            const turn = __s.getLatestCompleteConversationTurn()?.turn;
            const referenceTurn = Number(turn) || 0;
            if (referenceTurn <= 0) return '';

            const sections = activeUiTemplates.value
                .map(template => {
                    const state = buildUiTemplateStateAtTurn(template, referenceTurn);
                    if (!state || Object.keys(state).length === 0) return null;
                    const title = escapeXmlAttribute(template.name || template.id || 'UI模板');
                    return [
                        `  <template_state name="${title}">`,
                        indentXmlText(JSON.stringify(state, null, 2), 4),
                        '  </template_state>'
                    ].join('\n');
                })
                .filter(Boolean);

            if (!sections.length) return '';
            return [
                UI_TEMPLATE_CONTEXT_OPEN_TAG,
                `  <description>${BUILTIN_PROMPTS.uiTemplateContextDescription}</description>`,
                ...sections,
                UI_TEMPLATE_CONTEXT_CLOSE_TAG
            ].join('\n');
        };
        __s.buildUiTemplateContextSystemPrompt = buildUiTemplateContextSystemPrompt;
        const rebuildUiTemplateStateFromLogs = (template, remainingLogs) => {
            let rebuilt = cloneUiObject(inferInitialUiTemplateState(template));
            [...remainingLogs]
                .sort((a, b) => (a.turn || 0) - (b.turn || 0) || (a.time || 0) - (b.time || 0))
                .forEach(log => {
                    Object.entries(log.changes || {}).forEach(([key, change]) => {
                        if (change && Object.prototype.hasOwnProperty.call(change, 'to')) {
                            rebuilt = setUiTemplateValue(rebuilt, key, change.to);
                        }
                    });
                });
            template.variableState = rebuilt;
        };
        __s.rebuildUiTemplateStateFromLogs = rebuildUiTemplateStateFromLogs;
        const pruneUiTemplateChangesFromTurn = (turn) => {
            if (!Number.isFinite(turn) || turn < 1) return { logs: 0, blocks: 0 };
            let removedLogs = 0;
            currentUiTemplates.value.forEach(template => {
                const allLogs = Array.isArray(template.changeLog) ? template.changeLog : [];
                const remainingLogs = allLogs.filter(log => (log.turn || 0) < turn);
                removedLogs += allLogs.length - remainingLogs.length;
                if (allLogs.length !== remainingLogs.length) {
                    rebuildUiTemplateStateFromLogs(template, remainingLogs);
                    template.changeLog = remainingLogs;
                }
            });

            let removedBlocks = 0;
            const snapshot = __s.buildConversationTurnSnapshot();
            const blockMessageIndexes = new Set();
            snapshot.turns.forEach(turnInfo => {
                if ((turnInfo.turn || 0) < turn) return;
                (turnInfo.sourceIndexes || []).forEach(sourceIndex => blockMessageIndexes.add(sourceIndex));
            });
            blockMessageIndexes.forEach(msgIndex => {
                const msg = __s.chatHistory.value[msgIndex];
                if (msg?.role === 'assistant' && msg.uiTemplateBlocks) {
                    delete msg.uiTemplateBlocks;
                    removedBlocks++;
                }
            });

            if (__s.uiTemplateUpdateStatus.targetMessageId) {
                const targetStillExists = __s.chatHistory.value.some(msg => msg.id === __s.uiTemplateUpdateStatus.targetMessageId);
                if (!targetStillExists) {
                    __s.abortUiTemplateUpdate(__s.uiTemplateUpdateStatus.targetMessageId);
                }
            }

            return { logs: removedLogs, blocks: removedBlocks };
        };
        __s.pruneUiTemplateChangesFromTurn = pruneUiTemplateChangesFromTurn;
        const resetUiTemplateRuntimeState = () => {
            __s.abortUiTemplateUpdate();
            currentUiTemplates.value.forEach(template => {
                template.variableState = cloneUiObject(template.initialVariableState || {});
                template.changeLog = [];
            });
            saveGlobalUiTemplateRuntimeForCharacter();
            __s.chatHistory.value.forEach(msg => {
                if (msg.uiTemplateBlocks) delete msg.uiTemplateBlocks;
            });
            __s.markUiTemplateStatus('idle', '待命');
        };
        __s.resetUiTemplateRuntimeState = resetUiTemplateRuntimeState;
        const getUiTemplateRuntimeKey = (char = currentCharacter.value, branchId = __s.activeStoryBranchId.value) => (
            __s.getStoryBranchScopeId(char?.uuid, branchId)
        );
        __s.getUiTemplateRuntimeKey = getUiTemplateRuntimeKey;
        const getUiTemplatesForRuntime = (char = currentCharacter.value) => [
            ...ensureGlobalUiTemplates(),
            ...(Array.isArray(char?.uiTemplates) ? char.uiTemplates : [])
        ];
        __s.getUiTemplatesForRuntime = getUiTemplatesForRuntime;
        const saveGlobalUiTemplateRuntimeForCharacter = (
            char = currentCharacter.value,
            branchId = __s.activeStoryBranchId.value
        ) => {
            const key = getUiTemplateRuntimeKey(char, branchId);
            if (!key) return;
            getUiTemplatesForRuntime(char).forEach(template => {
                if (!template.runtimeByCharacter || typeof template.runtimeByCharacter !== 'object') {
                    template.runtimeByCharacter = {};
                }
                template.runtimeByCharacter[key] = {
                    variableState: cloneUiObject(template.variableState || template.initialVariableState || {}),
                    changeLog: Array.isArray(template.changeLog) ? JSON.parse(JSON.stringify(template.changeLog)) : []
                };
            });
        };
        __s.saveGlobalUiTemplateRuntimeForCharacter = saveGlobalUiTemplateRuntimeForCharacter;
        const loadGlobalUiTemplateRuntimeForCharacter = (char = currentCharacter.value) => {
            const key = getUiTemplateRuntimeKey(char);
            getUiTemplatesForRuntime(char).forEach(template => {
                const runtime = key && template.runtimeByCharacter ? template.runtimeByCharacter[key] : null;
                const legacyCharacterState = __s.activeStoryBranchId.value === STORY_BRANCH_MAIN_ID && template.scope === 'character';
                template.variableState = cloneUiObject(runtime?.variableState
                    || (legacyCharacterState ? template.variableState : null)
                    || template.initialVariableState
                    || {});
                const changeLog = runtime?.changeLog || (legacyCharacterState ? template.changeLog : []);
                template.changeLog = Array.isArray(changeLog) ? JSON.parse(JSON.stringify(changeLog)) : [];
            });
            __s.markUiTemplateStatus('idle', '待命');
        };
        __s.loadGlobalUiTemplateRuntimeForCharacter = loadGlobalUiTemplateRuntimeForCharacter;
    };
})();
