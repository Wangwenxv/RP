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
- **回 RP**（`15-generate.js`）：上下文组装后调 `appendWechatDigestToMessages`，把时间线里的**每一段**
  连续微信改写成一条「微信聊天记录」块（`buildWechatRpSegment`），按时间位置插回对话——段内多条
  **拍平成一处**（刻意设计：降低请求条数；用户视角仍是分块），段与段之间靠镜像 `rpIndex`
  （= chatHistory 索引）定位，于是 RP 侧上下文还原成 `RP1→微信1→RP2→微信2` 的时间交错，
  而不是把所有微信堆到最前或最后。取全量而非「最后一次 RP 之后」：RP 侧每轮独立重建上下文，
  增量过滤会让「微信1→RP1→微信2→RP2」在 RP2 时丢掉微信1。

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
  `{ text, coversThroughTurn, coversWechatCount, keepRPTurns, keepWechatCount, createdAt }`。`text` 是人类
  可读的第三人称「前情提要」，概括到压缩那一刻为止的全部 RP + 微信内容。
- **手动全量压缩**：入口在聊天输入框旁的**快捷面板**（`#chat-quick-panel`）里的「压缩上下文」按钮。
  点击即把**当前全部** RP 轮次 + 全部微信消息（连同更早的旧提要）交给模型，生成新提要并覆盖旧的
  ——覆盖点之前的内容全部塌成一条提要，之后只追加新内容。不自动触发，覆盖计数恒等于压缩那一刻的
  全部计数（`coversThroughTurn`/`coversWechatCount`）。
- **保留窗口（缓解摘要损耗）**：摘要是压缩产物，难免漏细节，用户接下一轮时会「割裂」。所以摘要在
  注入时**下面再贴回被覆盖范围内最新的若干条原文**（见 8.3）。保留条数由用户在前情提要按钮下方调，
  `keepRPTurns`（保留几轮 RP 原文，0–10）/`keepWechatCount`（保留几条微信原文，0–30），存进 recap 对象
  （压缩那一刻的快照），改设置只对**下一次**压缩生效。注意保留的原文与 `text` 里对应内容是**有意重复**
  的——摘要负责长期背景，原文负责近期细节。
- **素材顺序走统一时间线**：素材不是「先全部 RP、再全部微信」，而是按 `wechat_timeline` 交错还原
  （RP1→微信1→RP2→微信2→RP3）。时间线里 `channel:'rp'` 的镜像带 `rpIndex`（对应 chatHistory 下标），
  `channel:'wechat'` 就是微信消息本身；正文取自 chatHistory（已清洗 CoT/UI 模板/下一句提示），
  时间线只负责排序。压缩前先 `reconcileRpTimeline()` 对齐镜像，否则编辑/重新生成后微信段会插回错误
  的时间点。若按「先 RP 后微信」拼，整段微信会被判成发生在最后一轮之后，提要就丢了微信在剧情里的
  时间位置。
- **进度与结果回显**：按钮在压缩中显示转圈 + 「正在压缩 N 轮 RP + M 条微信…」，成功后按钮下方回显
  「已覆盖 N 轮 RP · M 条微信」；无可压缩内容时按钮禁用并说明原因，避免点了没反馈。
- **原文不销毁**：`chatHistory` 与 `wechat_timeline` 原样保留（UI 仍可回看、可撤销），只是不再进上下文。
  前情提要即「可丢掉旧原文」的依据——覆盖范围内的内容已由提要代表。

### 8.3 注入与去重

`storyRecap` 覆盖范围用**前缀计数**表达（压缩只压最老的内容，所以覆盖点必然是两条流的前缀）：
`coversThroughTurn`（覆盖到第几轮 RP）+ `coversWechatCount`（覆盖多少条微信消息）。

- **RP 侧**：`storyRecap.text` 作为一条独立 message（user 角色 + 明显标题）注入；被覆盖的老轮次
  从上下文剔除。那些轮次的**per-turn 记忆摘要随之消失**（记忆挂在轮次上），不与提要重复——提要是
  那段旧内容的唯一代表。老轮次的原文不再逐条进上下文，但最近 `keepRPTurns` 轮会作为保留窗口随提要
  一起回来（见下条）。
- **保留窗口（最近的原文）**：`buildStoryRecapMessages` 产出**三条独立的 user 背景消息**——摘要、
  最近 RP 原文、最近微信原文，各自带 `_preventContextMerge`（否则相邻同 role 会被合并回一坨；早期
  把三段拼进同一条 content，模型/用户都分不清哪段是什么，看起来像「没带微信」）。RP 段取**被覆盖
  范围内最新的** `keepRPTurns` 轮（「【第 N 轮】」格式），微信段取最新的 `keepWechatCount` 条逐条成行。
  两侧的注入（`15-generate.js` RP 侧 `[...recapMessages, ...history]`、`25-wechat.js` 微信侧
  `head.unshift(...recapMessages)`）都走这同一组消息，所以保留窗口是对称的。这段与摘要正文有意重复：
  摘要是长期背景，原文是近期语气/细节，让上下文接得自然。
- **微信侧**：`storyRecap.text` 作为**对话记录的第一条**注入（夹在 system 与聊天记录之间），**不进
  system prompt**——它是对话内容的一员，不是角色设定；被覆盖的旧 RP 块与微信老段从历史剔除
  （取代原 `dropEarlierRpBlocks` 的「只留最后一段」粗暴做法）。被覆盖的最近微信由上面的保留窗口带回。
- **和记忆的关系**：记忆继续负责**未被提要覆盖**的轮次。`buildWechatMemory` 只注入
  `turnEnd > coversThroughTurn` 的记忆，避免同一段出现「提要 + 记忆」两份。

### 8.4 存储与联动

scoped key `story_recap`，粒度跟随剧情分支（与 `wechat_timeline` 一致），注册进
`CHARACTER_SCOPED_STORAGE_NAMES`，随角色删除/存储清理一并处理。保留条数设置存 **全局 key
`story_recap_keep_settings`**（不随分支切、跨分支共享，改一次对以后所有压缩生效）。`clearChat`
（清空聊天记录）会一并调用 `clearStoryRecapSilently()`——提要是 `chatHistory` 之外的独立状态，
不清就会在清空后继续作为对话首条出现（用户看到的「清空没效果」）。压缩入口（`runStoryRecap`）先
`ensureWechatTimelineLoaded()`：微信时间线只在打开微信面板时载入，记忆页直接点压缩时可能为空，
否则素材会漏掉微信对话。


## 9. 微信表情包库

> 状态：已于 2026-09-30 落地实现（表情包库 + 用户发表情包 + 微信内改头像 + 粘贴图片）。
> 本节记录设计；「实现落点」小节标出代码位置。

### 9.1 现状与问题

原微信的「表情」并非表情包：模型在 `{"type":"sticker","content":"😼"}` 里直接吐一个 **emoji 字符**
（`wechat-protocol.js` 的 `PROTOCOL` 旧文案「一个最贴切的 emoji」），前端 `index.html` 把它当文本渲染，
`.wx-bubble.sticker`（`wechat.css` §表情包）放大到 68px。问题：

- 渲染出来是**系统字体 emoji**（Windows 上是彩色豆腐块），跟真人微信里的表情包是两回事，观感差；
- 模型可选的只有几十个 emoji，表达能力受限，且同一情绪反复用同一个。

目标：把「表情」从 **emoji 字符**换成 **用户自建的表情包库 + 按名字调用**。模型全程**不需要看到图**——
它从一份「名字｜适用场景」目录里挑名字输出，前端按名字贴图。

### 9.2 调用模型（核心）

表情包的 `type` 仍是 `"sticker"`，但 `content` 从 emoji 变成**库里的名字**（如 `伤心猫`）：

```json
{"messages":[{"type":"text","content":"哼"},{"type":"sticker","content":"伤心猫"}]}
```

三件事天然成立，**解析层（`parseReply` / `normalizeMessages`）无需改动**：

- **回灌上下文**：`25-wechat.js` 的 `buildWechatRpBlock` / 微信历史还原本就把 `content` 原样拼成
  `[表情 伤心猫]` 塞回上下文——模型据此知道「自己刚发过伤心猫」，延续语境。这一段**现成**。
- **频率档位**：`stickerRuleFor` / `applyStickerPolicy` 只看 `type === 'sticker'`，与 `content` 无关，照常生效。
- **协议容错**：`parseReply` 的降级、`isPureEmoji` 判定都不受影响。

协议层只有一处**措辞**改动：`PROTOCOL` 里 sticker 的说明从「一个最贴切的 emoji」改成两态
（「若下方出现【表情包库】目录就照抄目录里的名字，否则用 emoji」），好让模型知道两种模式怎么切换。
`isPureEmoji` **保留**——表情包名字是中文（Han 不属于 `Extended_Pictographic`），不会被它误升级成
sticker；它继续负责把模型「把 emoji 当成 text 发」的情况升格成 sticker 气泡。

### 9.3 数据模型与存储

**全局库**（不按角色/分支隔离）——库是用户自己的收藏，所有角色共用。存储沿用工程既有 KV：

- 单一 key `wechat_stickers`，值为数组，经 `getStoredValue/setStoredValue`（`data-services.js`）读写；
  不新增 objectStore，也不进 `CHARACTER_SCOPED_STORAGE_NAMES`（非角色作用域）。
- 每条：`{ id, name, description, image, createdAt }`
  - `id`：稳定 uuid，用于改名/删除时定位（**不用 name 当主键**，改名就不丢）；
  - `name`：**调用名**，模型输出的就是它，需唯一（保存时去重、trim）；
  - `description`：给模型看的「适用场景」，如「委屈、想被安慰、撒娇求关注时用」；
  - `image`：压缩后的 dataURL（复用微信发图那套 `compressImage`，长边 ≤1024，控制体积）。

### 9.4 目录注入（提示词）

`buildWechatSystemPrompt`（`25-wechat.js`）在协议段之前注入一份**可用表情目录**：

```
【表情包库】
你可以发送下列表情包，sticker 的 content 只能从下面这些名字里选（原样照抄，不要改动）：
- 伤心猫｜委屈、想被安慰、撒娇求关注时用
- 无语狗｜对对方发言感到无语、想翻白眼时用
```

- **库非空** → 注入目录，并把 `PROTOCOL` 里 sticker 的说明从「一个 emoji」改为「库里的名字」。
- **库为空** → **不注入目录，回退现状**（emoji 模式），即零配置时的默认行为不变。
- 目录**只带 name + description**；回灌历史只带 name，轻量。
- 体积控制：描述 ≤ 15 字；库超过上限（50 条）时只注入前 N 条并 `console.warn` 提示被截断，避免吃 token。

### 9.5 前端渲染与匹配回退

`index.html` 气泡模板改为按名字查库：

- `content` **精确命中**库中 `name`（trim 后比较）→ 渲染 `<img :src="item.stickerImage">`（`stickerImage` 由
  `wechatDisplayItems` 经 `stickerImageOf(content)` 填好），走 `.wx-bubble.sticker` 的无气泡大图样式；
- **未命中** → **回退当文本渲染**。旧记录里存的是 emoji、或库被删条目后遗留的名字，都走这条，**无需数据迁移**，也不会白屏。

### 9.6 双方都能发（用户侧）

表情包不是模型专属——用户也能从输入框的 😀 按钮打开表情面板，点一个即发出：

- `sendWechatSticker(sticker)` 往时间线写一条 `{role:'user', type:'sticker', content:name}`，
  与模型发的那条**走同一个渲染路径**，然后触发一轮生成（用户是发起方）。
- 因此回灌上下文时这段同样拼成 `[表情 伤心猫]`——模型能看见「对方发了个伤心猫」。
- 用户发的表情不走 `applyStickerPolicy`（那是约束模型的），发什么是什么。

管理 UI：微信设置面板加「表情包库」入口，模态内做增删改——上传图（复用 `compressImage`）→ 起名 → 填描述 → 保存。
最小版**纯手动录入**；后续可选接模型 vision 能力**自动打标签**（`25-wechat.js` 微信发图即用 `image_url` 那条路）。

### 9.7 微信内改头像 + 粘贴图片

让微信看起来更像真的：

- **改头像**：微信里双方头像可点，弹出文件选择器。自己 → 写 `__s.user.avatar`（走 `saveData`）；对方 →
  写 `char.avatar`（走 `saveCharactersNow`）。压缩复用 `compressImage(…, 200, 0.7)`。注意 `25-wechat.js`
  在 `app.js` 之前求值，`__s.user` 那时还没赋值，所以用户头像必须用 **惰性 `computed(() => __s.user?.avatar)`**，
  不能直接读。
- **粘贴图片**：输入框 `@paste` 取 `clipboardData` 里的图片文件，走和 📎 同一条压缩链路进待发送区；纯文字粘贴不拦截。

### 9.8 开源表情包商店（免手动一张张传）

一张张上传太慢，直接对接开源表情包合集 [getActivity/EmojiPackage](https://github.com/getActivity/EmojiPackage)
（Apache-2.0，3022 star）：55 个主题分类、2092 张图。商店面板按分类浏览 CDN 缩略图，可多选或「导入本类全部」。

- **静态清单**：`assets/js/emoji-catalog.js`（`window.RPHubEmojiCatalog`）内置「分类 + 文件名」，共 ~35 KB。
  只存文件名、不含图——图走 CDN 按路径取。清单由仓库 tree 生成；重生成方法见 §9.10。
- **取图**：`base` = `https://cdn.jsdelivr.net/gh/getActivity/EmojiPackage@master`（jsDelivr 对超 50 MB 仓库只
  禁了**列表 API**，按路径取图正常）；CDN 都带 `Access-Control-Allow-Origin: *`。
- **导入策略**（静态存本地、动图存引用）：
  - 静态图（jpg/png/webp）→ `remoteImageToDataURL(url)` 走 `crossOrigin='anonymous'` 取图 → canvas 压缩
    （1024 / 0.82）→ 存本地 dataURL，离线可用。**必须 crossOrigin**，否则 canvas 被污染、`toDataURL` 抛
    SecurityError；压缩失败退回备用 CDN（raw.githubusercontent）的 URL 引用。
  - 动图 GIF → 直接存 CDN URL（保留动画、不占 IndexedDB）。需联网，且不随库图一起被本地化。
- **名字与描述**：9 成文件名本身就是描述（`难过/委屈地哭了起来.jpg`、`滑稽/不向恶势力低头.jpeg`），
  据此生成——库内 name = `分类-文件名`（分类前缀保证唯一），description = 文件名（限 15 字）；`QQ图片xxx`
  这类无意义名退回分类名。词表/名字在导入时定死，沿用 §9.8 边界里「不改写历史」的口径。
- **判重**：按库内 name 判重，商店里已导入的标「已加入」并置灰；重复导入自动跳过。
- **许可**：Apache-2.0，商店头部注明来源；如需完全自包含可改为整体复制进仓库（代价是体积）。

### 9.9 边界与取舍

- **改名/删条**：旧聊天记录存的是旧 name，改名后旧气泡回退为文本——**不改写历史**（与 §7「原文不销毁」一致）。
- **重名**：保存时拒绝或提示，保证 name → 单张图。商店导入靠 `分类-文件名` 前缀天然去重。
- **删空库**：回到 9.4 的「库为空 → emoji 模式」。
- **token**：目录每轮进 system prompt，靠 9.4 的条数上限 + 描述字数上限兜底。
- **初始化顺序**：表情包库随 `loadData` 一次性读入（`06-persistence.js`），否则首轮 `saveData`
  会用空数组把已存的库覆盖掉；`saveData` 里也一并写入 `wechat_stickers`。
- **GIF 联网依赖**：GIF 走 CDN，离线时裂图；静态图已本地化不受影响。

### 9.10 实现落点

| 关注点 | 位置 |
| --- | --- |
| 协议措辞两态 | `wechat-protocol.js` `PROTOCOL` |
| 目录注入槽位 | `wechat-protocol.js` `buildSystemPrompt({stickerCatalog})` |
| 状态 / 目录 / 匹配 / CRUD / 发送 / 粘贴 / 头像 / 商店导入 | `assets/js/app/25-wechat.js` |
| 开源表情清单（生成物） | `assets/js/emoji-catalog.js` |
| 持久化（读写 + saveData + loadData） | `assets/js/app/06-persistence.js` |
| 模板暴露 | `assets/js/app.js` 的 setup 返回对象 |
| 气泡贴图 / 头像可点 / 表情面板 / 管理模态 / 商店模态 | `index.html` |
| 贴图 `.wx-sticker-img`、居中模态、管理列表、商店网格 | `assets/css/wechat.css` |
| 短验证 | `tools/refactor/smoke-wechat-stickers.cjs` |

**重生成表情清单**：抓 `https://api.github.com/repos/getActivity/EmojiPackage/git/trees/master?recursive=1`，
取一级目录下的图片 blob（`分类/文件名`，排除嵌套与 `.zip/.rar`），按 `name` 排序后写成
`window.RPHubEmojiCatalog` 的字面量即可（去掉 `size` 字段可把清单压到 ~35 KB）。

## 10. 已知遗留

- `index.html`（2728 行，模板 + 3 段内联脚本）与 `assets/js/ui-components.js`（2956 行）尚未拆分，
  可按同样思路继续（模板拆分需要引入构建步骤或 Vue 单文件组件替代方案，需单独评估）。
- Tailwind 走 CDN 开发版（控制台会有生产警告），属项目原状。
- 首屏依赖 CDN 的 `vue`/`marked`/`DOMPurify`/`Tailwind`：网络不通时 `marked` 未定义会让启动脚本
  抛错、页面白屏（`runtime-services.js` 的 `new marked.Renderer()` 无兜底）。可考虑本地副本 + 判空。
- `character/`、`novel/` 两个子工具页各自独立（内嵌 iframe 加载），不在本次范围内。
