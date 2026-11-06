/** Map editor follows the existing management pages and form controls. */
(function () {
    const MapsView = {
        components: { SettingsPageHeader: window.RPHubComponents.SettingsPageHeader },
        props: { records: Array, busy: Boolean, save: Function, getImage: Function, returnToCharacter: Boolean },
        emits: ['menu', 'import', 'export', 'delete', 'return-character'],
        setup(props) {
            const { ref, computed } = Vue, P = window.RPHubMapPackages;
            const draft = ref(null), originalId = ref(''), image = ref(''), tab = ref('places'), selected = ref(''), action = ref('select'), zoom = ref(1), filter = ref(''), error = ref(''), dirty = ref(false);
            const routeFrom = ref(''), routeTo = ref(''), routeResult = ref(''), jsonText = ref(''), showJson = ref(false), scaleSelection = ref(null);
            const place = computed(() => draft.value?.places.find(p => p.id === selected.value));
            const edge = computed(() => draft.value?.edges.find(e => e.id === selected.value));
            const places = computed(() => (draft.value?.places || []).filter(p => !filter.value || [p.name, p.id, ...(p.aliases || [])].some(v => v.includes(filter.value))));
            const edges = computed(() => (draft.value?.edges || []).filter(e => !filter.value || [e.id, name(e.from), name(e.to)].some(v => v.includes(filter.value))));
            const name = id => draft.value?.places.find(p => p.id === id)?.name || id;
            const allowLeave = () => !dirty.value || window.confirm('有未保存的地图修改，放弃修改并继续？');
            const edit = async record => {
                if (!allowLeave()) return;
                error.value = ''; originalId.value = record.world.id; draft.value = P.clone(record.world); draft.value.places.forEach(p => p.access ||= {}); image.value = record.imageData || record.world.image || ''; selected.value = ''; action.value = 'select'; zoom.value = 1; dirty.value = false;
                // A local raster path is enough for preview. Export/save lazily load original bytes.
                scaleSelection.value = null; showJson.value = false; routeResult.value = ''; filter.value = ''; routeFrom.value = ''; routeTo.value = '';
            };
            const create = () => {
                if (!allowLeave()) return;
                const id = 'map-' + crypto.randomUUID().slice(0, 8);
                draft.value = { version: 1, id, name: '新地图', imageSize: [1000, 1000], culture: [], districts: {}, places: [], edges: [] };
                originalId.value = ''; image.value = ''; selected.value = ''; dirty.value = true; error.value = ''; action.value = 'select'; zoom.value = 1;
                scaleSelection.value = null; showJson.value = false; routeResult.value = ''; filter.value = ''; routeFrom.value = ''; routeTo.value = '';
            };
            const back = () => { if (allowLeave()) { draft.value = null; dirty.value = false; } };
            const upload = async event => {
                const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
                try {
                    const result = await P.readImage(file);
                    if (!draft.value.places.length) draft.value.imageSize = result.size;
                    image.value = result.data; dirty.value = true; error.value = '';
                } catch (e) { error.value = e.message; }
            };
            const newPlace = () => {
                const id = 'place-' + crypto.randomUUID().slice(0, 8);
                draft.value.places.push({ id, name: '新地点', point: draft.value.imageSize.map(n => Math.round(n / 2)), kind: 'place', aliases: [], function: '', scene: '', access: {} });
                selected.value = id; tab.value = 'places'; action.value = 'move'; dirty.value = true;
            };
            const newEdge = () => {
                if (draft.value.places.length < 2) { error.value = '请先建立至少两个地点'; return; }
                const id = 'road-' + crypto.randomUUID().slice(0, 8);
                draft.value.edges.push({ id, from: draft.value.places[0].id, to: draft.value.places[1].id, modes: ['walk', 'bike'], points: [], provenance: 'player_map', note: '' });
                selected.value = id; tab.value = 'roads'; dirty.value = true; action.value = 'select';
            };
            const selectPlace = p => { if (action.value === 'move' || action.value === 'bend') return; selected.value = p.id; tab.value = 'places'; };
            const mapClick = event => {
                const svg = event.currentTarget, pt = svg.createSVGPoint(); pt.x = event.clientX; pt.y = event.clientY;
                const hit = pt.matrixTransform(svg.getScreenCTM().inverse()), point = [Math.round(hit.x), Math.round(hit.y)];
                if (point.some((v, i) => v < 0 || v > draft.value.imageSize[i])) return;
                if (action.value === 'move' && place.value) { place.value.point = point; dirty.value = true; }
                if (action.value === 'bend' && edge.value) { (edge.value.points ||= []).push(point); dirty.value = true; }
            };
            const linePoints = e => [draft.value.places.find(p => p.id === e.from)?.point, ...(e.points || []), draft.value.places.find(p => p.id === e.to)?.point].filter(Boolean).map(p => p.join(',')).join(' ');
            const deleteSelected = () => {
                if (!selected.value || !window.confirm('删除选中项？删除地点会同时删除相连道路。')) return;
                if (tab.value === 'places') {
                    draft.value.places = draft.value.places.filter(p => p.id !== selected.value);
                    draft.value.edges = draft.value.edges.filter(e => e.from !== selected.value && e.to !== selected.value);
                } else draft.value.edges = draft.value.edges.filter(e => e.id !== selected.value);
                selected.value = ''; dirty.value = true;
            };
            const setModes = (mode, checked) => { edge.value.modes = checked ? [...new Set([...edge.value.modes, mode])] : edge.value.modes.filter(m => m !== mode); dirty.value = true; };
            const setScaleMode = mode => {
                scaleSelection.value = mode;
                if (mode === 'time') draft.value.calibration = { ...(draft.value.calibration || {}), autoScale: true, anchorFrom: routeFrom.value || draft.value.places[0]?.id, anchorTo: routeTo.value || draft.value.places.at(-1)?.id, walkMinutes: 35, assumedWalkMetersPerMinute: 75, uncertainty: 0.15, source: '玩家按剧情步行时间标定；非实测距离' };
                else { draft.value.calibration = { ...(draft.value.calibration || {}), autoScale: false }; if (mode === 'unknown') delete draft.value.metersPerUnit; }
                dirty.value = true;
            };
            const scaleMode = computed(() => scaleSelection.value || (draft.value?.calibration?.autoScale ? 'time' : draft.value?.metersPerUnit || draft.value?.edges.some(e => e.meters !== undefined) ? 'scale' : 'unknown'));
            const checkRoute = () => {
                try { const w = P.prepareWorld(draft.value); routeResult.value = JSON.stringify({ walk: window.RPHubGeography.briefRoute(window.RPHubGeography.route(w, routeFrom.value, routeTo.value)), bike: window.RPHubGeography.briefRoute(window.RPHubGeography.route(w, routeFrom.value, routeTo.value, { mode: 'bike' })) }, null, 2); error.value = ''; }
                catch (e) { error.value = e.message; }
            };
            const saveDraft = async copy => {
                error.value = '';
                try {
                    const w = P.clone(draft.value);
                    if (copy) { w.id = w.id.slice(0, 60) + '-copy-' + crypto.randomUUID().slice(0, 8); w.name += '（副本）'; }
                    if (!image.value) throw new Error('请先上传底图');
                    const imageData = image.value.startsWith('data:') ? image.value : await props.getImage(originalId.value);
                    if (await props.save({ world: w, imageData, originalId: copy ? '' : originalId.value })) { draft.value = P.prepareWorld(w); originalId.value = w.id; image.value = imageData; dirty.value = false; }
                } catch (e) { error.value = e.message; }
            };
            const openJson = () => { jsonText.value = JSON.stringify(draft.value, null, 2); showJson.value = true; };
            const applyJson = () => { try { draft.value = P.prepareWorld(JSON.parse(jsonText.value)); draft.value.places.forEach(p => p.access ||= {}); scaleSelection.value = null; showJson.value = false; dirty.value = true; selected.value = ''; error.value = ''; } catch (e) { error.value = e.message; } };
            return { draft, originalId, image, tab, selected, action, zoom, filter, error, dirty, place, edge, places, edges, routeFrom, routeTo, routeResult, jsonText, showJson, scaleMode, name, edit, create, back, upload, newPlace, newEdge, selectPlace, mapClick, linePoints, deleteSelected, setModes, setScaleMode, checkRoute, saveDraft, openJson, applyJson };
        },
        template: `
        <div class="management-view map-view">
            <settings-page-header title="地图与地理环境" @menu="$emit('menu')">
                <button v-if="returnToCharacter" class="settings-create-button" @click="$emit('return-character')">返回角色编辑</button>
                <button v-if="draft" class="settings-create-button" @click="back">返回列表</button>
                <label v-else class="settings-create-button cursor-pointer" :class="{ 'opacity-50': busy }">导入地图包<input data-testid="map-import" type="file" accept=".json,.rpmap.json" class="hidden" :disabled="busy" @change="$emit('import', $event)"></label>
                <button v-if="!draft" class="settings-create-button" @click="create" :disabled="busy">新建地图</button>
            </settings-page-header>
            <p class="text-sm text-gray-500 mb-4">地图属于共享世界。在角色编辑的「地理环境」页绑定后，RP与微信共用地点与路程。世界书可保留简短世界说明。</p>
            <div v-if="!draft" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                <article v-for="record in records" :key="record.world.id" class="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                    <img v-if="record.imageData || record.world.image" :src="record.imageData || record.world.image" class="w-full h-40 object-contain bg-gray-50" :alt="record.world.name + '底图'">
                    <div class="p-4"><h3 class="font-bold text-gray-800">{{ record.world.name }}</h3>
                    <p class="text-xs text-gray-500 mt-1">{{ record.builtin ? '内置试点 · ' : '本地地图 · ' }}{{ record.world.places.length }} 个地点 / {{ record.world.edges.length }} 条道路</p>
                    <div class="flex flex-wrap gap-2 mt-4"><button class="settings-create-button" :disabled="busy" @click="edit(record)">查看 / 编辑</button><button class="settings-icon-button" :disabled="busy" @click="$emit('export', record.world.id)">导出地图包</button><button v-if="!record.builtin" class="settings-icon-button text-gray-500" :disabled="busy" @click="$emit('delete', record.world.id)">删除</button></div></div>
                </article>
            </div>
            <p v-if="!draft" class="text-xs text-gray-500 mt-5">地图包为自包含的 .rpmap.json，携带原图、地点坐标与用途、道路、文化及标定。单独的角色卡只携带地图绑定；分享自建世界时，请同时分享地图包。图片不会自动识别地点或推算真实尺度。</p>
            <div v-if="draft" @input="dirty = true" @change="dirty = true">
                <div class="map-toolbar"><input aria-label="地图名称" v-model="draft.name" class="map-input flex-1" placeholder="地图名称"><label class="settings-create-button cursor-pointer">上传底图<input data-testid="map-image" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="upload"></label><button class="settings-create-button" :disabled="busy" @click="saveDraft(false)">{{ busy ? '保存中…' : '保存地图' }}</button><button class="settings-icon-button" :disabled="busy" @click="saveDraft(true)">另存副本</button><span class="text-xs text-gray-500">{{ dirty ? '未保存' : '已保存' }}</span></div>
                <p v-if="error" role="alert" class="text-sm text-red-600 my-3">{{ error }}</p>
                <div class="map-editor-grid">
                    <section class="bg-white rounded-2xl border border-gray-200 p-3 min-w-0">
                        <div class="map-toolbar text-xs"><span>图上点选可定位；道路折点避开湖泊和围墙</span><label>缩放 <select v-model.number="zoom" class="map-input"><option :value="1">1×</option><option :value="2">2×</option><option :value="3">3×</option></select></label></div>
                        <div class="map-canvas-scroll">
                            <svg v-if="image" data-testid="map-canvas" :viewBox="'0 0 ' + draft.imageSize.join(' ')" :style="{ width: (zoom * 100) + '%' }" @click="mapClick" :class="{ 'cursor-crosshair': action !== 'select' }">
                                <image :href="image" :width="draft.imageSize[0]" :height="draft.imageSize[1]" preserveAspectRatio="none" />
                                <polyline v-for="e in draft.edges" :key="e.id" :points="linePoints(e)" fill="none" :class="['map-road', { 'is-selected': selected === e.id, 'is-closed': e.closed }]" @click="action === 'select' && (selected = e.id, tab = 'roads')" />
                                <g v-for="p in draft.places" :key="p.id" @click="selectPlace(p)"><circle :cx="p.point[0]" :cy="p.point[1]" :r="Math.max(5, draft.imageSize[0] / 140)" :class="['map-point', { 'is-selected': selected === p.id }]"/><text v-if="selected === p.id" :x="p.point[0] + 12" :y="p.point[1] - 12" :font-size="Math.max(14, draft.imageSize[0] / 55)" class="map-point-label">{{ p.name }}</text><title>{{ p.name }}</title></g>
                            </svg>
                            <p v-else class="p-10 text-center text-gray-500">先上传一张底图，再添加地点与道路。</p>
                        </div>
                        <p class="text-xs text-gray-500 mt-2">{{ action === 'move' ? '当前：点击底图移动选中地点。完成后切回选择。' : action === 'bend' ? '当前：点击底图依次增加道路折点。' : '当前：点击标点或道路查看设定。' }} 坐标 {{ draft.imageSize.join(' × ') }}；更换底图保留现有坐标尺寸。</p>
                    </section>
                    <section class="bg-white rounded-2xl border border-gray-200 p-4 min-w-0">
                        <div class="flex gap-2 mb-3"><button v-for="t in [{id:'places',name:'地点'},{id:'roads',name:'道路'},{id:'world',name:'文化 / 标定'}]" :key="t.id" @click="tab = t.id; action = 'select'" :class="['px-3 py-2 rounded-xl text-sm', tab === t.id ? 'bg-primary-50 text-primary-700 font-bold' : 'text-gray-500 bg-gray-50']">{{ t.name }}</button></div>
                        <template v-if="tab !== 'world'">
                            <div class="map-toolbar"><input aria-label="搜索地点道路" v-model="filter" class="map-input flex-1" placeholder="搜索名称、别名"><button class="settings-create-button" @click="tab === 'places' ? newPlace() : newEdge()">{{ tab === 'places' ? '添加地点' : '添加道路' }}</button></div>
                            <select aria-label="选择地点道路" v-model="selected" class="map-input w-full my-3" @change="action = 'select'"><option value="">选择一个{{ tab === 'places' ? '地点' : '道路' }}</option><template v-if="tab === 'places'"><option v-for="p in places" :value="p.id">{{ p.name }}{{ p.kind === 'junction' ? '（路网节点）' : '' }}</option></template><template v-else><option v-for="e in edges" :value="e.id">{{ name(e.from) }} → {{ name(e.to) }} · {{ e.id }}</option></template></select>
                        </template>
                        <div v-if="tab === 'places' && place" class="map-form">
                            <label>地点名称<input v-model="place.name" class="map-input"></label><label>别名（逗号分隔）<input :value="(place.aliases || []).join('，')" @input="place.aliases = $event.target.value.split(/[,，]/).map(v => v.trim()).filter(Boolean)" class="map-input"></label>
                            <label>用途 / 功能<textarea v-model="place.function" class="map-input" rows="2"></textarea></label><label>局部环境 / 文化<textarea v-model="place.scene" class="map-input" rows="3"></textarea></label>
                            <div class="grid grid-cols-2 gap-2"><label>类别<select v-model="place.kind" class="map-input"><option v-for="k in [{id:'place',name:'一般地点'},{id:'junction',name:'路网节点'},{id:'dorm',name:'宿舍'},{id:'canteen',name:'食堂'},{id:'teaching',name:'教学楼'},{id:'lab',name:'实验楼'},{id:'library',name:'图书馆'},{id:'sports',name:'体育场地'},{id:'gate',name:'校门'},{id:'landmark',name:'地标'}]" :value="k.id">{{ k.name }}</option><option v-if="place.kind && !['place','junction','dorm','canteen','teaching','lab','library','sports','gate','landmark'].includes(place.kind)" :value="place.kind">{{ place.kind }}</option></select></label><label>片区ID<input v-model="place.district" class="map-input" placeholder="living / academic"></label></div>
                            <div class="grid grid-cols-2 gap-2"><label>关闭时间<input v-model="place.access.close" class="map-input" placeholder="23:00"></label><label>进入限制<input v-model="place.access.restriction" class="map-input" placeholder="刷卡 / 访客限制"></label></div>
                            <div class="grid grid-cols-2 gap-2"><label>X<input type="number" v-model.number="place.point[0]" class="map-input"></label><label>Y<input type="number" v-model.number="place.point[1]" class="map-input"></label></div>
                            <div class="map-toolbar"><button class="settings-create-button" @click="action = action === 'move' ? 'select' : 'move'">{{ action === 'move' ? '完成定位' : '在图上定位' }}</button><button class="settings-icon-button" @click="deleteSelected">删除地点</button></div>
                            <p class="text-xs text-gray-500">地点ID：{{ place.id }}。junction仅用于路网连接，不作为日常地点检索。</p>
                        </div>
                        <div v-if="tab === 'roads' && edge" class="map-form">
                            <label>起点<select v-model="edge.from" class="map-input"><option v-for="p in draft.places" :value="p.id">{{ p.name }}</option></select></label><label>终点<select v-model="edge.to" class="map-input"><option v-for="p in draft.places" :value="p.id">{{ p.name }}</option></select></label>
                            <div class="flex flex-wrap gap-3 text-sm"><label v-for="m in ['walk','bike']"><input type="checkbox" :checked="edge.modes.includes(m)" @change="setModes(m, $event.target.checked)"> {{ m === 'walk' ? '步行' : '骑车' }}</label><label><input type="checkbox" v-model="edge.bikeDismount"> 骑车须推行</label><label><input type="checkbox" v-model="edge.oneWay"> 单向</label><label><input type="checkbox" v-model="edge.closed"> 封闭</label></div>
                            <label>道路长度（米，已知才填；与整图时间标定互斥）<input type="number" :value="edge.meters ?? ''" @input="$event.target.value === '' ? delete edge.meters : edge.meters = Number($event.target.value)" class="map-input" min="0" placeholder="未知留空，按比例和折线估算"></label>
                            <label>长度来源<select v-model="edge.provenance" class="map-input"><option value="player_map">玩家图示 / 估算</option><option value="measured">实测</option><option v-if="edge.provenance && !['player_map','measured'].includes(edge.provenance)" :value="edge.provenance">{{ edge.provenance }}</option></select></label><label>道路说明<textarea v-model="edge.note" class="map-input" rows="2"></textarea></label>
                            <div class="map-toolbar"><button class="settings-create-button" @click="action = action === 'bend' ? 'select' : 'bend'">{{ action === 'bend' ? '完成折线' : '图上添加折点' }}</button><button class="settings-icon-button" @click="edge.points?.pop(); dirty = true">撤销末折点</button><button class="settings-icon-button" @click="edge.points = []; dirty = true">清空折点</button><button class="settings-icon-button" @click="deleteSelected">删除道路</button></div>
                            <p class="text-xs text-gray-500">{{ (edge.points || []).length }} 个中间折点；道路应沿真实可走通道连接，不能穿越障碍。</p>
                        </div>
                        <div v-if="tab === 'world'" class="map-form">
                            <label>地图ID<input v-model="draft.id" :readonly="!!originalId" class="map-input"></label><label>共享文化 / 世界背景（每行一项）<textarea :value="(draft.culture || []).join('\\n')" @input="draft.culture = $event.target.value.split('\\n').filter(Boolean)" class="map-input" rows="4"></textarea></label>
                            <label>距离依据<select :value="scaleMode" @change="setScaleMode($event.target.value)" class="map-input"><option value="unknown">未标定（道路可查，时间未知）</option><option value="time">已知路线步行分钟</option><option value="scale">每坐标单位米数 / 道路长度</option></select></label>
                            <template v-if="scaleMode === 'time'"><label>标定起点<select v-model="draft.calibration.anchorFrom" class="map-input"><option v-for="p in draft.places" :value="p.id">{{ p.name }}</option></select></label><label>标定终点<select v-model="draft.calibration.anchorTo" class="map-input"><option v-for="p in draft.places" :value="p.id">{{ p.name }}</option></select></label><label>正常步行分钟<input v-model.number="draft.calibration.walkMinutes" type="number" min="1" class="map-input"></label><label>假定步速（米/分钟）<input v-model.number="draft.calibration.assumedWalkMetersPerMinute" type="number" min="1" class="map-input"></label><p class="text-xs text-gray-500">按最短可走路线标定；35分钟是假定剧情成本，推算米数不是实测。</p></template>
                            <label v-if="scaleMode === 'scale'">每坐标单位多少米<input :value="draft.metersPerUnit ?? ''" @input="$event.target.value === '' ? delete draft.metersPerUnit : draft.metersPerUnit = Number($event.target.value)" type="number" min="0" step="0.001" class="map-input" placeholder="只有道路米数时可留空"></label>
                            <button class="settings-icon-button" @click="openJson">高级：编辑结构数据（片区背景等）</button>
                            <hr class="border-gray-100"><span class="text-sm font-bold text-gray-700">检查两点路程</span><select aria-label="路程起点" v-model="routeFrom" class="map-input"><option value="">选择起点</option><option v-for="p in draft.places" :value="p.id">{{ p.name }}</option></select><select aria-label="路程终点" v-model="routeTo" class="map-input"><option value="">选择终点</option><option v-for="p in draft.places" :value="p.id">{{ p.name }}</option></select><button class="settings-create-button" @click="checkRoute">计算步行 / 骑车</button><pre v-if="routeResult" class="text-xs whitespace-pre-wrap break-all bg-gray-50 rounded-xl p-3 max-h-64 overflow-auto">{{ routeResult }}</pre>
                        </div>
                    </section>
                </div>
                <section v-if="showJson" class="bg-white border border-gray-200 rounded-2xl p-4 mt-4 map-form"><p class="text-sm text-gray-500">只编辑地点、道路、片区等结构数据。原图单独保存；资料中的命令仅当文本处理。</p><textarea aria-label="地图结构JSON" v-model="jsonText" class="map-input font-mono" rows="14"></textarea><div class="map-toolbar"><button class="settings-create-button" @click="applyJson">校验并应用</button><button class="settings-icon-button" @click="showJson = false">取消</button></div></section>
            </div>
        </div>`
    };
    const GeographyBindingEditor = {
        props: { value: Object, maps: Array, characterName: String }, emits: ['update', 'manage'],
        computed: { currentMap() { return this.maps.find(m => m.id === this.value?.worldId); } },
        methods: {
            choose(id) {
                if (!id) { this.$emit('update', { ...(this.value || {}), enabled: false }); return; }
                const same = id === this.value?.worldId;
                this.$emit('update', { ...(same ? this.value : {}), enabled: true, worldId: id, bindings: same ? this.value.bindings || {} : { user: {}, character: { name: this.characterName } }, placeMemories: same ? this.value.placeMemories || {} : {} });
            },
            setHome(who, id) { const next = window.RPHubMapPackages.clone(this.value); next.bindings ||= {}; const prev = next.bindings[who] || {}; next.bindings[who] = { ...prev, home: id, ...(prev.home !== id ? { room: '' } : {}), ...(who === 'character' ? { name: this.characterName } : {}) }; this.$emit('update', next); }
        },
        template: `<div class="map-form"><label>共享地图<select aria-label="角色绑定地图" :value="value?.enabled !== false ? value?.worldId || '' : ''" @change="choose($event.target.value)" class="map-input"><option value="">不启用地理工具</option><option v-if="value?.worldId && !currentMap" :value="value.worldId">缺失地图：{{ value.worldId }}</option><option v-for="m in maps" :value="m.id">{{ m.name }}</option></select></label><p v-if="value?.enabled !== false && value?.worldId && !currentMap" class="text-sm text-red-600">绑定的地图尚未导入，请导入配套地图包或重新选择。</p><template v-if="currentMap && value?.enabled !== false"><label v-for="who in ['user','character']">{{ who === 'user' ? '玩家住址' : '角色住址' }}<select :aria-label="who === 'user' ? '玩家住址' : '角色住址'" :value="value.bindings?.[who]?.home || ''" @change="setHome(who, $event.target.value)" class="map-input"><option value="">未设置</option><option v-for="p in currentMap.places" :value="p.id">{{ p.name }}</option></select></label></template><p class="text-sm text-gray-500">住址用于背景，当前位置由当前剧情确认。“我要去”不会被当作已经到达。地图、图像和道路保存在共享地图库，按需提供局部查询结果。</p><p class="text-xs text-gray-500">分享角色时，角色卡携带绑定和个人地点经历；自建地图须同时导出地图包，接收方先导入地图包再导入角色。</p><button class="settings-create-button self-start" @click="$emit('manage')">打开地图管理</button></div>`
    };
    window.RPHubMapComponents = { MapsView, GeographyBindingEditor };
    window.RPHubComponents.CharacterEditorModal.components = { ...(window.RPHubComponents.CharacterEditorModal.components || {}), GeographyBindingEditor };
})();
