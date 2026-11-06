/** Player-managed shared maps. Local images are never registered as tool data. */
(function () {
    window.RPHubAppSections.mapLibrary = function (__s) {
        const { ref, computed, watch } = Vue, P = window.RPHubMapPackages;
        const saved = ref([]), busy = ref(false);
        __s.mapLibraryBusy = busy;
        __s.hasOpenedMapManager = ref(false);
        __s.mapReturnToCharacter = ref(false);
        let returnView = 'characters';
        watch(__s.currentView, view => { if (view === 'maps') __s.hasOpenedMapManager.value = true; }, { immediate: true });
        __s.openMapManagerForCharacter = () => {
            returnView = __s.currentView.value;
            __s.mapReturnToCharacter.value = true;
            __s.showCharacterEditor.value = false;
            __s.currentView.value = 'maps';
        };
        __s.returnToCharacterFromMaps = () => {
            __s.mapReturnToCharacter.value = false;
            __s.currentView.value = returnView;
            __s.showCharacterEditor.value = true;
        };
        __s.mapRecords = computed(() => [
            ...Object.values(window.RPHubWorlds || {}).filter(w => !saved.value.some(r => r.world.id === w.id)).map(world => ({ world, builtin: true })),
            ...saved.value
        ]);
        __s.geographyMapOptions = computed(() => __s.mapRecords.value.map(r => ({ id: r.world.id, name: r.world.name, places: r.world.places.filter(p => p.kind !== 'junction').map(p => ({ id: p.id, name: p.name })) })));
        __s.getGeographyWorld = id => __s.mapRecords.value.find(r => r.world.id === id)?.world || null;
        const load = __s.loadData;
        __s.loadData = async (...args) => {
            await load(...args);
            try {
                const records = await window.RPHubStorage.getStoredValue('geographyMaps');
                const valid = [];
                for (const record of Array.isArray(records) ? records : []) {
                    try { valid.push({ world: P.prepareWorld(record.world), imageData: P.checkImage(record.imageData) }); }
                    catch (e) { __s.showToast('一张地图未能载入：' + e.message, 'error'); }
                }
                saved.value = valid;
            } catch (e) { __s.showToast('地图库读取失败：' + e.message, 'error'); }
        };
        let imagesLoading;
        const builtinImages = () => {
            if (window.RPHubWorldImages) return Promise.resolve(window.RPHubWorldImages);
            if (!imagesLoading) imagesLoading = new Promise((resolve, reject) => {
                const script = document.createElement('script'); script.src = 'assets/js/world-images.js';
                script.onload = () => resolve(window.RPHubWorldImages); script.onerror = () => { imagesLoading = null; reject(new Error('内置底图资源未找到，请上传原图')); };
                document.head.appendChild(script);
            });
            return imagesLoading;
        };
        __s.getMapImage = async id => {
            const record = __s.mapRecords.value.find(r => r.world.id === id);
            if (!record) throw new Error('地图不存在');
            return record.imageData || (await builtinImages())[id] || (() => { throw new Error('地图缺少原图'); })();
        };
        const persist = async records => {
            await window.RPHubStorage.setStoredValue('geographyMaps', P.clone(records));
            saved.value = records;
        };
        __s.saveMapRecord = async ({ world, imageData, originalId }) => {
            if (busy.value) return false;
            busy.value = true;
            try {
                const data = P.prepareWorld(world);
                if (originalId && originalId !== data.id) throw new Error('编辑时不能修改地图ID；请另存副本');
                if (!originalId && __s.getGeographyWorld(data.id)) throw new Error('地图ID已存在，请更换ID或另存副本');
                const image = imageData || await __s.getMapImage(originalId || data.id);
                await P.imageSize(image);
                await persist([...saved.value.filter(r => r.world.id !== data.id), { world: data, imageData: image }]);
                __s.showToast('地图已保存，RP与微信共同使用', 'success'); return true;
            } catch (e) { __s.showToast('地图保存失败：' + e.message, 'error'); return false; }
            finally { busy.value = false; }
        };
        __s.importMapPackage = async event => {
            const file = event.target.files?.[0]; event.target.value = '';
            if (!file || busy.value) return;
            busy.value = true;
            try {
                if (file.size > P.MAX_FILE) throw new Error('地图包不能超过20MB');
                const record = await P.decode(JSON.parse(await file.text()));
                const original = record.world.id;
                if (__s.getGeographyWorld(original)) {
                    record.world.id = original.slice(0, 60) + '-import-' + generateUUID().slice(0, 8);
                    record.world.name += '（导入副本）';
                }
                await persist([...saved.value, record]);
                __s.showToast(original === record.world.id ? '地图包已导入，可在角色编辑中绑定' : '同ID地图已导入为副本，现有角色绑定保持原地图', 'success');
            } catch (e) { __s.showToast('地图导入失败：' + e.message, 'error'); }
            finally { busy.value = false; }
        };
        __s.exportMapPackage = async id => {
            if (busy.value) return; busy.value = true;
            try {
                const world = __s.getGeographyWorld(id), image = await __s.getMapImage(id);
                const data = P.encode(world, image);
                window.RPHubCardUtils.downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), world.name.replace(/[<>:"/\\|?*]/g, '_') + '.rpmap.json');
                __s.showToast('地图包已导出（原图、地点、道路与文化）', 'success');
            } catch (e) { __s.showToast('地图导出失败：' + e.message, 'error'); }
            finally { busy.value = false; }
        };
        __s.deleteMapRecord = id => {
            if (busy.value) return;
            const linked = __s.characters.value.filter(c => c.geography?.worldId === id && c.geography.enabled !== false);
            if (linked.length) { __s.showToast('请先解除这些角色的地图绑定：' + linked.map(c => c.name).join('、'), 'warning'); return; }
            if (!saved.value.some(r => r.world.id === id)) { __s.showToast('内置地图不能删除，可以另存副本', 'warning'); return; }
            __s.confirmAction('删除这张地图？内置地图的本地修改删除后会恢复内置版本。', async () => {
                busy.value = true;
                try { await persist(saved.value.filter(r => r.world.id !== id)); __s.showToast('地图已删除', 'success'); }
                catch (e) { __s.showToast('删除失败：' + e.message, 'error'); }
                finally { busy.value = false; }
            });
        };
    };
})();
