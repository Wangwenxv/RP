/** Right-hand map drawer, built with RP-Hub's existing Vue and theme styles. */
(function () {
    window.RPHubChatMap = {
        props: { open: Boolean, pinned: Boolean, world: Object, locations: Object, user: Object, character: Object, getImage: Function, disabled: Boolean, saving: Boolean, worldMode: Boolean, actorList: Array, actorOptions: Array, focusedActor: String },
        emits: ['close', 'update:pinned', 'set-player', 'configure', 'manage', 'update:focused-actor'],
        setup(props, { emit }) {
            const { ref, computed, watch, nextTick, onBeforeUnmount } = Vue;
            const panel = ref(null), viewport = ref(null), image = ref(''), imageError = ref(''), loading = ref(false);
            const search = ref(''), selectedId = ref(''), zoom = ref(1), mode = ref('walk');
            const size = ref({ width: 440, height: 370 });
            const compact = ref(window.innerWidth < 1024);
            const modal = computed(() => !props.pinned || compact.value);
            const updateCompact = () => { compact.value = window.innerWidth < 1024; };
            window.addEventListener('resize', updateCompact);
            let imageEpoch = 0, observer, pan, returnFocus;
            const places = computed(() => props.world?.places.filter(p => p.kind !== 'junction') || []);
            const results = computed(() => search.value.trim()
                ? window.RPHubGeography.search(props.world, search.value, { limit: 30 }).results.map(p => places.value.find(place => place.id === p.id)).filter(Boolean) : places.value);
            const selected = computed(() => places.value.find(p => p.id === selectedId.value));
            const geometry = computed(() => {
                const [w, h] = props.world?.imageSize || [1000, 1000];
                const scale = Math.min(Math.max(120, size.value.width - 96) / w, Math.max(120, size.value.height - 96) / h) * zoom.value;
                const width = w * scale, height = h * scale;
                const outerWidth = Math.max(size.value.width, width + 96), outerHeight = Math.max(size.value.height, height + 96);
                return { width, height, outerWidth, outerHeight, left: (outerWidth - width) / 2, top: (outerHeight - height) / 2 };
            });
            const actors = computed(() => props.actorList ? props.actorList.map(a => ({ ...a, place: a.location.status === 'last_confirmed' && props.world?.places.find(p => p.id === a.location.placeId) })) : ['user', 'character'].map(key => {
                const location = props.locations?.[key] || { status: 'unknown' };
                const person = key === 'user' ? props.user : props.character;
                const place = location.status === 'last_confirmed' && props.world?.places.find(p => p.id === location.placeId);
                return { key, name: person?.name || (key === 'user' ? '玩家' : '角色'), avatar: person?.avatar, location, place };
            }));
            const markers = computed(() => actors.value.filter(a => a.place).map(a => {
                const samePoint = actors.value.filter(b => b.place && b.place.point.join(',') === a.place.point.join(','));
                return { ...a, offset: (samePoint.indexOf(a) - (samePoint.length - 1) / 2) * 60 };
            }));
            const route = computed(() => {
                const [a, b] = actors.value;
                if (!a || !b) return null;
                return a.place && b.place ? window.RPHubGeography.route(props.world, a.place.id, b.place.id, { mode: mode.value }) : null;
            });
            const routePoints = computed(() => {
                const [a, b] = actors.value;
                if (!a || !b) return '';
                if (!a.place || !b.place || route.value?.status !== 'ok') return '';
                const found = window.RPHubGeography.path(props.world, a.place.id, b.place.id, mode.value);
                const points = []; let cursor = a.place.id;
                found?.edges.forEach(e => {
                    const forward = e.from === cursor, target = forward ? e.to : e.from;
                    points.push(props.world.places.find(p => p.id === cursor).point, ...(forward ? e.points || [] : [...(e.points || [])].reverse()));
                    cursor = target;
                });
                points.push(b.place.point);
                return points.map(p => p.join(',')).join(' ');
            });
            const statusLabel = status => ({ last_confirmed: '最近确认', in_transit: '在途中 · 到达待确认', unknown: '位置未知', unknown_place: '地点未收录', ambiguous_place: '地点待澄清' }[status] || '位置待确认');
            const districtName = place => props.world?.districts?.[place?.district]?.label || place?.district || '';
            const refreshImage = async () => {
                const epoch = ++imageEpoch;
                image.value = ''; imageError.value = ''; loading.value = !!props.world;
                if (!props.world) return;
                try { const data = await props.getImage(props.world.id); if (epoch === imageEpoch) image.value = data; }
                catch (error) { if (epoch === imageEpoch) imageError.value = error.message; }
                finally { if (epoch === imageEpoch) loading.value = false; }
            };
            const centerPoint = async point => {
                await nextTick();
                if (!viewport.value || !props.world) return;
                const g = geometry.value;
                viewport.value.scrollTo({ left: g.left + point[0] / props.world.imageSize[0] * g.width - size.value.width / 2,
                    top: g.top + point[1] / props.world.imageSize[1] * g.height - size.value.height / 2 });
            };
            const focusActor = actor => { if (actor.place) { zoom.value = Math.max(zoom.value, 3); centerPoint(actor.place.point); } };
            const setZoom = async value => {
                const g = geometry.value, el = viewport.value;
                const point = el && props.world ? [(el.scrollLeft + size.value.width / 2 - g.left) / g.width * props.world.imageSize[0], (el.scrollTop + size.value.height / 2 - g.top) / g.height * props.world.imageSize[1]] : [0, 0];
                zoom.value = Math.max(1, Math.min(8, value)); await centerPoint(point);
            };
            const fitAll = () => { zoom.value = 1; centerPoint(props.world.imageSize.map(v => v / 2)); };
            const fitActors = () => {
                const points = markers.value.map(a => a.place.point);
                if (!points.length) return fitAll();
                if (points.length === 1) return focusActor(markers.value[0]);
                const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
                const scale = Math.min(Math.max(80, size.value.width - 160) / Math.max(100, Math.max(...xs) - Math.min(...xs)), Math.max(80, size.value.height - 160) / Math.max(100, Math.max(...ys) - Math.min(...ys)));
                const base = geometry.value.width / props.world.imageSize[0] / zoom.value;
                zoom.value = Math.max(1, Math.min(8, scale / base));
                centerPoint([(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2]);
            };
            const selectPlace = id => { selectedId.value = id; };
            const selectFromList = id => { selectedId.value = id; zoom.value = Math.max(zoom.value, 3); centerPoint(selected.value.point); };
            const startPan = event => {
                if (event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('button')) return;
                pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.value.scrollLeft, top: viewport.value.scrollTop };
                viewport.value.setPointerCapture(event.pointerId);
            };
            const movePan = event => { if (pan) { viewport.value.scrollLeft = pan.left - event.clientX + pan.x; viewport.value.scrollTop = pan.top - event.clientY + pan.y; } };
            const endPan = () => { pan = null; };
            const keydown = event => {
                if (event.key === 'Escape') { event.stopPropagation(); emit('close'); }
                if (event.key !== 'Tab' || !modal.value) return;
                const focusable = [...panel.value.querySelectorAll('button:not(:disabled), input, select, [tabindex="0"]')].filter(el => el.getClientRects().length);
                const first = focusable[0], last = focusable.at(-1);
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            };
            watch(() => props.world, () => { search.value = ''; selectedId.value = ''; zoom.value = 1; if (props.open) refreshImage(); else { imageEpoch++; image.value = ''; imageError.value = ''; loading.value = false; } }, { immediate: true });
            watch(viewport, el => {
                observer?.disconnect();
                if (!el) return;
                let measured = false;
                observer = new ResizeObserver(() => {
                    const previous = size.value, g = geometry.value;
                    const next = { width: el.clientWidth, height: el.clientHeight };
                    if (measured && next.width === previous.width && next.height === previous.height) return;
                    const point = measured && props.world ? [(el.scrollLeft + previous.width / 2 - g.left) / g.width * props.world.imageSize[0],
                        (el.scrollTop + previous.height / 2 - g.top) / g.height * props.world.imageSize[1]] : null;
                    size.value = next; measured = true;
                    if (props.world) { if (point) centerPoint(point); else fitActors(); }
                });
                observer.observe(el);
            });
            watch(() => props.open, async open => {
                observer?.disconnect();
                if (!open) { imageEpoch++; returnFocus?.isConnected && returnFocus.focus({ preventScroll: true }); return; }
                returnFocus = document.activeElement;
                await nextTick();
                panel.value?.querySelector('button')?.focus({ preventScroll: true });
                if (!image.value && props.world) refreshImage();
            }, { immediate: true });
            onBeforeUnmount(() => { observer?.disconnect(); imageEpoch++; window.removeEventListener('resize', updateCompact); });
            return { panel, viewport, image, imageError, loading, search, selectedId, zoom, mode, modal, results, selected, geometry, actors, markers, route, routePoints, statusLabel, districtName, refreshImage, focusActor, setZoom, fitAll, fitActors, selectPlace, selectFromList, startPan, movePan, endPan, keydown };
        },
        template: `
        <transition name="geo-drawer">
            <div v-if="open" class="geo-drawer-layer" :class="{ 'geo-drawer-layer--pinned': pinned }">
                <div class="geo-drawer-mask" @click="$emit('close')"></div>
                <aside ref="panel" class="geo-drawer bg-white text-gray-800 border-l border-gray-200" :role="modal ? 'dialog' : 'complementary'" :aria-modal="modal ? true : null" aria-label="地理地图" @keydown="keydown" data-testid="chat-map">
                    <header class="geo-drawer-header border-b border-gray-100">
                        <div><h2 class="font-bold text-lg">地理地图</h2><p class="text-xs text-gray-500 mt-1">{{ world?.name || '当前角色的地理环境' }}</p></div>
                        <div class="flex gap-1"><button class="settings-icon-button geo-pin-toggle" :aria-pressed="pinned" @click="$emit('update:pinned', !pinned)" :title="pinned ? '切换覆盖式抽屉' : '边聊边看'">{{ pinned ? '已固定' : '固定' }}</button><button class="settings-icon-button" @click="$emit('close')" aria-label="关闭地理地图">×</button></div>
                    </header>
                    <div v-if="!world" class="geo-empty text-gray-500">
                        <svg class="w-12 h-12 text-primary-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="m9 18-6 3V6l6-3 6 3 6-3v15l-6 3-6-3ZM9 3v15M15 6v15" stroke-width="1.5" stroke-linejoin="round"/></svg>
                        <h3 class="font-semibold text-gray-800">{{ character ? '尚未绑定可用地图' : '先选择一个角色' }}</h3>
                        <p class="text-sm leading-relaxed mt-2">在角色编辑的「地理环境」中绑定共享地图，即可查看双方位置。地图中没有确认位置的人物会显示为未知。</p>
                        <button class="settings-create-button mt-4" @click="$emit('configure')">{{ character ? '设置角色地理环境' : '选择角色' }}</button>
                        <button class="settings-icon-button mt-2" @click="$emit('manage')">打开地图管理</button>
                    </div>
                    <div v-else class="geo-drawer-body custom-scrollbar">
                        <label v-if="worldMode && actorOptions?.length" class="block text-xs text-gray-500">查看与谁的路程<select class="map-input w-full mt-1" :value="character?.actorId" @change="$emit('update:focused-actor', $event.target.value)" aria-label="地图关注人物"><option v-for="a in actorOptions" :key="a.actorId" :value="a.actorId">{{ a.name }}</option></select></label>
                        <div class="geo-actor-grid" aria-live="polite">
                            <button v-for="a in actors" :key="a.key" class="geo-actor-card bg-gray-50 border border-gray-200 text-left" :class="a.key === 'user' ? 'text-blue-600' : 'text-primary-600'" @click="focusActor(a)" :title="a.place ? '在地图上定位' : statusLabel(a.location.status)">
                                <img v-if="a.avatar" :src="a.avatar" class="geo-card-avatar" alt=""><span v-else class="geo-card-avatar bg-white border border-gray-200">{{ a.name.charAt(0) }}</span>
                                <span class="min-w-0"><strong class="block text-xs truncate">{{ a.name }}{{ a.key === 'user' ? ' · 我' : '' }}</strong><span class="block text-sm text-gray-800 font-semibold mt-1 truncate">{{ a.place?.name || statusLabel(a.location.status) }}</span><small class="block text-gray-500 mt-1">{{ a.place ? statusLabel(a.location.status) : '' }}{{ a.location.subLocation?.room ? ' · ' + a.location.subLocation.room + '室' : '' }}</small></span>
                            </button>
                        </div>
                        <section class="geo-map-section border border-gray-200 rounded-2xl overflow-hidden">
                            <div class="geo-map-toolbar bg-gray-50 border-b border-gray-200"><span class="text-xs text-gray-500">拖动 · 点选</span><div class="flex items-center gap-1"><button class="settings-icon-button" aria-label="缩小地图" :disabled="zoom <= 1" @click="setZoom(zoom / 1.5)">−</button><span class="text-xs text-gray-500">{{ zoom.toFixed(1) }}×</span><button class="settings-icon-button" aria-label="放大地图" :disabled="zoom >= 8" @click="setZoom(zoom * 1.5)">+</button><button class="settings-icon-button" @click="fitActors">双方</button><button class="settings-icon-button" @click="fitAll">全图</button></div></div>
                            <div ref="viewport" class="geo-map-viewport bg-gray-50" @pointerdown="startPan" @pointermove="movePan" @pointerup="endPan" @pointercancel="endPan" @lostpointercapture="endPan" @wheel.ctrl.prevent="setZoom(zoom * ($event.deltaY < 0 ? 1.2 : 1 / 1.2))">
                                <div class="geo-map-space" :style="{ width: geometry.outerWidth + 'px', height: geometry.outerHeight + 'px' }">
                                    <div class="geo-map-board" :style="{ width: geometry.width + 'px', height: geometry.height + 'px', left: geometry.left + 'px', top: geometry.top + 'px' }">
                                        <svg :viewBox="'0 0 ' + world.imageSize.join(' ')" class="geo-map-image" aria-label="当前世界地图">
                                            <image v-if="image" :href="image" :width="world.imageSize[0]" :height="world.imageSize[1]" preserveAspectRatio="none" />
                                            <polyline v-if="routePoints" :points="routePoints" class="geo-route text-primary-500" fill="none" stroke="currentColor" vector-effect="non-scaling-stroke"/>
                                        </svg>
                                        <button v-for="p in results" :key="p.id" class="geo-place-dot bg-white border border-primary-500" :class="{ 'geo-place-dot--selected bg-primary-500': selectedId === p.id }" :style="{ left: p.point[0] / world.imageSize[0] * 100 + '%', top: p.point[1] / world.imageSize[1] * 100 + '%' }" @click="selectPlace(p.id)" :aria-label="'查看地点：' + p.name" :title="p.name"></button>
                                        <button v-for="m in markers" :key="m.key" class="geo-marker" :class="m.key === 'user' ? 'text-blue-600' : 'text-primary-600'" :style="{ left: m.place.point[0] / world.imageSize[0] * 100 + '%', top: m.place.point[1] / world.imageSize[1] * 100 + '%' }" @click="selectPlace(m.place.id)" :aria-label="m.name + '：' + m.place.name" :title="m.name + ' · ' + m.place.name" :data-testid="'map-marker-' + m.key">
                                            <span class="geo-marker-bubble" :style="{ transform: 'translateX(' + m.offset + 'px)' }"><span class="geo-marker-name bg-white text-gray-800 border border-gray-200">{{ m.name }}</span><span class="geo-marker-ring"><img v-if="m.avatar" :src="m.avatar" alt="" class="border-white"><span v-else class="geo-marker-initial bg-white">{{ m.name.charAt(0) }}</span></span></span>
                                            <svg class="geo-marker-tip" viewBox="-52 0 104 20" aria-hidden="true"><path :d="'M' + (m.offset - 9) + ' 0 L0 18 L' + (m.offset + 9) + ' 0 Z'" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
                                        </button>
                                    </div>
                                </div>
                                <span v-if="loading" class="geo-map-notice bg-white text-gray-500">正在加载底图…</span>
                            </div>
                            <div v-if="imageError" class="p-3 text-xs text-gray-500" role="alert">{{ imageError }} · 仍可选地点和查看位置 <button class="text-primary-600 underline" @click="refreshImage">重试</button></div>
                        </section>
                        <div class="geo-route-summary bg-primary-50 border border-primary-100 rounded-xl">
                            <div class="flex justify-between items-center gap-2"><strong class="text-xs text-primary-700">{{ worldMode ? '我与' + (character?.name || '角色') + '的路程' : '双方路程' }}</strong><select v-model="mode" class="map-input text-xs" aria-label="地图交通方式"><option value="walk">步行</option><option value="bike">骑行</option></select></div>
                            <p class="text-sm text-gray-700 mt-2" v-if="!route">确认双方当前位置后可查看路程。</p>
                            <p class="text-sm text-gray-700 mt-2" v-else-if="route.status !== 'ok'">{{ route.status === 'unreachable' ? '当前道路无法连通' : '地图尚未标定通行耗时' }}</p>
                            <p class="text-sm text-gray-700 mt-2" v-else-if="route.duration.typicalMinutes === 0">同址地点 · 楼内上下楼和房间距离未建模</p>
                            <p class="text-sm text-gray-700 mt-2" v-else>约 <strong class="text-primary-700 text-lg">{{ route.duration.typicalMinutes }}</strong> 分钟 <span class="text-xs text-gray-500">（估算 {{ route.duration.rangeMinutes.join('–') }} 分钟）</span></p>
                        </div>
                        <label class="block text-xs text-gray-500">搜索地点或用途<input v-model="search" class="map-input w-full mt-1" placeholder="图书馆、13栋、吃饭、快递…" aria-label="地图搜索地点"></label>
                        <select class="map-input w-full" :value="selectedId" @change="selectFromList($event.target.value)" aria-label="选择地图地点"><option value="" disabled>选择地点 · 同址楼层可分别选取</option><option v-for="p in results" :key="p.id" :value="p.id">{{ p.name }}{{ districtName(p) ? ' · ' + districtName(p) : '' }}</option></select>
                        <p v-if="!results.length" class="text-xs text-gray-500">没有找到匹配地点，试试其他地名或用途。</p>
                        <div v-if="selected" class="geo-place-detail bg-gray-50 border border-gray-200 rounded-xl">
                            <h3 class="font-semibold text-sm text-gray-800">{{ selected.name }} <span class="text-xs font-normal text-gray-500">{{ districtName(selected) }}</span></h3>
                            <p v-if="selected.function" class="text-xs text-gray-500 mt-1">{{ selected.function }}</p>
                            <p v-if="selected.scene" class="text-xs text-gray-600 leading-relaxed mt-2">{{ selected.scene.slice(0, 200) }}</p>
                            <button class="settings-create-button mt-3 w-full" :disabled="disabled" @click="$emit('set-player', selected.id)">{{ saving ? '正在保存…' : '把我的位置设在这里' }}</button>
                        </div>
                        <div class="flex flex-wrap justify-between gap-2"><button class="settings-icon-button text-xs" :disabled="disabled" @click="$emit('set-player', '')">清除我的位置</button><button class="settings-icon-button text-xs" @click="$emit('manage')">地图管理</button></div>
                        <p class="text-xs text-gray-500 leading-relaxed">{{ worldMode ? '显示当前世界分支已提交的人物位置。角色移动按路程和剧情时间确认到达，在途不会画作已经到达；查看地图不赋予人物额外认知。' : '位置来自当前剧情的最近确认，模型按原文事实更新角色。' }}地图坐标属于RP世界示意图；玩家位置由你决定。设定会保存到本分支，不自动发送模型请求。</p>
                    </div>
                </aside>
            </div>
        </transition>`
    };
})();
