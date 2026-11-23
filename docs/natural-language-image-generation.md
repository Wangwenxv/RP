# 自然语言生图与参考图

2026-11-23 补充：自然语言图片加入「身份、视觉偏好、当前场景」分层与付费前画面计划校验。新增规则详见下方；旧请求保持兼容，NAI 载荷不变。

## 自拍的继承边界

人物自拍既提供身份，也提供视觉偏好，不能简单收缩成只参考脸：

| 来源 | 如何使用 |
| --- | --- |
| 脸型、五官关系、肤色 | 保持人物身份；具体发型服从角色设定和当前剧情 |
| 衣品、妆容、表情、自拍角度、常见手势 | 作为可迁移偏好，在本轮天气、情绪、活动、手部占用和机位允许时借鉴；不能凭单张图认定永久偏好 |
| 麦克风、演出造型、雨伞、背景、地点 | 需要本轮场景依据，不能默认继承；本轮演出、授课、录制确实需要设备时允许保留 |

每张卡可以在现有「参考图说明」中独立说明这些边界；资料随卡保存，保持与人设、世界书及供应商参数独立。程序在自然语言请求中整合该卡当前选中的参考说明。苏祈雪三张照片已补充各自的妆容、表情、姿势与偶然设备说明；原人设、三张参考图像素和16条世界书未改写。

聊天模型按完整上下文拟定 `scene`，再写自然语言 `prompt`。画面计划字段：`location`、`action`、`framing`、`props` 必填；可补 `time`、`clothing`、`lighting`、`avoid`，世界地图可带 `placeId`。明确借鉴某张本人的姿势可填 `poseReferenceId`，必须是当前绑定角色的人物参考图，不能借用其他人的图或地点图。

```json
{"mode":"generate","selfPortrait":true,"prompt":"下课后的教学楼走廊自拍，清爽针织衫，轻浅微笑，空闲手比V，柔和室内灯光。","scene":{"location":"教学楼走廊","time":"傍晚，天已黑","clothing":"米白针织衫与外套","action":"课后自然自拍，空闲手轻轻比V","framing":"手机前置上半身，另一只手在画面外持机","lighting":"柔和室内灯","props":["手机"],"avoid":["头戴麦克风"]}}
```

所有自然语言实际请求追加完整的参考用途和场景优先级说明；直接将短描述透传的旧请求也获得新的取舍规则。外部场景描述仍最多1500字符，场景计划最多1800字符，合成绘图请求最多6000字符；过长拒绝，不截断事实。原 NAI 最多1500字符，不套自然语言模板。

校验在付费前进行：普通自拍的 `props` 要求麦克风但 `action` 没有相应用途、同物件同时位于 `props/avoid`、普通夜间要求直射阳光、世界图片的显式 `placeId` 与本人确认位置不同，都会报错。原微信与世界人物可用既有的一次格式修正机会修正计划；重复矛盾停止，不发前置承诺、不调用生图；图片接口故障仍不自动重付费。旧任务没有 `scene` 时保持兼容，不能宣称程序已完整审查旧提示的语义。

当前聊天模型只读参考目录和说明，没有自动把所有参考像素发送给聊天模型；生成模型实际看到参考图。目录文字不能证明已识图。程序的校验是有限的确定性检查，不能证明每一句场景描述有真实依据，也不能检查尚未生成的像素。自动视觉分析或生成后视觉审核会增加模型调用，当前未默认启用，更不自动循环付费重画。

一次真实对照仍使用原三张图片，参考第三张的比V动作，场景为三月傍晚校园、朴素针织衫与外套。新 PNG 为 **2,079,720字节**，在 `.refactor-tmp/image-scene-consistency/live/suqixue-selfie.png`，完整提示与单次付费报告为同目录 `live-report.json`。目视检查：比V保留、无头戴麦克风、米白针织衣着、窗外暗与走廊灯相容；头发长度仍未完全符合提示中的齐肩要求。本例验证了取舍改善，不能据一次图片宣称身份或所有细节完全锁定。

新增回归覆盖视觉偏好与姿势保留、麦克风的合理/不合理用途、字段守卫、跨角色姿势、地图地点与原微信/世界的有界修正。**161项回归通过，20项隔离浏览器检查通过**；浏览器模拟一次校园自拍道具矛盾，修正后仅调用一次生图，刷新不重复生成。

```powershell
node --test tools/refactor/test-image-scene-consistency.cjs tools/refactor/test-image-generation.cjs tools/refactor/test-image-references.cjs tools/refactor/test-wechat-media.cjs tools/refactor/test-world-images.cjs
# 模拟聊天与生图，实际浏览器验证先修正矛盾、再调用一次生图
node tools/refactor/smoke-wechat-photo-flow.cjs --yeelo --scene-conflict --card card/suqixue/苏祈雪v2.json --out .refactor-tmp/image-scene-consistency/browser
# 单次真实生图，可能计费，保留原来的实测图片
node tools/image-generation/test-yeelo.cjs --scene-selfie --out .refactor-tmp/image-scene-consistency/live
```

2026-11-23。RP 正文插图、原单卡微信、世界微信与世界 RP 使用同一生图适配器，兼容自然语言 Images / Chat 生图和原 STA1N NAI。

## 使用

设置 → 生图服务（RP / 微信共用）→ **YeeMagine · gpt-image-2.6**，填写当前站点 API Key。预设使用：

- 地址：`https://img.yeelo.fun/v1/images/generations`，也可只填 `https://img.yeelo.fun/v1`。
- 模型：`gpt-image-2.6`。
- 参考图：JSON `image_data_urls`，请求 `/v1/images/edits`。
- 返回格式：`b64_json`。该站点生成请求支持浏览器跨域，但实测 URL 图片 CDN 没有 CORS 响应头，网页直接下载失败；使用 Base64 避免依赖 CDN 跨域。

切换不同站点预设会清空密钥，避免将原站点密钥发送到新站点。`/models` 不保证列出生图模型：实测该站点返回三个聊天模型，未列出 `gpt-image-2.6`，因此保留手动输入模型名称。

角色编辑 → **参考图**，或微信设置 → **生图参考图**，可添加人物/地点照片。人物图在 `selfPortrait:true` 时自动加入；饭菜、风景、其他人物用 `false`，不套当前角色的脸。地点图填写名称和说明，模型按本轮场景选择 `referenceIds`。世界模式在编辑世界的人物名册中也可管理各自参考图，保存新世界版本后生效。

最多保存并发送16张参考图。网页上传先验证并压缩；单张编码上限约6MB，总计约24MB。参考图随 JSON/PNG 角色卡、世界包、全量备份保存，聊天只收到小型资料目录，图片字节只发给生图服务。微信历史保存生成结果资源 ID 和画面说明。目录属于资料，不能覆盖当前请求或角色身份。

当前 `card/suqixue/苏祈雪v2.json` 已嵌入同目录 `sqx1.jpg`、`sqx2.jpg`、`sqx3.jpg`。原人格、开场、UI、正则、地理扩展与 **16条原世界书**保持原样。已有存档需重新导入更新的卡，或在参考图编辑项添加三张照片；既有世界需更新绑定卡并保存新世界版本。

## 格式由工程提供

| 分类 | 聊天模型的生图格式 | 请求 |
| --- | --- | --- |
| 自然语言 · Images API | 连贯的中文或英文画面描述 | 无参考图 `/images/generations`；有图按配置 `/images/edits` 或 `/images/generations` |
| 自然语言 · Chat 生图 | 连贯的画面描述 | `/chat/completions`，参考图为 `image_url` 内容块，需服务支持 |
| 其他 · STA1N NAI | 英文逗号分隔标签组 | `/chat/completions`，由适配器组织正面、通用负面词、画师、尺寸和采样器 |

说明随当前生图配置动态提供给按需微信发图工具、原 RP 主动微信、世界人物决策和正文插图。新角色无需生图专用正反词人设。自然语言协议不拼接旧角色外貌配置的正反词，不发送 NAI 参数。NAI 仍可根据原人设生成标签组，参考图像素不会发送给 NAI。

历史 NAI 存档的独立 `imageIdentity` 保留读取兼容；自然语言请求忽略它，原生编辑表单已改成参考图。旧命令 `patch-suqixue-image-identity.cjs` 现在是**清理入口**，不会再追加生图人设。清理只删除已知的追加段落和“苏祈雪·本人生图外貌”条目，保留原人设中的自然外貌描述。

```powershell
# 清理旧资料、嵌入三张人物图，先备份，重复执行不重复添加
node tools/character-cards/attach-image-references.cjs card/suqixue/苏祈雪v2.json card/suqixue/sqx1.jpg card/suqixue/sqx2.jpg card/suqixue/sqx3.jpg
```

卡扩展：`data.extensions.rp_hub_image_references`；应用字段：`imageReferences`。

```json
[{"id":"ref-example","name":"本人正面照","kind":"character","description":"人物身份参考","dataUrl":"data:image/jpeg;base64,..."}]
```

微信或主动微信图片意图：

```json
{"mode":"generate","selfPortrait":true,"prompt":"拍一张下课后的自然手机自拍，人物身份保持参考照片，米白针织衫，教学楼走廊的柔和夕阳，略带害羞的笑容。","description":"课后的自拍","referenceIds":[]}
```

自然语言正文插图用 `image###{"prompt":"自然语言画面描述","selfPortrait":true,"referenceIds":[]}###`；NAI 保留 `image###英文标签组###`。参数在计费前验证，仍沿用原图片缓存与检查点：刷新不自动重付费，失败不假装已发图、不切站点、不自动重试付费请求。

## 通用接口边界

`/v1/images/generations` 是常见的 OpenAI 风格路径，不保证所有站点完全一致。通常至少需要 **Base URL、API Key、模型名称**；参考图、尺寸和返回格式仍由供应商决定。

YeeMagine 前端示例将参考图发到 `/v1/images/edits`，支持 `image_data_urls`、`image_urls` JSON 和 multipart 文件。OpenAI 编辑使用 multipart `image[]`，部分 GPT Image 模型不接受 `response_format`，所以 OpenAI 预设默认不传该字段。其他兼容站可选择 JSON 或 Chat 参考图方式；应用保存本地图片 Data URL，选择 `image_urls` 时也要求服务接受 Data URL。

仅支持远程 URL、异步轮询、特殊签名或其他私有协议的服务需要额外适配。URL 下载不携带 API Key；接口与下载地址必须支持浏览器 CORS。参考图有助于保持人物身份，不保证每次完全同脸，仍需查看生成结果。

## 验证

生产适配器真实调用 `gpt-image-2.6`，提交三张人物图片到 `/v1/images/edits`，返回 PNG **2,114,669字节**，约 **82秒**。图片 `.refactor-tmp/yeelo-image-generation/suqixue-selfie.png`，同目录报告 `live-report.json`。Key 只从 `tmp/key.txt` 读取，不写入代码、卡或报告。

浏览器测试使用隔离 Edge/Vue/IndexedDB，聊天决策为 fixture。`--live-image` 仅让图片请求和下载直连真实服务，不能将 fixture 决策称为真实聊天模型决策。常规运行不读 Key、不计费：

最终验证：**154项回归通过**；参考图上传、用途编辑、保存、移除和服务切换 **20项浏览器检查通过**；原 NAI RP 插图 **10项通过**；世界 UI **32项通过**。真实浏览器 Base64 生图 **15项通过**：POST HTTP 200，返回体 **2,936,243字节**，保存 WebP **137,088字节**，刷新保留三张参考图与生成图片，不重新计费。报告 `.refactor-tmp/yeelo-photo-flow/live-base64/live-report.json`，图片同目录 `live-image.webp`。

卡片语义对比确认：除新增 `rp_hub_image_references` 外，更新卡与备份完全一致；原16条世界书保留，没有生图正反词人设。修改文件与新增文件中未发现本地 API Key。

```powershell
node --test tools/refactor/test-image-generation.cjs tools/refactor/test-image-references.cjs tools/refactor/test-card-image-identity.cjs tools/refactor/test-rp-image-generation.cjs tools/refactor/test-wechat-media.cjs tools/refactor/test-world-images.cjs tools/refactor/test-world-store.cjs tools/refactor/test-world-turns.cjs tools/refactor/test-world-backup.cjs tools/refactor/test-full-backup.cjs
node tools/refactor/smoke-wechat-photo-flow.cjs --yeelo --card card/suqixue/苏祈雪v2.json --out .refactor-tmp/yeelo-photo-flow/fixture
node tools/refactor/smoke-rp-image-generation.cjs
# 一次真实生图，可能计费
node tools/refactor/smoke-wechat-photo-flow.cjs --yeelo --live-image --card card/suqixue/苏祈雪v2.json --out .refactor-tmp/yeelo-photo-flow/live-browser
```
