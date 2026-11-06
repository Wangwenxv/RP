# RP-Hub 项目长期备忘

## 项目形态
- 纯前端零构建，经典 script 按序加载（共享全局词法作用域），Vue3+Tailwind+marked 全走 CDN。
- 无测试框架；用 tools/refactor/ 里的 playwright-core + 系统 Edge（channel: msedge）做无头冒烟。

## 代码组织（2026-09-28 重构后）
- `assets/js/app/01..24-*.js`：App 模块函数，setup() 中按序调用，共享上下文 `__s`。
  新功能：进最近语义的模块或新建序号文件；声明后镜像 `__s.x = x`；跨模块引用写 `__s.x`；
  会被重新赋值的 let 直接驻留 `__s`；模板要用就加进 app.js 的 return。
- 加载顺序必须在 index.html 与 app.js 调用清单中同步维护。
- 文档：docs/ARCHITECTURE.md、docs/MODULES.md（改代码前先看速查表）。

## 约定
- 内置预设/提示词/公告只改 built-in-content.js；存储走 IndexedDB `RPHubDB`，角色数据用 scoped key 按 uuid 隔离。
- 用户在意代码可 review 性与交接文档；大改动要留审计工具与回滚备份。

## 进行中计划
- （2026-09-28 已完成）微信聊天子系统集成：25-wechat 模块 + wechat-protocol.js + wechat.css + `.wx-root` 覆盖层；
  角色级 wechatEnabled 开关；统一时间线 scoped key `wechat_timeline`（跟随剧情分支）；RP↔微信双向衔接。
  验证：tools/refactor/smoke-wechat.cjs（27 项，全过）。详见 docs/ARCHITECTURE.md §7。
- （2026-10-19 已完成）聊天模型选择改成输入框左侧下拉（`#chat-model-menu`）：直接选 `/models` 拉到的模型 + 搜索 + 家族分类；
  快捷面板里的 3 个固定槽位 UI 移除。`settings.model` 是唯一入口，槽位数据（quality/balanced/fast）只留给设置页与角色卡。
  验证：tools/refactor/smoke-chat-model-menu.cjs（16 项）。
- （2026-11-03 已完成）微信单条消息编辑/复制/删除（对齐 RP 消息操作）：气泡外侧「···」+ 固定定位菜单 + 内联编辑；
  生成中禁止改动；编辑用户消息作废空回标记；删除时同步左移前情提要的 coversWechatCount。
  验证：tools/refactor/smoke-wechat-edit.cjs（46 项）。详见 docs/wechat-message-editing.md。
- （2026-11-04 已完成）微信附件 grep 式检索：新增 `wechat-document-search.js`（`parseQuery`/`scan` 纯函数，
  支持 `+必含/-排除/"短语"/~邻近//正则/`），工具链 list → search → read；search 支持省略 messageId 搜最近 10 个附件、
  startChunk/endChunk 限章节，read 支持 startChar 按字符定位。摘录与字符范围严格等于原文切片。
  验证：Node 文档专项 25/25、总 99/99；浏览器文档 25 项。详见 docs/wechat-document-search.md。
- （2026-11-06 已完成）地理 v2：位置证据带 `zone`/`point`/`relation`，context 增加 `reach` 距离表
  （按 `world.landmarks` 现算，锚点优先 character）；提示词强制「移动先有分钟数」；角色卡条目 13 改为
  纯能力声明 + 她对距离的反应函数，删掉卡内分钟断言。世界数据补 23 处 scene、5 个 district label、3 条北三路边。
  修 `map-packages.js` 丢 `landmarks` 的 bug。
  验证：单测 24+3+4、浏览器 smoke 22 项、地图库 E2E 全过。详见 docs/geography-v2-positions.md。
- 待办：北三路西侧通路/师苑性质/教学楼 D—C—B—A 连廊待用户确认；RP 正文回合仍未接入附件工具
  （`tool_grep` 可复用 `RPHubWeChatSearch.scan`）；检索目前是线性扫描，可考虑 Worker + 块级倒排。
