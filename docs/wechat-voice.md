# 微信语音消息与 BreezeBlue 接入交接

> 更新：2026-11-03。上游背景：[微信与 RP](./wechat-and-RP.md)、[单条消息编辑](./wechat-message-editing.md)。
> 本轮目标：同一个人物根据当下关系、场景和情绪，在微信回复中自然穿插语音。保持既有微信样式，不引入组件库。

## 1. 当前实现

- 同一轮聊天模型决定是否回复，以及文字、表情、图片、语音的顺序。语音不是把所有文字自动朗读一遍，也没有独立模型再编一份台词。
- 模型给出实际说话内容 `content` 和简短表演指令 `instructions`。BreezeBlue 只负责把该段台词合成音频。
- 每轮最多两条语音，单条最多 200 个 Unicode 字符，总计最多 300 字；逐条合成，不并发消耗额度。
- 收到的是微信语音气泡：真实音频时长、点击播放/停止、波纹播放态、转文字。一时只播放一条，默认不自动播放。
- “转文字”展开原始合成台词，不调用 ASR，不再收费。
- 语音和图片复用同一个持久化发送批次。所有资源准备成功后才按顺序发送依赖消息；任何资源失败，显示失败与待发送原文，允许手动重试/取消。
- 已成功取得的音频逐条保存。第二条失败后，刷新页面再重试仍可复用第一条；不重新请求聊天模型，也不重复已发消息。
- 微信历史、RP 回灌、前情提要记录 `[语音] 实际台词`。不把声音字节、资源 URL 或语气指令塞进模型历史。

本轮是角色发送的异步语音留言；用户麦克风录音、ASR、实时通话、音色克隆/设计、RP 主动工具直接发语音均未加入。`tool_wechat` 仍只发文字和表情。

## 2. 文档依据与跨域结论

已核对官方文档：

- [Text to speech](https://docs.breezeblue.ai/guides/text-to-speech)：完整文本请求、HTTP 音频、逐句合成。
- [Voice instruction prompting](https://docs.breezeblue.ai/guides/voice-instruction-prompting)：正文与表演指令分开，指令与正文同语言，从情境、意图、情绪强度、节奏中挑两三项。
- [Convert text to speech](https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech)：`POST /v1/text-to-speech/{voice_id}`。
- [List voices](https://docs.breezeblue.ai/api-reference/voices/list-voices)：公共音色目录与 `voice_id`。
- [Realtime browser session](https://docs.breezeblue.ai/guides/realtime-text-to-speech#create-a-browser-session)：实时浏览器方案也要先由后端创建短期令牌。

实测 `https://api.breeze.blue`：有效 Key 的音色 GET 为 200，但不返回 `Access-Control-Allow-Origin`；带 `Origin: null`、`content-type,xi-api-key` 的 TTS OPTIONS 预检为 405。未找到普通 TTS 接口允许任意浏览器来源的配置。终端成功不等于网页能直接请求。

因此加入一个 Node 原生 HTTP 转发服务：

```text
RP-Hub 浏览器 → /api/wechat-voice/synthesize
                  ↓ 本机 Node fetch（不受浏览器 CORS 限制）
                  → api.breeze.blue/v1/text-to-speech/{voice_id}
                  ← 完整 MP3
             ← MP3 → 解码时长 → IndexedDB Blob → 微信气泡
```

Cloudflare Tunnel 为这个**已经包含转发路由**的本机服务提供 HTTPS 入口。只给静态网页套一层 Tunnel、仍从网页直连 BreezeBlue，不能解决上游 CORS。

## 3. 启动与配置

需要 Node.js 20+，无需 npm install：

```powershell
cd D:\aiops_wwx\test\RP-Hub
node tools/wechat-voice-server.cjs
```

打开 `http://127.0.0.1:3000`，进入角色微信 → 设置 → 语音消息：

1. 打开“允许对方自然穿插语音”。
2. 填写 BreezeBlue Key。
3. 填写已有 `voc_…` 音色 ID，或点击“读取中文公共音色”再选择。目录只读前 30 条，不生成音频。
4. 可选填写“说话习惯”，例如“像给熟悉的人留语音，不要播音腔”。
5. 保存，然后正常聊天。Key、音色还没填齐时允许先保存，但不会向聊天模型开放语音能力。

服务地址留空时，HTTP(S) 页面使用当前网站来源；`file://` 页面使用 `http://127.0.0.1:3000`。端口被占用时可改：

```powershell
$env:VOICE_PORT = '3001'
node tools/wechat-voice-server.cjs
```

从原来的静态页面使用这个服务，在微信设置填写它的完整来源，例如 `http://127.0.0.1:3000`。来自 `file://` 和 localhost 的跨域请求已支持。

需要临时 HTTPS 验证时，另开终端：

```powershell
cloudflared tunnel --url http://localhost:3000 --no-autoupdate
```

在终端返回的 `https://…trycloudflare.com` 中打开网页时服务地址留空即可。停止 cloudflared 后该临时入口失效，下次一般是新域名。

如果继续在已有线上 RP-Hub 网站打开页面，只让语音通过 Tunnel，需在启动 Node 前指定实际页面来源，再在微信设置填 Tunnel 地址：

```powershell
$env:VOICE_ALLOWED_ORIGINS = 'https://wangwenxv.github.io'
node tools/wechat-voice-server.cjs
```

多个来源用逗号分隔，必须是完整来源（协议、域名、端口），不是页面路径。

项目实际 GitHub Pages 页面是 `https://wangwenxv.github.io/RP/`，其 Origin 为 `https://wangwenxv.github.io`，白名单不要带 `/RP/`。先把本次前端修改发布到 Pages，再在原页面的微信设置中填写正在运行的 HTTPS 转发服务来源。Pages 只能托管静态资源，不能执行 `tools/wechat-voice-server.cjs`；服务地址留空会请求 GitHub 上不存在的 `/api/wechat-voice/*` 路由。已有文字、表情、图片功能仍沿用原链路。2026-11-03 本轮核对时，线上 HTML 尚未加载新增语音脚本。

长期继续从 Pages 直接使用、又不想本机常驻 Node/Tunnel 时，需要另行部署固定 HTTPS 转发服务（例如云服务或 Cloudflare Worker）。本轮已完成本机转发与临时 Tunnel 验证，没有部署长期云端服务。

**已有聊天记录属于原网页来源的 IndexedDB。** 从 file、localhost、线上网站换到临时 Tunnel 页面，记录不会自动搬过去，也不是原记录被删除。需要继续原有记录时，保留原页面，在那里配置语音转发地址。新建临时域名不宜当持久使用入口。

## 4. Key 与服务边界

- Key 和服务地址保存在当前标签页的 `sessionStorage`。刷新可恢复；标签页会话结束后通常移除，浏览器“恢复关闭标签页/会话恢复”可能恢复它。可以清空 Key 后保存以主动移除。
- Key 不进入角色卡、全局应用 `settings`、IndexedDB 音频任务、聊天模型请求、源码或交接文档。服务每次从请求头取 Key，只转发到固定官方主机，不保留账户默认 Key。
- Node 只监听 `127.0.0.1`。对外只提供 `index.html`、`assets/` 及三个固定语音路由，仓库、`.git`、文档、临时测试文件不会通过 Tunnel 暴露。
- 同源、本地/file 来源，以及明确配置的额外来源可请求。没有任意上游 URL 参数，不是通用代理；上游重定向不跟随。
- 本服务不替用户更改 Key 的预算、账号设置或音色。测试 Key 未保存到任何项目文件，后续使用需填写有效的新 Key。

## 5. 消息协议与自然表达

模型信封示例：

```json
{
  "messages": [
    {"type":"text","content":"刚到家"},
    {"type":"voice_request","content":"怎么啦，慢慢说。","instructions":"像给熟悉的人留微信语音，轻声，语气放松"},
    {"type":"voice_request","content":"我听着呢。","instructions":"语气温和，短句自然落下，不要刻意煽情"}
  ]
}
```

语音能力说明放在完整回复判断规则前，末尾仍保留原来的自然收尾提醒。人物的通信条件、感知、意愿和精力仍优先：没法安全操作手机、不能出声、不方便收听、明确想要文字时，不以语音绕过限制。亲密不要求每轮语音，也不要求永远占据最后一句。

同一条语音不另发一份相同文字当字幕。正文不接受链接或源码，提示词要求不写动作括号和音频标签。本轮没有启用官方 audio tags，先以自然语言 `instructions` 控制语气，减少不支持标签被读出的问题。

当前 API 参数固定为：

```json
{
  "text": "实际说话内容",
  "instructions": "角色的说话习惯。该条消息的语气指令",
  "model_id": "breeze-tts-2-multilingual",
  "language_code": "zh",
  "voice_settings": {"guidance_scale": 2}
}
```

请求 `?output_format=mp3`，鉴权头 `xi-api-key`。音色由配置固定，同一批次缓存 `voiceId` 和说话习惯；两条语音各自保留自己的指令。没有调用收费的指令增强 API，也没有再用 LLM 重写台词。

## 6. 数据与代码位置

实际发送的消息：

```json
{
  "id": "wx-task-…-1", "channel": "wechat", "role": "assistant", "type": "voice",
  "content": "怎么啦，慢慢说。",
  "voice": {
    "assetId": "voice-…", "duration": 4.0, "voiceId": "voc_…",
    "instructions": "该条最终表演指令", "source": "breezeblue"
  }
}
```

| 位置 | 职责 |
| --- | --- |
| `assets/js/wechat-voice.js` | 意图/预算校验、能力提示词、转发客户端、音频解码、独立 Blob 库 |
| `assets/js/app/28-wechat-voice.js` | 设置/音色目录、语音取得、角色/分支校验、单一播放器、URL 回收 |
| `assets/js/wechat-protocol.js` | 新 `voice_request` 解析，非法语音不退化成普通文字 |
| `assets/js/app/25-wechat.js` | 注入能力、按原数组顺序发送、语音历史与 RP 回灌、语音展示字段 |
| `assets/js/app/27-wechat-media.js` | 图片/语音共用批次、逐资源检查点、重试/取消、稳定消息 ID 去重 |
| `assets/js/app/26-recap.js` | 前情提要素材和保留窗口中的语音原文 |
| `assets/js/app/20-character-crud.js` | 删除角色时回收音频资源 |
| `index.html`、`wechat.css`、`app.js` | 语音气泡/设置/加载顺序与模板接线 |
| `tools/wechat-voice-server.cjs` | 无依赖本机静态服务、CORS、固定 TTS 和目录转发 |

脚本层：`wechat-voice.js` 在 `wechat-protocol.js` 前加载；setup 顺序为 `wechat → wechatMedia → wechatVoice → recap`。

| 数据 | 内容 |
| --- | --- |
| 角色 `wechatVoice` | `{ enabled, voiceId, style }`，默认未配置/关闭，旧角色无需迁移 |
| scoped `wechat_timeline` | 真实发送的台词与 `voice` 元数据，按角色×分支隔离 |
| scoped `wechat_media_tasks` | 沿用图片任务键；增加 `voiceConfig` 和按消息下标缓存的 `voices`；无 Key、无音频字节 |
| global `wechat_voice_index` | 音频 ID、ownerId、scopeId、实际时长、voiceId、大小与创建时间 |
| global `wechat_voice_blob_资源ID` | Blob，使用 `{ clone:false }` 写入 |
| sessionStorage `rphub_wechat_voice_key/service` | 当前标签页服务配置，不导出 |

音频读取必须匹配当前 scope。点击播放时从当前时间线查真实消息，不接受任意资源 ID。关闭、切角色/分支、清空记录、删除正在播放的消息会停止播放并撤销 URL。失败可展开台词，但不会冒充播放成功。

单条语音可以删除，不直接编辑合成台词（否则音频与文字会不一致）；原有文字编辑能力不变。单条删除和取消失败批次暂时保留资源，删除角色统一清理其全部音频。现有 RP 导出和分支创建没有新增完整微信音频备份/复制功能。

删除会移除气泡及后续微信/RP 的该条原文，并调整前情提要覆盖计数；不会自动重写以前已经生成的提要正文，与文字/图片删除的既有边界一致。

模型下轮接收文本形式的历史，但保留消息类型。例如用户“说句话”、角色发送“你好”的语音，历史为 `user: 说句话`、`assistant: [语音] 你好`。相邻同角色气泡合并时也保留每条语音的标记，角色能区分自己发的是文字还是语音；不需要额外改成音频输入。该标记不表示对方已经播放过，也不表示模型实际听回了音色或停顿。

## 7. 失败、取消和额度

- 服务端最多一条合成请求，忙时返回 429 与 `Retry-After`；客户端每批顺序请求。每条 90 秒服务端超时，客户端 95 秒超时。
- 没有自动重试。401、402、403、404、422、429 和网络异常有可见提示；刷新不会自动消费额度。
- 准备失败不发依赖文字或假语音，不记作人物主动沉默。失败批次可展开待发送台词。
- 资源检查点与真实消息落盘均可恢复；先查真实消息 ID，再决定是否补发。成功消息优先于落后一个步骤的任务检查点。
- 重试沿用该批次原音色/说话习惯。要更换这批声音，取消批次，修改设置后重新请求聊天回复。
- 缓存文件丢失会明确失败，不把 ID 当作可播放音频，也不会悄悄重新收费生成。
- 关闭/停止会向本机服务及上游传递取消，并用 scope、epoch、AbortSignal 防止旧结果进入新会话。服务已经开始计算时，取消不保证官方退还额度；连接在响应落盘前丢失也可能无法复用结果。

## 8. 验证

默认测试使用 fixture，**不会消耗真实语音或聊天额度**：

测试清理约定（用户明确要求）：每轮测试结束，停止本轮启动的本机服务和 cloudflared，核实端口已释放；不停止用户或其他任务的服务。默认浏览器测试的临时服务器在 `finally` 中关闭，手动启动的 3000 服务和 Tunnel 也必须清理。上轮遗留的语音服务和 Tunnel 已在 2026-11-03 本轮停止，3000 端口确认无监听；先前的临时 HTTPS 链接不再可用。

```powershell
node --test tools/refactor/test-wechat-voice.cjs tools/refactor/test-wechat-silence.cjs tools/refactor/test-wechat-media.cjs
node tools/refactor/smoke-wechat-voice.cjs
node tools/refactor/smoke-wechat-media.cjs
node tools/refactor/smoke-wechat.cjs
node tools/refactor/smoke-wechat-stickers.cjs
node tools/refactor/smoke-wechat-edit.cjs
git diff --check
```

Node 共 66 项覆盖原空回/图片回归、语音协议/预算、CORS、来源和路径限制、官方请求契约、额度错误、并发及取消。浏览器专项使用真实 Vue、IndexedDB、AudioContext 和 Edge 播放器，检查混排、播放/停止/转文字、微信/RP/摘要原文、刷新恢复、缓存复用、晚到结果、资源隔离和删除。

本轮结果：66/66 Node 测试通过；语音、图片、完整微信、表情包（21 项）、消息编辑（46 项）五套浏览器回归全部通过，未出现 JavaScript 错误。语音气泡、转文字与移动端设置抽屉已截图核对。

真实冒烟已通过 Cloudflare HTTPS 页面完成：只请求 **1 次** TTS，脚本“嗯，我在呢。”，中文公共音色 `voc_b86bfwct4cjn`，得到 **25,344 字节 MP3、解码时长 1.584 秒**，浏览器保存、播放、关闭重开均成功。聊天模型输出使用固定信封；这证明实际 TTS 和跨域链路可用，不代表已经评估真实聊天模型选语音的自然程度，或用户最终希望采用该音色。

本地验证产物位于 `.refactor-tmp/`（Git 忽略）：`wechat-voice-live.mp3`、`wechat-voice-live.png`、`wechat-voice.png`、`wechat-voice-settings.png`。这些内容是专用测试角色和测试对话。

有意再次真实合成时才运行下面命令，不能把它加入默认回归任务；环境变量由操作者填写：

```powershell
# BREEZE_TEST_KEY = 有效测试 Key；WECHAT_VOICE_SMOKE_URL = 正在运行的本机或 Tunnel 来源
node tools/refactor/smoke-wechat-voice.cjs --live
```

## 9. 下一步

先由用户选定角色音色，再用真实聊天模型观察安慰、打趣、解释、争执、安静场所、自然收尾等情境。优先调整“何时说、怎样说”，再考虑音色设计/克隆、多语言、audio tags 或用户录音。长期部署应使用固定 HTTPS 服务地址，避免临时 Tunnel 域名变化造成来源和浏览器数据分散。
