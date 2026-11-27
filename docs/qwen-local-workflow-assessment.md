# Qwen-Image-2.1-Turbo 本地备用生图与工作流审查

审查日期：2026-11-25。对象：RP 工程的共用生图适配器，以及用户提供的 `▶▷Qwen2.1-Turbo-9步-编辑&扩图&移除&重绘&生图（整合）.json`。

> 后续实现状态：INT8 权重与 C++ 引擎已实际出图，RP 接口链路已接入；人物换场景的身份保持未通过效果验收。本文保留实施前的审查记录，其中“尚未出图”等表述仅对应当时阶段。实际对照见 `RP-image-center/docs/verification.md`。

## 更新：先试 INT8（用户最新选择）

用户希望参考低显存运行案例，优先尝试更高精度的 INT8。针对本机 8GB 显存、32GB 内存，这个试验合理；初版 Q4 建议保留为后备。后文的 Q4 配置表和启动例是原保守方案，本节为当前下载选择。

进一步确认：用户希望以提供的工作流为实现依据。**当前下载目标是下表三份 INT8 基础权重，再加编辑分支已启用的 `Qwen2.1 一致性无偏移_GH_V1.0.safetensors`，共四份。** 编辑采用原工作流九步、Euler、CFG=1、一致性 LoRA 0.7；文生图采用其八步分支，不挂这份编辑 LoRA。其余 PE、扩图、移除、换头、换身权重仍不在当前需求内。

下表三份基础权重总文件体积约 16.10 GiB，另加一致性 LoRA 的实际大小（尚未读取该文件）：

| 文件 | 字节数 | GiB |
| --- | ---: | ---: |
| `qwen_image_2.1_turbo_int8_convrot.safetensors` | 7,256,787,829 | 6.758 |
| `qwen3vl_8b_int8_convrot.safetensors` | 9,350,798,360 | 8.709 |
| `qwen_image_2.1_vae_bf16.safetensors` | 675,509,688 | 0.629 |

两份 INT8 文件在 `Comfy-Org/Qwen-Image-2.1` 分别位于 `diffusion_models/` 与 `text_encoders/`；VAE 位于 `vae/`。维护者的 C++ 文档明确列出 INT8 convrot safetensors 编码器路径。该打包编码器不像独立语言 GGUF 方案那样需要再配一个 `mmproj`；PE 模型及其 mmproj 仍无需下载。

迁移时还要复现参考图片顺序、等比例约 1 MP/整除 32 的预处理、第一张参考默认输出尺寸、关闭 PE 的开关和 prefix cache 策略。ComfyUI JSON 不能直接提交给 C++ 引擎；一致性 LoRA 的具体权重键名、INT8 主模型上的应用方式和跨引擎效果需单独验证，不能仅根据扩展名声称可直接加载。原换装示例中“姿态和背景完全不变”的任务文本需要按 RP 本轮实际画面替换。

INT8 的量化误差通常更小；Q4_K_M 为以 4-bit 为主的混合量化，模型更小，通常有更多显存余量。二者并不是采样步数或图片尺寸档位，也不能据此给出固定画质提升、同脸率或速度倍数。GGUF 与 safetensors 是打包格式；这两份模型还使用不同的量化方法，不能将差异归结为仅改变一个 bit 数。

试验依然需要卸载和分阶段执行。先保留 INT8 权重，把 TE/VAE 放到 CPU，扩散计算使用 GPU，并允许参数卸载/分层适配；以官方八步、两张参考、单任务、768×1024 起步。之后逐项增加参考数量与尺寸，记录实际峰值和耗时。文件体积不是显存峰值，32GB 物理内存也不是全部可用内存；较低配置的“能跑”案例需要结合其卸载、缓存、尺寸和时间才能比较。

如果压力或耗时主要来自编码器，下一步可保持扩散 INT8，仅将编码器切换为 Qwen3VL GGUF Q4＋对应视觉投影器；无需立即把两部分同时降到 Q4。本次仍未执行模型推理。

## 结论

**适合作为本地备用方案，可以完全不依赖 ComfyUI。推荐优先验证 `stable-diffusion.cpp / sd-server`，用官方 Turbo 八步作为基线，再比较这份工作流的九步和一致性 LoRA。**

这份文件有可复用的多图编辑流程，但它不是已经验证适合 RP 的“一键最佳方案”。其默认提示是保留原照片构图的换装；RP 示例需要保留人物身份、改变服装与场景及摄影机位，任务更复杂。8GB 显存下还要控制参考图尺寸、数量、缓存和并发。

本次完成的是代码、图结构、官方资料、模型文件清单和本机硬件审查。没有下载模型权重、安装推理环境、真实出图或修改生产生图代码。因此不把人物保持、秒数、显存峰值或成功率写成实测结论。

## 一、实际包含哪些工作流

提供的目录中只有 **1 个 JSON 文件**，212,407 字节，包含 **154 个节点、177 条连接、5 条主要任务分支**。三处额外图片分组不是独立模型流程。静态校验未发现连接两端记录不一致。

| 分支 | 对 RP 的用途 | 取用建议 |
| --- | --- | --- |
| Qwen-image21-图像编辑 | 人物参考＋服装/背景/姿势参考，生成当前画面 | **主要取用对象**；抽出核心链，不直接沿用换装示例 |
| Qwen-image21-生图 | 食物、风景、物品等无参考图请求 | **第二条必要链**；人物身份保持需要编辑链 |
| 局部重绘 | 对已有成图的指定区域修正 | 后续扩展；需要原图、遮罩和裁剪回贴 |
| 图像扩展 | 扩大已有图像画布 | 后续扩展；不是创建新的 RP 场景的默认路径 |
| 元素移除 | 去除已有照片中的指定内容 | 后续扩展；依赖涂色/遮罩及专用 LoRA |

保存时只有移除分支的 `SaveImage #38` 处于 mode=0。编辑与文生图主计算节点处于 mode=4（绕过），所以原文件当前默认状态不能当作自动多图生图服务。

整张图声明了五类第三方包：Goohaitools、rgthree、LayerStyle、Comfyroll、Easy-Use。移除、扩图、重绘主要使用孤海的遮罩、裁剪、缩放和回贴节点；这不是模型原生接口必须具有的依赖。编辑/文生图基础推理可以使用 Comfy 核心节点，或直接换成另一种推理引擎。

文件中的“复制到其他页面会错连提示词、尺寸、VAE”是作者留下的注意事项。当前原图的静态连接完整，但剪裁复制后仍需重新校验，不能只根据界面位置重建。

## 二、多图编辑分支的具体审查

核心链：`UNETLoader #460 → Power Lora Loader #459 → QwenImage21Cache #446 → CFGGuider #450 → SamplerCustomAdvanced #444 → VAEDecode #429 → SaveImage #422`。

条件来自 `CLIPLoader #452`、`VAELoader #453` 和 `TextEncodeQwenImage21 #430`；噪声、采样器、时间步分别来自 `RandomNoise #456`、`KSamplerSelect #443` 和 `ManualSigmas #467`。

关键细节：

- `#430` 实际连了 **三张图**，第四个输入存在但未连接。要完整输入示例的三张 identity 加一张 clothing，必须扩展输入或调整选图，原样运行并没有四图。
- 图片先由 `#448 / #432 / #455` 缩放到每张约 **1 MP**，整除数 32；`#430 resolution=0` 继续使用这些预处理尺寸。不是把三张原始小图直接低成本送入模型。
- `#426 自定义尺寸=false`，默认使用 `#430` 根据第一张参考生成的空 latent，**输出尺寸跟第一张处理后的参考走**。它不是将第一张原图作为待去噪的底图，但长宽比和训练编辑对齐仍会影响结果。RP 请求的新画面应明确决定输出尺寸。
- `#437 提示词优化=false`；当前没有启用额外的 PE 改写模型。`BatchImagesNode #451` 是给改写模型聚合图片，真正的生成条件是 `#430` 的独立图片输入，不应把所有生成参考合成普通 batch 来替代它。
- `#459` 启用了 `Qwen2.1 一致性无偏移_GH_V1.0.safetensors`，强度 **0.7**；换头、换身 LoRA 关闭。文件名不能证明它在新场景自拍中锁定脸部，也不能证明它只保持脸而不妨碍姿态/场景变化。
- 编辑分支的 CFG 是 **1**，采样器是 **Euler**，采样列表为九步：

```text
1.0, 0.978453, 0.954180, 0.926626, 0.895080,
0.845148, 0.704534, 0.414568, 0.150000, 0
```

官方 Turbo 的八步列表是：

```text
1.0, 0.978453, 0.95418, 0.926626, 0.89508,
0.845148, 0.704534, 0.414568, 0
```

九步是在末段增加 0.15 的经验方案，并非官方默认。当前文生图分支 `#489` 自己就使用官方八步。建议做八步无 LoRA、九步无 LoRA、九步一致性 LoRA 三组对照，不能只比步数就判定更好。

默认换装提示要求原图的发型、妆容、姿态、身体比例、背景全部不变。**这些限制不能直接复制进用户示例**：当前场景允许改变造型、背景和机位，只要求稳定面部身份保持。

## 三、完全不用 ComfyUI 的两条路线

### 推荐：stable-diffusion.cpp

已核对维护者的 Qwen 2.1 专用文档、Turbo recipe、服务端 API 文档以及服务端源码：

- 原生支持 Qwen-Image-2.1 和独立 Turbo 权重。
- 支持 Windows、CUDA 和 GGUF 量化。
- 支持文字生图、多张参考图编辑；CLI 用重复的 `-r` 保持图片顺序。
- Turbo recipe 设置 Euler、CFG=1、8 步及固定 sigma 列表。
- `sd-server` 提供 `/v1/images/generations`、`/v1/images/edits`，返回 `data[].b64_json`。
- 编辑接口使用 multipart `image[]`，**不能照搬云 API 的 JSON `image_data_urls`**。
- 服务端源码处理 OPTIONS 并提供跨域响应头；这确认了实现存在，仍需在实际浏览器部署中验证本机网络权限。
- `/v1/models` 当前固定返回 `sd-cpp-local`；请求体里的 `model` 不用于动态加载对应权重。加载哪个模型由启动参数或本地模型管理接口决定。

因此结构可以直接是：

```text
RP 网页 → http://127.0.0.1:1234/v1 → sd-server → 本机 CUDA / CPU → 图片 Base64 → 现有媒体库
```

既不需要 ComfyUI 网页，也不需要它的 Python 服务和节点包。现成工作流只用于提取图片处理、采样及参考用途等配置；`sd-server` 不会执行 ComfyUI JSON。

### 另一条：官方 Diffusers

官方提供 `QwenImage21Pipeline`，文字生图和多图编辑共用它；`image` 可为 PIL 图片列表。可自行包一个 FastAPI 服务。

优点是方便写自定义图片预处理、提示编译、身份参考选择和遮罩处理；代价是需要 PyTorch、Transformers、Diffusers 等环境，8GB 下还要额外选择合适的量化/分层卸载方案。**仅调用 `enable_model_cpu_offload()` 并不能证明某个完整 bf16 组件放得进 8GB。**

不要将 Comfy 的单文件量化权重视为可以无条件交给 `from_pretrained()` 的官方目录。它们的打包和加载器契约不同。

官方安装示例要求最新 Diffusers 源码以及支持对应模型的 Transformers。Turbo checkpoint 自带时间步配置；只设置 `num_inference_steps=9` 不会覆盖它。Diffusers 的 `sigmas` 参数不包含终端 0，与上述 Comfy/C++ 完整列表的接口约定不同。

## 四、这台机器该如何配置

本次硬件读取：RTX 4060 Laptop，8188 MiB 显存，驱动 592.82；物理内存 34,049,155,072 字节，约 31.7 GiB；C 盘剩余约 94 GiB（瞬时读数）。

适合先验证量化＋卸载，不能据此承诺四图 2K、固定耗时或稳定成功。

`sd-server` 推荐试验文件组合，体积来自本次 ModelScope 仓库清单读取：

| 组件 | 文件 | GiB |
| --- | --- | ---: |
| Turbo 扩散模型 | `unsloth/Qwen-Image-2.1-Turbo-GGUF` 的 `qwen-image-2.1-turbo-Q4_K_M.gguf` | 3.911 |
| Qwen3-VL 文本编码器 | `Qwen/Qwen3-VL-8B-Instruct-GGUF` 的 `Qwen3VL-8B-Instruct-Q4_K_M.gguf` | 4.682 |
| 独立视觉投影器 | 同仓库 `mmproj-Qwen3VL-8B-Instruct-F16.gguf` | 1.079 |
| 2.1 专用 VAE | `Comfy-Org/Qwen-Image-2.1` 的 `qwen_image_2.1_vae_bf16.safetensors` | 0.629 |
| 合计 | 不含运行时、输出与临时文件 | **约 10.30** |

**独立 GGUF 编码器做图像编辑还需要 mmproj。只下载扩散 GGUF、普通语言编码器和 VAE 会漏掉这一项。** 使用打包了视觉权重的其他编码器时按其加载方式处理，不能混搭猜测。

此前 Comfy 方案中的 `qwen3vl_8b_w4a8.safetensors` 不是这张表中的 GGUF 编码器；其量化格式/后端支持需要单独确认。VAE 必须匹配 2.1，不能换成旧 Qwen Image 或 Wan 2.2 VAE。

建议首次验证：

1. 主身份图一张＋服装图一张；身份参考长边先约 768、服装约 512～768，均保持比例、对齐 32，不把小图强行放大。
2. 输出先用 `768x1024`，单任务、`n=1`；这只是试验起点，不是经测量的最大能力。
3. 官方八步、CFG=1、Euler、不挂增强 LoRA、不另加载 PE 模型。
4. 保持默认缓存作为画质基线；根据实际显存峰值再尝试 CPU 缓存或量化缓存。C++ 文档给出的示例中，4096 条件 token 的单份 prefix cache 在 f16 下约 2 GiB，尚不含权重和工作缓冲；长提示及多参考图的代价不能忽略。
5. 若显存仍不足，先将 TE/VAE 放到 CPU，或减少参考像素/缓存；记录耗时再优化。Q5 扩散文件约 5.020 GiB，不应作为这台机器的第一档。

启动结构示例（需先准备兼容的 CUDA 发行版和上述权重；本次没有执行）：

```powershell
# 从放置 sd-server.exe 的目录运行；模型路径按实际存放位置修改。
.\sd-server.exe `
  --listen-ip 127.0.0.1 --listen-port 1234 `
  --diffusion-model .\models\qwen-image-2.1-turbo-Q4_K_M.gguf `
  --llm .\models\Qwen3VL-8B-Instruct-Q4_K_M.gguf `
  --llm_vision .\models\mmproj-Qwen3VL-8B-Instruct-F16.gguf `
  --vae .\models\qwen_image_2.1_vae_bf16.safetensors `
  --backend 'diffusion=cuda0,te=cpu,vae=cpu' --params-backend cpu `
  --sampling-method euler --cfg-scale 1 --steps 8 `
  --sigmas qwen-image-2.1-turbo
```

这里用 CPU 执行 TE/VAE 作为保守起点；它可能显著增加耗时。之后可以按实测尝试 `--backend cuda0` 和参数自动适配/卸载。源码分支的选项会变化，安装时应核对该发行版 `--help`，并锁定通过验证的版本。

## 五、与现有 RP 工程的适配

现有共用入口为 `assets/js/image-generation.js`：

- `base()` 接受 HTTP 本机地址。
- `payload()` 已能无参考时发 JSON `/images/generations`，有参考时发 multipart `/images/edits`。
- `generate()` 已按原顺序上传 `image[]`。
- `candidates()/extract()` 已识别 `data[].b64_json`，并进行图片像素验证。
- RP、微信和世界模式共享该服务，图片继续进入原有媒体库。

本次离线调用了实际 `payload()`：两图请求生成正确的本机 `/v1/images/edits` 地址、两份文件和 `768x1024` 尺寸；无图请求生成 `/v1/images/generations`。**仅验证序列化，没有用虚拟图片冒充模型出图。**

验证阶段的配置应为：

```json
{
  "baseUrl": "http://127.0.0.1:1234/v1",
  "model": "sd-cpp-local",
  "protocol": "openai-images",
  "referenceMode": "multipart",
  "referenceEndpoint": "images/edits",
  "responseFormat": "b64_json",
  "size": "768x1024"
}
```

目前 `ready()` 强制非空 Key，`generate()` 总会发送 Authorization。没有鉴权的本地服务若仅用现有 UI 临时验证，可使用无实际凭据的 `local` 标记；正式适配应新增明确的本地配置并支持无 Key，不复用云服务 Key。该标记不提供访问保护。

产品化改造主要集中在：

1. **本地预设与独立备用配置**：避免每次手动覆盖云服务设置；参考图、尺寸、采样策略明确绑定本地模型。
2. **在 `characterRequest()` 阶段选择参考并重新生成编号**：该函数现在会自动选择所有人物参考。裁减不能放到提示生成之后，否则提示的图4可能实际变成图2。保留显式姿势参考的来源关系。
3. **按本地能力编译画面提示**：保留原场景事实、人物身份与当前造型的优先级；只压缩模型输入，不改写故事或持久人物卡。
4. **按任务设置尺寸、图片预处理与 GPU 队列**：RP 一轮可能出多张、世界角色也可能同时请求；8GB 服务一次执行一张，不能仅限制单次请求 n。
5. **超时与真正取消**：当前默认五分钟且只有 AbortSignal。同步 OpenAI 兼容接口没有向客户端暴露任务取消契约，断开 HTTP 不应等同于已经释放 GPU。需要完整进度/取消时使用 C++ 原生异步 jobs API 并轮询到 cancelled，或写本机桥接服务。
6. **备用切换策略**：先提供显式“本地生成/本地重试”；要自动切换时区分明确失败与云端状态未知，继续遵守已有检查点、资源保存和晚到结果守卫。

为最初的生图验证，无需先重做上述所有产品能力。若要求完整的自动备用、并发和取消，再在共用适配层落实它们。`presence-server` 当前只有更新检查等接口，不是已经存在的本地生图代理。

## 六、用户示例提示词是否合适

**任务方向合适：中文指令、身份参考、换装和新场景都是该模型支持的方向。原始长提示可以作为对照输入，不能因其冗长就断言模型不接受。**

但它混合了故事资料规则、参考角色说明和最终画面要求；模型接受文字不等于逐条执行规则。需要重点处理：

- **同人多图**：三张 identity 可能帮助补足角度，也可能带来造型、背景和身份干扰。没有证据证明“必然平均脸”或“多图注意力对称所以主图无效”。低显存基线先只送最合适的一张主图；第二张身份图应通过对照决定是否值得加入。
- **服装参考的人脸**：即使声明 clothing，图里另一张脸仍可能干扰。可裁成清楚的服装区域，裁剪不能丢失本轮需要的版型与图案；困难时再考虑分割。无需先用文字重造主参考的五官。
- **图序号**：保留实际上传顺序，优先使用训练模板的 `<image1>`、`<image2>` 来指代。`role: identity/clothing` 是工程语义，模型 API 没有由此自动隔离面孔的结构参数。
- **机位**：本轮英文明确 mirror selfie，应编译成镜面自拍，不同时强调默认前置摄像头视角。原模板有例外规则，但直接明确当前机位更少歧义。
- **服装冲突**：若 clothing 图片不是白色红心睡衣，要先按本轮确认事实决定服装来源，不能同时强制两种衣服。本次没有读取那张微信服装图的像素，不能假定其内容。
- **负面文字**：本地 pipeline 接受 `negative_prompt`；只是推荐 Turbo CFG=1 时不会运行负向 CFG。正面提示内的“不添加人物”等语句仍属于文本条件，不能宣称完全无效；是否遵守需看图。不建议仅为了负向词提高 Turbo CFG。
- **PE 改写**：官方推荐用 PE 扩展短提示；对已经带有严密身份/场景边界的长提示，应先关闭通用扩写。正式编译若用语言模型，必须校验它保留了身份、服装、机位等事实，而不是把关闭所有改写当成永久规则。

编译示例，假设 clothing 图确实对应本轮确认的白色红心睡衣，实际只送主身份与服装两张图：

> 生成一张自然真实的手机镜面自拍照片。画面中只有一位年轻成年中国女性，她的面部身份来自 `<image1>`，保留该图的脸型和五官比例；发型、衣着、表情和环境按本轮要求改变。`<image2>` 仅提供睡衣的款式、剪裁、颜色、红心图案和材质，人物面部仍以 `<image1>` 为依据。她在普通宿舍浴室的镜子前，一只手持手机拍摄，手机、手臂与镜面反射的空间关系一致，另一只手自然放松。头发齐肩、柔软并别到耳后，穿白色长袖红心睡衣上衣与配套短裤。她略微脸红，带羞怯而紧张的浅笑。取景能看到睡衣上衣与短裤，暖色室内荧光灯，日常手机照片质感，自然身体比例与真实皮肤细节。当前姿态、浴室环境和持有物按这段画面描述生成。

这不是保证同脸的“万能提示”。作为对照应保留原长提示，并检查新提示是否丢掉了本轮必要信息；无需套用英文-only、固定 400～500 词的 PE 风格要求。

## 七、如何验证“能拿出来用”

建议用固定参考、同一组种子、相同输出尺寸，逐项改变一个因素：

| 对照 | 要回答的问题 |
| --- | --- |
| 原长提示 vs 编译后的画面提示 | 是否减少道具/机位混乱，有没有丢事实 |
| 主身份＋服装 vs 三身份＋服装 | 多身份图是否改善脸部或引入干扰；速度和显存代价 |
| 服装整图 vs 清楚的服装裁图 | clothing 图中的陌生面孔是否影响身份 |
| 官方八步 vs 九步 | 额外 0.15 时间步是否改善该场景 |
| 九步无 LoRA vs 一致性 LoRA 0.7 | 是否改善脸部，同时限制换姿态、衣服或背景 |

使用多组种子，记录冷启动、热运行、峰值显存和失败情况。验收看稳定五官、服装、地点、镜面持机、手部、是否混入参考背景/设备；人脸相似度只能辅助，不能替代对透视和妆容变化的检查。

跨引擎即使使用相同种子、采样列表，也不能保证像素一致。九步/LoRA 效果先在同一引擎内比较；移除/重绘的专用 LoRA、裁剪回贴若迁移到 C++，还要确认权重键名和条件处理兼容，不能只换一个模型路径。

## 八、对工程中旧评估的修正

现有 `qwen-image-2.1-turbo-assessment.md` 可作为此前资料记录，但以下结论本次未找到足够的出图证据，不能沿用为验收标准：

- “覆盖 70–80% 意图”“本机 1–3 分钟/张”“8GB 四图需 768～896”等数值没有本次推理实测支持。
- 本地支持 `negative_prompt`，CFG=1 不用负向分支与云 API 不接受某个字段是两件不同的事。
- 云 API 的长度上限不能直接移到本地 pipeline；本次看到的官方 Diffusers 文本处理没有设置 4500 字符截断。字符数也不等于 tokenizer 的 token 数，图像条件还会扩大序列和缓存。
- 多身份参考融合是需要评估的风险，不是必然结果；保留参考像素，不用自行概括的脸部文字取代所有补充身份图。
- “无需 ComfyUI”有现成原生实现，不需要从零开发整套扩散推理器。

## 资料与核对记录

- [Qwen-Image-2.1 官方仓库](https://github.com/QwenLM/Qwen-Image-2.1)：Turbo、参考图能力、Diffusers、缓存、PE。
- [Diffusers QwenImage21Pipeline 源码](https://github.com/huggingface/diffusers/blob/main/src/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py)：图片列表、文字处理、负向 CFG 与保存的 sigma。
- [stable-diffusion.cpp Qwen 2.1 文档](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/models/qwen_image_2.1.md)：多图、GGUF/mmproj、Turbo 参数、prefix cache。
- [C++ Turbo recipe](https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/recipes/qwen-image-21-turbo.json)。
- [C++ HTTP API 文档](https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/api.md)、[OpenAI 路由源码](https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/routes_openai.cpp)、[服务入口源码](https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/main.cpp)。
- [C++ 后端和卸载文档](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/guides/backend.md)。
- [Comfy 核心 Qwen 节点](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_qwen.py)、[官方 Turbo 编辑模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_turbo_image_edit.json)。
- [Comfy 模型清单](https://modelscope.cn/models/Comfy-Org/Qwen-Image-2.1)、[Turbo GGUF](https://modelscope.cn/models/unsloth/Qwen-Image-2.1-Turbo-GGUF)、[Qwen3-VL GGUF](https://modelscope.cn/models/Qwen/Qwen3-VL-8B-Instruct-GGUF)。

资料快照与静态审计保存在 `.tmp-review/qwen-local-research/`（Git 忽略目录）。`audit.json` 包含原文件 SHA-256、节点配置、文件字节数和实际适配器序列化结果。原工作流及原评估文件均保留。
