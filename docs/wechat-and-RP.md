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
