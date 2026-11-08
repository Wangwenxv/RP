# App 模块地图（assets/js/app/）

> 2026-11-08 `26/15/data-services` 区分程序历史资料与玩家发言，`25` 剔除档案内部字段；`02/10` 解析提示词双方姓名。见 [实际 messages 审计交接](./request-context-audit.md)。

> 2026-11-08 `built-in-content/14/15` 补齐发送者归属和卡片资料来源，`25` 回执具名 sender/recipient，压缩与检索保留玩家草稿方向。见 [发送归属交接](./wechat-sender-ownership.md)。

> 2026-11-08 新增 `34-history-retrieval.js`（`historyRetrieval`），setup 在 `conversationClear` 后包装 RP/微信工具。`api-utils/05` 提供请求前 messages 日志，`15/16` 协调提要加载与增强记忆覆盖；见 [调试与原文检索交接](./history-retrieval-and-debug.md)。

> 2026-11-08 `wechat-media.js` / `27` 新增描述型图片与缺图兜底，`14/17/18/25` 接入 RP 主动图片，`15` 提供本地目录说明；卡片沿用微信 UI，历史共用图片记录格式。见 [离线图片与描述交接](./wechat-described-images.md)。

> 2026-11-08 新增 `33-conversation-clear.js`（`conversationClear`），setup 在 `fullBackup` 后调用。RP/微信清空入口、本段边界与 scoped 批量事务由它统一负责；详见 [清空功能交接](./conversation-clear.md)。

> 2026-11-07 `25` 限制主动微信同轮一次、不展开 JSON 列表；`18` 成功联系后结束自动续写，`15` 将交接视为完成回合。工具参数与共享提示同步，见 [微信玩家交接](./wechat-player-handoff.md)。

> 2026-11-07 `built-in-content.js` 新增 RP 世界叙事共享规则；`25` 区分 RP 玩家输入与旁白，微信协议防止跨场景认知泄漏，`26` 提要改为叙述背景。逐轮总结、二次压缩及提要同步保留人物知情来源。见 [世界自主叙事交接](./rp-world-narrative.md)。

> 2026-11-07 `15` 删除DeepSeek最少700字注入与普通历史最近两轮旧分析回灌，并启用最终玩家提醒；本体/文风/COT/活人感允许短回复等待，`16`总结规则补微信发送与已读来源核对，苏祈雪卡移除强制甜度指标。见 [玩家决定权交接](./player-agency.md)。

> 2026-11-07 `15` 在请求组装末尾追加玩家决定权约束，`25`/微信协议共用；`16` 给总结提供玩家来源核对，`26` 标明RP玩家输入与AI叙述，`30` 限定地理建议不能代玩家行动。提示词与回归入口见 [玩家决定权交接](./player-agency.md)。

> 2026-11-07 新增 `32-full-backup.js`（`fullBackup`），整库快照与原子恢复在 `data-services.js`，文件与二进制校验在 `backup-utils.js`；设置页沿用原 UI 新增整库备份。setup 末尾 `26 → 32`，工坊存储同步接入主库。见 [完整备份交接](./full-backup.md)。

> 2026-11-07 `16` 新增向量故障状态/冷却/查询超时与响应校验，`19` 将可选索引故障和总结、二次压缩分开处理；`index.html` 沿用原 UI 展示故障详情与重试。见 [记忆总结与向量召回交接](./memory-recall-fallback.md)。

> 2026-11-06 微信剧情时间：玩家可选下次发送日期或相对间隔，连发默认同一时刻；模型可用 sendAt / delayMinutes 推进回复时间。合并上下文只在首条和时间变化处标记，RP 回灌与前情提要同步保留。见 [微信剧情时间交接](./wechat-story-time.md)。

> 30地理适配新增轻量生活需求预取，复用RP/微信本轮文本，不额外调用意图模型；geography.js提供needs/everydayContext及按用途搜索，地图包保留新资料。见[生活需求预取交接](./geography-everyday.md)。

> 地图库的只读浏览界面新增`map-atlas.js`组件，`map-components.js`增加“浏览地点”入口；读取31模块当前地图库记录，不改地图或模型提示。见[地点可视化交接](./geography-atlas.md)。

> 30地理适配的后续修复：微信连发读取当前未回复的一批文本，最多4地点短资料预取；引擎识别已知地点＋房号，不把询问/计划作为到达。见[场景预取交接](./geography-scene-prefetch.md)。

> 2026-11-06新增31号共享地图库管理：地图管理入口、角色绑定、原图与标注/路网自包含包、IndexedDB持久化，接入30地理适配；原图资源按需加载，RP/微信按需取得局部结果。setup末段为25→27→28→29→30→31→26。详见[地图管理与便携地图包交接](./geography-map-manager.md)。

> 01~24 号模块由原 `app.js` 的 `setup()`（661 条顶层语句、662 个声明）机械拆分而来，行为与原文件完全一致；
> 25 号为微信、26 号为前情提要、27 号为图片、28 号为语音、29 号为文档。setup 末段按 25 → 27 → 28 → 29 → 26 初始化。
> 每个文件头部注释标明了它来自原文件的哪几行。加载顺序 = 文件序号 = 原声明顺序。
> 约定见 [ARCHITECTURE.md](./ARCHITECTURE.md) §3（`__s` 共享上下文）。

| # | 文件 | 行数 | 职责 |
| --- | --- | --- | --- |
| 01 | `01-state-app-shell.js` | ~380 | 全局 UI 状态：弹窗可见性、生成/接收中标志、Toast、DOM 模板引用、移动端视口适配、导航开关、API 状态灯 |
| 02 | `02-state-settings.js` | ~415 | 用户人设、`settings`、字体、API 提供商选择与归一化、模型模式/推理强度、聊天模型槽位（数据层，设置页在用）、聊天区模型下拉菜单（`chatModelMenuModels` / `selectChatModel`） |
| 03 | `03-state-chat.js` | ~281 | 角色列表、`chatHistory`、渲染窗口、预设与文风过滤、会话轮次快照、正则/世界书/UI 模板列表 |
| 04 | `04-state-memory-tools.js` | ~249 | 记忆常量与状态（经典记忆、记忆设置）、主动工具定义与归一化、各类设置弹窗开关 |
| 05 | `05-state-editing-export.js` | ~317 | 编辑器草稿（角色/预设/模板/正则/世界书/工具）、剧情分支视图状态、token 用量与存储统计接线、导出弹窗、内嵌页（生成器/广场/小说）、拖拽排序 |
| 06 | `06-persistence.js` | ~391 | 聊天记录防抖保存与失败重试、`saveData` 总落盘、`loadData` 启动加载 |
| 07 | `07-image-gen-autosave.js` | ~411 | 自动生图开关与任务、生成图重抽/补水合、生图正则同步、`debounce` 与自动保存 |
| 08 | `08-scoped-uitemplate.js` | ~446 | `currentCharacter`、角色作用域资源合成（正则/UI 模板）、UI 模板运行时（状态重建、上下文注入、更新应用） |
| 09 | `09-chat-display-branch.js` | ~426 | 收藏与角色过滤、聊天渲染窗口与滚动锚点、剧情分支路线图与拖拽、经典记忆查找、压缩率统计、模型标签过滤 |
| 10 | `10-methods-core.js` | ~255 | `showToast`、确认框、正则管线 `processRegex`、Markdown 渲染与消息布局判断 |
| 11 | `11-methods-models.js` | ~175 | 模型选择器、连接状态检查、停止生成与中断安全处理 |
| 12 | `12-methods-chat-send.js` | ~224 | 聊天图片附件（选择/识别/描述）、`sendMessage` 入口、滚到底部、清空对话 |
| 13 | `13-methods-message-ops.js` | ~524 | 全屏、复制/编辑/删除/重新生成消息、UI 模板更新运行（`updateUiTemplatesFromChat`）、记忆与会话绑定清理 |
| 14 | `14-tools-runtime.js` | ~121 | 主动工具定义装配与系统提示词、思考链包裹、下一回复提示注入 |
| 15 | `15-generate.js` | ~668 | **主生成管线 `generateResponse`**（上下文组装 → 流式请求 → 工具调用循环 → 后处理），全应用最大单函数 |
| 16 | `16-memory-extraction.js` | ~557 | 经典记忆抽取（单轮/二级压缩）、向量嵌入与索引、增强记忆选择 |
| 17 | `17-retrieval-web-tools.js` | ~317 | 关键词检索工具、Tavily 联网搜索/抓取、随机数工具、原生工具调用解析 |
| 18 | `18-tools-ui.js` | ~335 | 工具调用 UI 组件生成、状态机、思考摘要折叠、时间线构建 |
| 19 | `19-memory-batch.js` | ~229 | 记忆批量抽取、后台巡逻、中断与恢复 |
| 20 | `20-character-crud.js` | ~477 | 角色/UI 模板增删改、角色删除与批量删除、特殊规则（`enforceSpecialRules`） |
| 21 | `21-character-lifecycle.js` | ~592 | 初始会话创建、角色切换（`selectCharacter`）、剧情分支持久化与切换、角色记忆加载、头像上传 |
| 22 | `22-character-io.js` | ~407 | 世界书归一化/导入导出、角色卡/聊天记录/PNG 导出、预设增删改 |
| 23 | `23-lifecycle.js` | ~289 | 启动 watcher、`onMounted` 初始化全流程、`onBeforeUnmount` 清理（无导出成员，纯副作用） |
| 24 | `24-late-helpers.js` | ~195 | 流式正文截断 `processMainContent`、用户人设切换、记忆展示与统计滑块 |
| 25 | `25-wechat.js` | ~1900 | **微信子系统**：统一时间线、进出微信、上下文、空回、工具续写、回复播放、单条消息编辑/删除与作用域防护 |
| 26 | `26-recap.js` | — | RP/微信交错前情提要、覆盖边界、保留原文及短图片描述 |
| 27 | `27-wechat-media.js` | — | 按本轮触发图片说明、相册、实际图片/描述卡片与失败兜底、新图视觉输入、加载/查看工具、图片任务和可选来源适配 |
| 28 | `28-wechat-voice.js` | — | BreezeBlue 设置/目录、语音合成、单一播放器与作用域校验；批次复用 `27`，详见 [语音交接](./wechat-voice.md) |
| 29 | `29-wechat-documents.js` | — | 文本附件、scope 校验、list/search/read 工具、隔离读者续读、预览下载与资源回收；新增附件拖入/输入框适配，详见 [文档交接](./wechat-documents.md)、[grep 检索交接](./wechat-document-search.md) 与 [界面交接](./wechat-layout-and-drop.md) |
| 33 | `33-conversation-clear.js` | — | RP/微信本段或全部清空、派生数据事务与晚到请求隔离 |
| 34 | `34-history-retrieval.js` | — | RP/微信原文搜索/读取、当前分支来源、临时预算与原生工具包装 |

> 注：行数为约数（含镜像赋值与文件头注释）。23 号模块没有顶层声明（只有 `watch` / `onMounted` / `onBeforeUnmount` 三条副作用语句），这是正常的。
> 微信的当前协议和维护入口见 [实现交接](./wechat-and-RP.md)。`wechat-media.js` 是独立资源服务，不属于 app 模块；图片二进制不进入历史文本。

## 速查：我要改 X，去哪个文件？

- **发送/回复流程**：入口 `12` → 主管线 `15` → 后处理 `13`/`10`
- **上下文组装（角色卡/世界书/记忆如何进 prompt）**：`15`（装配）+ `08`（UI 模板注入）+ `16`（增强记忆召回）+ `data-services.js`（`RPHubContextUtils`）
- **聊天记录保存**：`06`（`scheduleChatHistorySave` / `saveChatHistoryNow`）
- **角色切换时发生了什么**：`21`（`selectCharacter`：停当前工作 → 保存旧角色 → 加载聊天/记忆/分支 → 应用角色作用域资源）
- **剧情分支**：状态 `05`、视图与拖拽 `09`、持久化与切换 `21`
- **记忆系统**：状态与常量 `04`、抽取 `16`、批量 `19`、展示 `24`、查找 `09`
- **主动工具**：状态 `04`、定义装配 `14`、联网/关键词/随机数 `17`、UI 时间线 `18`、与主管线的衔接 `15`
- **自动生图**：`07`
- **UI 模板（面板/变量）**：运行时 `08`、更新执行 `13`、工具函数 `data-services.js`（`RPHubUiTemplateUtils`）
- **API 请求/密钥/提供商**：`02`（选择与归一化）+ `api-utils.js`（请求实现）
- **请求前 messages 调试 / 压缩后原文核实**：`api-utils/05`（日志）+ `history-retrieval.js/34`（搜索与执行）+ `15/18/25`（续写）；见 [调试与原文检索交接](./history-retrieval-and-debug.md)。
- **微信子系统**：状态/时间线/生成 `25` + 协议 `wechat-protocol.js` + UI/样式 `index.html` 的 `.wx-root` / `wechat.css`；
  角色开关字段在 `20`-crud 归一化、编辑器开关在 `ui-components.js`；RP 侧衔接注入在 `15`（`appendWechatDigestToMessages`）。
- **微信单条消息编辑/删除**：`25`（`startWechatEdit` / `saveWechatEdit` / `deleteWechatMessage`）+ `26`（删除后修正提要覆盖计数）
  + `index.html` 的 `.wx-tools` / `.wx-msg-menu` + `wechat.css`。说明见 [单条消息编辑交接](./wechat-message-editing.md)。
- **微信文档阅读**：`29`（上传/工具/隔离读者）+ `wechat-documents.js`（分块/资源库/按字符定位）+ `25`（消息与工具续写）；说明见 [长文档交接](./wechat-documents.md)。
- **附件检索语法/排序**：`wechat-document-search.js`（`parseQuery`/`scan`，纯函数）+ `29` 的工具层格式化；改语法、上限或打分先看 [grep 检索交接](./wechat-document-search.md)。
- **微信工具等待状态**：`25`（`wechatActivity`/计时/请求次数/清理）+ `29`（读者批次与成功进度）+ `27`（识图次数）+ `index.html`/`wechat.css`（输入区状态卡）；附件找回与 RP 工具边界见 [状态交接](./wechat-tool-activity.md)。
- **移动端键盘/视口**：`01`
- **启动初始化顺序**：`23`（`onMounted`：`loadData` → 恢复上次角色 → `fetchModels` → 状态检查 → 视口监听 → 全局点击收起）

## bootstrap 全局常量（app.js 顶部，原 setup 前 29 行）

`cardUtils`、`fontFamilyOptions` 等 12 个 UI 选项、`ACTIVE_TOOL_*` 常量族、`getDefaultActiveToolDefinitions`。
它们是文件顶层 `const`，全体模块可直接裸引用。

## 地理试点（2026-11-06）

后续多调用与context/batch组合查询在`api-utils`、`30`、`15`、`25`接线，默认brief并提供本轮本地速查。当前预算与协议见[地理工具与费用](./geography-tools-cost.md)。

`30-geography.js`（`geography`）接入RP/微信共享地图与工具；`geography.js`负责别名、道路寻路与位置证据重放；`worlds/*.json`是共享资料源，`world-data.js`是生成的浏览器注册表。RP挂点`15/18`，微信挂点`25`，卡扩展往返`core-utils/22`。使用、地图替换及待校准限制见[地理交接](./geography-pilot.md)。

v2（同日）在引擎侧增加`compass`/`relation`/`reachability`，`briefState`改为`(state, world)`并输出`zone`/`point`/`relation`，`contextInfo`带`reach`；适配层据`world.landmarks`现算"从这里出发到各处"的分钟表。角色卡只管能力声明与"她对距离的反应"，不再存分钟数。详见[位置、距离表与卡片剥离](./geography-v2-positions.md)。

## 新增功能的落点建议

1. 优先加入现有语义最近的模块；若跨域较大，新建 `NN-feature.js`（序号接龙），并在
   `index.html` 的加载清单和 `app.js` 的 `__sections.*(__s)` 调用清单**同位置**各加一行。
2. 新状态：`const x = ref(...)` + `__s.x = x;`；新函数同理。
3. 模板要用？在 app.js 的 `return` 里补 `x: __s.x`。
4. 会被重新赋值的 `let`：直接写 `__s.x = init;`，不要本地镜像。
