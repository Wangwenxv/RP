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

## 2. RP 主动发起微信

需求：不总是由用户点开微信。角色在 roleplay 里觉得「该私下找你」时，应当能**主动**把微信递过来。

### 2.1 触发方式

复用既有的**主动工具**机制：新增内置工具 `tool_wechat`（类型 `wechat_message`，默认关闭）。
模型在 RP 回合里通过 API 的原生 function call 调用它，参数：

```json
{ "content": "睡了吗", "reason": "想单独说句话" }
```

- `content`：角色要发的那条微信，写成真人微信口吻的短消息，一次一条；想连发就多次调用。
- 该工具**只在当前角色 `wechatEnabled` 时**才进模型工具表（`getEnabledActiveTools()`），
  没开微信的角色不会被「强制」策略逼着调用一个没有落点的工具。

用主动工具而非正文里的特殊标记，好处是天然复用开关、提示词注入、工具 UI 时间线和多轮续写循环，
也不污染正文渲染。

### 2.2 时序（为什么面板要延迟弹）

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

### 2.3 主要挂点

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
