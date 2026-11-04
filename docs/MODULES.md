# App 模块地图（assets/js/app/）

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
| 27 | `27-wechat-media.js` | ~350 | 按本轮触发图片说明、相册、图片取得与显示、新图视觉输入、加载/查看工具、图片任务和可选来源适配 |
| 28 | `28-wechat-voice.js` | — | BreezeBlue 设置/目录、语音合成、单一播放器与作用域校验；批次复用 `27`，详见 [语音交接](./wechat-voice.md) |
| 29 | `29-wechat-documents.js` | — | 文本附件、scope 校验、搜索/翻页工具、隔离读者续读、预览下载与资源回收；新增附件拖入/输入框适配，详见 [文档交接](./wechat-documents.md) 与 [界面交接](./wechat-layout-and-drop.md) |

> 注：行数为约数（含镜像赋值与文件头注释）。23 号模块没有顶层声明（只有 `watch` / `onMounted` / `onBeforeUnmount` 三条副作用语句），这是正常的。
> 微信的当前协议和维护入口见 [实现交接](./wechat-and-RP.md)。`wechat-media.js` 是独立资源服务，不属于 app 模块；图片二进制不进入历史文本。

## 速查：我要改 X，去哪个文件？

- **发送/回复流程**：入口 `12` → 主管线 `15` → 后处理 `13`/`10`
- **上下文组装（角色卡/世界书/记忆如何进 prompt）**：`15`（装配）+ `08`（UI 模板注入）+ `17`（记忆召回）+ `data-services.js`（`RPHubContextUtils`）
- **聊天记录保存**：`06`（`scheduleChatHistorySave` / `saveChatHistoryNow`）
- **角色切换时发生了什么**：`21`（`selectCharacter`：停当前工作 → 保存旧角色 → 加载聊天/记忆/分支 → 应用角色作用域资源）
- **剧情分支**：状态 `05`、视图与拖拽 `09`、持久化与切换 `21`
- **记忆系统**：状态与常量 `04`、抽取 `16`、批量 `19`、展示 `24`、查找 `09`
- **主动工具**：状态 `04`、定义装配 `14`、联网/关键词/随机数 `17`、UI 时间线 `18`、与主管线的衔接 `15`
- **自动生图**：`07`
- **UI 模板（面板/变量）**：运行时 `08`、更新执行 `13`、工具函数 `data-services.js`（`RPHubUiTemplateUtils`）
- **API 请求/密钥/提供商**：`02`（选择与归一化）+ `api-utils.js`（请求实现）
- **微信子系统**：状态/时间线/生成 `25` + 协议 `wechat-protocol.js` + UI/样式 `index.html` 的 `.wx-root` / `wechat.css`；
  角色开关字段在 `20`-crud 归一化、编辑器开关在 `ui-components.js`；RP 侧衔接注入在 `15`（`appendWechatDigestToMessages`）。
- **微信单条消息编辑/删除**：`25`（`startWechatEdit` / `saveWechatEdit` / `deleteWechatMessage`）+ `26`（删除后修正提要覆盖计数）
  + `index.html` 的 `.wx-tools` / `.wx-msg-menu` + `wechat.css`。说明见 [单条消息编辑交接](./wechat-message-editing.md)。
- **微信文档阅读**：`29`（上传/工具/隔离读者）+ `wechat-documents.js`（分块/检索/资源库）+ `25`（消息与工具续写）；说明见 [长文档交接](./wechat-documents.md)。
- **移动端键盘/视口**：`01`
- **启动初始化顺序**：`23`（`onMounted`：`loadData` → 恢复上次角色 → `fetchModels` → 状态检查 → 视口监听 → 全局点击收起）

## bootstrap 全局常量（app.js 顶部，原 setup 前 29 行）

`cardUtils`、`fontFamilyOptions` 等 12 个 UI 选项、`ACTIVE_TOOL_*` 常量族、`getDefaultActiveToolDefinitions`。
它们是文件顶层 `const`，全体模块可直接裸引用。

## 新增功能的落点建议

1. 优先加入现有语义最近的模块；若跨域较大，新建 `NN-feature.js`（序号接龙），并在
   `index.html` 的加载清单和 `app.js` 的 `__sections.*(__s)` 调用清单**同位置**各加一行。
2. 新状态：`const x = ref(...)` + `__s.x = x;`；新函数同理。
3. 模板要用？在 app.js 的 `return` 里补 `x: __s.x`。
4. 会被重新赋值的 `let`：直接写 `__s.x = init;`，不要本地镜像。
