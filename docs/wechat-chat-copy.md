# 微信聊天记录复制交接

更新：2026-11-23。上游入口：[微信与 RP 实现交接](./wechat-and-RP.md)、[架构交接](./ARCHITECTURE.md)。

## 使用方式与范围

单角色微信顶栏新增「复制记录」按钮；手机宽度下显示复制图标，按钮的可访问名称为「复制聊天记录」。点击后可直接粘贴到文本编辑器或其他聊天窗口。空会话禁用；复制过程中防止重复点击，成功或失败均有提示。

复制当前角色、当前剧情分支时间线中的全部已发送微信消息，按原有顺序逐条输出。即使屏幕只显示最近 80 条、历史已被前情提要覆盖，原文仍包含在复制结果里。RP 背景、系统提示、日期分隔、输入草稿、未发送的媒体任务不参与。切换分支尚未加载完成时提示稍后重试，避免复制上一个作用域的记录。此入口位于原单卡 `.wx-root` 页面；多角色世界独立会话页面没有接入。

每条格式为「发送者 日期 时间」一行，正文下一行，消息之间空一行。例如：

```text
王文叙 11/20 下午5:43:50
再试最后一次看看

杨德兵 11/20 下午5:45:28
【image：桌面上的门户配置截图】

杨德兵 11/23 上午11:55:15
【语音 13秒】
```

## 字段规则

| 内容 | 复制结果与数据来源 |
| --- | --- |
| 玩家姓名 | 当前 `user.name`，空值用「我」 |
| 对方姓名 | `wechatPeerName`，与顶栏一致；备注空值时用角色名 |
| 时间 | `RPHubWeChatTime.itemTime(item)`：优先 `storyAt`，旧数据从 `ts` 取本机日历；输出 `M/D 上午/下午h:mm:ss`，无有效时间时省略时间 |
| 文字 | `content` 原文，保留正文中的换行和空行 |
| 图片 | `media.caption` 已存描述，输出 `【image：描述】`；没有描述为 `【image】`，不识图、不查资源、不复制 URL 或旧 `content` 中的 data URL |
| 语音 | `voice.duration` 的有效正数向上取整，与气泡时长一致，输出 `【语音 xx秒】`；缺有效时长为 `【语音】`，不复制转写正文、合成指令或音频资源 |
| 表情 | `【表情：content】`，缺名称用「表情」 |
| 文件 | `【文件：document.name】`，缺名称用「文件」，不读取附件全文 |

`storyAt` 的 UTC 字段编码虚构日历，复制时不能再做本机时区换算。上午/下午按 `<12` 与 `>=12` 区分，0 点显示上午12点，12 点显示下午12点。时间与顺序均来自记录，复制不推进剧情钟。编辑后复制最新已保存正文；正在编辑的未保存草稿不参与。

## 实现与维护入口

| 文件 | 入口 |
| --- | --- |
| `assets/js/app/25-wechat.js` | `wechatCopyBody` 与 `wechatCopyTime` 格式化；`buildWechatTranscriptText` 读取完整时间线；`copyWechatTranscript` 做作用域、空记录、防重复和结果提示；`isWechatCopying` 为操作状态 |
| `assets/js/app/25-wechat.js` | 私有 `writeWechatClipboard` 优先 `navigator.clipboard.writeText`，缺失或拒绝时使用临时只读 textarea + `execCommand('copy')`；清理节点并恢复原焦点、文字选择和输入框光标；双重失败显示错误 |
| `assets/js/app.js` | 将 `copyWechatTranscript`、`isWechatCopying`、`buildWechatTranscriptText` 暴露给根模板 |
| `index.html` | `wx-i-copy` SVG 与 `.wx-copy-records` 顶栏按钮 |
| `assets/css/wechat.css` | 复用微信现有颜色变量与按钮样式；手机隐藏文字标签，顶栏留间距 |

原单条菜单「复制」仍只复制文字正文，复用剪贴板兼容逻辑。完整记录在点击时同步形成文本快照，再异步写剪贴板；复制中到达的新消息在下一次点击时包含。此操作没有存储写入、数据迁移、模型请求、媒体加载或额外组件依赖，沿用现有 Vue/CSS 样式。

## 验证

在仓库根目录运行，浏览器脚本依赖 `tools/refactor/node_modules/playwright-core` 和本机 Edge：

```powershell
node --test tools/refactor/test-wechat-transcript.cjs tools/refactor/test-wechat-time.cjs
node tools/refactor/smoke-wechat-transcript.cjs
node tools/refactor/smoke-wechat-edit.cjs
git diff --check
```

单测覆盖格式、多行正文、多种媒体、105 条历史、剧情/旧时间、空数据、编辑后复制、新旧分支隔离、复制快照、防重复、API 缺失或拒绝及双重失败。时间回归同时覆盖原有剧情钟链路。

浏览器专项通过真实 Vue 页面点击按钮并读取系统剪贴板，核对文本与示例一致；检查桌面、390px 和 320px 手机顶栏、长备注、单条复制及真实降级复制后的输入焦点/光标和节点清理。Windows 剪贴板的 CRLF 仅在断言时归一化为 LF。截图保存在被忽略的 `.refactor-tmp/wechat-transcript-desktop.png` 与 `wechat-transcript-mobile.png`。

本轮实测：复制与剧情时间单测 23/23、复制浏览器专项 12/12、原消息编辑/删除回归 46/46 通过。已查看桌面及手机截图；`git diff --check` 无空白错误。

复制入口不会要求网络或媒体服务；浏览器自身拒绝两个复制方式时会显示失败，不会提示已成功。
