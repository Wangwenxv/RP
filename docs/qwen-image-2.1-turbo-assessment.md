# Qwen-Image-2.1-Turbo 可行性评估（RP 生图提示词）

2026-11-25。评估对象：工程 `naturalScenePrompt()` 产出的多参考图长提示，能否由 `qwen-image-2.1-turbo` 承接。

> 本文是早期静态评估。后续本地实测已完成：单主图并未可靠解决换场景锁脸，关闭 LoRA 也仍有旧衣服和饰品残留。下文的“70–80%”“单图可靠”没有实测依据，不作为验收结论；是否混脸也不能仅由参考图数量推定。当前状态与对照以 `RP-image-center/docs/verification.md` 为准。

## 结论

**技术上可行，但不能把现有提示词原样投喂。** 需要三处改造，缺一处效果就会明显掉：

1. **参考图必须裁剪**：只传 1 张主身份图 + 需要的 clothing 图。当前工程会把全部人物图一起发（`image-generation.js:159`），3 张 identity 同传会被模型融合成平均脸，恰好是提示词明令禁止的"混合五官"。
2. **负面约束必须转正向**：2.1 系列**不支持 `negative_prompt`**（仅 3.0 系列支持），本地 8 步 Turbo 工作流 CFG=1，负向词根本不参与计算。"不出现麦克风/不撑伞/不添加人物"只能改写成正面描述。
3. **必须关掉 `prompt_extend`**：默认 `true`，会先让改写模型重写你的 1200 字规则书，细则大概率被压缩掉。

改造后预期覆盖提示词意图的 70–80%。**"绝不混合五官、不为漂亮另造网红脸"这条无法用提示词保证**，只能靠"只传一张主脸"从结构上规避；官方原话是"更好保留面部身份特征"，不承诺同脸。

## 已验证事实

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 端点在线 | HTTP 401 `InvalidApiKey` | `POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` |
| 浏览器跨域 | 支持 | 预检 200，`access-control-allow-origin` 回显 origin，`allow-headers: authorization,content-type` |
| 参考图上限 | 1–10 张（3.0 系列反而只有 3 张） | 官方 API 参考 |
| 图序号机制 | `content` 数组内 `{image}` 顺序即"图1…图N"，与工程 `{image:index+1}` 天然对齐 | 官方示例 + `image-generation.js:105` |
| 输出 | 只返回 URL，24h 有效；2.1 **不支持 `b64_json`** | 官方 API 参考 |
| 单价 | 0.1 元/张（北京）；新加坡 0.113362 | 百炼计费页 |
| 尺寸格式 | `宽*高` 星号，512²–2048²，宽高比 1:8–8:1 | 官方 API 参考 |
| 权重可得性 | ModelScope 可直连，HuggingFace 本机不可达（curl 000） | 见下方清单 |

未验证、必须出图才能定的两项：真实出图的面部保持度；返回的 OSS 图片 URL 是否带 CORS（工程踩过 YeeMagine CDN 无 CORS 的坑）。

## 提示词逐条对照

| 提示词要求 | Qwen 支持度 | 说明 |
| --- | --- | --- |
| 多图分角色（identity / clothing / background / pose） | 结构支持，语义打折 | 画面能拼出来，但"图2只借手势不借脸"属于元指令，模型不是规则执行器 |
| 身份图定脸、冲突以像素为准 | 部分 | 单图可靠；多图同传会融合 |
| 不混合五官、不做网红脸 | **不保证** | 无参数可控，只能靠减少 identity 图数量 |
| 中文长提示 | 强项 | 文本编码器为 Qwen3-VL-8B，中文原生 |
| 肩长发/睡衣/手机镜前自拍/荧光灯 | 支持 | 常规画面指令 |
| 不出现麦克风、不撑伞、不加人 | **只能正向化** | 无 negative_prompt，CFG=1 |
| 前置摄像头机位、手部一致 | 支持但易错 | 手部与持机是扩散模型通病，需多出图挑 |
| 2K | 支持 | 8GB 本地跑不动 2K，需 API |
| 提示词长度 | 实测 1689 字符（苏祈雪卡 + 宿舍浴室场景），约 1700 token，低于 4500 上限 | 工程 6000 字符上限在极端长场景下约 6000 token，会超；需在该协议下另设 4500 字符闸门 |
| 参考图体积 | 实测 1 张 122 KB、3 张 1.25 MB（base64） | 远低于单张 10MB 限制 |

## 参考图策略（最关键的一条）

Qwen-Image-2.1 没有"主图权重"参数，多图注意力是对称的。工程当前逻辑：

```js
// image-generation.js:159
const selected = [...new Map([...(intent.selfPortrait === true ? refs.filter(r => r.kind !== 'scene') : []), ...scenes]...
```

本人入镜时所有人物图都进 `referenceImages`。3 张带脸的照片同传 → 融合风险最高。

建议改为：**首张 identity + 本轮需要的 clothing/background 图**，其余 identity 只作为文字补充（"眼型略长、鼻梁细、唇形偏薄"），不进图片数组。这与提示词"第1张作为主要面部依据"完全一致，但要用代码强制，不能指望模型自己排序。

对比实验：同一 seed 跑 A（3 图）与 B（1 主图 + clothing），看哪组的跨图人脸相似度更高。这是唯一能定论的验证方式。

## 本地部署（本机实测硬件）

```
GPU  NVIDIA GeForce RTX 4060 Laptop GPU   8188 MiB  (驱动 592.82)
CPU  Intel Core i9-14900HX   24 核 32 线程
RAM  31.7 GB
磁盘 C: 剩余 91.8 GB
```

判定：**能跑，但只能跑量化档，且 4 图编辑会非常慢。**

8GB 显存跑 bf16 需要约 30GB（DiT 13.25 + 编码器 16.33 + VAE 0.63），不可行。下表为 ModelScope `Comfy-Org/Qwen-Image-2.1` 与 `unsloth/Qwen-Image-2.1-Turbo-GGUF` 的实际文件体积（已用 API 拉取核实，非估算）：

| 用途 | 文件 | 实测体积 | 放置目录 |
| --- | --- | --- | --- |
| 扩散主干（推荐） | `qwen-image-2.1-turbo-Q4_K_M.gguf` | 3.91 GB | `models/diffusion_models/` |
| 扩散主干（画质优先） | `qwen-image-2.1-turbo-Q5_K_M.gguf` | 5.02 GB | 同上 |
| 扩散主干（官方 INT8，8G 偏紧） | `qwen_image_2.1_turbo_int8_convrot.safetensors` | 6.76 GB | 同上 |
| 文本编码器（最省） | `qwen3vl_8b_w4a8.safetensors` | 5.88 GB | `models/text_encoders/` |
| 文本编码器（官方默认） | `qwen3vl_8b_int8_convrot.safetensors` | 8.71 GB | 同上 |
| VAE（必需） | `qwen_image_2.1_vae_bf16.safetensors` | 0.63 GB | `models/vae/` |

推荐组合总下载量 **10.4 GB**（Q4_K_M + w4a8 + VAE）。ComfyUI 会先跑编码器再把它挪到系统内存，32GB RAM 足够。

前置条件：
- ComfyUI ≥ 0.39.0（Qwen Image 2.1 节点是核心节点，旧版显示红框缺节点）。
- GGUF 必须用 **leejet fork 的 ComfyUI-GGUF**；city96 原版没有 `qwen_image21` 架构，会报 `Unknown model architecture`。
- 模型目录覆盖可写 `extra_model_paths.yaml`，不要把三个文件堆同一目录。

8GB 实测参考：编辑工作流 1024×1024、2–3 张参考图；4 张参考图需降到 768–896 长边。首次加载约 3 分钟属正常。

速度与成本对比：本地约 1–3 分钟/张且占满显存；API 0.1 元/张、十几秒。**RP 聊天插图场景建议用 API，本地只作离线批量或隐私用途。**

## API 接入改造点

在 `assets/js/image-generation.js` 增加 `qwen-multimodal` 协议，改动集中在四处：

1. `payload()`：新增分支
   ```js
   { endpoint: 'services/aigc/multimodal-generation/generation',
     body: { model, input: { messages: [{ role: 'user', content: [
       ...refs.map(r => ({ image: r.dataUrl })),        // 顺序必须等于提示词里的 image 1..N
       { text: prompt }
     ]}]}, parameters: { size: c.size.replace('x', '*'), n: 1, prompt_extend: false, watermark: false } } }
   ```
2. `candidates()`：现有解析不认 `output.choices[].message.content[].image`，需补：
   ```js
   for (const item of data?.output?.choices?.[0]?.message?.content || []) add(item?.image);
   ```
3. 协议白名单：`payload()` 里 `['sta1n-nai','chat-image']` 需加入 `qwen-multimodal`；参考图上限由 16 收到 10。
4. `negativePrompt`：该协议下丢弃，不发（发了也不生效）。同时在 `naturalScenePrompt()` 输出端把 `avoid` 数组改写成"画面中只见……"，不要留"不出现X"。

另外两处非代码风险：
- 返回 URL 下载走 `fetch` 转 Blob，若 OSS 无 CORS 会失败。兜底：用 `img` 标签 + `crossOrigin` 读 canvas，或经 `presence-server` 代理。必须先用真实响应验证。
- 同步接口长提示 + 4 图可能 60–120 秒，工程 5 分钟超时够用；但期间用户取消无法中止服务端计费。

## 验证

```powershell
# 1) 只验证连通与鉴权（不产生费用，401 即说明端点与路径正确）
curl -s -o NUL -w "%{http_code}" -X POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation `
  -H "Content-Type: application/json" -H "Authorization: Bearer sk-invalid" `
  -d '{\"model\":\"qwen-image-2.1-turbo\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":[{\"text\":\"t\"}]}]}}'

# 2) 干跑：只拼提示词、读参考像素，不联网不计费（已跑通：1689 字，3 图 1.25MB）
node tools/image-generation/test-qwen.cjs --card card/suqixue/苏祈雪v2.json --refs 3 --dry

# 3) 真实出图（计费 1 张）。Key 写入 tmp/key.txt 第一行
node tools/image-generation/test-qwen.cjs --card card/suqixue/苏祈雪v2.json --refs 1 --out .refactor-tmp/qwen-image/ref1
node tools/image-generation/test-qwen.cjs --card card/suqixue/苏祈雪v2.json --refs 3 --out .refactor-tmp/qwen-image/ref3
# 对比两次输出的人脸相似度，确定参考图裁剪策略
```

`--refs 1` 与 `--refs 3` 用同一 seed、同一提示词，只改参考图数量。这是判断"多图是否导致融合"的唯一干净对照。
