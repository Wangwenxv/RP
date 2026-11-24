# 微信图片按需用于生图与模型跟随

更新：2026-11-24。当前单卡微信可以把本会话已发送的图片按用途交给生图模型，保持原有Vue/UI、图片气泡与工具协议。

## 使用方式

玩家上传衣服后说“穿这件给我看看”，模型可以在愿意发图时选择这张图片作为clothing参考；上传地点图说“在这里拍”，可选择background参考。本人入镜时仍自动带当前角色的人物参考。只拍宿舍、风景、饭菜或物品时填selfPortrait:false，不附人物参考；背景参考也按实际需要选择，没有参考时仍是普通文生图。

tool_view_image负责按消息ID查看真实画面。新图已经在当前视觉请求中，旧图需要核对未保留的细节时才调用查看工具。模型决定生图时，把需要的图写入最终image_request.media.generationReferences；看过图片不自动选中它，也不自动把全部历史图片发给生图服务。tool_load_image_sending按原流程提供生成格式、近期48条记录中的图片目录与可用来源，更早图片仍可以按当前会话里的完整真实消息ID选择。

```json
{"type":"image_request","media":{"mode":"generate","selfPortrait":true,"prompt":"穿参考图中的连衣裙，在参考宿舍中拍一张自然自拍。","description":"宿舍里的新衣自拍","generationReferences":[{"messageId":"衣服图片消息ID","purpose":"clothing"},{"messageId":"宿舍图片消息ID","purpose":"background"}]}}
```

| purpose | 继承范围 |
| --- | --- |
| clothing | 服装款式、剪裁、颜色、图案和材质，优先于人物身份图里的旧服装 |
| background | 背景布局、环境，图中的陌生人不变成当前角色 |
| pose | 动作、姿势，仍服从本轮机位与手部占用 |
| style | 画面视觉风格 |
| object | 本轮需要的物品 |

聊天参考不能指定identity；角色稳定外貌继续来自当前卡的身份参考。每张聊天图指定一个用途，相同ID与用途去重，不允许同一ID给出互相不明确的不同用途。消息ID允许一个前导#，按当前微信时间线查找。不存在、属于其他会话、只有画面描述、资源丢失或取消的图片不能冒充已经送入生成模型。

## 传输与保存

程序先校验整批ID与总数量，再读取完整像素。人物、已选择的卡内地点图和聊天参考合计最多16张；既有单图6MB、参考总24MB与实际图片签名检查保持。支持参考图的OpenAI Images服务继续按配置使用image_data_urls、image_urls或multipart，Chat生图继续使用多模态content；NAI和未启用参考图输入的协议在付费前报错，不悄悄丢掉所选参考。

本轮主请求、查看工具与生成共用临时像素缓存，已读的聊天图和角色参考可复用。临时聊天参考带generationPurpose供生成提示标注用途，不加入角色卡。生成模型收到有顺序的全部选中像素和对应用途；服装、背景等参考不迁移其他人的身份或经历。

媒体任务只保存选图消息ID、用途与原生成计划，像素仍在媒体库。刷新或手动重试时按同一会话重新取得选中的资源；成功生成的资源检查点沿用原逻辑，不重复付费生成。图片气泡和后续对话不保存generationReferences、临时参考像素或generationPurpose。生成描述仍标注为来自生成计划，不冒充已核实的像素细节。

## 微信识图模型跟随

用户截图里的temperature:0.1、stream:false请求属于前置画面观察，而不是角色主回复。旧实现优先读取settings.visionModel，因此即使RP输入框切换settings.model，识图仍可能使用此前配置的qwen3.7-plus。

新增settings.wechatVisionFollowsChat，默认true，旧设置缺少该字段时同样跟随。设置页面“识图模型”下有“微信识图跟随当前聊天模型”复选框：勾选时，微信人物比对、历史图查看与主回复采用当前聊天模型；取消勾选时，识图使用单独的visionModel，主回复仍使用当前聊天模型。RP原有单独识图配置不清空。

一次微信回合开始时固定本轮主模型与识图模型，工具续写使用同一快照；回合中切模型不会让半轮请求混用，下一个回合采用新选择。画面处理状态显示实际识图模型，请求摘要保留原来的请求标签与model字段。

## 验证

197项相关Node回归通过，覆盖实际多图请求载荷、人物与衣服/背景合并、无人物生成、像素缓存、非法批次、资源丢失、停止/切会话、任务重试和模型跟随/独立两种模式；语法与diff检查通过。模拟结果验证组装与执行边界，不证明真实模型自主选图的稳定性或最终生成画面已准确复现。

浏览器专项使用本地fixture API、独立来源与IndexedDB，22项检查通过，0页面JavaScript错误。真实Vue模型选择器切换后，微信主请求和独立比对均采用新模型；生图实际收到的图片数为5（人物3＋服装1＋背景1）、1（仅背景）、0（无参考），通过图片数据SHA-256核对所选微信消息和传入像素一致。报告和截图存放于`.refactor-tmp/wechat-generation-reference-check/report.json`和`browser-check.jpg`。接口不会连接真实服务商，不新增付费测试。

维护入口：image-generation.js、wechat-media.js、app/27-wechat-media.js、app/25-wechat.js、app/14-tools-runtime.js负责格式与执行；app/02-state-settings.js和index.html负责模型跟随选项。
