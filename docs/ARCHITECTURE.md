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

每条：`{ id, ts, channel: 'rp' | 'wechat', role, type, content }`。

- **RP → 时间线**：`generateResponse` 的 `finally` 调 `recordRpMessages()`，按 `rpIndex` 只追加新消息
  （角色未开微信时为空操作）。
- **进微信**（`openWechat`）：读该 scope 的时间线，把已有 RP 历史补齐；
  system prompt = 微信协议 + 角色微信人设 + **RP 近况摘要**（`buildRpDigestForWechat`，
  复用 `buildConversationTurnSnapshot` 取最近若干轮）；历史只取 `channel==='wechat'` 段。
- **回 RP**（`15-generate.js`）：上下文组装后调 `appendWechatDigestToMessages`，把
  「最后一次 RP 之后」的微信段改写成第三人称剧情片段（`buildWechatRpDigest`），
  附到最新一条 user 消息**前面**（保留用户输入原文）。

两侧永远不整段复制历史，只按需取窗口；因此不会互相膨胀。

### 7.4 微信侧生成

复用 `requestTrackedChatCompletion`（RP 当前 `settings` 的 URL/Key/模型）+ 微信 agent 的
JSON 分段协议与打字节奏：逐条 `typingDuration`（基线 + 字数×每字耗时 + 抖动，12% 走神）、
每条之间重起「对方正在输入…」、等待期状态栏跑计时器。

**不触发** RP 的世界书/正则/记忆抽取/UI 模板管线，避免互相污染。微信图片经 `compressImage`
压到长边 ≤1024 后作为 `image_url` 多模态 part 发送。

### 7.5 验证

`tools/refactor/smoke-wechat.cjs`（无头 Edge，`node tools/refactor/smoke-wechat.cjs`）覆盖：
协议解析 6 例、建角色开微聊、入口按钮显隐、覆盖层渲染、分段气泡（含表情）、
IndexedDB 持久化回读、以及**双向衔接**（黑盒拦截真实请求体，验证进微信带 RP 摘要、
回 RP 注入微信剧情段且保留原文）、角色编辑器开关。`tools/refactor/shot-wechat.cjs` 生成覆盖层截图。


## 8. 已知遗留

- `index.html`（2728 行，模板 + 3 段内联脚本）与 `assets/js/ui-components.js`（2956 行）尚未拆分，
  可按同样思路继续（模板拆分需要引入构建步骤或 Vue 单文件组件替代方案，需单独评估）。
- Tailwind 走 CDN 开发版（控制台会有生产警告），属项目原状。
- `character/`、`novel/` 两个子工具页各自独立（内嵌 iframe 加载），不在本次范围内。
