# 多角色世界界面、头像与保存优化

日期：2026-11-12。本次修改在本地工作树，未发布到 GitHub Pages。用户已有林晚、卿测试卡，本次没有新增或改写角色卡文件。

## 使用变化

- 世界标题旁新增「编辑世界」，重新打开完整的世界档案、玩家和人物名册。保存设置会继承所有分支剧情并建立新版本，原世界可继续从存档列表打开；开局时间在编辑时只读，推进时间位于世界工具。
- 名册支持玩家和 NPC 上传、替换和移除头像。运行后在「世界工具 → 人物」也可更换，头像在同一存档原地保存，不生成世界副本。私聊标题、会话列表、消息发言人和人物列统一使用世界内头像。
- 头像自动居中裁剪为最长 384 像素的方形 PNG，支持 JPG、PNG、WebP、GIF、AVIF 输入，最大 10 MB；GIF 取静态首帧。持久化为图片 data URL，刷新、分支、世界包和整库备份都可承载。无法加载的图片回退到姓名首字。
- 人物名册显示明确的卡就绪状态、参与开关与绑定选择。新建世界会重置创建草稿；保存后的身份 ID 保留，可暂停人物参与，新增或删除身份仍需另建世界。
- 会话列表与剧情工作台常驻；人物、时间、分支、记忆和知情来源在按需打开的工具面板。窄屏使用可关闭的抽屉，不挤占正文。群聊创建加保存锁，避免重复点击；聊天输入支持 Ctrl / Command + Enter。

## 视觉方案

主体是校园 RP 创作者的世界档案，页面任务是准备人物并持续读写同一世界的故事。冷灰底、白色纸面与松石绿建立静静阅读的感觉，人物列是识别世界的标记；剧情正文的时间线边线表达真实的叙述顺序，不加入装饰性编号。

基础 Token：冷灰 `#eff3f5`、纸白 `#ffffff`、墨色 `#223945`、次要文字 `#667b83`、松石绿 `#4b7b78`、浅绿 `#dee9e7`；错误提示使用独立状态色。标题使用本地中文宋体系列，正文使用微软雅黑 / 苹方，时间与来源使用等宽字体。深色模式使用单独 Token，头像保持原图。

本仓库是 CDN Vue 3 的零构建原生界面。已向 CWUI MCP 传实际目标文件，但解析没有组件库证据；架构文档也明确本项目不属于 CWUI。没有引入组件库或改变构建方式。

## 保存慢的原因与处理

旧创建流程在点击保存后才加载 `assets/js/world-images.js`，其中校园原图约 1.1 MB。随后依次创建空世界、提交会话、提交开场白，包含地图图片与人物卡的整个存档连续读写三次。

现在进入创建页、选择地图时提前准备图片；首次仍未完成时显示「正在准备地图」。准备失败不保留失败 Promise，下次操作可重试。卡预检结果按卡快照和绑定缓存，导入卡与不可变世界定义避免 Vue 深层代理处理。

`RPHubWorldStore.create` 新增可选 `initialEvents`，会话放入初始 baseState、开场白作为已验证的叙述事件，一次事务保存。沿用来源与观察权限校验，开场白不授予任何角色知情，不调用模型。`openingEvents` 和 `ensureOpening` 共用同一个开场构造函数，旧世界的首次开场逻辑保留。

使用现有苏祈雪 v2、林晚校园测试卡、卿卡与校园地图，本地世界序列化长度约 1,307,265 字符。地图预加载完成后，几次隔离 Edge 测量保存约 0.13–0.25 秒；整档写入从 3 次降为 1 次。测试给首次地图资源添加了 1 秒延迟，旧流程的约 1.2–1.4 秒包含这段模拟等待，不能作为线上网络性能保证。

## 数据与维护入口

- `assets/js/world-components.js`、`assets/css/world.css`：档案、人物头像、正文与工具抽屉；CSS 从 index 的既有防缓存加载清单载入。
- `assets/js/app/35-world-session.js`：编辑草稿、保存新版本、图片裁剪、地图预加载、绑定与 UI 接线。编辑保存核对打开时的世界定义版本和分支 revision；取消或切换后的晚到结果不能替换当前界面。
- `assets/js/world-model.js`：头像 URL 格式归一化。头像位于 actor 的展示字段，不加入角色上下文或知识事件。
- `assets/js/world-store.js`：`updateActorAvatar` 在事务内核对定义 revision，头像变化不修改卡哈希、分支 revision 或事件；卡/地图修改仍调用 `reviseDefinition` 创建副本，其事务同时检查定义与各分支版本。存档列表按创建/修订时间显示最新版本。
- `assets/js/world-chat.js`：初始开场事件构造与旧档补开场。

## 验证

世界纯逻辑与备份专项 58/58；原浏览器 smoke 24/24；真实 IndexedDB 两页面 CAS、幂等、回滚、备份、世界包及卡版本专项通过。新增 `smoke-world-ui.cjs` 18/18，通过隔离 Edge 验证实际头像文件上传、原地保存、消息头像、刷新、完整编辑与历史保留、群聊、桌面、390 像素移动端、抽屉、深色控件配色及截图。截图等待入场遮罩和主题过渡结束。测试未连接用户浏览器资料，也未发送真实模型请求。

```powershell
node --test tools/refactor/test-world-events.cjs tools/refactor/test-world-store.cjs tools/refactor/test-actor-visibility.cjs tools/refactor/test-world-turns.cjs tools/refactor/test-world-chat-memory.cjs tools/refactor/test-world-backup.cjs
node tools/refactor/smoke-world-chat.cjs
node tools/refactor/smoke-world-store.cjs
node tools/refactor/smoke-world-ui.cjs
# 可选：与本次修改前的固定提交对比创建耗时和写入次数
node tools/refactor/smoke-world-ui.cjs --baseline=e092efce88e62650a70afc74771d1a4ef996f5cf
```

保存耗时数据在忽略目录 `.refactor-tmp/world-ui/timings.json`，桌面、手机、编辑页、工具抽屉和深色截图在 `.tmp-review/*-redesign.png`。
