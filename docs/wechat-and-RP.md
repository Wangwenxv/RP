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


## 压缩后的注入：摘要 + 保留的最近原文

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


