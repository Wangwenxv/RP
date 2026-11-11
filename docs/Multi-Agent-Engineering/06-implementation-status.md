# 多角色世界实现交接

日期：2026-11-11。状态：**文本世界模式已经接入应用并通过隔离测试；P4 仅完成世界包与版本生命周期，不代表完整媒体、摘要及旧档迁移已完成。**

本目录 01～05 保存最初的设计和审计快照。后续维护请以本文、实际代码及本次测试结果判断已经实现的范围。

## 使用入口

刷新 `index.html`，从导航打开“多角色世界”。双击本地文件的 `file://` 运行方式保持可用。

1. 创建世界，填写玩家姓名、玩家身份、开局剧情时间，以及公共世界背景。可以选现有地图，也可以暂不使用地图。
2. 为人物槽位导入 JSON 卡，或选择角色管理里已有的卡。卡被保存为世界内独立快照；角色管理里的模板和旧聊天保持原样。
3. 默认名册为苏祈雪、林晚、卿和独立玩家。林晚卡的 `{{user}}` 默认绑定卿；没有适配卡的 NPC 保留身份但不参与模拟。时间线冲突和未解决的绑定会阻止启用。
4. 会话列表包含世界 RP 和每名启用 NPC 的私聊，可以创建多人群聊。文本消息在同一世界分支保存；每位角色只取得自己实际阅读或听到的来源。
5. RP 输入可以区分玩家行动与作者剧情前提；选择本轮实际在场或能够听到输入的人物。NPC 镜头向读者展示，并不自动增加玩家角色的知识。
6. “剧情时间与状态”可以明确手机可用性、活动、地点及限制结束时间。地点不能自动推出正在上课或手机收起。只有玩家提交或明确推进时间才结算到期行为。
7. “世界分支与回档”从指定事件序号建立整世界分支；若要撤销一轮输入，应选该轮 `player.input` 之前的序号，不能只截在紧随它的 `message.sent` 之前。
8. 卡牌后续就绪时，通过人物卡更新入口保存为新的世界副本。原世界的卡、历史和分支保留；新卡可在副本中启用原先未启用的 NPC。

模型接口沿用应用设置中的聊天模型配置。没有额外常驻进程、后台世界时钟或关闭页面后的模型调用。已有单卡 RP、微信和媒体仍走原有模式。

## 阶段与实际范围

| 阶段 | 本次实现 |
| --- | --- |
| P0 | 核对基线；修复旧分支聊天 v2 缺文件和接线，重新验证实际下载、导入及事务回滚 |
| P1 | 世界定义、稳定人物 ID、固定卡/地图快照、世界分支、事件追加、观察权限、角色读取工具、CAS/幂等、多私聊及检查点 |
| P1b | 没有把旧单卡全知请求作为目标方案；世界 RP 使用下面 P3 的独立人物决策路径 |
| P2 | 文本群聊、发送时成员资格区间、逐人物阅读和顺序生成、真实发送者、半成功恢复；成员变更的数据契约已支持，精细群管理产品操作尚未扩展 |
| P3 | 独立角色提案、有限告知传播、已确认同地的当面告知、微信告知、待办、地理路线/出发/到达、受约束的 RP 叙述器、玩家回应点 |
| P4 | 世界包导出/校验/作为新存档导入、分支恢复、卡版本副本更新、整库备份承载世界命名空间；其余见限制 |

三条关键场景已在实际浏览器请求中验证：卿读到取消打球而苏祈雪不能检索该私聊；卿群回复提交后林晚才读到并接话；林晚实际告知后苏祈雪才作知情决定，NPC 旁白不授予玩家角色知识。测试用合成卡和固定模型提案，产品不会硬编码林晚必须告知或苏祈雪必须沉默。

## 代码入口

| 文件 | 职责 |
| --- | --- |
| `assets/js/world-model.js` | schema v1、身份与卡预检、绑定、来源和事件硬约束 |
| `assets/js/world-store.js` | 世界存档/分支、事务内 revision 比较、幂等、检查点、世界包与修订副本 |
| `assets/js/world-projections.js` | 确定性重放、成员区间、观察集、真实发送人和阅读游标 |
| `assets/js/actor-context.js` | 本人设定、已观察原文、预算、权限优先的搜索和读取、人物介绍、绑定人物的地理查询 |
| `assets/js/actor-runtime.js` | 复用 API 客户端、JSON 提案校验、工具续写和有界修复；身份由调用参数绑定 |
| `assets/js/world-orchestrator.js` | 玩家触发的顺序调度、实际动作提交、有限传播、未决动作和失败恢复 |
| `assets/js/scene-narrator.js` | 只组织本轮接受的场景包，不发微信或授予角色知识 |
| `assets/js/app/35-world-session.js` | 新模式 UI 状态与适配，不借切换 `currentCharacter` 运行另一 NPC |
| `assets/js/world-components.js`、`assets/css/world.css` | 世界创建、会话、群聊、状态、恢复、卡修订与来源面板 |
| `assets/js/branch-chat-utils.js`、`app/22-character-io.js` | 补齐旧单卡 JSONL v2 与资源往返；与世界 `.rpworld.json` 是两个入口 |

`index.html` 先加载纯服务，再加载界面组件和 35 模块；`app.js` 将世界界面注册并在初始化结束前接入适配层。原有模块加载顺序不能按文件编号猜测。

## 存储、失败与权限

继续使用 `RPHubDB/store` 和 `rp_hub_` 前缀。世界逻辑键是 `world_session_v1:<编码后的 sessionId>`，一个记录保存固定 definition、activeBranchId 和 branches；分支保存 revision、剧情时间、不可变事件、基础状态、派生状态、turns、pendingActions 与幂等记录。当前使用完整分支快照，尚未做事件分块和大历史性能优化。

世界提交通过新增 `RPHubStorage.updateStoredValue` 在一个 IndexedDB `readwrite` 事务中同步读、比较和写。模型请求位于事务外。世界目录通过 `getStoredEntriesByPrefix` 只读取世界命名空间，避免展开无关旧聊天、配置和媒体。旧分支聊天导入使用 `setStoredValues` 一次写入所有分支和附件，Blob 不经过会把它转换为普通对象的 `cloneForStorage`；分叉后共享的语音与文档在导入时各自重建分支资源 ID 和授权作用域。

整库 `.rphub` 备份包含世界定义、卡与地图快照、所有分支、事件与观察；恢复预览显示世界、人物、分支及事件数量。导入在写入前检查世界存储键与身份、事件来源、分支结构及卡/地图快照哈希，损坏的世界数据不能仅凭外层备份校验通过而恢复。恢复时从事件重建派生状态，忽略被修改的状态缓存；更卡通过源／目标多键事务核对并保存新世界副本。

`access` 是资料资格，`message.read` / `observation.acquired` 才增加接收人的观察。搜索先过滤再匹配和计数；读取再次核对授权。`narration.published` 没有角色观察资格，不能通过旁白、调试面板或世界总摘要绕过。

默认每轮最多三名相关 NPC、两层新增传播、六次聊天模型调用；读取工具、协议修复和叙述均计入预算。角色输入有实际序列化字符预算，字符数不冒充 token。超时、非法提案和预算耗尽保存技术故障与未完成步骤，不伪装为人物沉默。已提交的角色回复保留；恢复只运行未完成的人物，叙述失败只重试正文。切会话、切分支和停止后晚到提案不能落盘，revision 冲突不把旧提案重贴新版本。

## 验证记录

以下命令在本次开发中实际执行；假 API 只验证程序契约和真实请求内容，不证明正式人物口吻或自然语言语义完全可靠。

```powershell
# 重点旧模式基线及已修复的分支聊天：127/127
node --test tools/refactor/test-branch-chat.cjs tools/refactor/test-player-agency.cjs tools/refactor/test-wechat-silence.cjs tools/refactor/test-wechat-time.cjs tools/refactor/test-history-retrieval.cjs tools/refactor/test-memory-recall.cjs tools/refactor/test-full-backup.cjs tools/refactor/test-conversation-clear.cjs

# 世界纯逻辑专项：44/44
node --test tools/refactor/test-world-events.cjs tools/refactor/test-world-store.cjs tools/refactor/test-actor-visibility.cjs tools/refactor/test-world-turns.cjs

# 整库备份世界专项：3/3；与上述旧模式和世界专项合并执行共 174/174
node --test tools/refactor/test-world-backup.cjs

# 实际 Vue / Edge / IndexedDB / HTTP 请求：21/21
node tools/refactor/smoke-world-chat.cjs

# 真实 IndexedDB 两页面并发、幂等、整批回滚、备份与原子更卡：通过
node tools/refactor/smoke-world-store.cjs

# 旧分支 v2 实际下载/跨角色导入/附件/刷新/真实事务中止/v1：通过
node tools/refactor/smoke-branch-chat.cjs

# 旧历史检索浏览器基线：19/19
node tools/refactor/smoke-history-retrieval.cjs
```

浏览器使用独立临时 context、合成卡与 fixture API，没有打开用户真实浏览器 profile、读取用户正式存档或请求真实模型。请求证据在忽略目录 `.refactor-tmp/world-chat/requests.json`，世界包也在该目录；桌面、390 像素移动和夜间截图位于 `.tmp-review/world-desktop.png`、`world-mobile.png`、`world-dark.png`，已经实际目检。移动端输入框及发送按钮通过视口边界检查；截图没有启动遮罩或提示遮挡。`file://` 入口另在独立 context 验证脚本加载及世界创建界面。

## 限制与下一步

世界模式目前只接入文本。旧单卡模式的图片、语音、文档仍完整可用；世界媒体引用、音色、OCR/文档读者笔记等尚未按 actor 观察授权接入，因此世界角色不会开放那些旧工具。世界模式尚未接入向量记忆或自动世界摘要，长期证据保留原文并按角色预算读取，不使用全知摘要兜底。

没有自动把多张旧卡的聊天、摘要或 NPC 旁白合并成新世界。新世界默认从明确开局开始；要续接旧剧情仍需用户指定权威分支和校对续接快照。精细通知、消息撤回/隐藏、群成员操作 UI、大规模存档分块、世界附件包、长期摘要与完整旧档迁移属于后续 P4 工作。

正式林晚、卿卡及室友名单由用户后续适配；本次未改写磁盘正式卡、没有补造卿的正式人设。正式卡就绪后需使用用户选定模型作多次真实场景评测，核对人格、保密/告知选择、玩家决定权、请求用量与延迟。程序能检查身份、权限、来源、顺序、时间和幂等，不能保证生成的自然语言从不隐含新增事实。

回到旧模式只需打开原来的角色聊天。世界事件位于独立命名空间，不需把多人历史压回单卡结构；回退前可下载世界包或整库 `.rphub`。旧分支聊天基线缺口现已修复，01 中“缺文件、version 1”的描述是实施前状态。
