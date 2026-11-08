/** Read-only atlas: complete local descriptions and inherited world background. */
(function () {
    const MapAtlas = {
        props: { world: { type: Object, required: true }, imageData: String },
        setup(props) {
            const { ref, computed, watch } = Vue;
            const search = ref(''), district = ref(''), showNodes = ref(false), showRoads = ref(false), zoom = ref(1), selectedId = ref('');
            const ordinary = computed(() => props.world.places.filter(p => p.kind !== 'junction'));
            const nodes = computed(() => props.world.places.filter(p => p.kind === 'junction'));
            const districtName = id => props.world.districts?.[id]?.label || id || '未分片区';
            const visible = computed(() => props.world.places.filter(p => {
                if (!showNodes.value && p.kind === 'junction') return false;
                if (district.value && p.district !== district.value) return false;
                return !search.value.trim() || searchIds.value.has(p.id);
            }));
            const searchIds = computed(() => new Set(window.RPHubGeography.search(props.world, search.value, { includeNodes: showNodes.value, limit: 2000 }).results.map(p => p.id)));
            const grouped = computed(() => Object.entries(props.world.districts || {}).map(([id, d]) => ({ id, name: d.label || id, places: visible.value.filter(p => p.district === id) })).concat([{ id: '', name: '未分片区', places: visible.value.filter(p => !props.world.districts?.[p.district]) }]).filter(g => g.places.length));
            const clusters = computed(() => {
                const groups = new Map();
                visible.value.forEach(p => { const key = p.point.join(','); if (!groups.has(key)) groups.set(key, { point: p.point, places: [] }); groups.get(key).places.push(p); });
                return [...groups.values()];
            });
            const selected = computed(() => props.world.places.find(p => p.id === selectedId.value));
            const inherited = computed(() => props.world.districts?.[selected.value?.district]);
            const accessEntries = computed(() => Object.entries(selected.value?.access || {}).filter(([, v]) => v !== '' && v !== undefined).map(([key, value]) => ({ label: { open: '开放', close: '关闭', check: '查寝', restriction: '进入限制', sessions: '开放时段', note: '说明' }[key] || key, text: Array.isArray(value) ? value.join('、') : String(value) })));
            const select = id => { selectedId.value = id; };
            const selectCluster = c => {
                const index = c.places.findIndex(p => p.id === selectedId.value);
                selectedId.value = c.places[(index + 1) % c.places.length].id;
            };
            const linePoints = e => [props.world.places.find(p => p.id === e.from)?.point, ...(e.points || []), props.world.places.find(p => p.id === e.to)?.point].filter(Boolean).map(p => p.join(',')).join(' ');
            watch(() => props.world, () => { search.value = ''; district.value = ''; showNodes.value = false; zoom.value = 1; selectedId.value = ordinary.value.find(p => p.id === 'teaching-B')?.id || ordinary.value[0]?.id || props.world.places[0]?.id || ''; }, { immediate: true });
            watch(visible, places => { if (!places.some(p => p.id === selectedId.value)) selectedId.value = places[0]?.id || ''; });
            return { search, district, showNodes, showRoads, zoom, selectedId, ordinary, nodes, visible, grouped, clusters, selected, inherited, accessEntries, districtName, select, selectCluster, linePoints };
        },
        template: `
        <section class="map-atlas" data-testid="map-atlas">
            <div class="flex flex-wrap items-baseline gap-3 mb-3"><h2 class="text-lg font-bold text-gray-800">{{ world.name }}</h2><span class="text-sm text-gray-500">{{ ordinary.length }} 个场景地点 · {{ nodes.length }} 个路网节点 · {{ world.edges.length }} 条道路</span></div>
            <div class="map-editor-grid">
                <section class="bg-white rounded-2xl border border-gray-200 p-3 min-w-0">
                    <div class="map-toolbar text-sm text-gray-600"><label>缩放 <select v-model.number="zoom" class="map-input"><option :value="1">1×</option><option :value="2">2×</option><option :value="3">3×</option></select></label><label><input type="checkbox" v-model="showRoads"> 显示道路</label><label><input type="checkbox" v-model="showNodes"> 显示路网节点</label></div>
                    <div class="map-canvas-scroll">
                        <svg v-if="imageData || world.image" :viewBox="'0 0 ' + world.imageSize.join(' ')" :style="{ width: (zoom * 100) + '%' }" role="img" aria-label="校园地点分布；点选标记查看介绍，同坐标多个地点可再次点击切换">
                            <image :href="imageData || world.image" :width="world.imageSize[0]" :height="world.imageSize[1]" preserveAspectRatio="none" />
                            <template v-if="showRoads"><polyline v-for="e in world.edges" :key="e.id" :points="linePoints(e)" fill="none" :class="['map-road', { 'is-closed': e.closed }]"/></template>
                            <g v-for="c in clusters" :key="c.point.join(',')" @click="selectCluster(c)"><circle :cx="c.point[0]" :cy="c.point[1]" :r="world.imageSize[0] / 100" class="atlas-hit"/><circle :cx="c.point[0]" :cy="c.point[1]" :r="world.imageSize[0] / (c.places.every(p => p.kind === 'junction') ? 220 : 140)" :class="['map-point', { 'is-selected': c.places.some(p => p.id === selectedId) }]"/><title>{{ c.places.map(p => p.name).join(' / ') }}</title></g>
                            <circle v-if="selected" :cx="selected.point[0]" :cy="selected.point[1]" :r="world.imageSize[0] / 65" class="atlas-selection-ring"/>
                        </svg>
                        <p v-else class="text-gray-500 p-5">该地图没有底图，仍可从右侧目录查看全部地点资料。</p>
                    </div>
                    <p class="text-xs text-gray-500 mt-2">地图标注来自RP示意图。图书馆各楼层等同坐标地点，可用目录分别查看；浏览不会修改地图或聊天位置。</p>
                </section>
                <section class="min-w-0">
                    <div class="bg-white rounded-2xl border border-gray-200 p-4 map-form">
                        <label>搜索地点、用途或介绍<input aria-label="浏览搜索地点" v-model="search" class="map-input" placeholder="快递、吃饭、B栋、声控灯…"></label>
                        <label>片区<select aria-label="浏览片区" v-model="district" class="map-input"><option value="">全部片区</option><option v-for="(d, id) in world.districts" :key="id" :value="id">{{ d.label || id }}</option></select></label>
                        <label>地点目录（{{ visible.length }} 项）<select aria-label="浏览地点目录" v-model="selectedId" class="map-input"><option v-if="!visible.length" value="">没有匹配地点</option><optgroup v-for="g in grouped" :key="g.id" :label="g.name"><option v-for="p in g.places" :key="p.id" :value="p.id">{{ p.name }}{{ p.kind === 'junction' ? '（路网节点）' : '' }}</option></optgroup></select></label>
                        <div class="atlas-place-list" aria-label="匹配地点列表"><div v-for="g in grouped" :key="g.id" class="mb-3"><h3 class="text-xs font-bold text-gray-500 mb-1">{{ g.name }}</h3><div class="flex flex-wrap gap-1"><button v-for="p in g.places" :key="p.id" :aria-pressed="p.id === selectedId" @click="select(p.id)" :class="['atlas-place-button', p.id === selectedId ? 'bg-primary-50 text-primary-700 font-bold' : 'text-gray-600 hover:bg-gray-50']">{{ p.name }}</button></div></div></div>
                    </div>
                    <article v-if="selected" class="bg-white rounded-2xl border border-gray-200 p-4 mt-3 map-form" aria-live="polite">
                        <div><h3 class="font-bold text-lg text-gray-800">{{ selected.name }}</h3><p class="text-xs text-gray-500">{{ districtName(selected.district) }}{{ selected.kind === 'junction' ? ' · 路网连接节点' : '' }}</p></div>
                        <p v-if="selected.aliases?.length" class="text-sm text-gray-500">别名：{{ selected.aliases.join('、') }}</p>
                        <p v-if="selected.keywords?.length" class="text-sm text-gray-500">用途关键词：{{ selected.keywords.join('、') }}</p>
                        <p v-if="selected.services?.length" class="text-sm text-gray-500">服务：{{ selected.services.join('、') }}</p>
                        <p v-if="selected.usage" class="text-sm text-gray-700 whitespace-pre-wrap">使用说明：{{ selected.usage }}</p>
                        <section><h4 class="text-sm font-bold text-gray-700 mb-1">用途 / 功能</h4><p class="text-sm text-gray-700 whitespace-pre-wrap">{{ selected.function || (selected.kind === 'junction' ? '连接道路，用于寻路；没有独立场景功能。' : '尚未填写') }}</p></section>
                        <section><h4 class="text-sm font-bold text-gray-700 mb-1">地点完整介绍</h4><p data-testid="atlas-local-scene" class="text-sm text-gray-700 whitespace-pre-wrap">{{ selected.scene || '尚无独立介绍；可查看下方所属片区背景。' }}</p></section>
                        <section v-if="accessEntries.length"><h4 class="text-sm font-bold text-gray-700 mb-1">开放 / 通行规则</h4><p v-for="entry in accessEntries" :key="entry.label" class="text-sm text-gray-700">{{ entry.label }}：{{ entry.text }}</p></section>
                        <details v-if="inherited?.scene"><summary class="text-sm font-bold text-primary-700 cursor-pointer">所属片区完整背景：{{ inherited.label || selected.district }}</summary><p data-testid="atlas-district-scene" class="text-sm whitespace-pre-wrap text-gray-700 mt-2">{{ inherited.scene }}</p><p v-if="inherited.source" class="text-xs text-gray-500 mt-2">来源：{{ inherited.source }}</p></details>
                        <details v-if="world.culture?.length"><summary class="text-sm font-bold text-primary-700 cursor-pointer">共享世界文化</summary><p v-for="(item, i) in world.culture" :key="i" class="text-sm text-gray-700 whitespace-pre-wrap mt-2">{{ item }}</p></details>
                    </article>
                    <p v-else class="text-sm text-gray-500 p-4">没有匹配的地点。</p>
                </section>
            </div>
        </section>`
    };
    window.RPHubMapAtlas = MapAtlas;
})();
