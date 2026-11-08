# RP / 微信统一清空交接

更新：2026-11-08。本工程沿用原 Vue 模板、ModalShell 与现有配色，不使用 CWUI。

## 使用与范围

RP 顶栏和微信顶栏的垃圾桶都打开同一个菜单，展示两个执行按钮、将移除的消息数量及不可撤销提示。

| 选项 | 行为 |
| --- | --- |
| 微信里的「清空本段微信」 | 删除最后一段 RP 之后的微信；保留那段 RP 和之前的微信/剧情。 |
| RP 里的「清空本段 RP」 | 删除最后一段微信之后的 RP；保留微信和更早 RP。尚未进入微信时，清掉初始 RP 段的对话，保留角色卡开场白。 |
| 「清空全部 RP + 微信」 | 重置当前角色、当前分支的 RP、微信、记忆、前情提要、变量进度与待发送任务，回到角色卡开场。 |

例如 `RP1 → 微信1 → RP2 → 微信2`：在微信里清本段只删微信2；在微信2发生前返回 RP 清本段，则删 RP2，保留 RP1 与微信1。刚切到微信但还没有微信内容时，本段按钮禁用，避免删除切换前的 RP。

边界以统一时间线最后一个异渠道记录为准，不用消息日期、固定条数或摘要压缩覆盖点。角色主动发出的实际微信同样属于微信记录，空回元数据随所在消息删除。

「全部」指当前剧情分支，不删除角色卡、世界书、API 设置、表情库、相册、地图或其它角色/分支。原图和语音仍使用独立资源库；聊天引用删除后不会进入下一轮模型上下文。文档原文、分块、读者笔记按当前 scope 或本段删除的引用回收。

## 原问题

1. RP 清空只重置 `chatHistory`、经典记忆与变量；`wechat_timeline` 中的旧微信和 RP 镜像仍在，微信请求及 RP 回灌继续读到它们。
2. `clearStoryRecapSilently` 看到内存提要为空就返回，尚未加载的磁盘 `story_recap` 没有删除，之后又带回旧前提。
3. 提要请求缺少 scope/请求代次防护；清空发生在请求期间时，晚到结果可重建旧提要。
4. 微信旧清空只删微信消息，保留含被删内容的提要，存储错误后仍提示成功。
5. RP 对账遇到空正文直接返回，不能移除全部过期镜像；防抖与旧保存请求也需要在清空时作废。

## 执行与持久化

新增 `33-conversation-clear.js` 统一菜单、范围计算与执行。setup 在 `fullBackup` 后初始化 `conversationClear`，模板接口由 `app.js` return 暴露。纯范围函数为 `RPHubConversationClear.planClear`。

打开菜单先载入当前 scope，按实际 RP 镜像重置游标、补齐并对账，避免旧游标重复镜像而改变本段边界。清理时的微信读取使用严格错误模式，读取失败不当成空时间线继续删除。

执行时冻结新发送、角色/分支切换和整库备份，停止 RP、微信、媒体、提要与记忆后台任务，等待 RP 主管线收尾。再增加 `conversationRevision`，取消保存防抖，等待旧 RP 保存队列并核对菜单 scope。

`RPHubStorage.setScopedStoredValues(scope, values)` 在同一个 IndexedDB 事务里更新：

```text
chat / classic_memories / wechat_timeline / story_recap / wechat_media_tasks
```

写空值覆盖旧键，同时阻止旧库 fallback 读回旧数据。主事务完成后才替换聊天界面；事务失败保留原正文并报告失败。变量 runtime、分支统计、配置和文档资源继续使用各自持久化入口，全部完成后才提示成功。附加保存失败会提示「清空未完成」，主事务已提交的聊天不会自动复原。

部分清理按受影响的 RP 轮次裁剪经典总结。跨过删除边界的二次压缩使用现有源总结拆回保留部分，不直接留下混有删除剧情的摘要。前情提要覆盖被删 RP 轮次或微信前缀时，整份提要作废，原文保留供重新压缩；未覆盖本段的较早提要保留。清微信本段时，较早 RP 记忆继续保留。

清空同时重置微信加载 scope/游标、编辑菜单、待发送附件、指定发送时间、上下文查看器、工具结果和向量故障冷却。地理位置依现有引擎从保留正文/微信重放。

提要新增独立 epoch、AbortController 与 scope 核对；即使模型忽略 abort，旧结果也不能落回清空后的状态。微信/提要异步读取核对代次，旧保存等待数据库初始化后检查 revision。

取消全局防抖后显式调用 `saveData({saveChat:false,saveMemories:false,throwOnError:true})` 保存其负责的配置，避免刚修改的 API/用户设置丢失。

## 维护入口

| 文件 | 改动责任 |
| --- | --- |
| `assets/js/app/33-conversation-clear.js` | 共用菜单、本段边界、清空事务与联动。 |
| `assets/js/data-services.js` | scoped 批量事务写入。 |
| `assets/js/app/03-state-chat.js`、`06-persistence.js` | 清理状态、保存代次和防抖守卫。 |
| `assets/js/app/12-methods-chat-send.js`、`25-wechat.js` | 原垃圾桶委托新入口、镜像对账、游标重置、异步加载防护。 |
| `assets/js/app/26-recap.js` | 未加载提要也写 null；请求取消与 scope 防护。 |
| `assets/js/app/15-generate.js`、`16-memory-extraction.js`、`19-memory-batch.js`、`21-character-lifecycle.js`、`32-full-backup.js` | 生成、记忆重试、切换与备份互斥。 |
| `assets/js/app/29-wechat-documents.js` | 按移除消息回收本段文档原文与笔记。 |
| `index.html`、`assets/js/app.js` | 原 UI 上的菜单、加载顺序和模板接线。 |

## 验证

```powershell
node --test tools/refactor/test-conversation-clear.cjs
node tools/refactor/smoke-conversation-clear.cjs
node tools/refactor/smoke-wechat-edit.cjs
node tools/refactor/smoke-wechat.cjs
node --test tools/refactor/test-wechat-silence.cjs tools/refactor/test-memory-recall.cjs tools/refactor/test-player-agency.cjs
node --test tools/refactor/test-wechat-media.cjs tools/refactor/test-wechat-documents.cjs tools/refactor/test-wechat-time.cjs tools/refactor/test-wechat-voice.cjs tools/refactor/test-full-backup.cjs
git diff --check
```

专项 Node 测试 17 项通过，覆盖本段边界、未加载磁盘数据、事务/读取/停止失败、跨分支与晚到请求/读取结果。完整浏览器专项 12 项通过，使用真实 Vue、IndexedDB、Edge，验证两种本段清理、全部重置、刷新、微信→RP 回切的实际请求，以及 1280×900 / 390×844 菜单布局。截图已视觉核对，输出在忽略目录 `.refactor-tmp/`。

原微信编辑/删除浏览器检查 46 项通过，综合微信 E2E 通过且无 JavaScript 错误。沉默、记忆降级、玩家边界、图片、文档、时间、语音与完整备份的相关 Node 回归通过。综合微信浏览器脚本同步移除旧「主动微信成功后继续请求正文」预期，改为既有交接规则：叙述到联系位置，发送一条实际微信后等待玩家；清空后首条消息的日期头用包含正文核对。

模型接口使用测试响应，验证本地数据和实际请求体，不消耗真实模型额度，不清空用户正在使用的浏览器聊天。

`tools/refactor/verify.cjs` 是最初 662 个声明拆分时的历史校验，仍依赖已不存在的 `assets/js/app.js.new` 与旧 manifest，后来的地理包装/微信模块也不符合它的同名声明假设；本次执行仍失败，不作为现工程验收依据。全部 app JS、bootstrap 和存储模块已经另行逐个 `node --check` 通过。
