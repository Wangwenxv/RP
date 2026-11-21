# RP 生图与微信统一交接

更新：2026-11-21。

## 原问题与结果

旧单卡 RP 自动插图在 `07-image-gen-autosave.js` 中向 `https://nai.sta1n.cn/api/jobs` 提交任务并轮询；微信使用 `image-generation.js`，默认向 `https://sta1n.ai/v1/chat/completions` 发送 NAI 标签请求。旧 RP 使用 `imageGenKey/imageModel/imageSize`，微信使用 `wechatImageApi`，两套协议和密钥不能混用。本次依据代码确认了配置和协议脱节，未实测旧服务是否仍在线。

现在 RP 正文插图与原微信、世界微信共用 `settings.wechatImageApi` 和 `RPHubImageGeneration.generate()`：API 地址、Key、模型、协议、比例相同。原微信配置无需迁移；旧 `imageGenKey` 保留为历史设置但不再发送，也不自动当作新 API 的 Key。

RP 继续使用 `image###英文画面提示###` 正文标记、单独的「自动生图」世界书开关和期望数量（原 2～8 张）。微信继续根据人设和对话决定是否发图、每个角色一次决策最多一张。底层接口相同不代表发图策略或提示词相同。RP 的 NAI 画师风格写入「画师串:」，其它协议不强套 NAI 参数；微信原有固定外貌与 `selfPortrait` 行为不变，RP 标记仍依赖正文模型提供的人物画面提示，不推断本人入镜。

## 使用方式

1. 刷新或重新打开工程的 `index.html`。
2. 设置 → **生图服务（RP / 微信共用）**，开启服务并填写 Key。已有微信生图配置直接复用。默认地址 `https://sta1n.ai/v1`，协议 `sta1n-nai`，模型 `nai-diffusion-4-5-full:k_dpmpp_2m`。
3. RP 聊天开启「自动生图」。风格与期望数量仍在「RP 自动插图设置」中；实际比例和模型使用共用设置。
4. 图片卡片右下角「重新生成图片」会手动请求新图。失败后可通过同一按钮重试。

连接检测改为调用共用提供商 `/models`，不再以旧站点的 `no-cors HEAD` 当作成功。不支持模型列表的服务可能检测失败，读取列表本身也不能保证某个模型能生图。删除旧的剩余图片次数显示，因为不同提供商没有统一的余额接口。

## 保存、费用与取消

- 等 RP 正文和工具续写完成后再生图，避免流式半截提示产生多次请求。
- 生图前先把 `message.generatedImages[index] = {prompt,status:'pending'}` 保存到原分支聊天。刷新后的 pending/failed 任务显示错误并等待手动重试，不自动重复付费。
- 成功像素使用与微信相同的媒体库，原图 Blob 与缩略图独立保存到 `wechat_media_blob_* / wechat_media_thumb_*`；RP 消息只存 `prompt/assetId/status/width/height`。不把 Key、Base64 或 object URL 放进聊天记录。
- 原图已保存但聊天记录落盘失败时保留 assetId，手动重试先复用已保存像素。原件确实丢失时需用户手动重新生成；生成或媒体落盘前中断仍可能已在服务端计费。
- 五分钟超时、响应取图和像素验证复用共用适配器。失败不会用描述卡片冒充图片，也不自动重发请求。
- 停止生成、编辑/回档/清空、切角色/分支及卸载会中止任务并回收 object URL。守卫校验分支、会话 revision、任务 epoch、原消息和对应提示，晚到结果不能写入新会话。
- `08` 在恢复角色数据完成后重新加载插图；切分支完成也触发加载。只有图片的消息使用宽布局，避免失败卡片缩成零宽，导致错误与重试按钮不可见。
- 全部分支 JSONL v2 的资源收集与导入重映射新增 RP `generatedImages[].assetId`，同一媒体库仍支持完整备份。旧版本导出没有这些新资源时不能凭空恢复原图；历史旧插图未缓存像素的首次展示会使用新接口生成。历史图片资源暂不自动垃圾回收。

## 维护入口与验证

- `app/07-image-gen-autosave.js`：正文标记、任务、检查点、图片卡片和手动重试。
- `image-generation.js`：共用协议适配器，新增可选 artists；微信空画师行为不变。
- `app/10-methods-core.js`：显示阶段逐条编码提示，绕开旧正则中的地址和 Key；图片消息宽布局。
- `app/20-character-crud.js`：系统图片正则不再含远程生成 URL 或 Key。
- `app/27-wechat-media.js`：将同一媒体库暴露给 RP，避免两个索引写入器相互覆盖。
- `app/08-scoped-uitemplate.js`、`11`、`19`、`23`：恢复、连接检测、停止和卸载。
- `branch-chat-utils.js`：RP 图片随聊天导出/导入。

```powershell
node --test tools/refactor/test-rp-image-generation.cjs tools/refactor/test-image-generation.cjs tools/refactor/test-wechat-media.cjs tools/refactor/test-world-images.cjs tools/refactor/test-conversation-clear.cjs tools/refactor/test-full-backup.cjs tools/refactor/test-world-backup.cjs
node tools/refactor/smoke-rp-image-generation.cjs
node tools/refactor/smoke-wechat-image-generation.cjs
```

新增 RP 单测覆盖共用协议/Key/比例、检查点、保存像素、重试复用、取消与跨分支晚到、资源导出/导入，以及提示中的引号/加号/与号。RP 浏览器专项 10 项通过；微信/世界生图浏览器专项 11 项通过。浏览器均使用独立 Edge 上下文、隔离 IndexedDB 和 fixture API，不读取用户 Key 或存档，也未实际消费生图额度。真实供应商调用、账号余额、浏览器 CORS 和生成画面语义需要在用户环境实际使用时确认，fixture 图片不作为真实提示效果验收。

历史 `tools/refactor/verify.cjs` 是最初 662 个 setup 声明拆分时的校验，当前工程新增模块已超出其 manifest，并且没有它依赖的 `assets/js/app.js.new`，因此不能作为当前功能验收。本次改动的 JavaScript 另用 `node --check` 检查语法。
