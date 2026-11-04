# 微信附件 grep 式检索交接

更新：2026-11-04。把原先"空格分词 + 字面子串"的关键词搜索，升级成一套可被模型当作工具使用的检索链路：列出附件 → grep 定位 → 按块或字符位置读原文。存储与隔离读者见 [长文档阅读](./wechat-documents.md)，工具等待状态见 [附件找回与工具等待提示](./wechat-tool-activity.md)。

## 1. 为什么要改

旧实现（`wechat-documents.js` 原 `search`）只有 6 个能力缺口，导致模型"能搜但搜不准"：

| 旧行为 | 后果 |
| --- | --- |
| 只切空格，纯 `indexOf` | `钥匙，地下室` 被当成一个词，永远 0 命中 |
| 命中词数就是得分，没有词权重 | 搜 `主角 钥匙 的 了` 和搜 `钥匙` 同分，噪声淹没有效段 |
| 每块只出一处摘录，取最左命中 ±200/+600 | 一块里命中 5 次只显示 1 次，关键句在块尾会被窗口切掉 |
| 同分按块号升序截断到 5 条 | 靠后章节被前面同分块永久挤掉 |
| 没有正则/短语/必含/排除/邻近 | 模型想表达"必须有 A 不能有 B""A 附近 B"时无从下手 |
| 每次都从块 0 全量扫，无上限保护 | 大文件慢且没有任何可解释的截断说明 |

## 2. 语法（模型可见）

`query` 是不超过 300 字符的表达式，空格分隔；中文标点 `，、；｜` 也当分隔符。

| 写法 | 含义 |
| --- | --- |
| `钥匙 仓库` | 任一命中（默认），按词权重、词频、邻近、标题综合排序 |
| `+钥匙 +仓库` | 必含：优先返回同时含全部必含词的窗口；全文分散时退回按命中排序并提示 |
| `钥匙 -梦` | 排除：窗口内出现被排除词就丢弃该窗口 |
| `"青铜钥匙"` | 短语：必须整句出现（同时算必含词） |
| `钥匙 ~30 仓库` | 邻近：两词相距 ≤30 字符加显著分，通常最先返回 |
| `/他.{0,4}(摸到\|握着).{0,8}钥匙/` | 正则：JavaScript 正则，支持 `i m s u`；`g` 自动加，`y` 忽略 |
| `case:on` / `case:off` | 字面词大小写敏感开关（正则自带 `i` 标记优先） |

错误信息都指名道姓：`"~" 后面要写距离数字`、`引号没有闭合`、`正则表达式缺少结束的 /`、`一次最多 8 个搜索词`。

## 3. 实现结构

新增 `assets/js/wechat-document-search.js`，纯函数、不碰存储和 Vue，导出 `window.RPHubWeChatSearch = { LIMITS, parseQuery, scan }`：

1. **parseQuery**：手写扫描器，产出 `{ terms[], links[], caseSensitive }`；`terms` 带 `required/phrase/excluded/regex`，`links` 是 `~N` 产生的邻近对。
2. **scan**：按块读取（`getText(index)` 由资源库注入），保留前一块末尾 80 字符处理后拼接，所以短语、正则、邻近都能跨块命中；命中记成紧凑的 `{ti, abs, len}` 绝对位置列表，同一位置因重叠窗口重复命中会去重。
3. **聚类**：按绝对位置排序后，间距 ≤220 字符且跨度 ≤900 字符的命中合并成一个窗口，天然形成"一段话里的多处证据"，而不是按块硬切。
4. **打分**：`idf ≈ ln(1 + 已扫描块数/命中块数)`（下限 0.35）× `(1 + 0.35·log2(1+词频))`，短语/必含 +0.4，同窗多词 +0.3×(词数−1)，邻近对 +1.4，必含词齐全 +1.2。`idf` 必须扫描结束才算得出来，所以先收集出现位置、最后统一打分，不重复读盘。
5. **摘录**：窗口起点前 160、终点后 240，总长 ≤900；起点/终点都落到块边界内的真实字符偏移，`excerpt === 原文.slice(offset, end)` 是硬约束（有测试守住）。
6. **回填原文**：只对排名前 `min(24, limit×4)` 的候选读块拼摘录，再按排除词过滤、截断到 `limit` 条。

`wechat-documents.js` 只留一层薄封装：`library.search(item, query, {start, end, limit, signal})` 注入 `getText`，另加 `library.locate(item, charOffset, signal)` 用 `floor(char / CHUNK_CHARS)` 猜块再前后各试 3 次，把搜索返回的字符位置落回块号。

## 4. 工具层（`29-wechat-documents.js`）

| 工具 | 变化 |
| --- | --- |
| `tool_list_documents` | 每行补 `已整理 a/b 块`、`目录 n 条`，模型能判断哪个文件值得先读 |
| `tool_search_document` | 新增 `limit(1–8)`、`startChunk`/`endChunk`；`messageId` 变为可选，省略或填 `*` 时一次搜索**最近 10 个附件**，命中行带 `#消息ID｜文件名` 才能接着 `read` |
| `tool_read_document` | 新增 `startChar`，按搜索结果的「字符 X–Y」直接定位到块；返回 `已按字符 N 定位到块 M` |
| `tool_document_reader` | 未改（隔离读者仍是最多六批、每批四块） |

返回体固定包含：扫描范围与块数、各词出现次数/段数、`未出现：` 名单、命中段数与返回条数、每段 `[块 N｜字符 X–Y｜标题｜命中 词×次数]`。没命中时给可执行建议（换更短的词、去掉排除词、改用正则），而不是一句"未命中"。

提示词 `buildWechatDocumentPrompt` 同步写明调用顺序（list → search → read）和语法，否则模型不会用这些符号。

## 5. 预算与上限

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `LIMITS.query` | 300 字符 | 表达式长度 |
| `LIMITS.terms` | 8 | 单次词数（含排除词） |
| `LIMITS.pattern` | 160 字符 | 单条正则长度 |
| `LIMITS.perChunk` | 40 | 每块每词最多记 40 次出现，防病态正则 |
| `LIMITS.occurrences` | 20000 | 单次扫描出现位置总量，超限停止并标记 `truncated` |
| `LIMITS.excerpt` | 900 字符 | 单条摘录上限 |
| `LIMITS.budget` | 4000 ms | 单次扫描时间预算，超时返回已扫部分并标记 |

工具层仍是每轮最多 4 次文档工具、资料合计 16000 字符；超预算会截断并提示下一轮继续。整个 grep 不新增模型调用，也不产生额外费用。

## 6. 验证

```powershell
node --test tools/refactor/test-wechat-documents.cjs
node tools/refactor/smoke-wechat-documents.cjs
node --test tools/refactor/test-wechat-silence.cjs tools/refactor/test-wechat-media.cjs tools/refactor/test-wechat-voice.cjs tools/refactor/test-wechat-voice-local.cjs
```

Node 文档专项由 18 项增至 **25 项**，新增 7 项覆盖：短语/必含/排除/邻近、正则与四类语法报错、摘录等于原文切片（含跨块与跨块短语）、省略 `messageId` 的多附件搜索与 `#消息ID` 回传、`startChunk/endChunk` 限范围、`startChar` 定位读回、中文标点与 `case:on`、以及词数/长度/limit/范围/空附件等参数守卫。原空回/图片/语音/本机语音 **74/74** 仍通过。

浏览器专项由 22 项增至 **25 项**，新增三项真实链路验证：`+翡翠钥匙 -离别` 工具结果含表达式与命中统计、`startChar` 按搜索字符位置读回原文、上传第二个文件后省略 `messageId` 一次命中两个附件并回传文件消息 ID。零 JavaScript 错误。换行、`git diff --check` 与 `node --check` 均通过。

## 7. 已知边界

- **线性扫描，没有倒排索引**。1.1M 字符（459 块）随机中文语料实测单次 8–12 ms（内存读块，不含 IndexedDB 往返）；高度重复语料（每块二十余次命中）为 60–110 ms。20 MiB 上限下会先撞 4000 ms 预算，此时返回已扫部分并标注 `已扫描 N 块`，模型可缩小 `startChunk/endChunk` 分段继续。
- **出现过多时偏向文档前段**。撞到 20000 次上限会停止扫描，命中统计与摘录只覆盖前半部分；建议用更具体的词或限定范围。
- **排除词只在摘录窗口内判断**，不是"整篇含 B 就丢弃"。`-词` 语义是"这段不要提到它"。
- **大小写与全角不做归一化**。`toLowerCase()` 会改变长度的极少数脚本（如土耳其语 `İ`）退化为不折叠匹配；全角 `Ａ` 与半角 `A` 不互相命中。
- **正则没有 AST 级 ReDoS 检测**，只有单块 40 次上限 + 4 秒总预算 + `try/catch` 编译校验。语料是本机单用户纯文本，逃逸面有限；如果以后支持更大文件，应移到 Worker。
- **跨块只有 80 字符重叠**：正好跨越块边界且长度超过 80 的分隔命中可能漏掉；`startChar` 读回可以人工确认。
- **多附件搜索只覆盖最近 10 个**，更早的需要先 `tool_list_documents` 拿 `#消息ID`。
- RP 正文回合仍未接入这些工具（只有文件引用），边界与建议见 [附件找回](./wechat-tool-activity.md) §5。

## 8. 后续建议

1. 把 `wechat-document-search.js` 复用给 RP 的 `tool_grep`：接口已经是 `scan({chunkCount, getText, query})`，改动集中在 `17-retrieval-web-tools.js` 的取文本方式。
2. 导入时为 >200 KB 的文件生成块级倒排（词 → 块号），查询从 O(全文) 降到 O(命中)；需要先量化索引体积与 IndexedDB 写入耗时。
3. 扫描搬进 Web Worker，主线程只处理渲染；顺带把 4000 ms 预算提高到接近无感。
4. 为读者笔记保留分段摘要（现为逐批覆盖），再让搜索按"笔记定位章节 → 原文核对"两段式工作，进一步降低 token。
