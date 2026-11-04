# 微信附件找回与工具等待提示交接

更新：2026-11-04。此次核对附件重新查找的范围，并实现微信回合的实时系统处理状态。文档存储与隔离读者见 [长文档阅读](./wechat-documents.md)，图片机制见 [微信与 RP](./wechat-and-RP.md)。

## 1. 附件到底能否重新找回

需要区分“在微信面板继续聊天”和“回到 RP 剧情页面生成正文”。两者共享角色/分支时间线，但工具调用入口不同。

| 使用位置 | 文档原文 | 历史图片 |
| --- | --- | --- |
| 微信回合 | 已支持 `tool_list_documents` → `tool_search_document` / `tool_read_document`；整本整理用 `tool_document_reader` 续读 | 已支持 `tool_view_image({messageId, question})` 重新读取真实像素 |
| RP 正文回合 | 当前只有文件引用；尚未接入文档资源工具 | 当前只有短画面描述；尚未接入历史图片查看工具 |

微信文档目录与读取入口都查完整 `wechatTimeline`，没有只查最近 30 条模型消息、最近 80 条显示消息或最近八个附件。聊天上下文裁剪或前情提要压缩不会删除原文件；即使当前 prompt 不再列出旧文件，也可以先翻页列文件再查原文。本轮新增回归覆盖旧文件离开最近附件清单与聊天窗口后仍可检索的情况。

图片像素也独立保存在资源库，查看工具按微信消息 ID 从当前完整时间线定位，资源未删除即可读回。配置 `settings.visionModel` 时用独立识图请求返回客观细节；未配置时把图片视觉附件交给当前聊天模型。当前没有 `tool_list_images`，因此旧图 ID 被提要省略后，模型缺少完整图片目录入口；不能把“字节还在”理解为“模型必定能找出任何旧图”。

RP 的现有关键词工具 `tool_grep` 通过 `17-retrieval-web-tools.js` 的 `searchDialogueByKeywordForTool` 查询 RP `chatHistory` 文本。`14-tools-runtime.js` 从主动工具配置组装 schema，`15-generate.js`/`18-tools-ui.js` 执行对应链路，没有把微信四个文档工具和 `tool_view_image` 接进去。文件原文和图片字节本来就不在聊天文本内，因此 RP 关键词查找无法还原附件全文/像素。这次明确该边界，没有宣称完成 RP 跨渠道附件检索。

找回仅限同一角色、同一剧情分支的真实附件消息，删除文件、删除消息引用、清空记录或清理浏览器数据可能使附件不可读；资源仍在也不允许跨角色/分支读取。附件目前保存在本浏览器 IndexedDB，没有完整跨设备附件同步/备份。

## 2. 新增前端表现

微信输入区上方新增独立系统状态卡片，从开始生成显示到准备好实际消息；此后交给原有角色输入/气泡播放逻辑。

- 准备请求、等待模型、查找历史文件、搜索文档、读取原文、准备长文阅读、查看历史图片、加载图片素材、整理回复和准备发送内容分别显示对应阶段。
- 长文读者显示文件名、当前批次、正在处理的段范围，以及已整理段数、总段数和百分比。这里只把成功保存的阅读笔记计入进度，当前正在请求的批次不提前算成功。
- 实时显示本轮已用秒数、模型请求次数、工具调用次数。停止按钮沿用原发送区入口，处理中可随时中止。
- 工具失败时保留简短失败提示，主模型仍可根据明确失败结果回复；中止不会作出“已读完”的声明。
- 成功、主动空回、失败、停止、关闭面板、切角色/分支均清理状态。刷新只恢复文件与已保存笔记，不恢复未完成的网络请求；下次读者调用从保存位置续读。

这些提示是后台处理状态，独立于 `wechatTyping`/`wechatStatusText`；不会写入时间线、前情提要、长期记忆或 RP 回灌。模型计算和系统读者整理不自动变成人物当时有空、已经看过或愿意回复的剧情事实。

## 3. 代码入口与计数口径

| 文件 | 改动 |
| --- | --- |
| `assets/js/app/25-wechat.js` | `wechatActivity`、计时器与本轮报告函数；主模型请求、每个工具和准备发送阶段；生命周期清理 |
| `assets/js/app/29-wechat-documents.js` | `executeWechatDocumentTool(call, signal, budget, report?)`；读者请求开始和笔记成功保存后的进度事件 |
| `assets/js/app/27-wechat-media.js` | `executeWechatImageTool(call, signal, report?)`；独立识图请求计数 |
| `assets/js/app.js` | 向模板导出 `wechatActivity` |
| `index.html`、`assets/css/wechat.css` | 输入区状态卡、原生进度条、无障碍阶段提示与既有微信颜色变量 |
| `tools/refactor/test-wechat-documents.cjs` | 失败进度/计数、旧报告与晚到请求隔离、旧附件找回 |
| `tools/refactor/smoke-wechat-documents.cjs` | 延迟两批读者响应和最终主回复，验证真实页面状态、时间、桌面/手机布局与停止清理 |

状态包括 `title/detail`、`seconds`、`modelRequests/toolCalls`、`completed/total` 和可选失败 `notice`。报告函数闭包校验当前报告身份、AbortSignal、scope 和 media epoch。旧请求的 finally 只有在仍持有当前 AbortController 时才清理状态，避免停止后马上发起的新请求被旧请求收尾覆盖。读者/图片工具新增的报告参数可省略，原调用方式保持有效。

模型计数是本轮发起的**主聊天 + 隔离读者 + 独立识图**逻辑请求次数，包含已发起但失败/中止的调用；没有单独统计 API 内部自动重试，也不包括语音合成/图片生成供应商请求。工具计数是在校验通过后实际进入执行的工具次数。不增加模型调用，也没有估算剩余秒数。整本阅读仍受原每次最多六批、每批四块的预算约束，短文件显示实际所需批次数。

在一个正常“主模型调用读者 → 六批读者 → 主模型回复”回合，卡片最终显示八次模型请求、一次工具调用。阅读百分比根据已保存原文段数计算，表示覆盖范围；累计摘要仍有压缩损耗，细节需搜索原文。

状态区使用现有 `--wx-*` 变量，没有新组件库或新增硬编码色值。按项目 CWUI 技能，对目标 `index.html` 调用组件 API、示例、Token 与合规检查，均得到 `resolution.status: unsupported`（服务无法可靠解析目标的组件库证据）。工程实际使用 CDN Vue 3 全局构建，无 CWUI 依赖；本次没有生成版本相关 CWUI 代码，沿用已有 Vue 模板/CSS。

## 4. 验证

```powershell
node --test tools/refactor/test-wechat-documents.cjs
node --test tools/refactor/test-wechat-silence.cjs tools/refactor/test-wechat-media.cjs tools/refactor/test-wechat-voice.cjs tools/refactor/test-wechat-voice-local.cjs
node tools/refactor/smoke-wechat-documents.cjs
node tools/refactor/smoke-wechat-media.cjs
git diff --check
```

本次改动当时 Node 文档专项 **18/18**（随同日检索升级扩到 **25/25**），原空回/图片/语音/本机语音回归 **74/74**，合计 **92 项**通过。文档浏览器专项通过，包含真实 Vue、Edge、IndexedDB、原生文件输入与延迟模型 fixture；等待阶段无假输入气泡、计时更新、每批成功进度、八次请求后的最终等待、停止/切角色隔离和状态不落库均通过。

图片浏览器回归也通过，包括真实历史像素查看、独立资源持久化、工具续写、失败重试、可选来源适配、过期请求隔离与 file:// 内置图片读取。两套浏览器测试均为零 JavaScript 错误；修改的 JS 语法检查与 `git diff --check` 通过。

桌面 1280×900、手机 430×900 截图已视觉核对，状态卡和停止按钮可见，无横向溢出。截图：`.refactor-tmp/wechat-document-reading-desktop.png`、`.refactor-tmp/wechat-document-reading-mobile.png`。测试没有调用真实模型 Key，证明状态链路与资源机制，真实模型的工具选择与阅读质量仍需实际使用确认。

## 5. 下一步建议

若需要在 RP 正文中继续讨论微信小说或截图，下一步应将附件目录/搜索/读取接入 RP 的 schema、工具分发、续写和工具 UI，复用现有 scope 守卫与每轮预算；同时补图片目录工具。应按需返回原文片段或像素，不把全文/图片字节常驻 RP 历史或前情提要。检索本身已经是独立纯函数（`window.RPHubWeChatSearch.scan({chunkCount, getText, query})`），RP 的 `tool_grep` 若要支持正则/短语/邻近，可直接复用而不是重写。本文描述当前限制和扩展入口，不把建议当作已经实现的能力。
