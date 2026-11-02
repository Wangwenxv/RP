# 微信 ↔ RP 设计稿

## 1. 上下文压缩的素材顺序

状态 对话记忆
RP1 开场白
wechat1 RP1
RP2 RP1->wechat1
wechat2 RP1->wechat1->RP2
RP3 RP1->wechat1->RP2->wechat2
压缩1 RP1->wechat1->RP2->wechat2->RP3
RP4 压缩1
wechat4 压缩1->RP4
RP5 压缩1->RP4->wechat4
压缩2 压缩1->RP4->wechat4->RP5
wechat5 压缩2


（实现对应 docs/ARCHITECTURE.md §8：压缩素材必须按上面的**时间顺序**交错送入模型，
即 RP1→wechat1→RP2→wechat2→RP3，顺序取自统一时间线 wechat_timeline；
不能「先全部 RP、再全部微信」，否则微信段会被判成发生在最后一轮之后。）


## 2. 压缩后的注入：摘要 + 保留的最近原文

压缩是「全量」的——`coversThroughTurn`/`coversWechatCount` 覆盖到压缩那一刻的全部内容。
但摘要难免损耗细节，直接接下一轮会有割裂感。所以提要在注入时，**下面再贴上被覆盖范围内
最新的若干条原文**（保留条数在快捷面板前情提要按钮下方调）：

- `keepRPTurns`：保留最近几轮 RP 原文（0–10，默认 3）
- `keepWechatCount`：保留最近几条微信原文（0–30，默认 6）

**三段各自成一条独立的 user 消息**（`buildStoryRecapMessages`），不要拼进同一条 content——
揉在一起会糊成一坨，模型分不清哪段是摘要、哪段是 RP、哪段是微信，用户还会以为「没带微信」。
每条都带 `_preventContextMerge`，免得被相邻同 role 消息又合并回去。注入的三条长这样：

```jsonc
{ "role": "user", "_preventContextMerge": true, "content":
  "【前情提要｜此前剧情的压缩摘要，作为你已知的背景】\n傍晚，lin 在大学马原课上犯困……" }

{ "role": "user", "_preventContextMerge": true, "content":
  "【最近 RP 原文｜以上摘要已覆盖到这段，这里是最近的原文，接下文时保持连贯】\n【第 5 轮】……\n【第 6 轮】……" }

{ "role": "user", "_preventContextMerge": true, "content":
  "【最近微信原文｜摘要覆盖到的最近微信对话原文，作为背景】\nlin：今晚马原要补课……\n林晚：行，知道啦" }
```

要点：

- 覆盖计数**不变**——提要和它的保留窗口都算「已覆盖」，之后只追加新内容；被覆盖的老轮次原文
  仍不进上下文，最近 K 条由这三条消息带回来。RP 侧与微信侧注入的是**同一组消息**，保留窗口对称。
- RP 段按 `wechat_timeline` 取被覆盖范围内最新的 `keepRPTurns` 轮；微信段取最新的 `keepWechatCount`
  条逐条成行。摘要仍覆盖全部内容，保留的原文与摘要**有意重复**：摘要负责长期背景，原文负责近期语气/细节。
- 改保留条数只对**下一次**压缩生效（条数是压缩那一刻的快照，存在 recap 对象里）。

## 3. RP 主动发起微信

需求：不总是由用户点开微信。角色在 roleplay 里觉得「该私下找你」时，应当能**主动**把微信递过来。

### 3.1 触发方式

复用既有的**主动工具**机制：新增内置工具 `tool_wechat`（类型 `wechat_message`，默认关闭）。
模型在 RP 回合里通过 API 的原生 function call 调用它，参数：

```json
{ "content": "睡了吗", "reason": "想单独说句话" }
```

- `content`：角色要发的那条微信，写成真人微信口吻的短消息，一次一条；想连发就多次调用。
- 该工具**只在当前角色 `wechatEnabled` 时**才进模型工具表（`getEnabledActiveTools()`），
  没开微信的角色不会被「强制」策略逼着调用一个没有落点的工具。

**两道开关必须同时成立**（工具开关 + 角色微信开关）。任一边没开，该工具都会被静默过滤，
用户只会看到「开了没反应」，所以聊天页会给一条可见提示（`wechatActiveToolNotice`）：
工具开但角色未开微信 → 「去开启」拉角色编辑器；角色开了微信但工具没开 → 「去打开」跳工具页。
两边一致时不提示，可手动关闭。另外 `<active_tools>` 的说明按本轮实际启用的工具类型裁剪，
只开微信工具时不会混入检索专用规则。

用主动工具而非正文里的特殊标记，好处是天然复用开关、提示词注入、工具 UI 时间线和多轮续写循环，
也不污染正文渲染。

### 3.2 时序（为什么面板要延迟弹）

一次带工具调用的 RP 回合实际是两段生成：

```
用户输入 → [depth 0] 模型调用 tool_wechat（正文还没出）
         → 工具执行：把消息攒进 __s.pendingActiveWechatMessages
         → [depth 1] 模型接着写完 RP 正文
         → 整轮结束（depth 0 收尾）→ flush：弹微信面板 + 按打字节奏发出
```

所以工具执行阶段**只攒不发**，面板一律等整轮 RP（含工具续写）结束、且非中止/非失败时才弹——
否则正文会被面板打断。中止或生成失败则丢弃队列，不弹面板。

`flushActiveWechatMessages()` 复用 `openWechat()`（载入 / 补齐 RP 镜像 / 对账时间线）后再播放，
保证 RP 与微信两条流对齐、消息落点不错。

### 3.3 主要挂点

| 关注点 | 位置 |
| --- | --- |
| 工具定义 | `assets/js/built-in-content.js`（`activeTools.types.wechat` + `defaults`） |
| 常量 | `assets/js/app.js`（`ACTIVE_TOOL_WECHAT_TYPE`） |
| 归一化 | `assets/js/app/04-state-memory-tools.js`（`normalizeActiveTool`） |
| 暴露条件与 schema | `assets/js/app/14-tools-runtime.js` |
| 参数解析 | `assets/js/app/17-retrieval-web-tools.js`（`parseNativeActiveToolCall`） |
| 执行与工具 UI | `assets/js/app/18-tools-ui.js` |
| 攒队列 / 播放 / 弹出 | `assets/js/app/25-wechat.js` |
| 清空与收尾触发 | `assets/js/app/15-generate.js`（depth 0 起止） |

## 4. 微信角色自主收尾与空回（2026-11-02 交接）

### 4.1 现有原理与问题

本项目是零构建的纯前端应用。微信不是独立的后端 agent，也不是实际微信客户端：
`assets/js/app/25-wechat.js` 复用当前 RP 的 API 地址、Key 和模型，通过
`requestTrackedChatCompletion` → `assets/js/api-utils.js` 请求模型。
微信 system prompt 组装完整角色卡（或微信人设覆盖）、对方信息、关系、场景、
用户勾选的微信版预设/世界书、RP 长期记忆、表情包策略与表情包名字目录。
历史由角色/剧情分支作用域的 `wechat_timeline` 按时间顺序还原，连续 RP 转成剧情背景块，
相邻同 role 的微信气泡合并；有前情提要时按覆盖边界剔除旧内容并注入摘要/保留原文。
模型返回文字 JSON 后，`wechat-protocol.js` 解析成消息数组，按表情档位裁剪，再逐条模拟打字、
追加气泡并保存到 IndexedDB。回到 RP 时，微信原文按时间位置转成背景消息注入 RP。

此前无法自然结束话题有三个原因：

1. `PROTOCOL` 强制「不是只发表情，就至少发 2 条」，简单回答也容易被迫补话。
2. `parseReply` 只在解析出非空消息数组时接受 JSON；`{"messages":[]}` 会被当成解析失败，
   降级成一条包含 JSON 的文字气泡。
3. 请求层将零条消息一律视为错误；未回应计数只靠 assistant 消息清零，无法表达「模型已处理、选择沉默」。

### 4.2 协议：一轮模型请求中先判断，再输出

沿用现有 JSON 信封，无须新增 function tool、额外判断请求或角色设置开关。
角色现在可以输出 0–6 条消息：

```jsonc
// 主动不回复：用户发言保留，角色没有气泡
{"messages":[]}

// 简单问题可以只回答一条，不再为了凑条数加话
{"messages":[{"type":"text","content":"2"}]}

// 角色确实想表达情绪时，也可以只用一句话或一个表情收尾
{"messages":[{"type":"sticker","content":"挥手猫"}]}
```

`REPLY_DECISION_RULE` 由 `buildSystemPrompt` 放在人设、关系、场景、自选规则之后，
长期记忆之前。每轮先结合完整局势、性格、关系和情绪判断是否真有话想说，判断过程不输出。
它优先于分段、表情频率、要求一直继续聊天的旧规则。

- 已解答/已交代的事情，对方仅确认收到，且没有新问题、请求、待确认约定或需要接住的情绪时，允许自然停下。
- 不硬编码「好的」「嗯」「谢谢」「晚安」等关键词，也不按概率强行抽掉回复。
  同一句「好的」，内敛角色可能不回，亲近或热情角色可能有一句话/一个表情的收尾。
- 仍有问题、明确请求、关键确认或情绪需要回应时，应按人设接话；禁止拿空回逃避未解决的事。
- 禁止为了接话加「如果还有问题可以继续问我」、强行反问或凭空找新话题。
- 真正空回只能用空数组，不能发空字符串、省略号、动作描写、「已读不回」或解释原因。

分段规则改为需要回复时通常 1–3 条，允许单条完整回答/确认/道别，长消息按真实需要处理。
四档表情提示也明确只在「决定回复」之后适用；空回跳过表情策略与播放，
不会触发既有「整轮表情被裁空时保留第一张」的兜底。

### 4.3 解析与失败的区别

新增 `RPHubWeChatProtocol.parseReplyResult(raw)`：

```js
// 模型明确输出 {"messages":[]}
{ messages: [], silent: true }

// 正常文字或表情回复
{ messages: [{ type: 'text', content: '2' }], silent: false }

// 空内容、无效结构、全是空字符串、截断 JSON
{ messages: [], silent: false } // 请求层报告失败，保留重试入口
```

只有对象中明确存在空的 `messages` 数组才表示主动空回。
代码块、think/thinking/reasoning 块、前后说明的容错保留。
已经识别出的 JSON 不再降级成聊天文字；以 JSON 结构开头或包含消息协议字段的截断内容也不会展示为气泡。
普通纯文本按换行降级、旧的 `msgs`/`data` 和裸数组非空回复、emoji 升级、消息数量/长度上限仍保留。
旧 `parseReply(raw)` 继续返回数组，兼容 RP 主动微信工具等调用方。

`requestWechatReply` 仍拒绝 API 完全空内容；`finishReason` 为 `length` 或 `content_filter`
也报告截断/拦截失败，即便收到的正文看起来像空回。网络错误、格式错误、中止都不能伪装成主动沉默。

### 4.4 不增加空白记录，但要记录处理边界

空回成功后，仅在**本轮实际处理到的最后一条 user 微信消息**上追加元数据：

```jsonc
{
  "id": "原消息 id",
  "ts": 1790000000000,
  "channel": "wechat",
  "role": "user",
  "type": "text",
  "content": "好的",
  "replyDecision": "silent"
}
```

- 不追加 assistant、system、占位气泡或独立沉默事件，原用户内容/时间/id 不变。
- `wechatUnansweredCount` 遇到 assistant 或带 `replyDecision: 'silent'` 的 user 消息清零。
  连发的多条消息由最后一条标记划定处理边界，新用户消息重新计数。
- 元数据与原时间线一并存入原 `wechat_timeline` scope；重开/刷新后仍是已处理状态，无须数据库迁移。
  旧消息没有该字段时继续按原方式计数，不追溯推断老消息是否空回。
- `wechatDisplayItems`、微信模型上下文和回 RP 的背景只取真实内容；元数据不展示、不作为角色说过的话注入。
  前情提要覆盖计数仍按真实微信消息条数计算，空回不会增加条数。
- 正常结束统一清理 typing、状态文本、ticker、generating 和 AbortController；空回不弹错误、不自动重试。
  已处理后「让对方回复（攒了 N 条）」隐藏，后续用户消息仍正常触发生成。
- 中止/角色或分支 scope 变化后，晚到的结果不标记用户消息、不播放。
  保存使用请求开始时捕获的 scope；旧请求的收尾只在其 controller 仍归当前请求所有时执行，
  避免停止后新请求的状态被旧请求清掉或旧快照覆盖新请求的记录。

### 4.5 修改落点与验证

| 文件 | 本次职责 |
| --- | --- |
| `assets/js/wechat-protocol.js` | 自主收尾提示、移除至少两条限制、`parseReplyResult`、兼容 `parseReply`、表情提示与空回分离 |
| `assets/js/app/25-wechat.js` | 区分主动空回与失败、用户消息元数据、待处理计数、统一收尾与中止/scope 防护 |
| `tools/refactor/test-wechat-silence.cjs` | Node 原生测试，直接执行真实协议和微信模块，替换 Vue 容器/模型/存储/打字延时 |
| `tools/refactor/smoke-wechat.cjs` | 无头 Edge 原有完整微信回归，新增真实 DOM/IndexedDB 空回与接续探针 |

验证命令（仓库根目录）：

```powershell
node --check assets/js/wechat-protocol.js
node --check assets/js/app/25-wechat.js
node --test tools/refactor/test-wechat-silence.cjs
node tools/refactor/smoke-wechat.cjs
node tools/refactor/smoke-wechat-stickers.cjs
git diff --check
```

本次实测结果：语法检查及 `git diff --check` 通过；Node **18/18 通过**；
微信完整浏览器回归（含新增空回/接续探针）**WECHAT E2E: PASS，0 JS 错误**；
既有表情包专项 **21/21 通过，0 JS 错误**。

18 项 Node 测试覆盖：明确空回及包裹容错、错误结构/截断区别、旧回复兼容、提示与人物上下文、
`1+1 → 2 → 好的 → 空回 → 新问题`、无空白记录、持久化重开、连发/图片/表情处理边界、
接口失败可重试、中止晚到、切分支隔离、停止后新请求、真实表情收尾。
浏览器回归使用 mock 模型接口，验证真实 Vue 渲染、气泡、按钮、状态、IndexedDB 和跨 RP 衔接。
测试没有调用用户的真实模型 API；实际角色是否选择沉默由所用模型结合提示和人设决定，
不会保证每次「好的」都空回。人工体验时建议分别测试已完成问答、亲近角色道别、
「好的，明天几点见？」及「好吧，其实我有点难过」，观察收尾是否符合角色。
