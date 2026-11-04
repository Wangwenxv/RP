# 微信界面与拖入附件交接

更新：2026-11-04。承接 [长文档阅读](./wechat-documents.md)，本轮优化微信桌面/移动端布局、附件拖入和文件预览。使用用户指定的 `frontend-design` 技能，继续沿用现有 Vue 3、经典 script 与微信 CSS；按用户要求没有使用 CWUI 或新增 UI 库。

## 1. 设计方向

这是与 RP 人物私下聊天的窗口，主要任务是读消息、回复与分享附件。保留微信的左右气泡和绿色语义，让布局承担质量感：安静的背景、统一线形图标、明确文字层级与对齐，附件用带绿色书脊的“小封面”识别，而不是系统 emoji。

截图中的主要问题是工具图标风格混杂、过长的占位文字、所有按钮挤在一行、姓名下方无意义的空状态高度，以及桌面只把手机内容放大。方案调整为：

- 桌面：960px 上限的居中聊天窗口，外缘 24px 留白。顶栏、消息区和输入区共用边界；输入文字占独立一行，工具和发送按钮下一行。
- 手机：全宽聊天，不额外加桌面边框。附件/表情、消息输入和发送仍在一行，连发开关放到下一行，不挤占正文输入宽度。
- 空会话：保留人物头像/名字，邀请用户发近况、照片或小说，提供附件入口说明，不写虚假的在线状态。
- 文件：白色卡片、文件类型、大小和打开方向；预览用页码和整理百分比，隐藏“分块/隔离读者”等实现细节。

桌面概念布局：

```text
┌ 返回 · 人物头像/姓名                    相册 设置 清空 ┐
│                     日期                              │
│ 对方气泡                              我的气泡         │
│                                        文件小封面      │
├ 输入文字，按内容自动增长                               ┤
│ 附件 表情                              连发    发送     │
└ 拖入提示                         Enter/Shift Enter     ┘
```

颜色仅集中在 `.wx-root` 变量，后续规则引用变量或由 `color-mix` 派生：

| 语义 | 变量 | 值 |
| --- | --- | --- |
| 云灰聊天背景 | `--wx-bg` | `#f3f6f4` |
| 白色表面 | `--wx-bar` / `--wx-bubble-peer` | `#ffffff` |
| 细边界 | `--wx-line` | `#dfe7e2` |
| 深绿正文 | `--wx-text` | `#243c32` |
| 次级文字 | `--wx-muted` | `#75857e` |
| 微信绿色 | `--wx-accent` | `#15825b` |
| 我的气泡 | `--wx-bubble-me` | `#daf1e4` |

标题使用 Microsoft YaHei UI / PingFang SC，正文 Microsoft YaHei / PingFang SC 优先，英文与工具数据使用 Bahnschrift / Segoe UI；没有额外下载字体。字号为标题 18px、正文 15px、辅助 11–12px；移动输入 16px 避免部分手机聚焦自动放大。

## 2. 拖入操作

在微信窗口内拖入一张图片或一个文本文件，显示接收区域；松手后通过现有上传流程进入待发送区，用户点击发送才产生消息或 API 请求。拖入接收区设置 `pointer-events:none`，不拦截下方真实 drop 事件。

本轮保留一次一个文件的产品行为。拖入多个文件会提示“请一次拖入一个文件”，不会静默选择第一个。生成中、图片处理或文档处理期间拒绝添加新附件。普通文字/链接拖拽交给浏览器原生行为，不统一 `preventDefault`。

`dragDepth` 统计嵌套 dragenter/dragleave，避免跨子元素时接收提示闪烁。drop、Esc、关闭微信、切角色或分支都会复位。拖出聊天窗口后深度归零，提示消失。

Windows 文件拖入可能没有 MIME，或为 `application/octet-stream`。对 png/jpg/jpeg/gif/webp/bmp/avif 明确推断 MIME，通过 Blob slice 添加格式提示，不复制整文件；现有 rasterizer 仍检查文件预算并实际解码像素，扩展名不意味着图片一定有效。失败照常报错。

## 3. 代码挂点

| 文件 | 改动 |
| --- | --- |
| `assets/js/app/29-wechat-documents.js` | 拖拽状态/深度、四个事件处理、忙碌守卫、MIME 归一化、共用上传、输入框高度、中文 IME 保护、大小/类型显示工具 |
| `assets/js/app/25-wechat.js` | 图片选择允许受支持的扩展名提示；既有发送/上下文/资源协议保持原行为 |
| `assets/js/app.js` | 新状态、拖入与输入事件、文件显示辅助的模板接口 |
| `index.html` | 微信根元素拖拽事件，内置 SVG symbol、顶栏/空会话/文件卡片/预览/输入区与拖入层 |
| `assets/css/wechat.css` | 微信变量、字体层级、间距/对齐、桌面 Grid 输入区、移动断点、预览 Flex 收缩和减少动态效果 |
| `tools/refactor/test-wechat-documents.cjs` | 拖入、嵌套进出、多文件/忙碌守卫、空 MIME 路由、中文输入法与 Enter 测试 |
| `tools/refactor/smoke-wechat-layout.cjs` | 真实 Vue/Edge/DataTransfer、5 个宽度、输入增长/复位、文件预览、截图与回归 |

图标 symbol 只存在于微信根元素内，使用 `wx-i-*` ID 与 `wx-icon` 描边样式，没有第三方图标包。SVG 的 viewBox 统一 24×24，大小 21px、描边 1.7；这让工具栏图标在 Windows/手机浏览器上保持一致。

文件卡片明确同时覆盖 `.wx-row .wx-bubble.document` 和 `.wx-row.me .wx-bubble.document`，避免普通 outgoing 气泡背景覆盖文件样式。手机断点同样覆盖两者；预览页头/页码/操作区不可收缩，正文 `min-height:0` 允许内部滚动，短屏也能操作。

输入区自动增长，移动端最多 128px、桌面最多 180px。发送后/清空文字回到单行，打开面板或 resize 后重新测量。模块注册 resize 监听，在 Vue 卸载时解除。普通 Enter 发送、Shift Enter 换行；`isComposing` / keyCode 229 时不阻止输入法确认，更不会误发送。

## 4. 验证

```powershell
node --test tools/refactor/test-wechat-documents.cjs tools/refactor/test-wechat-media.cjs tools/refactor/test-wechat-silence.cjs
node tools/refactor/smoke-wechat-layout.cjs
node tools/refactor/smoke-wechat-documents.cjs
node tools/refactor/smoke-wechat-media.cjs
node tools/refactor/smoke-wechat-voice.cjs
node tools/refactor/smoke-wechat-edit.cjs
git diff --check
```

Node 文档专项增加为 **15/15**；文档/图片/沉默合计 **75/75**。新布局浏览器 **22 项通过**，覆盖 320、375、430、768、1366px 无横向溢出、输入框宽度与按钮不重叠、文件拖入/真实落库、空 MIME 图片解码、正文高度增长/复位、页码、减少动态效果、多文件拒绝和关闭复位。既有文档、图片、语音和单条消息编辑（46 项）浏览器回归通过，浏览器零 JavaScript 错误，语法与 diff 检查通过。

模型为 fixture，不使用真实 Key；验证的是界面与应用链路。手机宽度在 Edge 中模拟，尚未在实体 iPhone/Android 上验证系统文件选择器或系统拖入行为。

截图目录 `.refactor-tmp/`：

- `wechat-layout-desktop-empty.png`：桌面空会话。
- `wechat-layout-desktop-drop.png`：拖入接收区域。
- `wechat-layout-desktop.png`：桌面消息与文件。
- `wechat-layout-mobile.png`：430px 手机消息与输入栏。
- `wechat-layout-mobile-document.png`：375×640 短屏文件预览。

## 5. 后续维护

附件格式与存储预算仍以长文档交接为准，本轮没有增加 PDF/DOCX，也没有支持批量文件队列。将来支持批量时需要同时重做待发送模型、图片/文档数量预算和失败重试，不应在 drop handler 里简单遍历并覆盖当前 pending 值。

界面继续使用原生 Vue 和 `wx-*` CSS。后续调整先核对宽窄屏截图，再改共享样式；不要仅靠桌面截图决定移动输入框宽度，也不要向按钮、气泡或文件卡片重新混入 emoji 工具图标。
