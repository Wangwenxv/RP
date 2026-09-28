/**
 * RP-Hub 应用模块 17 · 增强记忆召回、关键词检索工具与 Tavily 联网工具
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 5492–5789 行。
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
    window.RPHubAppSections.retrievalWeb = function (__s) {
        const extractKeywordToolTerms = (query) => {
            const cleanQuery = trimMemoryText(query, 300);
            if (!cleanQuery) return [];
            const parts = cleanQuery
                .split(/[\s,，、;；|｜/\\]+/u)
                .map(term => term.trim())
                .filter(Boolean);
            return Array.from(new Set([cleanQuery, ...parts]))
                .filter(term => term.length > 0)
                .slice(0, 12);
        };
        __s.extractKeywordToolTerms = extractKeywordToolTerms;
        const getKeywordToolMessageText = (message) => {
            if (!message || typeof message.content !== 'string') return '';
            const parsedData = parseCot(message.content || '');
            const cleanMain = __s.stripUiTemplateContextInjection(parsedData.main || '');
            return trimMemoryText(__s.stripDisabledImageGenContext(__s.stripNextResponsePrompt(stripUiTemplateUpdateBlock(cleanMain))), 5000);
        };
        __s.getKeywordToolMessageText = getKeywordToolMessageText;
        const buildKeywordToolSnippet = (text, matchedTerms) => {
            const source = String(text || '').trim();
            if (source.length <= 1400) return source;
            const lowerSource = source.toLowerCase();
            const firstIndex = matchedTerms
                .map(term => lowerSource.indexOf(String(term || '').toLowerCase()))
                .filter(index => index >= 0)
                .sort((a, b) => a - b)[0] ?? 0;
            const start = Math.max(0, firstIndex - 420);
            const end = Math.min(source.length, firstIndex + 900);
            return `${start > 0 ? '...' : ''}${source.slice(start, end).trim()}${end < source.length ? '...' : ''}`;
        };
        __s.buildKeywordToolSnippet = buildKeywordToolSnippet;
        const searchDialogueByKeywordForTool = (query, limit, options = {}) => {
            const terms = extractKeywordToolTerms(query);
            if (terms.length === 0) return [];
            const lowerTerms = terms.map(term => term.toLowerCase());
            const messages = __s.getPostprocessedChatMessages(__s.chatHistory.value, { includeSystem: false });
            const snapshot = __s.buildConversationTurnSnapshot(messages, { alreadyPostprocessed: true });
            const turnByMessageIndex = new Map();
            (snapshot.turns || []).forEach(turnInfo => {
                (turnInfo.messageIndexes || []).forEach(messageIndex => {
                    turnByMessageIndex.set(messageIndex, turnInfo.turn);
                });
            });

            const scored = [];
            messages.forEach((message, index) => {
                if (!message || message.role === 'system') return;
                if (options.excludeMessageId && message.id === options.excludeMessageId) return;
                const text = getKeywordToolMessageText(message);
                if (!text || isRoleMemoryContextContent(text)) return;

                const lowerText = text.toLowerCase();
                const matchedTerms = terms.filter((term, termIndex) => lowerText.includes(lowerTerms[termIndex]));
                if (matchedTerms.length === 0) return;

                const fullQueryMatched = lowerText.includes(lowerTerms[0]);
                const roleLabel = message.role === 'user' ? '用户' : '角色卡';
                const speaker = message.name || (message.role === 'user' ? __s.user.name : __s.currentCharacter.value?.name) || roleLabel;
                scored.push({
                    turn: turnByMessageIndex.get(index) || getConversationTurnAtIndexFromSnapshot(snapshot, index) || '?',
                    role: message.role,
                    speaker,
                    matchedTerms,
                    score: (fullQueryMatched ? 100 : 0) + matchedTerms.length,
                    messageIndex: index,
                    dialogueText: `${roleLabel}：${buildKeywordToolSnippet(text, matchedTerms)}`
                });
            });

            return scored
                .sort((a, b) => {
                    const scoreDiff = b.score - a.score;
                    if (scoreDiff !== 0) return scoreDiff;
                    return b.messageIndex - a.messageIndex;
                })
                .slice(0, Math.max(ACTIVE_TOOL_MIN_RESULT_COUNT, Math.min(ACTIVE_TOOL_MAX_RESULT_COUNT, Number(limit) || ACTIVE_TOOL_DEFAULT_RESULT_COUNT)))
                .sort((a, b) => a.messageIndex - b.messageIndex);
        };
        __s.searchDialogueByKeywordForTool = searchDialogueByKeywordForTool;
        const getTavilyErrorDetailText = (detail) => {
            if (detail === null || detail === undefined) return '';
            if (typeof detail === 'string') return detail.trim();
            if (typeof detail === 'number' || typeof detail === 'boolean') return String(detail);
            if (Array.isArray(detail)) {
                return detail
                    .map(item => getTavilyErrorDetailText(item))
                    .filter(Boolean)
                    .join('；');
            }
            if (typeof detail === 'object') {
                const directKeys = ['msg', 'message', 'error_message', 'error', 'detail', 'reason', 'description'];
                for (const key of directKeys) {
                    const text = getTavilyErrorDetailText(detail[key]);
                    if (text) return text;
                }
                return stringifyErrorDetail(detail).trim();
            }
            return String(detail).trim();
        };
        __s.getTavilyErrorDetailText = getTavilyErrorDetailText;
        const buildTavilyErrorMessage = (response, data) => {
            const detail = data?.detail ?? data?.message ?? data?.error ?? data?.error_message;
            const message = getTavilyErrorDetailText(detail);
            if (response.status === 401) return 'Tavily API Key 无效，请检查工具设置里的 API Key。';
            if (response.status === 429) return 'Tavily 请求太频繁或额度不足，请稍后再试。';
            if (response.status === 432 || response.status === 433) return message || 'Tavily 账户额度或权限不足。';
            return message || `Tavily 搜索失败：HTTP ${response.status}`;
        };
        __s.buildTavilyErrorMessage = buildTavilyErrorMessage;
        const requestTavily = async (endpoint, apiKey, body, signal) => {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body),
                signal
            });
            const data = await response.json().catch(() => ({}));
            return { response, data };
        };
        __s.requestTavily = requestTavily;
        const normalizeTavilyExtractUrl = (value) => {
            let text = String(value || '').trim().replace(/[，。；、）)\].,;]+$/g, '');
            if (!text) return '';
            if (/^www\./i.test(text)) text = `https://${text}`;
            try {
                const url = new URL(text);
                if (!['http:', 'https:'].includes(url.protocol)) return '';
                return url.href;
            } catch (err) {
                return '';
            }
        };
        __s.normalizeTavilyExtractUrl = normalizeTavilyExtractUrl;
        const extractWebUrlsFromToolQuery = (query) => {
            const matches = String(query || '').match(/https?:\/\/[^\s<>"'，。；、）)\]]+|www\.[^\s<>"'，。；、）)\]]+/gi) || [];
            const urls = matches
                .map(normalizeTavilyExtractUrl)
                .filter(Boolean);
            return [...new Set(urls)].slice(0, ACTIVE_TOOL_TAVILY_EXTRACT_MAX_URLS);
        };
        __s.extractWebUrlsFromToolQuery = extractWebUrlsFromToolQuery;
        const getWebTitleFromUrl = (url) => {
            try {
                return new URL(url).hostname || url;
            } catch (err) {
                return url || '网页';
            }
        };
        __s.getWebTitleFromUrl = getWebTitleFromUrl;
        const extractWebPagesByTavilyForTool = async (urls, tool, signal) => {
            const apiKey = String(tool?.tavilyApiKey || '').trim();
            if (!apiKey) {
                throw new Error('请先在工具设置里填写 Tavily API Key。');
            }

            const body = {
                urls: urls.length === 1 ? urls[0] : urls,
                extract_depth: ACTIVE_TOOL_TAVILY_SEARCH_DEPTH,
                format: 'markdown',
                include_favicon: true,
                timeout: 30
            };

            const { response, data } = await requestTavily(ACTIVE_TOOL_TAVILY_EXTRACT_ENDPOINT, apiKey, body, signal);
            if (!response.ok) {
                throw new Error(buildTavilyErrorMessage(response, data).replace('搜索失败', '网页读取失败'));
            }

            const results = (Array.isArray(data.results) ? data.results : [])
                .map((item, index) => {
                    const url = String(item?.url || urls[index] || '').trim();
                    return {
                        index: index + 1,
                        title: String(item?.title || getWebTitleFromUrl(url)).trim(),
                        url,
                        content: trimMemoryText(item?.raw_content || item?.content || '', 6000),
                        favicon: item?.favicon || '',
                        sourceType: 'extract'
                    };
                })
                .filter(item => item.url || item.content);
            results.tavilyMode = 'extract';
            results.tavilyResponseTime = data.response_time || '';
            results.tavilyFailedResults = Array.isArray(data.failed_results)
                ? data.failed_results.map(item => ({
                    url: String(item?.url || '').trim(),
                    error: getTavilyErrorDetailText(item?.error ?? item?.message ?? item?.detail)
                }))
                : [];
            return results;
        };
        __s.extractWebPagesByTavilyForTool = extractWebPagesByTavilyForTool;
        const searchWebByTavilyForTool = async (query, tool, signal) => {
            const cleanQuery = trimMemoryText(query, 800);
            if (!cleanQuery) return [];
            const extractUrls = extractWebUrlsFromToolQuery(cleanQuery);
            if (extractUrls.length > 0) {
                return extractWebPagesByTavilyForTool(extractUrls, tool, signal);
            }

            const apiKey = String(tool?.tavilyApiKey || '').trim();
            if (!apiKey) {
                throw new Error('请先在工具设置里填写 Tavily API Key。');
            }

            const maxResults = Math.max(ACTIVE_TOOL_MIN_RESULT_COUNT, Math.min(ACTIVE_TOOL_MAX_RESULT_COUNT, Number(tool?.resultCount) || ACTIVE_TOOL_DEFAULT_RESULT_COUNT));
            const body = {
                query: cleanQuery,
                search_depth: ACTIVE_TOOL_TAVILY_SEARCH_DEPTH,
                max_results: maxResults,
                topic: 'general',
                include_favicon: true
            };

            const { response, data } = await requestTavily(ACTIVE_TOOL_TAVILY_ENDPOINT, apiKey, body, signal);
            if (!response.ok) {
                throw new Error(buildTavilyErrorMessage(response, data));
            }

            const results = (Array.isArray(data.results) ? data.results : [])
                .slice(0, maxResults)
                .map((item, index) => ({
                    index: index + 1,
                    title: String(item?.title || '未命名网页').trim(),
                    url: String(item?.url || '').trim(),
                    content: trimMemoryText(item?.content || '', 1800),
                    score: Number(item?.score),
                    publishedDate: item?.published_date || item?.publishedDate || '',
                    favicon: item?.favicon || '',
                    sourceType: 'search'
                }));
            results.tavilyMode = 'search';
            results.tavilyResponseTime = data.response_time || '';
            return results;
        };
        __s.searchWebByTavilyForTool = searchWebByTavilyForTool;
        const resetActiveToolResultContext = () => {
            __s.activeToolMessages.length = 0;
        };
        __s.resetActiveToolResultContext = resetActiveToolResultContext;
        const appendActiveToolResult = (callId, payload) => {
            __s.activeToolMessages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify(payload) });
        };
        __s.appendActiveToolResult = appendActiveToolResult;
        const getRandomToolRangeSize = (min, max) => {
            const size = max - min + 1;
            if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max || !Number.isSafeInteger(size)) {
                throw new Error('min 和 max 必须为安全整数，min 不大于 max，范围内整数个数不能超过 9007199254740991');
            }
            return size;
        };
        __s.getRandomToolRangeSize = getRandomToolRangeSize;
        const generateRandomNumberForTool = (min, max) => {
            const size = getRandomToolRangeSize(min, max);
            // 丢弃不能均分到范围内的尾部，避免取余后某些数字更容易出现。
            const sampleSpace = 2 ** 53;
            const limit = sampleSpace - (sampleSpace % size);
            const words = new Uint32Array(2);
            let sample;
            do {
                crypto.getRandomValues(words);
                sample = (words[0] & 0x1fffff) * 2 ** 32 + words[1];
            } while (sample >= limit);
            return { min, max, value: min + sample % size };
        };
        __s.generateRandomNumberForTool = generateRandomNumberForTool;
        const parseNativeActiveToolCall = (call, tools) => {
            const tool = tools.find(item => item.callName === call.function.name);
            const parsed = { tool, callLabel: call.function.name, query: '', reason: '', raw: call.function.arguments };
            try {
                if (!tool) throw new Error('该工具未开启或不存在');
                const args = JSON.parse(call.function.arguments);
                if (!args || typeof args !== 'object' || Array.isArray(args)
                    || (args.reason !== undefined && typeof args.reason !== 'string')) {
                    throw new Error('工具参数必须为 JSON 对象，reason 为可选字符串');
                }
                if (tool.type === ACTIVE_TOOL_RANDOM_TYPE) {
                    if (Object.keys(args).some(key => !['min', 'max', 'reason'].includes(key))) {
                        throw new Error('随机数工具仅接受 min、max 和可选的 reason');
                    }
                    getRandomToolRangeSize(args.min, args.max);
                    Object.assign(parsed, { min: args.min, max: args.max, query: `${args.min} ～ ${args.max}`, reason: (args.reason || '').trim() });
                } else {
                    if (Object.keys(args).some(key => !['query', 'reason'].includes(key))
                        || typeof args.query !== 'string' || !args.query.trim()) {
                        throw new Error('检索工具仅接受非空 query 字符串和可选的 reason');
                    }
                    Object.assign(parsed, { query: args.query.trim(), reason: (args.reason || '').trim() });
                }
            } catch (error) {
                parsed.error = error instanceof SyntaxError ? '工具参数不是完整有效的 JSON 对象' : error.message;
            }
            return parsed;
        };
        __s.parseNativeActiveToolCall = parseNativeActiveToolCall;
    };
})();
