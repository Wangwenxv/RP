# RP-Hub、RP-train、RP-image-center 交接

记录更新于 2026-11-27。本文用于新会话接手苏祈雪（SQX）的生图、LoRA 训练和云端推理联调。

## 背景和目标

用户想在 RP 正文和微信剧情中生成像角色本人会拍的真人照片。苏祈雪是第一位验证角色，目标是在换衣服、光线、角度和场景后，脸型及五官关系仍能辨认，同时保留自然的手机随拍感。GPT Image 2 是用户认可的画质和构图参照。当前 Qwen 链路已经能用于出图和调参，正脸一致性、构图遵从和配饰残留仍需按场景验收。

现有路线把训练、推理和 RP 业务放在三个相邻目录里。推理直接跑原生 C++，训练用 DiffSynth-Studio，整条链路可以在未安装 ComfyUI 的情况下工作。Image Center 用 Comfy 工作流 JSON 读取启用节点的采样和 LoRA 参数。

## 三个工程怎么串起来

| 工程 | 本机路径 | 职责 |
| --- | --- | --- |
| RP-Hub | `D:\aiops_wwx\RP-Hub` | RP 正文、微信、多人世界、角色卡及聊天媒体。根据剧情生成画面描述、挑参考图、调用图片接口并保存返回的图片。此次联调分支为 `multi_agent`。 |
| RP-train | `D:\aiops_wwx\RP-train` | 云端训练脚本、选图清单、数据包、训练出的 SQX LoRA 和效果对照。记录时是独立目录，未初始化 Git。 |
| RP-image-center | `D:\aiops_wwx\RP-image-center` | FastAPI 图片服务、任务队列、调试台和 stable-diffusion.cpp 启动管理。加载底模、GH 编辑 LoRA 和可选的 SQX 角色 LoRA。此次联调分支为 `main`。 |

```text
训练  RP-Hub 的训练照片 → RP-train 选图和训练 → SQX LoRA 放进 RP-image-center
出图  RP / 微信 / 多人世界 → RP-Hub 图片适配器 → RP-image-center → stable-diffusion.cpp
回传  stable-diffusion.cpp 的图片 → RP-image-center API → RP-Hub 聊天媒体库
```

- 训练照片在 `RP-Hub/card/suqixue/sqx/`，共 44 张。用于日常运行的角色卡是 [苏祈雪v2.json](../card/suqixue/苏祈雪v2.json)，其中首张身份参考 [sqx1.jpg](../card/suqixue/sqx1.jpg) 是用户试出的默认图。卡片里的 `sqx2.jpg` 和 `sqx3.jpg` 还能按需参与有明确用途的对照。
- 人物 LoRA 从 RP-train 的 `results/` 复制到实际运行的 RP-image-center 的 `qwen2.1-turbo/`。FastAPI 启动时检查权重，随后在模型列表注册 SQX 模型。运行 RP-Hub 和 Image Center 时无需启动 RP-train。 [训练入口](../../RP-train/README.md) · [推理入口](../../RP-image-center/README.md)

## 接着用现有的生图环境

| 地址或路径 | 用途 |
| --- | --- |
| `http://127.0.0.1:9999/` | 本机 RP-Hub 网页。在 RP-Hub 根目录可以用 `python -m http.server 9999` 启动。 |
| `http://127.0.0.1:17865/studio` | 本机浏览器通过 SSH 转发打开云端 Image Center 调试台。 |
| `http://127.0.0.1:17865/v1` | RP-Hub 配置里的云端 Images API 基础地址。 |
| 云端 `127.0.0.1:7865` | 同一台 AutoDL 实例内的 FastAPI 网关，由本机 `17865` 转发到这里。原生引擎默认使用实例内部的 `7866`。 |
| 云端 `/root/autodl-tmp/RP-image-center` | 上次部署的持久盘目录，含代码、权重、输出、日志和 Python 环境。 |

写本文时，`9999` 返回 HTTP 200，本机 `17865` 未监听。上次验证的云端部署成功，当前云机开机状态需要到 AutoDL 控制台核实。继续云端任务时，先确认原实例和云端服务状态，再用实例当前的 SSH 信息恢复本机转发。在 Windows 本机运行下面的转发命令，替换三个大写占位符，保持进程运行。

```powershell
ssh -N -L 127.0.0.1:17865:127.0.0.1:7865 -p SSH_PORT SSH_USER@SSH_HOST
```

在另一个终端确认链路。

```powershell
Invoke-RestMethod http://127.0.0.1:17865/health
(Invoke-RestMethod http://127.0.0.1:17865/v1/models).data
Invoke-RestMethod http://127.0.0.1:17865/v1/workflow
```

如果云端网关已退出，在云端工程目录使用 `.venv/bin/python -m uvicorn image_center.app:app --host 127.0.0.1 --port 7865` 启动。原生引擎按需加载，网关正常时 `native_ready` 也可能暂时为 false。上次云端网关日志在 `runtime/gateway.log`，原生引擎日志在 `logs/native.log`。新建实例或需重新编译时，按部署说明恢复 Linux 运行时和权重。 [AutoDL 部署说明](../../RP-image-center/docs/autodl.md)

在 RP-Hub 的「设置 → 生图服务（RP / 微信共用）」选择 OpenAI Images，基础地址填 `http://127.0.0.1:17865/v1`，参考图方式选 multipart，参考图接口用 `images/edits`，返回格式选 Base64 或自动。当前分支的通用设置要求 API Key 非空，可填本地占位符 `local`，Image Center 不校验这个值。通过「读取可用模型」选择 `qwen-image-2.1-turbo-local` 或 `qwen-image-2.1-turbo-local-sqx`。选中 SQX 模型会加载人物 LoRA，`selfPortrait` 决定 RP 是否附上本人参考图。仅测纯环境、食物或其他角色时用基础模型。 [RP 图片适配器](../assets/js/image-generation.js)

Windows 本机另有 `start.cmd`，完整安装后默认提供 `127.0.0.1:7865/studio`。截至写本文，本机这份模型目录只有工作流 JSON 和 GH 权重，直接启动还缺主模型、编码器、VAE；SQX 权重可从 RP-train 取。历史上的 4060 Laptop 8 GB 验证使用的是已有完整权重的环境。 [本机验证](../../RP-image-center/docs/sqx-rp-verification.md)

## 训练做过什么

- 首轮用 DiffSynth-Studio 的官方 Qwen-Image-2.1-Turbo BF16 DiT 训练独立人物 LoRA。试训包 `sqx-cloud.zip` 有 14 张训练图和 3 张留出图。先用 2 步 smoke 验证 CUDA 前后向及导出，再跑 336 步 pilot，之后把 14 张版续至 840 步。上次训练在 AutoDL 的 RTX 6000D 实例完成。有清单和打包脚本，可从原始照片重新准备数据。 [训练说明](../../RP-train/README.md) · [首轮选图清单](../../RP-train/selection.csv)
- 全量 44 张版先跑到 864 步，随后对照 1172、1249、1326、1403、1480 步，并补了 0.90、0.95、1.00 三档强度的固定种子对照。全量版把原有 44 张都用于训练，图册中的原照适合目测，独立泛化仍需新留出照。
- 当前采用 `sqx-1326-all44-transformer.safetensors`，触发词 `sqxv9`，rank 16，224 个目标层、448 个 BF16 张量，约 84 MB。1326 步在当时的正脸、室外侧角和玩偶遮脸样例中综合表现较好，1172 步保留为对照。后面的步数和更高强度未带来稳定收益。五个全量检查点及 SHA-256 已在本地保留。 [1326 步权重](../../RP-train/results/sqx-1326-all44-transformer.safetensors) · [权重校验清单](../../RP-train/results/SHA256SUMS.txt) · [步数对照](../../RP-train/results/sqx-bisection-steps.jpg) · [高强度对照包](../../RP-train/results/sqx-high-strength-comparison.zip)
- RP-train 的 DiffSynth 对照以 BF16 进行。步数和高强度对照属于 Turbo 8 步、CFG 1 的纯文生图测试，右侧参考图只供目测。要评估 RP 中的换装、换背景和人物保持，应在 Image Center 的实际参考编辑链路复测。

## 推理、接入和界面做过什么

**模型和调参。** 推理使用 Qwen-Image-2.1-Turbo INT8 ConvRot、Qwen3-VL 8B INT8 ConvRot 编码器、Qwen 2.1 BF16 VAE。GH 是工作流自带的通用一致性编辑 LoRA，SQX 是单独训练的人物 LoRA。当前文生图为 Euler、CFG 1、8 步；参考编辑用同采样器和 CFG、9 步，额外有 0.15 sigma。编辑默认 GH 0.70。选择 SQX 模型自动补 `sqxv9`，角色 LoRA 默认 0.70，调试台和 API 可以按次改强度。历史 4060 CUDA 日志确认 GH 384/384、SQX 448/448 张量实际生效。 [工作流实现](../../RP-image-center/image_center/workflow.py) · [4060 实测](../../RP-image-center/docs/sqx-rp-verification.md)

**4090D 云端联调。** 为已有 Windows 启动器补了 Linux 可执行文件识别和 CUDA 构建脚本，固定 stable-diffusion.cpp `79dc7ca`。上次选择单张 RTX 4090D 24 GB，镜像为 PyTorch 2.8 / Ubuntu 22.04 / CUDA 12.8。云端用 `backend=cuda`、`params_backend=auto`、20 GiB 管理预算，编码器和 VAE 使用 GPU。1024×1024 首轮样例的任务耗时为文生图冷启动 10.64 秒、热机 5.28 秒、单图加 GH 11.52 秒、双图加 GH 和 SQX 15.51 秒。全部原尺寸完成，显存采样最高 21,994 MiB，RP-Hub 也通过 multipart 拿到真实 PNG。本机早期样例的单图双 LoRA 耗时为 84 秒，画幅和运行配置与云端不同。 [4090D 实测报告](../../RP-image-center/outputs/autodl-491/report.json) · [Linux 构建脚本](../../RP-image-center/scripts/install_native_linux.sh)

**RP 短提示词及参考路由。** 原来的自然语言提示包含画面计划 JSON、大段身份规则和多张身份图说明。用户实测 Qwen 更容易处理约 80～160 字的构图短句，例如主体、机位、造型、动作、背景、光线和照片质感，画面里不要的细节可写「没有耳饰」。现在匹配 Image Center 的模型 ID 时，RP 仍做 `media.scene` 校验，传给 Qwen 的正文使用本轮短画面描述。本人入镜自动选择卡片第一张身份图，苏祈雪卡即 `sqx1.jpg`；本轮显式指定的地点、姿势、服装等参考仍可随请求发送。multipart 的 `reference_roles` 与上传顺序一一对应。云端「人物身份（仅脸部）」会附加只参考脸部轮廓与五官、忽略原图耳饰等的用途说明。图片仍可能残留原参考造型，需看成图。 [适配器](../assets/js/image-generation.js) · [原自然语言生图背景](./natural-language-image-generation.md) · [微信参考用途](./wechat-generation-references.md)

**调试台和删除。** `/studio` 支持上传参考图、逐张指定用途、调整画幅和种子、独立调 GH/SQX、取消、A/B 对照、抓取原 PNG。「用此种子」填入种子，复刻配方还要手动对齐其余参数。A/B 预览有删除按钮，最近任务的按钮位于任务卡片右上角，缩略图完整可见。确认删除后，服务删除生成的 PNG 并在 SQLite 中记录删除状态，刷新和重启后仍按删除状态显示图库。RP 聊天媒体库保存的是 RP 接到的图，与调试台图库分开。此前服务测试 30 项、RP 生图相关回归 46 项通过，卡片布局已在线核对 12 张。 [调试台代码](../../RP-image-center/image_center/studio/studio.js) · [任务存储和删除](../../RP-image-center/image_center/jobs.py)

排查 RP 正文、微信或多人世界的生图入口，可分别从 [07-image-gen-autosave.js](../assets/js/app/07-image-gen-autosave.js)、[27-wechat-media.js](../assets/js/app/27-wechat-media.js)、[world-media.js](../assets/js/world-media.js) 找到调用，它们共用 `image-generation.js`。短提示词和角色参考路由的回归位于 [test-image-scene-consistency.cjs](../tools/refactor/test-image-scene-consistency.cjs)，可用 `node --test tools/refactor/test-image-scene-consistency.cjs` 单独跑。服务端从 Image Center 根目录用 `python -m pytest -q tests` 跑，测试会在导入应用时读取工作流及权重头。本机权重不齐时，之前使用隔离的合成权重夹具运行这套测试。

## 种子结果与后续画质验证

用户最初喜欢的 `1279614750` 是 1024×1536、GH 0.70、SQX 0.35、9 步编辑，PNG 元数据确认有两张参考图，分别是身份和服装。云端历史任务 ID 为 `img_6e2cde6fb9154e7a9210dd741c276592`。同样的种子要配合同一张图、提示词、尺寸、强度和推理设置才能复刻；原收藏图的第二张服装参考也属于输入。

单参考复测固定 `sqx1.jpg`、红心睡衣短提示词、1024×1536、GH 0.70、SQX 0.35。种子 `1279614750` 两次输出的 RGB 像素哈希完全一致，相邻种子 `1279614751` 和远处种子 `3492067137` 生成了不同的像素，两者的脸和取景也都接近。三张都偏近景，手机未清楚入镜。可以指定种子范围来组织对照，种子数值的距离不能预测视觉相似度。 [单参考种子参数及哈希](../../RP-image-center/outputs/sqx-seed-check/report.json) · [三图对照](../../RP-image-center/outputs/sqx-seed-check/comparison.jpg)

下一轮若目标是换场景也像本人，可用 `1279614750` 加 7 个随机种子，每个种子分别跑近脸自拍、半身镜自拍、室外侧脸，固定同一参考和 LoRA 参数。按脸部比例、耳饰和构图筛出跨场景稳定的少数种子，并一起保存模型、提示词、工作流、尺寸、LoRA 强度及参考图。要判断 SQX LoRA 的增益，可以在同一张未进训练的清晰正脸上固定种子和其余参数，比较 GH 单挂与 GH + SQX，分别观察五官、皮肤纹理和构图。上述跨场景筛选和独立留出集对照尚未完成。

## 新会话直接引用

> 先读 `D:\aiops_wwx\RP-Hub\docs\RP-RPTrain-RPImageCentre.md`。当前目标是继续优化苏祈雪在 RP 和微信里的真人感及跨场景身份一致性。训练在 RP-train，推理和调试台在 RP-image-center，RP-Hub 负责场景、参考图和接口调用。默认脸部参考是 `sqx1.jpg`，当前候选权重是 SQX 1326。具体任务如下。

原始背景抄录在本机 `tmp/tmp.txt`、`tmp/tmp2.txt`，长提示词样例在 `tmp/tishici.txt`。这些临时文件被 Git 忽略。训练权重、数据包和实测输出位于相邻目录，换机器时需另外取回。交接时 RP-Hub 与 RP-image-center 的相关修改仍在本机工作树。
