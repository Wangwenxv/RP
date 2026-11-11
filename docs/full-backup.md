# 全部内容备份与恢复交接

日期：2026-11-07。沿用现有 UI，在「设置 → 高级设置 → 全部内容备份」增加「导出全部内容 / 导入全部内容」。原角色卡、聊天 JSONL、预设、世界书等单项入口继续保留。

> 单角色全部分支聊天 JSONL 当前使用 version 1，只保存分支目录与 RP 聊天记录，不包含微信时间线、附件原件、记忆和前情提要。需要迁移这些数据时使用本页的 `.rphub` 整库备份。

## 使用与覆盖范围

导出得到一个 `.rphub` 文件。导入先读取并校验文件，显示角色、分支、RP/微信记录、记忆、图片、语音、文档、地图、小说和工坊草稿数量；此时不会改动数据。用户点击「覆盖并导入全部内容」后，先自动下载当前内容的完整回退备份，再覆盖数据库并重新载入页面。

这是**当前浏览器来源的全部已保存应用数据**，不是单角色导出，也不是工程源代码压缩包：

| 数据 | 备份方式 |
| --- | --- |
| 所有角色及卡内微信/语音/地理配置、头像、角色作用域世界书/正则/UI 模板 | 原存储记录 |
| 所有角色/分支的 RP 原文、分支目录与当前选择、经典/向量记忆、二次压缩源总结、前情提要覆盖信息 | 原存储键与记录，保留 UUID 和消息引用 |
| 微信时间线、剧情时间、沉默/空回信息、未回复的已发送气泡、媒体任务 | 作用域原记录 |
| 微信图片/缩略图/相册、语音、文档原件 | Blob 实际字节，不只保存引用 |
| 文档全文分块、目录、阅读进度和读者笔记 | 原存储记录 |
| 表情包、快捷时间标签、自建地图库及底图、用户人设、预设、正则、世界书、工具、模型与界面设置、用量记录 | 原存储记录 |
| 已保存小说库 | 主库 `rp_hub_novel_library`，包含书籍、章节、人物和小说侧设置 |
| 角色工坊草稿 | 迁入主库的 `rp_hub_workshop_characters`；旧 AICharGen 库只读迁移，旧库保留 |
| 外观与工坊偏好 | localStorage 白名单：`rphub-appearance`、`ai_chargen_options`、`ai_chargen_active_index` |
| 语音服务地址与可选语音 Key | sessionStorage 白名单：`rphub_wechat_voice_service`、`rphub_wechat_voice_key` |

默认不导出配置密钥；勾选「包含 API 与语音密钥」适合迁移到自己的设备。可选密钥覆盖主 API、服务商 Key 表、生图 Key、Tavily、模型槽位快照、小说供应商和语音 Key。备份里的配置密钥字段及其在普通存储文本/URL 中的出现会被移除；附件原件字节保持原样，因此用户自己放入附件的私密信息仍随附件备份。

导入时即使文件带密钥，也需要另外勾选「恢复备份中的 API 与语音密钥」。不恢复密钥时，清空这些配置，导入后重新填写；不把旧站点的 Key 自动配给新导入的 API 地址。导入前自动下载的回退包**包含当前密钥**，界面有明确说明，文件未加密。

浏览器 origin 不同（file、本机静态服务器、不同端口等）会有不同数据库；备份仅取当前来源的数据。网络图片/GIF、远端生图链接、内置随工程提供的素材仍保留原引用；自建地图底图和已落本地的附件随包保存。未发送输入、未保存编辑草稿、生成中的任务、本地语音服务程序及工程文件不属于应用备份。生成、补录、附件处理、分支切换等进行中时按钮暂时禁用，避免导出半完成的数据。

## 格式与存储设计

- `assets/js/backup-utils.js` 导出 `window.RPHubBackup`。格式为 16 字节 `RPHUB_BACKUP_V1\n` 标记、8 字节目录长度/CRC32、UTF-8 JSON 目录和顺序排列的原始二进制资源。
- JSON 目录用带类型节点保存普通对象/数组/值、Blob、Date、ArrayBuffer 和常用 TypedArray，避免 Blob 经通用 `cloneForStorage` 后变成空对象；二进制没有 base64 的体积膨胀。类型节点不执行任何脚本或模板。
- 目录与每个二进制资源均做 CRC32 完整性校验。CRC32 用于发现意外损坏，不作为文件真实性认证。资源边界、总长度、版本、节点结构、存储键唯一性和核心数据类型也会先检查；未知备份版本与普通 RP JSONL/角色卡在这个入口拒绝。
- 单文件上限 2GB，JSON 目录上限 128MB；校验资源按 1MB 分块读取并让出 UI。没有新增 CDN、ZIP 库或构建依赖。
- `RPHubStorage.readStorageSnapshot()` 收集主库 `rp_hub_*` 全部键，合并未禁用的旧库同名记录，主库优先。采用全键快照而非手工维护数据类别清单，未来使用主库的新功能也能进入备份。
- `restoreStorageSnapshot()` 在主库 `store` 的一个 readwrite 事务中移除 RP Hub 命名空间键并写入新快照；不清除同库其他命名空间。写入失败或配额失败时事务整体回滚。
- 恢复时设置 `backup_legacy_disabled = true`，防止备份里没有的旧库记录在后续读取时又被迁回，包括旧工坊草稿。旧库没有删除，仍可手工审计/恢复。
- 主页面恢复期间锁住通用写入/删除接口；成功后保持锁直到重载，避免延迟自动保存把恢复结果覆盖。主页面通过 BroadcastChannel 通知同来源的其他 RP 主页面暂停写入和重载。独立工坊/小说窗口应先保存并关闭，再恢复，避免独立窗口的旧编辑状态覆盖刚恢复的数据。
- 浏览器偏好先试写；主库事务失败时恢复旧偏好。localStorage/sessionStorage 与 IndexedDB 不是同一事务，进程在恢复过程中被强制关闭时可通过回退包重新恢复。

## 接线和维护入口

| 文件 | 修改 |
| --- | --- |
| `assets/js/data-services.js` | 全库快照、原子恢复、写入锁、旧库回退标记、工坊只读迁移 |
| `assets/js/backup-utils.js` | 独立文件格式、二进制与目录校验、数据校验、概览、可选配置密钥 |
| `assets/js/app/32-full-backup.js` | 导出、导入预览、当前数据落盘、回退包下载、恢复/重载、焦点与键盘处理 |
| `assets/js/app/06-persistence.js` | `saveData({ throwOnError: true })` 供备份确认落盘失败；新增 `saveChat` 选项及加载中禁止写聊天 |
| `assets/js/app/23-lifecycle.js` | 启动预设同步使用 `saveChat: false`，避免重载时聊天尚未读入就保存空聊天 |
| `assets/js/app/07-image-gen-autosave.js` | 防抖函数新增 `cancel()`，备份先取消等待的旧保存任务再主动落盘 |
| `assets/js/app/25-wechat.js` | `flushPendingWechatSave()` 保存当前已载入作用域，避免空时间线覆盖未载入记录 |
| `assets/js/app.js` / `index.html` | 加载 32 模块和纯服务、暴露状态/动作；沿用设置按钮与模态样式 |
| `character/index.html` | 去掉工坊独立 localforage 存储依赖，使用共用存储服务；保留旧草稿的迁移路径，UI 不变 |

setup 尾部为 `25 → 27 → 28 → 29 → 30 → 31 → 26 → 32`。`backup-utils.js` 在 `data-services.js` 之后、app 模块之前加载。

## 验证

在工程根目录运行：

```powershell
node --test tools/refactor/test-full-backup.cjs
node tools/refactor/smoke-full-backup.cjs
node --test tools/refactor/test-memory-recall.cjs tools/refactor/test-wechat-time.cjs
node tools/refactor/smoke-memory-recall.cjs
```

纯服务 6 项回归覆盖：多角色/分支/记忆/提要/地图/小说/工坊及各类附件往返，Blob 字节与 MIME、嵌套 Blob/TypedArray/Date，默认去除配置密钥但原数据不改写，错误格式/目录损坏/附件损坏/截断拒绝，重复键/无效设置/循环引用/不支持对象拒绝。

浏览器冒烟使用隔离 Edge、假 API 和临时数据，验证真实下载、导入预览不改数据、桌面与 390px 手机宽度、覆盖前自动下载回退包、实际重载后各角色/分支/RP/微信与媒体原件读回、文档阅读笔记、默认清空密钥、回退包恢复原状态及密钥、实际 IndexedDB 写入失败整体回滚、写入锁、旧工坊迁移和工坊独立页面编辑共用库。截图与测试备份存于忽略目录 `.refactor-tmp/full-backup/`。

本次没有使用用户真实数据库、导出其私人内容或请求真实模型服务。
