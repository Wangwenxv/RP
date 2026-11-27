# 本机 Qwen 生图接入

子工程：`C:\Users\25428\Desktop\File_About\RP-image-center`。

本机生图预设为「试验」。早期 GH 一致性 LoRA 对照出现了旧配饰残留和五官漂移，见子工程 `docs/verification.md`。苏祈雪角色 LoRA 的本机对照见子工程 `docs/sqx-rp-verification.md`。

双击子工程 `start.cmd` 后，在 RP 设置 → 生图服务（RP / 微信共用）选择“本机 Qwen 2.1 Turbo”。无需 Key，默认地址 `http://127.0.0.1:7865/v1`。RP 通过 `/v1/jobs` 提交异步任务，参考图为 multipart `image[]`，完成后直接下载 PNG。设置页可打开调试台查看任务与成图。

无参考图片使用工作流中的八步文生图；有参考使用九步、多图条件与一致性 LoRA 0.7。角色人物参考、当前微信服装/背景等参考的顺序和用途继续由共用适配器传递，图片仍进入原媒体库，RP/微信的原有检查点与晚到结果守卫继续有效。

本机有 SQX 权重时，点击「读取可用模型」并选 `qwen-image-2.1-turbo-local-sqx`。角色卡名称为「苏祈雪」且 `selfPortrait: true` 时，RP 将选择 SQX 模型，服务自动补 `sqxv9` 并以 0.70 加载角色 LoRA。其他图片使用普通本机模型。苏祈雪卡里已有的人物参考仍会用于九步编辑。

本地配置仅允许 localhost/127.0.0.1/[::1] 地址。选择该预设会清空 Key；本地请求不会发送 Authorization。切回云预设恢复云协议并要求其 Key。本地超时为30分钟，实际服务按一张图排队执行；用户停止请求时服务会向推理引擎请求取消。

服务按需加载模型。遇到显存分配失败或 Vulkan 设备丢失会自动重试一次，RP 正文显示低显存重试状态。低显存模式可能缩小实际渲染画幅并按请求尺寸输出，调试台会标出实际渲染尺寸。详细参数和出图记录见子工程 README 和 `outputs/`。

回归命令：

```powershell
node --test tools/refactor/test-local-image-generation.cjs tools/refactor/test-image-generation.cjs tools/refactor/test-image-references.cjs tools/refactor/test-image-scene-consistency.cjs tools/refactor/test-rp-image-generation.cjs
```
