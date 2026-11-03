# GitHub Pages 公共音色 404 排查与修复

> 日期：2026-11-03。上游：[微信语音接入交接](./wechat-voice.md)。本轮直接操作用户已经打开的 `https://wangwenxv.github.io/RP/` 内置浏览器标签页，没有创建或改写聊天消息。

## 问题与结论

线上已经发布语音功能。微信设置中 Key 已填写，语音开关开启，但“语音服务地址”和音色 ID 尚未填写。点击“读取中文公共音色”后，页面显示 `语音服务返回 HTTP 404`。

原因是旧 `serviceBase('')` 对所有 HTTP(S) 页面返回 `location.origin`。在 Pages 上就会请求 `https://wangwenxv.github.io/api/wechat-voice/voices`；Pages 不运行 Node 路由，因而返回 404。Key 和 BreezeBlue 目录接口都没有出错。

## 当前网页实测

1. 在用户原有的微信设置页点击目录按钮，复现 404。
2. 启动使用随机端口的本机转发服务，并设置 `VOICE_ALLOWED_ORIGINS=https://wangwenxv.github.io`。
3. 使用 cloudflared 临时 HTTPS 域名，在原页面的服务地址**草稿**中填入该来源。
4. 再次点击目录按钮，成功读取 **30 个真实中文公共音色**，出现“选择音色”下拉框。
5. 没有调用合成接口，没有选择/保存用户音色，没有修改 Key、角色人设和聊天记录。
6. 验证后恢复服务地址原草稿、停止本轮 Node 与 cloudflared，确认 3000 和本轮随机端口均无监听。临时域名没有保存到用户配置。

证明的是 Pages → HTTPS 转发 → BreezeBlue 音色目录的真实连通性。**本轮未部署永久云端后端**，停止临时服务后不能把该域名当作正式配置。

截图：`.refactor-tmp/wechat-voice-catalog-live.png`，测试产物不提交 Git。

## 代码修复

| 文件 | 变化 |
| --- | --- |
| `assets/js/wechat-voice.js` | GitHub Pages 来源（显式填写或留空回退）提前报告需配置独立转发地址；拒绝把 BreezeBlue 官网/API 当成转发服务；检查明显的 HTTPS→公网 HTTP 配置错误 |
| 同上 | 发 Key 前先 GET `/api/wechat-voice/health`，只接受 `{ok:true,service:"rphub-wechat-voice"}`；探测不携带 Key，8 秒超时，不自动重试 |
| 同上 | 目录接口 404、服务标记不符、返回 HTML 或错误目录结构分别给出可操作的错误信息 |
| `assets/js/app/28-wechat-voice.js` | 无有效服务配置时不向模型开放语音；设置面板显示目录成功/失败状态；不完整语音配置仍可先保存其他微信设置 |
| `index.html`、`assets/js/app.js` | 明确标注“语音转发服务地址”，说明 Pages 需独立 HTTPS 服务；显示已读取数量或错误原因，避免只显示短暂 toast |
| `tools/refactor/test-wechat-voice.cjs` | 增加 Pages/官网误配置、错误服务不发送 Key、确认服务后才取目录等回归 |

`file://` 继续默认访问本机 3000；由本机语音服务打开的网页仍可留空使用同源服务。已有转发服务已经提供 health 标记，无需为此次健康检查更改其 API。

健康标记只用于识别配置错误，不代替对所填服务运营方的信任；用户仍应填写自己控制或信任的服务。

## 正式使用仍需完成的配置

用户已选择“本机按需启动，结束后停止”。已提供根目录 `start-wechat-voice.cmd` / `stop-wechat-voice.cmd`，自动建立 HTTPS 转发并允许 Origin `https://wangwenxv.github.io`（不带 `/RP/`）。使用时在原 Pages 设置中填脚本返回的地址，用完停止；重新启动可能需要换地址。详见 [本机语音运行交接](./wechat-voice-local.md)。

现有线上版本已经支持填写独立服务地址，可立即配合脚本使用；此次前端错误提示修复仍需按原流程发布后上线。本轮没有执行发布。

不能通过改变 Pages 的 URL 拼接、设置 `no-cors` 或只套一个静态页面 Tunnel，让 GitHub Pages 执行后端程序。也没有把默认更新检测域名当成语音服务：未确认该服务归属和授权前，不向其发送用户的 BreezeBlue Key。

## 验证

```powershell
node --test tools/refactor/test-wechat-voice.cjs tools/refactor/test-wechat-silence.cjs tools/refactor/test-wechat-media.cjs
node tools/refactor/smoke-wechat-voice.cjs
git diff --check
```

语音 Node 专项 9 项、原图片/沉默 60 项，合计 **69/69 通过**。完整语音浏览器专项通过，覆盖原有混排、播放、文字展开、持久化、刷新重试、作用域和清理逻辑，无 JavaScript 错误。该回归合成为 fixture，不消耗真实额度。本轮真实联网验证只有目录读取。
