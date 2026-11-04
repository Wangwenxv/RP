# 微信长文档阅读交接

更新：2026-11-04。此次实现纯文本附件、按需检索与可续读的隔离读者。微信原有流程见 [微信与 RP 实现](./wechat-and-RP.md)，模块地图见 [MODULES](./MODULES.md)。后续相关改动继续更新本文件，并在对应交接中记录验证。

> 同日界面迭代：微信窗口支持拖入单个图片/文本文件，统一图标、间距和桌面/手机输入区；文件预览改为页码和阅读百分比。见 [界面与拖入附件交接](./wechat-layout-and-drop.md)。文档专项测试已扩展为 15 项。

## 1. 调研结论与取舍

这里的“微信”是 RP-Hub 的网页模拟聊天界面，不连接真实微信客户端。工程是 Vue 3 全局构建、经典 script、IndexedDB 存储的零构建纯前端应用。`25-wechat.js` 直接复用当前聊天 API、模型与用量统计；没有独立微信后台。

角色、RP 和微信共用角色/剧情分支作用域的时间线。微信每轮重新组装角色卡、设置、长期记忆、前情提要和历史；回 RP 及手动压缩也读取该时间线。因此，把小说文本作为普通消息保存，会同时放大微信上下文、RP 回灌、压缩输入以及 Vue 响应式数据。

图片已经采用“独立 Blob + 消息引用 + 历史短描述 + 按需查看”的结构。此次沿用这个结构，但文本可在本地检索，不需要识图服务。选择以下组合：

- 原文件与正文分块保存在资源库，消息只记录文件名、大小、分块数量、资源 ID。
- 用户问具体问题时，主模型搜索关键词、读取少量原文。这是第一选择，不必先读完整本小说。
- 用户希望整体了解长文时，隔离读者按原文顺序分批更新短笔记，返回实际覆盖范围。每次有限预算，多次调用可以续读至全文。
- 原文始终是细节的依据；短笔记有压缩损耗，不能承担逐字记忆。

没有默认上传全文给模型，没有为每个文件建立 embedding，没有导入后自动付费生成全文摘要。直接全量喂主模型会污染上下文；embedding 会增加外部依赖和隐私/成本配置；固定全文摘要可能丢失后续真正关注的细节。先提供确定性的本地检索和隔离阅读，后续需要时再补语义召回。

## 2. 使用方法

1. 打开角色的微信面板，点击输入框左侧 **📎**。同一选择器支持图片和文本文件。
2. 选择 TXT、MD/Markdown、LOG、CSV 或 TSV。等待“已整理 … 字符”结束，再点击发送。可以只发送文件，也可以文字、图片、文件混合发送；连发模式同样适用。
3. 角色可以自然确认收到了。文件卡片不会让角色自动知道内容，提示词要求不得假装已经读完。
4. 问“某个人物在哪里得到钥匙”“第二章发生了什么”等问题时，模型可搜索/阅读原文。问“先读一下整本小说”时可调用隔离读者。
5. 阅读未完成时，继续让角色读；工具会接着保存的进度整理，无须从头重复。
6. 点击文件气泡预览原文，每页最多两块；可下载原文件或移除附件。文件预览显示隔离读者已整理的分块数量，用户预览不计入角色阅读进度。

当前聊天接口需要支持 OpenAI 兼容原生 function calling。隔离读者使用当前聊天模型和当前 API 配置，没有新增 Key 或独立模型配置。导入与关键词搜索在浏览器本地完成；调用原文阅读工具后，对应片段会进入主模型请求；隔离读者整理的正文批次会发送到已配置的聊天 API。

## 3. 代码位置与加载顺序

| 文件 | 职责 |
| --- | --- |
| `assets/js/wechat-documents.js` | 扩展名/大小校验、编码检测、增量解码、正文分块、目录、关键词搜索、Blob/阅读笔记存储及回收 |
| `assets/js/app/29-wechat-documents.js` | 附件选择状态、scope 校验、四个工具、隔离读者、预览/下载/移除、角色资源清理入口 |
| `assets/js/app/25-wechat.js` | 文件进入时间线、历史引用、RP 回灌、文档工具与图片工具共用续写、中止/空回、删除/清空入口 |
| `assets/js/app/26-recap.js` | 压缩素材和最近微信原文只包含文件引用 |
| `assets/js/app/27-wechat-media.js` | `invalidateWechatMedia` 同时取消文档导入、清理待发送文件与关闭预览 |
| `assets/js/app/20-character-crud.js` | 删除角色时调用文档 owner 清理 |
| `assets/js/app/21-character-lifecycle.js` | 删除剧情分支时回收其 scope 的文档 |
| `assets/js/api-utils.js` | 新增可选 `maxTokens` → `max_tokens`，只在显式指定正整数时发送；读者上限 2400 tokens |
| `assets/js/app.js`、`index.html`、`assets/css/wechat.css` | setup/模板接线、附件气泡、预览；复用 `--wx-*` 样式变量 |
| `tools/refactor/test-wechat-documents.cjs` | Node 测试，真实模块 + 内存存储/API fixture |
| `tools/refactor/smoke-wechat-documents.cjs` | Edge + Vue + IndexedDB 实际页面验证，模型 fixture |

`wechat-documents.js` 在 `wechat-media.js` 后、协议和 data-services 前加载，存储服务在 setup 时传入，因此不依赖前序初始化的数据库。`29-wechat-documents.js` 在 bootstrap 前加载。setup 尾部为 **25 → 27 → 28 → 29 → 26**。

CWUI 检查：目标 `index.html` 明确使用 CDN Vue 3，但没有 `@canway/cwui-vue` / `@canway/cw-magic-vue` 依赖。按项目技能调用 API 解析及合规检查，服务均返回 `unsupported`（缺少组件知识包）；没有生成任何 CWUI 版本相关代码。界面延续原生 Vue 模板和微信变量体系，没有引入其他组件库或新增硬编码色值。

## 4. 消息与资源协议

文件消息示例：

```json
{
  "id": "微信消息ID",
  "channel": "wechat",
  "role": "user",
  "type": "document",
  "content": "",
  "document": {
    "id": "doc-UUID",
    "name": "小说.txt",
    "bytes": 123456,
    "chars": 60000,
    "chunkCount": 25
  }
}
```

历史、RP 回灌和压缩统一用 `wechatDocumentRecordText`：

```text
[文件 #微信消息ID｜小说.txt｜60000 字符，25 块；附件可检索，收到不代表已读]
```

所有文档数据复用 `RPHubDB` 的 KV 存储，不修改 DB version；下表为逻辑键，存储层会添加 `rp_hub_` 前缀。

| 逻辑键 | 内容 |
| --- | --- |
| `wechat_document_index` | 轻量元数据：资源 ID、ownerId、scopeId、名字、编码、大小、字符数/块数、时间 |
| `wechat_document_blob_<资源ID>` | 原始文件 Blob，`clone:false` 避开对象展开 |
| `wechat_document_chunk_<资源ID>_<块号>` | `{index, offset, heading, text}`，最多 2400 UTF-16 字符单位 |
| `wechat_document_toc_<资源ID>` | 章节/Markdown 标题与起始块号，最多 2000 条，超限有标记 |
| `wechat_document_reader_<资源ID>` | `{next, summary, batches, updatedAt}`；累计短笔记，不是角色记忆 |

没有全文字符串进响应式状态。导入每次只解码 64 KiB 文件切片，`TextDecoder` 保留字节边界，分块不拆 UTF-16 代理对；保留原始换行与正文，`offset` 是实际累计字符位置。UTF-8 优先，BOM 识别 UTF-16LE/BE，非 UTF-8 尝试 GB18030。首段检测之后遇到非法编码会明确报错，不悄悄替换成乱码；二进制控制字符拒绝导入。

原文每块独立落盘；分块/目录/Blob 完成后才发布轻量索引。正常失败、中止会回滚已写分块，不会发送假文件气泡。单文件最多 20 MiB，单角色原文件总量最多 100 MiB，文件数最多 50；实际存储占用还包括解码文本、索引和笔记，浏览器配额不足会报错。

## 5. 工具与阅读预算

所有工具使用 **微信消息 ID**，不接受资源 ID、任意路径或 URL。运行时核对：当前时间线包含该附件，且资源的 ownerId/scopeId 与当前角色、当前分支一致。即便窗口或前情提要裁掉了旧文件气泡，仍可从完整时间线找到引用。

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `tool_list_documents` | `cursor?: 非负整数` | 当前时间线附件每页 10 个，next cursor |
| `tool_search_document` | `messageId, query` | 全文关键词扫描，最多 5 处摘录、命中数量/扫描范围和原文块号 |
| `tool_read_document` | `messageId, mode?: text/outline, start?: 非负整数` | 正文每次最多两块；目录每次 15 项；带 next |
| `tool_document_reader` | `messageId` | 隔离读者短笔记、已覆盖块数、未读完提示/完成状态 |

关键词搜索是确定性的子串匹配：1–8 个关键词以空格分隔，多词按命中词数排名。保留前一块末尾 80 字符，因此可以搜索跨块词语。无命中不等于语义上不存在；应改用人物名、事件名等具体关键词。返回片段最多约 800 字符/处；详细内容用块号读回。

隔离读者每次工具调用最多六批，每批最多四块（约 9600 字符）。每批发起独立模型请求，只有读者专用 system、上次最多 1800 字符的笔记和本批原文；不携带 RP 角色卡、微信聊天史、长期记忆或工具。成功后才存新笔记与 next；截断、空响应、API 失败或中止不推进本批。下一次调用从已成功位置续读。全书覆盖的笔记仍可能遗失细节，需搜索原文核对。

主模型收到的读者结果约 2000 字符，而不是读者的全部正文或内部对话。四种文档工具合计每轮最多 4 次，资料正文合计最多 16000 字符，超出有明确截断提示。每轮结束后工具资料不写入聊天时间线，不进入 RP 回灌或前情提要；角色实际说出的消息仍照常保存。

有附件的微信回合最多 8 次主模型请求，原图片上限仍为两次查看、一次按需加载；没有附件时仍是原来的 4 次主模型请求。极端情况下 4 次读者工具会增加最多 24 次读者请求，因此主请求和读者请求的费用/等待时间需一起考虑。以上是业务调用预算；API 层原有重试可能产生额外网络尝试，用量仍记录在聊天统计中。

## 6. 生命周期与人物知识

- 上传完成后先是待发送附件，用户点击发送才成为真实时间线消息；取消、关闭面板、切角色/分支会回收待发送文件。
- “收到”“本地解析完成”“用户预览”“隔离读者整理”是不同事件。不能据系统资料推断人物当时已读、空闲或解除 RP 中的限制。
- 工具内容显式标注为附件资料。原文中的指令、HTML、代码、提示词只供分析；预览使用 Vue 文本插值，不执行原文 HTML。
- 中止使用原微信 AbortController；scope 和 media epoch 校验阻止晚到结果写入新会话，读者进度属于原文件。
- 文件气泡菜单删除与预览“移除附件”同时移除当前文件消息、原文、Blob、目录与笔记，并按原消息位置调整前情提要覆盖计数。已有提要或角色曾发出的文字不会自动重写。
- 清空当前微信记录或删除剧情分支同时回收对应 scope 的文档；删除角色回收其所有分支文档，保留其他角色。
- 刷新后已发送文件及读者笔记可恢复。没有新增完整微信备份/导出或跨设备同步；RP 聊天导出不包含这些文档资源。

## 7. 验证与已知边界

```powershell
node --test tools/refactor/test-wechat-documents.cjs
node tools/refactor/smoke-wechat-documents.cjs
node --test tools/refactor/test-wechat-silence.cjs tools/refactor/test-wechat-media.cjs tools/refactor/test-wechat-voice.cjs tools/refactor/test-wechat-voice-local.cjs
node tools/refactor/smoke-wechat.cjs
node tools/refactor/smoke-wechat-media.cjs
node tools/refactor/smoke-wechat-voice.cjs
node tools/refactor/smoke-wechat-edit.cjs
node tools/refactor/smoke-wechat-stickers.cjs
git diff --check
```

本轮 Node 文档专项 **12/12**，既有空回/图片/语音/本机语音服务 **74/74** 通过。文档浏览器专项、完整微信、图片、语音、消息编辑（46 项）、表情包（21 项）回归通过；浏览器无 JavaScript 错误。语法检查与 `git diff --check` 通过。

浏览器测试使用真实 Vue、Edge、IndexedDB 与文件输入；聊天模型响应为 fixture，没有使用真实 Key。因此验证的是附件、上下文和生命周期机制，不保证每个真实模型都正确选择工具、理解文档或遵守阅读声明。截图在 `.refactor-tmp/wechat-document-preview.png`、`.refactor-tmp/wechat-document-mobile.png`。新测试还处理了旧 Playwright 1.49 在关闭 Blob 下载临时 target 时的内部 `TargetClosedError`，仅允许 teardown 阶段该特定异常，实际页面错误仍使测试失败。

第一版不解析 PDF、DOCX、EPUB、ZIP 或扫描件，也没有 Excel 表格语义解析；CSV/TSV 作为普通文本。字符预算是 UTF-16 长度预算，不是精确 tokenizer 上限。搜索为线性扫描，大文件在旧设备上可能较慢；没有 Web Worker，解码/扫描与异步存储在页面线程执行。章节标题索引只识别常见中文章节、英文 Chapter/Part 和 Markdown 标题。

异常关闭标签页发生在导入未完成且正常回滚未执行时，可能遗留尚未发布索引的分块；后续可增加导入事务日志与启动时垃圾回收。多标签页同时写同一存储索引没有跨标签锁，这是原 KV 资源模式的限制。

## 8. 后续建议

先用真实模型试验“收到小说 → 追问具体情节 → 多轮继续读 → 切回 RP”并观察用量与人物知识边界，再决定加哪些能力：

1. PDF/DOCX/EPUB 提取器按格式独立接入，提取之后仍进入同一分块/工具协议。
2. 把导入/扫描搬到 Worker，增加导入事务日志、跨标签写锁、孤儿资源回收和完整附件备份。
3. 为已阅读批次保留分段笔记，最终按层级归纳，减少当前累计短笔记逐轮压缩的损耗；具体问题仍读原文。
4. 可选向量召回作为关键词检索补充，明确模型配置、费用、原文发送范围和失效重建规则。
5. 如要拟真人物“我晚点看”，需要显式调度/事件系统和人物阅读行动状态，不能仅靠提示词或前端假定已经阅读。本版只有用户触发回合内的阅读，没有定时后台读书或自动补回。
