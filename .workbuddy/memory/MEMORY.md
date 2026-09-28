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
- 微信聊天子系统集成（需求与挂点见 docs/ARCHITECTURE.md §7；参考工程 D:\aiops_wwx\test\wechat-chat-agent）。
