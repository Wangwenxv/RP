# RP-Hub 架构交接文档

> 新人第一读。本文说明整体架构、文件职责、数据流与扩展挂点。
> 模块级地图见 [MODULES.md](./MODULES.md)；本次 app.js 拆分的过程与工具见 [tools/refactor/README.md](../tools/refactor/README.md)。

## 1. 项目形态

纯前端、零构建的本地 Roleplay 工具。双击 `index.html` 即可运行（也可任意静态服务器托管）。
没有打包器：所有 JS 都是**经典 script**，按 `index.html` 底部的顺序通过 `document.write` 加载（带时间戳防缓存）。

技术栈：Vue 3（全局构建 `vue.global.prod.js`，CDN）+ Tailwind（CDN）+ DaisyUI 风格约定 + marked + DOMPurify + SortableJS。
模板直接写在 `index.html` 里（2700+ 行），根组件是 `createApp({ components, setup() })` 单实例应用，挂在 `#app`。

## 2. 脚本加载顺序与职责（依赖方向自上而下）

| 顺序 | 文件 | 导出（window 命名空间） | 职责 |
| --- | --- | --- | --- |
| head | `assets/js/theme.js` | `RPHubTheme` | 主题色切换 |
| 1 | `assets/js/built-in-content.js` | `RPHubBuiltinContent` / `RPHubBuiltinPresets` / `RPHubLatestUpdate` | 默认预设、各模式提示词、画师串、更新公告 |
| 2 | `assets/js/core-utils.js` | `RPHubUtils` / `RPHubCardUtils` / `RPHubConfig` | 通用工具、角色卡处理、基础配置（API 提供商、主动工具常量、UI 选项） |
| 3 | `assets/js/api-utils.js` | `RPHubApiUtils` / `RPHubApiClient` | API 端点拼接、OpenAI 兼容请求（流式） |
| 3.5 | `assets/js/wechat-protocol.js` | `RPHubWeChatProtocol` | 微信分段回复协议：JSON 分段 prompt + 容错解析（见 §7） |
| 4 | `assets/js/data-services.js` | `RPHubStorage` / `RPHubMemoryUtils` / `RPHubContextUtils` / `RPHubStoryBranches` / `RPHubUiTemplateUtils` | IndexedDB 存储层、记忆/向量工具、上下文组装、剧情分支、UI 模板工具 |
| 5 | `assets/js/runtime-services.js` | `RPHubMessageRenderer` / `RPHubComposables` | 消息渲染器、存储统计与 token 用量两个 composable |
| 6 | `assets/js/update-check.js` | `RPHubUpdateCheck` | 更新检查 |
| 7 | `assets/js/ui-components.js` | `RPHubCustomSelect` / `RPHubLayoutComponents` / `RPHubComponents` | 全部弹窗/导航/卡片等 Vue 组件 |
| 8 | `assets/js/app/*.js`（25 个） | `RPHubAppSections.<模块名>` | **应用模块**（原 app.js setup() 的拆分，见 §3） |
| 9 | `assets/js/app.js` | — | 引导：全局常量解构、`RollingText` 组件、createApp、按序调用 25 个模块、mount |

另有 `assets/js/presence.js`（`RPHubPresence`，在线状态，配合 `presence-server/` 使用，主页未加载）。

**关键机制：经典 script 共享全局词法作用域。** 前序文件顶层的 `const/let/function` 对后续文件可见；
`app/*.js` 的模块函数体内可以直接引用 `ref/computed`、`RPHubXxx` 以及 app.js 顶部解构出的辅助常量。
改动加载顺序前先想清楚这一层。

## 3. App 模块模式（`__s` 约定）

原来的 `app.js` 是一个 8560 行文件，`setup()` 里有 662 个顶层声明。
现在拆成 `assets/js/app/01..25-*.js` 共 25 个**模块函数**（`25-wechat.js` 为后加的微信子系统，见 §7），约定如下：

```js
// assets/js/app/XX-*.js
(function () {
    window.RPHubAppSections = window.RPHubAppSections || {};
    window.RPHubAppSections.someKey = function (__s) {
        const foo = ref(0);
        __s.foo = foo;                 // 镜像到共享上下文
        const bar = () => __s.foo.value + 1;  // 跨模块引用一律走 __s
        __s.bar = bar;
    };
})();
```

```js
// assets/js/app.js setup()
const __s = {};
__sections.stateAppShell(__s);   // 按序号调用，顺序 = 原 setup() 声明顺序
// ...
return { foo: __s.foo, bar: __s.bar /* ... */ };  // 模板拿到的接口不变
```

三条规则：

1. **模块内声明镜像到 `__s`**：每个顶层声明后紧跟 `__s.<name> = <name>;`。
2. **跨模块引用写 `__s.<name>`**；模块内引用保持裸名。
3. **会被重新赋值的 `let`（timer/flag/epoch 等 34 个）直接驻留在 `__s` 上**
   （声明写作 `__s.waitTimer = null;`），所有读写一律 `__s.` 前缀，避免镜像值过期。

`setup()` 的 `return` 对象（模板接口）保持在 app.js 中，全部改为 `__s.<name>` 引用，
因此 **`index.html` 模板零改动**。新增功能时：放进最贴合的模块（或新建 `25-*.js` 并在
index.html 与 app.js 的调用清单各加一行），return 里暴露模板需要的名字。

## 4. 存储层

- IndexedDB 主库 `RPHubDB`（`data-services.js` 的 `initDB`），`getStoredValue/setStoredValue` 系列读写；
  兼容一个历史遗留库（见 `LEGACY_DB_NAME`）。
- **角色作用域键**：`getScopedStoredValue / setScopedStoredValue`，按角色 uuid（+剧情分支 scope）隔离：
  聊天记录、经典记忆、记忆设置、分支状态都按角色独立保存（见 `06-persistence.js` 与 `21-character-lifecycle.js`）。
- 全局数据（角色列表、预设、正则、世界书、设置、用户人设）由 `saveData()` 统一落盘；
  聊天与记忆有独立防抖保存（`scheduleChatHistorySave` 等）。
- token 用量与存储统计由 `runtime-services.js` 的两个 composable 管理（`05-state-editing-export.js` 里接线）。

## 5. 一次对话生成的链路（速查）

1. `sendMessage()`（`12-methods-chat-send.js`）处理输入、图片附件，推入用户消息；
2. `generateResponse()`（`15-generate.js`，650 行主管线）：
   - 组装上下文：角色卡 + 世界书（`resolveWorldInfoEntries`，`08-scoped-uitemplate.js`/`22-character-io.js`）
     + 预设 + 记忆召回（`17-retrieval-web-tools.js`）+ 历史（`postprocessChatHistory`）；
   - 经 `requestChatCompletion`（`api-utils.js`）流式请求；
   - 正则后处理（`10-methods-core.js` 的 `processRegex`）、UI 模板更新（`13-methods-message-ops.js`）、
     主动工具调用循环（`14/17/18-tools-*.js`）；
3. 渲染：`createMessageRenderer`（`runtime-services.js`）+ `processMainContent`（`24-late-helpers.js`，流式截断未闭合 HTML）；
4. 后台：经典记忆抽取/压缩/向量索引（`16-memory-extraction.js`）与批量巡逻（`19-memory-batch.js`）。

## 6. 视图与导航

单页多视图：`currentView`（`'chat' | 'characters' | 'settings' | ...`）切换 `index.html` 中的大块模板。
模态弹窗可见性都是 `showXxx` ref。DOM 模板引用：`chatContainer`、`inputBox`、`messageElements` 等模板 ref。

## 7. 微信聊天子系统（已实现）

需求：角色扮演 ↔ 拟真微信聊天双场景互通，共享角色记忆，按时间线无缝衔接。
微信 agent 参考工程：`D:\aiops_wwx\test\wechat-chat-agent`。

### 7.1 文件与挂点

| 文件 | 职责 |
| --- | --- |
| `assets/js/wechat-protocol.js` | 微信分段协议（`window.RPHubWeChatProtocol`）：JSON 分段 prompt + 容错解析（代码块/think/纯文本降级） |
| `assets/js/app/25-wechat.js` | 应用模块 `wechat`：统一时间线、进出微信、分段生成、打字节奏 |
| `assets/css/wechat.css` | 全屏覆盖层样式（`.wx-*` 前缀，挂在 `.wx-root` 下，不污染既有样式） |
| `index.html` | `.wx-root` 全屏覆盖层模板；聊天顶栏「微信」入口按钮（`currentCharacter.wechatEnabled` 时显示） |

加载顺序：`wechat-protocol.js` 紧随 `api-utils.js`（在 `data-services.js` 前）；
`app/25-wechat.js` 在 `24-late-helpers.js` 之后、`app.js` 之前。

### 7.2 角色级开关与字段

角色卡新增字段（`20-character-crud.js` 新建/保存时归一化，`ui-components.js` 的角色编辑器
「基础」页有「开启微信」开关）：

- `wechatEnabled`（布尔，缺省 false）：聊天顶栏是否显示「微信」入口。
- `wechatPeerName` / `wechatRelation` / `wechatScene` / `wechatPersona`（微信侧人设，留空回退角色卡 name/personality/description）。
- `wechatSpeed`：`'fast' | 'normal' | 'slow'`，决定打字停顿长短。

### 7.3 统一时间线（核心）

`25-wechat.js` 把 RP 消息与微信消息写入**同一条角色作用域时间线**，存在 scoped key
`wechat_timeline`（已在 `05-state-editing-export.js` 的 `CHARACTER_SCOPED_STORAGE_NAMES` 注册，
随角色删除/存储清理一并处理）。**粒度跟随剧情分支**（scope = `getCurrentStoryBranchScopeId()`），
切分支时微信记录一起切，不会串戏。

每条：`{ id, ts, channel: 'rp' | 'wechat', role, type, content, rpIndex?, rpMsgId? }`
（`rpIndex`/`rpMsgId` 仅 RP 镜像有，指向对应的 chatHistory 消息）。

- **RP → 时间线**：`generateResponse` 的 `finally` 调 `recordRpMessages()`，按 `rpIndex` 只追加新消息
  （角色未开微信时为空操作）。
- **进微信**（`openWechat`）：读该 scope 的时间线 → `recordRpMessages()` 补齐 → `reconcileRpTimeline()`
  做一次权威对账。RP 侧每轮上下文独立重建，编辑/删除/重新生成不会自动回写镜像，所以对账按
  `rpMsgId`（id 对不上时回退 `rpIndex`）重绑：编辑过的就地更新、新增的按时间槽插回原位、已删的丢弃。
  system prompt（`buildWechatSystemPrompt`）由以下拼成：
  - **完整角色卡**（`buildWechatCharacterCard`）：`Name` + `Description` + `Personality` + `mes_example`，
    与 RP 侧 `[Character]` 注入对齐；若角色编辑器填了「微信人设」则用它覆盖；
  - **对方（用户）信息**：复用 `buildUserInfoPrompt()`，让模型知道在跟谁聊；
  - **RP 预设白名单**（`WECHAT_PRESET_WHITELIST`：人格内核/禁止规则/防神化）——
    只带跨媒介的人格与行为约束；叙事格式类预设（文风/活人感/剧情面板/时间戳/第二人称/去User中心化）
    与 NSFW增强（要求「细腻缓慢推进」，与短气泡冲突）都是 RP 正文规则，一律不带；
  - 关系/场景（`wechatRelation`/`wechatScene`）+ **RP 长期记忆**（`buildWechatMemory`）；
  - 微信协议 + 跨场景提示。
  历史按时间线顺序还原：每段连续 RP 合并成**一条**「剧情背景」块（`buildWechatRpBlock`）插在原时间位置，
  正文先过 RP 的 `processRegex` 解析 `{{user}}` 等占位符且**不截断**；微信消息**相邻同角色气泡全量合并**
  成一条（跨轮因 user/assistant 交替天然分开），避免一轮 4 条被拆成 4 条分别发。
- **回 RP**（`15-generate.js`）：上下文组装后调 `appendWechatDigestToMessages`，把**全部**微信消息
  改写成「微信聊天记录」块（`buildWechatRpDigest`），附到最新一条 user 消息**前面**（保留用户输入原文）。
  取全量而非「最后一次 RP 之后」：RP 侧每轮独立重建上下文，增量过滤会让
  「微信1→RP1→微信2→RP2」在 RP2 时丢掉微信1。

两侧永远不整段复制历史，只按需取窗口；因此不会互相膨胀。

### 7.4 微信侧生成

复用 `requestTrackedChatCompletion`（RP 当前 `settings` 的 URL/Key/模型）+ 微信 agent 的
JSON 分段协议与打字节奏：逐条 `typingDuration`（基线 + 字数×每字耗时 + 抖动，12% 走神）、
每条之间重起「对方正在输入…」、等待期状态栏跑计时器。

**不触发** RP 的世界书/正则/记忆抽取/UI 模板管线，避免互相污染。微信图片经 `compressImage`
压到长边 ≤1024 后作为 `image_url` 多模态 part 发送。

### 7.5 验证

`tools/refactor/smoke-wechat.cjs`（无头 Edge，`node tools/refactor/smoke-wechat.cjs`）覆盖：
协议解析、建角色开微聊、入口按钮显隐、覆盖层渲染、分段气泡（含表情）、气泡全量合并、
IndexedDB 持久化回读、角色间时间线隔离、编辑/重新生成后的镜像对账、
`{{user}}` 占位符解析与长文不截断、以及**双向衔接**（黑盒拦截真实请求体，验证进微信带 RP 摘要、
回 RP 注入微信聊天记录块且保留原文，含「微信1→RP1→微信2→RP2」两段微信都进 RP2 背景）、
角色编辑器开关。`tools/refactor/shot-wechat.cjs` 生成覆盖层截图。


## 8. 前情提要（上下文压缩）

### 8.1 问题

长期记忆（`classicMemories`）本质是「每轮一份缩写」。它和 RP/微信两块原文历史混在一起时会出现
「弄没」和「多一份」：

- **弄没**：微信侧为省 token 只留最近一段 RP 块（`dropEarlierRpBlocks`），更早的靠【长期记忆】兜底；
  记忆没精确覆盖到的轮次，其 RP 正文就在微信上下文里彻底消失。
- **多一份**：最新那段 RP 块是完整原文，【长期记忆】又覆盖了同一批轮次，同一内容出现两遍。

用户要求**完整保真优先**，且要能自己控制压缩时机——于是引入 agent 式的「上下文压缩」。

### 8.2 机制

- **前情提要 `storyRecap`**：每个「角色×分支」存一份
  `{ text, coversThroughTurn, coversWechatCount, createdAt }`。`text` 是人类可读的第三人称
  「前情提要」，概括到压缩那一刻为止的全部 RP + 微信内容。
- **仅手动触发**：UI 加「压缩」按钮。点击后把截止点之前的 RP 轮次 + 微信时间线老段
  （连同更早的旧提要）一起交给模型，生成新提要并覆盖旧的。不自动触发。
- **保留窗口可配置**：`settings.recapKeepRpTurns`（RP 保留轮数，默认 3）与
  `settings.recapKeepWechatMsgs`（微信保留条数，默认 20）。压缩时更早的部分进提要，最近这些保留原文。
- **原文不销毁**：`chatHistory` 与 `wechat_timeline` 原样保留（UI 仍可回看、可撤销），只是不再进上下文。
  前情提要即「可丢掉旧原文」的依据——覆盖范围内的内容已由提要代表。

### 8.3 注入与去重

`storyRecap` 覆盖范围用**前缀计数**表达（压缩只压最老的内容，所以覆盖点必然是两条流的前缀）：
`coversThroughTurn`（覆盖到第几轮 RP）+ `coversWechatCount`（覆盖多少条微信消息）。

- **RP 侧**：`storyRecap.text` 作为一条独立 message（user 角色 + 明显标题）注入；被覆盖的老轮次
  从上下文剔除。这样那些轮次的**原文和它们的 per-turn 记忆摘要一起消失**（记忆挂在轮次上），
  天然不与提要重复——提要是那段旧内容的唯一代表。
- **微信侧**：`storyRecap.text` 进 system prompt；被覆盖的旧 RP 块与微信老段从历史剔除
  （取代原 `dropEarlierRpBlocks` 的「只留最后一段」粗暴做法）。
- **和记忆的关系**：记忆继续负责**未被提要覆盖**的轮次。`buildWechatMemory` 只注入
  `turnEnd > coversThroughTurn` 的记忆，避免同一段出现「提要 + 记忆」两份。

### 8.4 存储

scoped key `story_recap`，粒度跟随剧情分支（与 `wechat_timeline` 一致），注册进
`CHARACTER_SCOPED_STORAGE_NAMES`，随角色删除/存储清理一并处理。


## 9. 已知遗留

- `index.html`（2728 行，模板 + 3 段内联脚本）与 `assets/js/ui-components.js`（2956 行）尚未拆分，
  可按同样思路继续（模板拆分需要引入构建步骤或 Vue 单文件组件替代方案，需单独评估）。
- Tailwind 走 CDN 开发版（控制台会有生产警告），属项目原状。
- 首屏依赖 CDN 的 `vue`/`marked`/`DOMPurify`/`Tailwind`：网络不通时 `marked` 未定义会让启动脚本
  抛错、页面白屏（`runtime-services.js` 的 `new marked.Renderer()` 无兜底）。可考虑本地副本 + 判空。
- `character/`、`novel/` 两个子工具页各自独立（内嵌 iframe 加载），不在本次范围内。
