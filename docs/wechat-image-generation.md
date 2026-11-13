# 微信角色按对话生图交接

更新：2026-11-13。沿用工程现有 Vue 与设置控件，无 CWUI 依赖；覆盖原单卡微信与多角色世界微信。接口依据见 [STA1N 实测经验](./sta1n-image-generation.md)。

## 用户入口与行为

设置 → **微信生图**：默认开启能力，默认地址 `https://sta1n.ai/v1`，模型 `nai-diffusion-4-5-full:k_dpmpp_2m`。用户填写自己的 API Key 即可使用。可以读取模型列表、选择模型或手动输入完整 ID，并选择协议与比例。模型列表读取不生成图片；实际生成由供应商计费。原微信设置另保留本角色的允许生图开关，已有明确关闭值继续生效，未设置时允许使用全局配置。

`settings.wechatImageApi` 独立于旧的 `imageGenKey/imageModel`，也不复用聊天 API Key。旧“生图设置”明确标为“RP 自动插图设置”；开启微信按需生图不会启动 RP 每轮自动插图。全局配置随原设置自动保存；完整备份默认递归去掉 API Key，世界包本身不含设置和 Key。

典型交互：

1. 玩家：“你在干嘛” → 角色：“吃饭，黄焖鸡刚端上来”。
2. 玩家：“给我拍拍照，看看你吃啥”。
3. 聊天模型根据对话生成黄焖鸡的画面提示词，返回图片请求。
4. 程序调用所选生图服务，下载、验证并保存像素后，显示真实图片气泡；可以点击放大，刷新后仍可读取。

模型仍根据人设决定是否拍照，不使用关键词硬塞固定饭菜图片。已配置生图时优先生成当前场景；不为了匹配内置沙拉照片改写角色正在吃的饭菜。默认 NAI 偏插画，用户可选择其它适配的模型改善风格。人物自拍当前是文字提示生图，尚无参考图身份锁定。

## 模型协议

原微信与世界微信回复都支持 `messages` 中混排文字和 `image_request`；每个角色的一次决策最多一张图片，最多六个气泡。

```json
{"messages":[
  {"type":"text","content":"给你看看"},
  {"type":"image_request","media":{
    "mode":"generate",
    "prompt":"yellow braised chicken with potatoes and green peppers in a clay pot, bowl of rice, dining table, close-up, warm indoor light",
    "description":"砂锅黄焖鸡和一碗米饭",
    "usage":"scene_photo"
  }}
]}
```

`prompt` 最长 1500 字符，`description` 最长 240 字符。前者仅用于本次生图，后者保存为简短画面说明，不额外发送成角色配文。无 Key 或全局关闭时不向模型提供生图能力，伪造请求也不能触发 API。

原 RP 与世界 RP 的 `tool_wechat` 都可以使用 `image:{mode:"generate",prompt,description,usage}`，与 `content` 二选一。世界工具可指定已认识的收件人 `targetActorId`，发件人始终绑定当前角色，仍遵守手机可用性和一次主动联系限制。图片是立即发送的微信动作，不能伪装成线下动作或附带延后执行参数。

原微信继续提供相册、绘图、搜索、画面描述、玩家上传和查看原图能力。世界微信本次新增的是模型生成图片及展示/备份；世界端玩家上传、相册选择、独立识图工具、语音与文件仍未接入。现有原微信的上传/识图未删改。

## 保存、失败与重试

- 原微信复用 `wechat_media_tasks`、媒体库 Blob/缩略图和批次消息 ID；生图失败保留“重试图片”入口，不发前置承诺文字、不用描述卡片冒充成功，不自动重复付费请求。
- 世界端在生图前保存 `turn.preparedActor`（角色提案、队列步骤、预分配图片 ID）。成功像素单独存为 `world_media_worldimg-…`，世界事件只保存 `type:image` 和 `media` 引用。
- 世界端生成或落消息失败，界面使用原有“继续未完成回合 / 结束此回合”。继续时复用角色提案；已保存像素按预分配 ID 复用，不再请求聊天或生图模型。图片文件未保存前断网/取消可能已在服务端计费，不能保证这种情况不重复费用。
- 原单卡沿用会话 scope/epoch/AbortSignal；世界沿用分支 revision、回合锁和取消检查。旧请求不能把图片发到新会话。文件空间或事务失败不能用“描述兜底”掩盖。
- 群聊每个角色独立产生、提交图片，发言人与访问范围不变；其他角色只有通过既有阅读/观察事件才获知图片。显示 NPC 私密镜头不等于玩家角色知情。
- 生成说明标记 `captionSource:generation_prompt`。历史明确说明“依据生图提示，像素细节尚未核对”，不把生成描述当成真实识图结果；后续模型上下文不重放 Base64、Key 或整段生图提示。

世界包 `.rpworld.json` 附带 `media` 资源表，导出读取所有已发送图片；缺原件时报错，避免交付看似完整的坏包。导入验证资源格式并分配新图片 ID，不覆盖原世界资源。完整备份会收录独立资源存储键。清空世界、回档和删除版本沿用可恢复副本逻辑，保留历史图片供原分支恢复；目前不自动垃圾回收无人引用的世界图片。

## 维护入口

| 文件 | 职责 |
| --- | --- |
| `assets/js/image-generation.js` | 配置、模型列表、三种显式协议、响应取图、超时/取消、像素格式检查 |
| `assets/js/app/02-state-settings.js`、`app.js`、`index.html` | 设置状态、模板导出、微信生图设置 |
| `assets/js/app/27-wechat-media.js` | 原微信能力提示、按需生图、复用媒体任务 |
| `assets/js/app/14-tools-runtime.js`、`25-wechat.js` | 原 RP 主动图片 schema、配置与参数守卫 |
| `assets/js/actor-runtime.js`、`actor-context.js` | 世界模型图片提案与主动工具，仍只控制当前角色 |
| `assets/js/world-orchestrator.js` | 提案检查点、生图执行、失败恢复与原子提交 |
| `assets/js/world-media.js`、`world-store.js` | 独立像素资源与世界包导入/导出 |
| `assets/js/world-components.js`、`assets/css/world.css` | 图片气泡和可关闭的放大预览 |
| `assets/js/world-model.js`、`wechat-media.js` | 图片事件校验、短描述与像素证据边界 |

## 验证方式

```powershell
node --test tools/refactor/test-image-generation.cjs tools/refactor/test-world-images.cjs tools/refactor/test-wechat-media.cjs tools/refactor/test-world-turns.cjs tools/refactor/test-world-store.cjs
node tools/refactor/smoke-wechat-image-generation.cjs
node tools/refactor/smoke-wechat-media.cjs
node tools/refactor/smoke-world-chat.cjs
```

接口单测覆盖标签格式、模型/协议/比例、Markdown/Base64/直接图片返回、CDN 不携带 Key、无 Key/禁用、错误/空成功、超时与取消。世界图片测试覆盖身份/多图限制、私聊隔离、混合气泡、付费后落盘失败复用、世界包往返和原生 RP 图片发送。浏览器测试使用独立 Edge 上下文和 IndexedDB；默认 fixture API，不操作用户存档。真实调用与最终验证结果见本文件后续记录。
