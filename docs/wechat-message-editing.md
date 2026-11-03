# 微信单条消息「编辑 / 删除」优化交接

> 更新：2026-11-03。本文记录本轮改动：让微信气泡和 RP 消息一样可以改、可以删。
> 上游阅读顺序：[微信与 RP 实现交接](./wechat-and-RP.md) → 本文。全项目结构见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 1. 为什么改

之前微信只有「清空记录」一个出口：写错一句话、对方回错一条，只能整段清空重来。RP 侧早就有单条编辑/删除，微信没有，两条时间线的维护能力不对等。

本轮要的是**同一份时间线，三种消费者同时生效**：

```text
wechat_timeline 里的那一条
        ├─ 气泡显示        wechatDisplayItems（computed，读 content）
        ├─ 下一轮请求      buildWechatModelMessages / buildWechatRpSegment
        └─ RP 回灌与前情提要 appendWechatDigestToMessages / buildRecapMaterial
```

因此实现上只改时间线里的那一条消息，其余链路全部现算，不额外维护副本。

## 2. 交互

| 操作 | 行为 |
| --- | --- |
| 打开操作菜单 | 每条气泡外侧一个「···」按钮（桌面 hover 变实、触屏常显 0.8 透明度），点击弹出「编辑 / 复制 / 删除」 |
| 菜单定位 | 按按钮 `getBoundingClientRect` 固定定位：对方消息向右弹、自己的消息向左弹，并夹在视口内；透明遮罩点击即关，滚动也关 |
| 编辑 | 气泡就地变成编辑框（白底、去气泡尾巴），自动聚焦并把光标放到末尾，随内容长高（上限视口 42%） |
| 保存 | 「保存」按钮或 `Ctrl/⌘ + Enter`；内容自动去首尾空白；空内容拒绝保存并提示；与原内容相同则提示「消息未改动」 |
| 取消 | 「取消」按钮或 `Esc`，草稿丢弃，不改时间线 |
| 复制 | 仅文字消息；写系统剪贴板，成功/失败都有 toast |
| 删除 | 系统确认框二次确认后移除该条；图片消息的文案额外说明「相册里的原图保留」 |

边界：

- **只开放文字消息的编辑**。图片消息没有可改的文本，表情消息的正文是表情名（改它等于改语义），这两类只有「删除」一项；「复制」同样只给文字。
- **生成中禁止改/删**（`isWechatGenerating`）。这一轮的请求体、播放队列、落库都以当时的时间线快照为准，中途改会让气泡与上下文错位；点了只会提示「对方正在回复，等这条发完再改」。
- 系统消息（`role: 'system'`）不参与，`wechatDisplayItems` 把它们渲染成 `wx-sys`，不带「···」。
- 取消编辑、关闭面板、切换角色、清空记录都会复位编辑态与菜单，不会把草稿带进下一条。

## 3. 数据变更

只加字段，旧数据无需迁移：

| 字段 | 位置 | 说明 |
| --- | --- | --- |
| `editedAt` | 被编辑的消息 | 编辑时间戳，当前只用于追溯，不影响渲染与上下文 |
| `replyDecision` / `replySilence` | 被编辑的 **user** 消息 | 编辑后删除这两个字段 |

最后一条是语义决定：`replyDecision: 'silent'` 记录的是「模型当时决定不回这句」。句子被改写后，这个结论不再成立，继续留着会让这条永远算作已处理、`wechatUnansweredCount` 恒为 0。清掉后它重新算作待回复，「让对方回复（攒了 N 条）」按钮会重新出现——但仍然**不自动发请求**，是否让对方回应由用户点。

删除不改其他消息的字段：删掉助手回复后，它前面的用户消息自然重新计入未回复条数（该计数本来就按「最后一条助手消息」重算）。

## 4. 前情提要的覆盖计数

`storyRecap.coversWechatCount` 是「压缩那一刻覆盖了前 N 条微信」的**前缀计数**，不是 id 列表。删掉覆盖段内的一条，实际条数就比计数少，后果是下一次压缩会把已经进过摘要的内容再算一遍、保留窗口（最近 `keepWechatCount` 条原文）整体后移一位。

处理：`26-recap.js` 新增 `adjustRecapWechatCoverageAfterDelete(indexInWechat)`。删除时按「被删消息在非 system 微信序列里的下标」判断，落在覆盖段内就减一（并落盘），段外不动。

**编辑不改写摘要**：摘要里可能提到原句，但重写摘要需要整轮重新压缩，成本与副作用都太大；RP 侧编辑消息同样不会重写 `storyRecap`，这里保持一致。真要修正，走「压缩上下文」重新压一次。

## 5. 代码位置

| 文件 | 改动 |
| --- | --- |
| `assets/js/app/25-wechat.js` | 状态 `wechatEditingId` / `wechatEditDraft` / `wechatMenu`；新增「单条消息：编辑 / 复制 / 删除」整段：`findWechatMessage`、`canEditWechatMessage`、`wechatMenuTarget`、`wechatMenuStyle`、`openWechatMessageMenu`、`closeWechatMessageMenu`、`autoResizeWechatEdit`、`startWechatEdit`、`cancelWechatEdit`、`saveWechatEdit`、`copyWechatMessageText`、`deleteWechatMessage`；`openWechat` / `closeWechat` / `clearWechatTimeline` 复位编辑态与菜单 |
| `assets/js/app/26-recap.js` | `adjustRecapWechatCoverageAfterDelete` |
| `index.html` | `.wx-row` 增加 `is-editing` 态、气泡内编辑块、第 3 个 flex 子项 `.wx-tools`、固定定位的 `.wx-msg-menu` + 遮罩；`main.wx-chat` 的点击/滚动顺手关菜单 |
| `assets/css/wechat.css` | `.wx-tools` / `.wx-tool-btn` / `.wx-msg-menu*` / `.wx-edit*` 及移动端适配（层级：遮罩 56、菜单 57，压在 `.wx-root` 55 之上、抽屉 58 之下） |
| `assets/js/app.js` | 把上述状态与函数加进 `return`，供模板使用 |

布局取巧点：`.wx-row` 本来就是 `display:flex`，`.wx-tools` 直接作为第三个 flex 项。`row` 时它落在气泡右侧、`row-reverse`（`me`）时落在左侧，正好都在气泡**外侧**，不必再包一层容器，原有气泡宽度、箭头、表情/图片样式全部不受影响。编辑态给 `.wx-row.is-editing` 加 `align-items:stretch`，气泡 `flex:1` 占满剩余宽度。

## 6. 刻意没做

- **不回收图片资源**。删除图片气泡只移除消息，`wechat_media_index` 与 Blob 保留——那张图可能还在相册、可能被别的角色引用。只顺手 `loadVisibleWechatImages()` 释放 object URL。
- **不自动补一条回复**。编辑用户消息后只是让它重新进入待回复，请求仍由用户点「让对方回复」或直接发新消息触发。
- **不改写摘要、不重抽长期记忆**。见 §4。
- **不同步 RP 镜像**。RP 侧消息的镜像对账仍只在 `openWechat`、压缩上下文、以及重复生成后的 `recordRpMessages` 处发生；不在 RP 请求组装里做对账——那时本轮用户消息已经进了 `chatHistory`，对账会把它镜像成新锚点，微信段的插入位置会从「本轮用户消息之前」挪到之后，破坏既有的交错顺序（实测会让 `smoke-wechat.cjs` 的三条交错断言失败）。
- **不做长按菜单**。触屏没有 hover，用常显的低透明度「···」比长按更容易被发现，也不会和图片点击放大、头像换图抢手势。

## 7. 验证

```powershell
node tools/refactor/smoke-wechat-edit.cjs          # 本轮新增，46 项
node tools/refactor/smoke-wechat.cjs               # 微信主链路
node tools/refactor/smoke-wechat-stickers.cjs      # 表情包 21 项
node tools/refactor/smoke-wechat-media.cjs         # 图片链路
node --test tools/refactor/test-wechat-silence.cjs tools/refactor/test-wechat-media.cjs  # 60 项
git diff --check
```

`smoke-wechat-edit.cjs` 用无头 Edge + 真实 Vue/IndexedDB 覆盖 46 项：面板与气泡渲染、菜单项数与视口内定位、进入/取消/保存编辑、空白守卫、`replyDecision` 作废与未回复计数、生成中禁用、二次确认删除、关闭重开后从 IndexedDB 读回（编辑与删除都持久化）、下一轮请求体里只出现新文案、前情提要覆盖计数在段内/段外删除时的行为、RP 编辑与删除后镜像与回灌摘要的对齐。

本轮同时回归：微信主链路（152 项）、表情包 21 项、图片链路、Node 单测 60 项，全部通过；三套浏览器测试无 JavaScript 错误。模型与其他外部服务仍由 fixture 控制，测试证明的是上下文组装与落库行为，不证明真实模型的偏好。

## 8. 后续可选

- 删除撤销：`showToast` 目前没有 action 槽，做撤销要么扩 toast 组件，要么单独做一个 3 秒可恢复的待删队列。
- 多选删除 / 按区间删除（批量整理很长的历史时有用）；`clearWechatTimeline` 之外再补一个「删除到此处」也合理。
- 编辑历史：`editedAt` 只记录最后一次时间，若要「查看原句」需要额外存 `previousContents` 数组，注意别把它带进上下文。
- 摘要与原文的一致性：若摘要里出现已被改写/删除的句子，目前只能重新压缩解决；需要更强的保证时应改成 id 锚点式覆盖，而不是前缀计数。
