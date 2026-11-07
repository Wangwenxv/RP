/** Whole-library backups, including RP/WeChat branches and binary resources. */
(function () {
    window.RPHubAppSections.fullBackup = function (__s) {
        const B = window.RPHubBackup, S = window.RPHubStorage;
        const fullBackupBusy = ref(false), fullBackupProgress = ref(''), fullBackupError = ref('');
        const backupIncludeCredentials = ref(false), importBackupCredentials = ref(false);
        const fullBackupPreview = ref(null);
        const fullBackupDialog = ref(null);
        Object.assign(__s, { fullBackupBusy, fullBackupProgress, fullBackupError, backupIncludeCredentials, importBackupCredentials, fullBackupPreview, fullBackupDialog });
        let previousFocus = null;
        watch(() => !!(fullBackupBusy.value || fullBackupPreview.value), async open => {
            if (open) { previousFocus = document.activeElement; await nextTick(); fullBackupDialog.value?.focus(); }
            else if (previousFocus?.isConnected) previousFocus.focus();
        });
        const fullBackupBlocked = computed(() => fullBackupBusy.value || !!(
            __s.isConversationBusy.value || __s.isClassicBatchExtracting.value || __s.retryingClassicMemoryId.value
            || __s.isUiTemplateUpdating?.value || __s.uiTemplateUpdateStatus?.state === 'running' || __s.isRecapGenerating?.value || __s.isWechatGenerating?.value
            || __s.isWechatMediaPreparing?.value || __s.isWechatDocumentPreparing?.value || __s.wechatTimeTagsSaving?.value
            || __s.stickerStoreImporting?.value || __s.mapLibraryBusy?.value || __s.storyBranchSwitching.value
            || __s.switchingCharacterIndex.value >= 0 || __s.isAutoImageGenerating?.value || __s.pendingChatImageReadCount.value > 0
            || __s.chatHistory.value.some(message => message?.isImageGenerating || message?.generatedImage?.status === 'generating')
            || __s._isApplyingCharacterScopedData
        ));
        __s.fullBackupBlocked = fullBackupBlocked;
        const pending = { backup: null };
        const progress = text => { fullBackupProgress.value = text; };
        const cancelSaves = () => {
            __s.debouncedSave.cancel(); __s.debouncedCharacterSave.cancel();
            clearTimeout(__s._memorySettingsSaveTimer); __s._memorySettingsSaveTimer = null;
        };
        const readBrowser = () => {
            const browser = {};
            for (const [area, keys] of Object.entries(B.browserKeys)) {
                browser[area] = {};
                try { for (const key of keys) { const value = window[`${area}Storage`].getItem(key); if (value !== null) browser[area][key] = value; } }
                catch (_) { /* Optional browser storage may be unavailable in local-file mode. */ }
            }
            return browser;
        };
        const writeBrowser = browser => {
            for (const [area, keys] of Object.entries(B.browserKeys)) {
                const target = window[`${area}Storage`];
                for (const key of keys) {
                    if (typeof browser[area]?.[key] === 'string') target.setItem(key, browser[area][key]);
                    else target.removeItem(key);
                }
            }
        };
        const flushBackupPersistence = async () => {
            progress('正在保存当前内容…');
            await nextTick(); cancelSaves();
            if (__s.currentCharacter.value) {
                await __s.ensureWechatTimelineLoaded();
                await __s.flushPendingWechatSave();
                await __s.ensureStoryRecapLoaded();
                await __s.saveStoryRecapNow();
                if (!await __s.saveCurrentStoryBranchState()) throw new Error('当前剧情分支保存未完成，请稍后重试');
            }
            await __s.saveData({ throwOnError: true });
            await __s.saveTokenUsageHistoryNow();
            await S.migrateWorkshopStorage();
            cancelSaves();
            return S.readStorageSnapshot();
        };
        __s.flushBackupPersistence = flushBackupPersistence;
        const filename = suffix => 'RP-Hub_' + suffix + '_' + new Date().toISOString().replace(/[:.]/g, '-') + '.rphub';
        const exportAllContent = async () => {
            if (!__s._initComplete || fullBackupBlocked.value) return;
            fullBackupBusy.value = true; fullBackupError.value = '';
            try {
                const entries = await flushBackupPersistence();
                const blob = await B.create(entries, { credentials: backupIncludeCredentials.value, browser: readBrowser(), onProgress: progress });
                cardUtils.downloadBlob(blob, filename('完整备份'));
                __s.showToast('全部内容已导出，包含 RP、微信和本地附件', 'success');
            } catch (error) { fullBackupError.value = '导出失败：' + error.message; }
            finally { fullBackupBusy.value = false; fullBackupProgress.value = ''; }
        };
        __s.exportAllContent = exportAllContent;
        const cancelFullBackupImport = () => {
            if (fullBackupBusy.value) return;
            pending.backup = null; fullBackupPreview.value = null;
        };
        __s.cancelFullBackupImport = cancelFullBackupImport;
        __s.onFullBackupKeydown = event => {
            if (event.key === 'Escape') { event.stopPropagation(); cancelFullBackupImport(); }
            else if (event.key === 'Tab') {
                const controls = [...fullBackupDialog.value.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
                const first = controls[0], last = controls[controls.length - 1];
                if (event.shiftKey && (event.target === first || event.target === fullBackupDialog.value)) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
            }
        };
        const importAllContent = async event => {
            const file = event.target.files?.[0]; event.target.value = '';
            if (!file || !__s._initComplete || fullBackupBlocked.value) return;
            fullBackupBusy.value = true; fullBackupError.value = ''; progress('正在读取并校验完整备份…');
            try {
                pending.backup = await B.inspect(file, progress);
                fullBackupPreview.value = { ...pending.backup.summary, name: file.name, size: file.size,
                    createdAt: pending.backup.createdAt, credentials: pending.backup.credentials };
                importBackupCredentials.value = false;
            } catch (error) { pending.backup = null; fullBackupPreview.value = null; fullBackupError.value = '导入检查失败：' + error.message; }
            finally { fullBackupBusy.value = false; fullBackupProgress.value = ''; }
        };
        __s.importAllContent = importAllContent;
        let channel = null;
        try { if (typeof BroadcastChannel === 'function') channel = new BroadcastChannel('rphub-full-restore'); } catch (_) { }
        if (channel) channel.onmessage = event => {
            if (event.data === 'lock') {
                cancelSaves(); S.setStorageWriteLock(true); fullBackupBusy.value = true;
                progress('另一个页面正在恢复全部内容，请稍候…');
            } else if (event.data === 'complete') location.reload();
            else if (event.data === 'cancel') { S.setStorageWriteLock(false); fullBackupBusy.value = false; fullBackupProgress.value = ''; }
        };
        onBeforeUnmount(() => channel?.close());
        const confirmFullBackupImport = async () => {
            if (!pending.backup || fullBackupBlocked.value) return;
            fullBackupBusy.value = true; fullBackupError.value = '';
            let committed = false, browserBefore;
            try {
                // 实际覆盖前下载当前内容；这是完整回退包，因此包含当前密钥。
                const current = await flushBackupPersistence();
                browserBefore = readBrowser();
                const rollback = await B.create(current, { credentials: true, browser: browserBefore, onProgress: progress });
                cardUtils.downloadBlob(rollback, filename('导入前回退备份'));
                const credentials = pending.backup.credentials && importBackupCredentials.value;
                const entries = credentials ? pending.backup.entries : B.removeCredentials(pending.backup.entries, pending.backup.browser);
                if (!credentials) {
                    const settings = entries.find(([key]) => key === 'settings')?.[1];
                    if (settings) Object.assign(settings, { apiKey: '', apiProviderKeys: {}, imageGenKey: '' });
                }
                progress('正在恢复全部内容，完成后自动重新载入…');
                channel?.postMessage('lock'); S.setStorageWriteLock(true);
                // 浏览器偏好写入失败时，在碰数据库之前停止；事务失败时恢复原偏好。
                const browser = B.sanitizeBrowser(pending.backup.browser, credentials);
                try { writeBrowser(browser); } catch (error) {
                    if (Object.values(browser).some(area => Object.keys(area).length)) throw new Error('浏览器偏好设置无法写入：' + error.message);
                }
                await S.restoreStorageSnapshot(entries);
                committed = true; channel?.postMessage('complete');
                location.reload();
            } catch (error) {
                if (!committed && browserBefore) { try { writeBrowser(browserBefore); } catch (_) { } }
                fullBackupError.value = '导入失败，原数据库已保留：' + error.message;
            } finally {
                // 成功后保持旧页面写入锁，直到重新载入，避免延迟自动保存覆盖恢复结果。
                if (!committed) {
                    S.setStorageWriteLock(false); channel?.postMessage('cancel');
                    fullBackupBusy.value = false; fullBackupProgress.value = '';
                }
            }
        };
        __s.confirmFullBackupImport = confirmFullBackupImport;
        __s.formatFullBackupDate = value => {
            const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '未知';
        };
    };
})();
