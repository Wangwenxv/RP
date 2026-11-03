# 微信语音：本机按需启动与停止

> 日期：2026-11-03。用户明确选择“本机按需启动，结束后停止”。关联：[语音完整交接](./wechat-voice.md)、[GitHub Pages 音色 404 排查](./wechat-voice-pages-fix.md)。保持现有页面样式和聊天数据来源，不部署常驻云端服务。

## 日常操作

本机需安装 Node.js 20.3+ 和 cloudflared，且能在终端执行 `node`、`cloudflared`。本轮机器已具备，不需 npm install。

1. 在项目根目录双击 **`start-wechat-voice.cmd`**，等待显示“语音服务已就绪”和 `https://…trycloudflare.com` 地址。
2. 继续打开原来的 **https://wangwenxv.github.io/RP/**，进入角色微信设置，将该 HTTPS 地址填入“语音转发服务地址”（旧线上版本叫“语音服务地址”）。
3. 填有效 BreezeBlue Key，读取中文公共音色、选定音色、保存设置。角色就能根据聊天情境穿插语音。读取目录不生成音频。
4. 用完双击 **`stop-wechat-voice.cmd`**。出现停止成功后，本机转发与本轮 Cloudflare 均已关闭。

启动窗口可以关闭，后台服务会继续运行；需运行停止脚本结束。重复启动会显示同一运行实例的地址，不再另开一套；重复停止也可直接执行。

**重新启动时临时 HTTPS 地址可能变化，需要更新微信设置。** 地址同时写入 `.refactor-tmp/wechat-voice-local/service-url.txt`，停止时删除，以免误用已失效地址。已选音色随角色配置保留；Key 和转发地址仍是当前网页标签页的会话配置。

保留原 GitHub Pages 页面可继续使用该来源的 IndexedDB 聊天记录。不要为了语音改用临时 Tunnel 域名作为日常聊天入口；新来源不会自动带上原来的记录。

既有线上语音版本已支持填写独立服务地址，因此这套脚本可直接配合当前 Pages 使用。此次新增的空地址拦截、健康检查、目录状态提示，需要按项目原发布流程更新前端后才会出现在 Pages；本轮没有提交、推送或发布。

命令行等价操作：

```powershell
cd D:\aiops_wwx\test\RP-Hub
node tools/wechat-voice-local.cjs start
node tools/wechat-voice-local.cjs stop
```

`.cmd` 默认暂停展示结果，自动化调用可传 `--no-pause`。无需为启动脚本填写 Key，也不要把 Key 加到命令或脚本中。

## 实现

| 文件 | 职责 |
| --- | --- |
| `start-wechat-voice.cmd` | 双击启动入口，UTF-8 输出，保留退出码 |
| `stop-wechat-voice.cmd` | 双击停止入口，可重复调用 |
| `tools/wechat-voice-local.cjs` | 后台服务管理、本机代理、Cloudflare 生命周期、HTTPS 检查 |
| `tools/wechat-voice-server.cjs` | 沿用既有固定 BreezeBlue 转发与 CORS 路由 |
| `tools/refactor/test-wechat-voice-local.cjs` | 无额度启停回归，子进程为本机 fixture |

启动脚本以隐藏窗口运行后台 Node，Node 嵌入原有 `createVoiceServer()`，绑定 `127.0.0.1` 的系统分配空闲端口，因此不占用或抢占 3000。随后启动隐藏的 cloudflared 子进程：

```text
cloudflared tunnel --url http://127.0.0.1:<系统分配的端口> --no-autoupdate
```

`VOICE_ALLOWED_ORIGINS` 自动加入 `https://wangwenxv.github.io`，保留操作者原有的其他许可来源。可用 `CLOUDFLARED_PATH` 指定 cloudflared 可执行文件的完整路径。

提取临时 HTTPS 地址后，最多约 90 秒等待 health GET 和 OPTIONS 预检成功。两者都验证 Pages 的 `Access-Control-Allow-Origin`，health 还需匹配 RP-Hub 服务标记。启动期间只重试这些**不带 Key 的探测**，不调用音色目录或 TTS，不消耗生成额度。

生命周期状态放在 Git 忽略的 `.refactor-tmp/wechat-voice-local/`。独占创建 `state.json` 防止同时双击启动两个实例；每轮有独立随机控制令牌。后台另开一个仅监听 loopback 的控制端口，**不会通过 Tunnel 转发**，且不接受网页 Origin。停止脚本向该端口发送带本轮令牌的停止请求，由后台关闭自己持有的 cloudflared 子进程和 HTTP 监听；不会按进程名、3000 端口或旧 PID 批量杀进程。

启动失败、HTTPS 就绪超时、运行中 cloudflared 退出，会回收该轮服务。无法确认运行实例身份时，停止脚本报错，保留状态供排查，不强制结束其他进程。异常强制结束后台 Node 不属于正常停止流程；可能需要按日志核对遗留 cloudflared，不能据旧 PID 盲目终止进程。

日志为 `.refactor-tmp/wechat-voice-local/service.log`，不记录请求 Key 或合成正文。正常停止保留日志，清理运行状态与临时地址文件。

## 验证记录

```powershell
node --test tools/refactor/test-wechat-voice-local.cjs
```

5 项全部通过：自动端口、重复启动、错误控制令牌、代理上无法调用停止接口、正常停止与重复停止、cloudflared 失败回收、HTTPS 超时、启动中停止、过期状态与 PID 误杀保护、无 Key 健康检查及 Pages CORS。

与 `test-wechat-voice.cjs`、`test-wechat-silence.cjs`、`test-wechat-media.cjs` 合并运行，最终 **74/74 通过**。前端 404 修复后的真实 Vue/Edge 语音浏览器专项亦已通过；本轮启停脚本未再修改前端。

真实网络验证也通过：启动得到临时 Cloudflare HTTPS 地址，health 和 OPTIONS 均确认 Pages 来源许可；再次通过 `.cmd` 启动，PID 和地址保持一致；通过 `.cmd` 停止后，本轮 Node/cloudflared **0 个残留进程**，本轮代理端口、控制端口和 3000 **均无监听**，运行状态已清理。临时地址不写入交接文档或用户配置。

本次启停验证没有调用 TTS、没有读取或修改用户 Key，也没有更改用户聊天或音色配置。此前已在用户原 Pages 标签页通过临时 HTTPS 转发真实读取 30 个中文公共音色，详见 404 修复文档。
