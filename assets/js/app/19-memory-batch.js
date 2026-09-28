/**
 * RP-Hub 应用模块 19 · 记忆批量抽取、后台巡逻与中断恢复
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 6107–6317 行。
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
    window.RPHubAppSections.memoryBatch = function (__s) {
        const waitForMemoryConversationIdle = (signal) => new Promise(resolve => {
            if (!__s.isConversationBusy.value || signal?.aborted) {
                resolve();
                return;
            }
            let stopWatching = () => { };
            const finish = () => {
                stopWatching();
                signal?.removeEventListener('abort', finish);
                resolve();
            };
            stopWatching = watch(__s.isConversationBusy, busy => {
                if (!busy) finish();
            });
            signal?.addEventListener('abort', finish, { once: true });
        });
        __s.waitForMemoryConversationIdle = waitForMemoryConversationIdle;
        const abortClassicBatchExtraction = () => {
            __s._classicExtractionEpoch++;
            if (__s._classicBatchExtractAbort) __s._classicBatchExtractAbort.abort();
            __s._classicBatchExtractAbort = null;
            __s._classicBatchRescanRequested = false;
            __s.isClassicBatchExtracting.value = false;
            if (__s.memoryBackfillProgress.value.status === 'running') {
                __s.memoryBackfillProgress.value.status = 'stopped';
                __s.memoryBackfillProgress.value.message = '已停止补录，已完成的记忆已保留。';
            }
        };
        __s.abortClassicBatchExtraction = abortClassicBatchExtraction;
        const abortConversationBackgroundWork = () => {
            __s.abortUiTemplateUpdate();
            abortClassicBatchExtraction();
        };
        __s.abortConversationBackgroundWork = abortConversationBackgroundWork;
        const startClassicBatchMemoryExtraction = async (options = {}) => {
            const { manual = true } = options;
            if (__s.isClassicBatchExtracting.value) return;
            __s.memoryBackfillProgress.value = { status: 'running', message: '正在检查待补录记忆…', phase: '', stages: [] };
            const progress = __s.memoryBackfillProgress.value;
            if (!__s.currentCharacter.value || __s.chatHistory.value.length === 0) {
                progress.status = 'done';
                progress.message = '当前没有可补录的对话。';
                return;
            }
            if (__s.memorySettings.mode === __s.MEMORY_MODE_ENHANCED && !__s.getMemoryEmbeddingModel()) {
                progress.status = 'error';
                progress.message = '请先在记忆系统设置中选择向量模型。';
                return;
            }
            if (!String(__s.memorySettings.classicModel || '').trim()) {
                progress.status = 'error';
                progress.message = '请先在记忆系统设置中选择总结模型。';
                return;
            }

            const batchController = new AbortController();
            __s._classicBatchExtractAbort = batchController;
            __s._classicBatchRescanRequested = false;
            __s.isClassicBatchExtracting.value = true;
            progress.stages = [
                { key: 'summary', title: '逐轮总结', unit: '轮' },
                { key: 'vector', title: '向量记忆', unit: '条' },
                { key: 'secondary', title: '二次压缩', unit: '组' }
            ].map(stage => ({ ...stage, current: 0, total: 0, elapsedMs: 0 }));
            const stageProgress = key => {
                const stage = progress.stages.find(item => item.key === key);
                const previous = stage.current;
                const previousElapsed = stage.elapsedMs;
                const startedAt = Date.now();
                return (current, total) => {
                    if (!total || __s._classicBatchExtractAbort !== batchController || batchController.signal.aborted) return;
                    progress.phase = key;
                    progress.message = '';
                    stage.current = previous + current;
                    stage.total = previous + total;
                    stage.elapsedMs = previousElapsed + Date.now() - startedAt;
                };
            };

            try {
                while (__s._classicBatchExtractAbort === batchController && !batchController.signal.aborted) {
                    __s._classicBatchRescanRequested = false;
                    const snapshot = await __s.ensureConversationMessageIds();
                    if (__s._classicBatchExtractAbort !== batchController || batchController.signal.aborted) return;
                    const safeTurnCount = __s.isConversationBusy.value
                        ? Math.max(0, snapshot.turns.length - 1)
                        : snapshot.turns.length;
                    const jobs = snapshot.turns
                        .slice(0, safeTurnCount)
                        .map((_, index) => __s.buildClassicSummaryJob(snapshot, index))
                        .filter(job => job && !__s.hasClassicMemoryForJob(job));
                    const remaining = {
                        summary: jobs.length,
                        vector: __s.memorySettings.mode === __s.MEMORY_MODE_ENHANCED
                            ? __s.getSummaryEmbeddingJobs(snapshot).length + jobs.length : 0,
                        secondary: __s.getEligibleClassicSecondaryGroups(safeTurnCount, [...__s.classicMemories.value, ...jobs]).length
                    };
                    progress.stages.forEach(stage => { stage.total = stage.current + remaining[stage.key]; });
                    const reportSummary = stageProgress('summary');
                    let summarized = 0;
                    reportSummary(0, jobs.length);

                    const runClassicJob = async job => {
                        try {
                            const added = await __s.generateAndStoreClassicMemory(job, batchController.signal);
                            if (added || __s.hasClassicMemoryForJob(job)) reportSummary(++summarized, jobs.length);
                            return { job, added };
                        } catch (error) {
                            return { job, error };
                        }
                    };
                    const concurrency = __s.normalizeClassicMemoryConcurrency(__s.memorySettings.classicConcurrency);
                    for (let offset = 0; offset < jobs.length; offset += concurrency) {
                        if (__s._classicBatchExtractAbort !== batchController || batchController.signal.aborted) break;
                        const group = jobs.slice(offset, offset + concurrency);
                        const results = await Promise.all(group.map(runClassicJob));
                        if (__s._classicBatchExtractAbort !== batchController || batchController.signal.aborted) break;

                        if (results.some(result => result.added)) await __s.saveClassicMemoriesNow();
                        for (const failed of results.filter(result => result.error)) {
                            if (!manual) throw failed.error;
                            let retryError = failed.error;
                            while (true) {
                                if (retryError.name === 'AbortError') throw retryError;
                                const retry = await __s.showVueConfirmModal(
                                    '基础模式补录遇到错误',
                                    `第 ${failed.job.turn} 轮生成失败：\n${retryError.message}\n\n是否立即重试？`
                                );
                                if (__s._classicBatchExtractAbort !== batchController || batchController.signal.aborted) return;
                                if (!retry) throw retryError;
                                const retryResult = await runClassicJob(failed.job);
                                if (!retryResult.error) {
                                    if (retryResult.added) {
                                        await __s.saveClassicMemoriesNow();
                                    }
                                    break;
                                }
                                retryError = retryResult.error;
                            }
                        }
                    }

                    if (__s.isConversationBusy.value) {
                        progress.message = '等待当前回复结束后继续补录。';
                        await waitForMemoryConversationIdle(batchController.signal);
                        continue;
                    }
                    const currentTurnCount = __s.buildConversationTurnSnapshot(__s.chatHistory.value, { includeSystem: false }).turns.length;
                    if (jobs.length > 0 || __s._classicBatchRescanRequested || currentTurnCount !== safeTurnCount) continue;
                    if (__s.memorySettings.mode === __s.MEMORY_MODE_ENHANCED) {
                        await __s.indexSummaryMemories(snapshot, batchController.signal, undefined,
                            stageProgress('vector'));
                    }
                    if (__s._classicBatchExtractAbort !== batchController || batchController.signal.aborted) break;
                    await __s.compressEligibleClassicMemories(
                        currentTurnCount,
                        batchController.signal,
                        manual,
                        stageProgress('secondary')
                    );
                    if (__s._classicBatchExtractAbort !== batchController || batchController.signal.aborted) break;
                    if (__s.isConversationBusy.value) {
                        progress.message = '等待当前回复结束后继续补录。';
                        await waitForMemoryConversationIdle(batchController.signal);
                        continue;
                    }
                    const finalTurnCount = __s.buildConversationTurnSnapshot(
                        __s.chatHistory.value,
                        { includeSystem: false }
                    ).turns.length;
                    if (__s._classicBatchRescanRequested || finalTurnCount !== currentTurnCount) continue;
                    break;
                }

                if (__s._classicBatchExtractAbort === batchController) {
                    const incomplete = progress.stages.some(stage => stage.current < stage.total);
                    progress.status = incomplete ? 'error' : 'done';
                    progress.message = incomplete ? '部分任务未完成，已完成的记忆已保留，可再次补录。'
                        : progress.stages.some(stage => stage.total > 0) ? '' : '当前没有需要补录的记忆。';
                }
            } catch (error) {
                if (__s._classicBatchExtractAbort !== batchController) return;
                progress.status = error.name === 'AbortError' ? 'stopped' : 'error';
                progress.message = error.name === 'AbortError' ? '已停止补录，已完成的记忆已保留。'
                    : `补录未完成：${error.message}。已完成的记忆已保留。`;
                if (error.name !== 'AbortError') console.error('[记忆补录] 失败：', error.message);
            } finally {
                if (__s._classicBatchExtractAbort === batchController) {
                    __s._classicBatchExtractAbort = null;
                    __s.isClassicBatchExtracting.value = false;
                }
            }
        };
        __s.startClassicBatchMemoryExtraction = startClassicBatchMemoryExtraction;
        const startAutomaticMemoryPatrol = () => {
            if (!__s.memorySettings.enabled || !__s.currentCharacter.value || !__s._classicMemoriesLoaded) return Promise.resolve(false);
            if (__s.isClassicBatchExtracting.value) {
                __s._classicBatchRescanRequested = true;
                return Promise.resolve(false);
            }
            return startClassicBatchMemoryExtraction({ manual: false });
        };
        __s.startAutomaticMemoryPatrol = startAutomaticMemoryPatrol;
        const startBatchMemoryExtraction = () => {
            __s.showMemoryBackfillModal.value = true;
            return startClassicBatchMemoryExtraction({ manual: true });
        };
        __s.startBatchMemoryExtraction = startBatchMemoryExtraction;
        watch(() => [__s.memorySettings.enabled, __s.memorySettings.mode, __s.memorySettings.classicModel, __s.memorySettings.embeddingModel, __s.settings.apiUrl], () => {
            abortClassicBatchExtraction();
        });
    };
})();
