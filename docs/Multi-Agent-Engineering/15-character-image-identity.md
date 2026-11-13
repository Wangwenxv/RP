# 角色固定外貌与苏祈雪 v2 更新

日期：2026-11-13。用户希望复用 `card/suqixue/sqx2.png` 中的面部特征，让扮演苏祈雪的模型在生图时主动使用，而不是每次由玩家重复提示。

## 使用方式

已原地更新本地 `card/suqixue/苏祈雪v2.json`，保留原性格、关系、开场、UI、正则、地理扩展和原有 **16 条世界书**，新增一条“苏祈雪·本人生图外貌”。按原 v2 保留齐肩细软发型，补入瘦鹅蛋脸、柔和收窄下颌、小巧下巴、正常大小深棕杏眼、细直鼻梁、小巧鼻尖、淡玫瑰嘴唇与自然白皙肤质；写实手机照片是目标风格。

新导入此卡后资料自动可用。已有单卡微信存档可在“微信设置 → 本人生图外貌”填写或修改外貌说明、固定英文提示词、本人图片负面提示词，并保存；无需为了补资料另建同名角色。取消“使用固定外貌”会保留资料但停用，清空英文提示词会删除结构化资料。普通人物设定和已选中的世界书仍独立生效，停用结构化资料不会删除其文字。

世界模式每个绑定角色读取自己的卡；已有世界需要在角色编辑中重新载入更新后的卡并保存世界版本。单卡设置不会自动覆盖既有世界版本。其他卡客户端可通过新增世界书的“苏祈雪 / 自拍 / 拍照 / 照片 / 生图 / 绘图 / 本人入镜”关键词获得完整英文特征；它们如何调用生图由各自客户端决定。

本次代码在本地工作树，尚未发布到 GitHub Pages。线上网页需要发布代码后刷新，新卡或旧档外貌资料需要按上述方式导入/填写。

## 数据与工具契约

可携带的卡扩展：`data.extensions.rp_hub_image_identity`，应用内人物字段：`imageIdentity`。

```json
{
  "version": 1,
  "enabled": true,
  "description": "人物外貌中文说明，最多240字符",
  "prompt": "固定英文外貌提示词，最多900字符",
  "negative": "本人图片负面提示词，最多400字符"
}
```

导入、JSON/PNG 导出的共用契约以及世界角色卡保存均携带该资料。显式 `imageIdentity:null` 优先于旧扩展，防止清除后旧资料恢复。

现有 `tool_load_image_sending` 的返回说明中包含当前人物固定外貌，普通聊天维持按需加载。当前轮已加载完整发图说明时直接提供外貌；原 RP 主动发图说明与世界模式亦提供相同资料。无需额外的全局姓名检索工具；工具只能取得当前绑定角色资料，减少同名匹配和跨人物串用。

本人入镜请求：

```json
{
  "type": "image_request",
  "media": {
    "mode": "generate",
    "selfPortrait": true,
    "prompt": "campus corridor, phone selfie, evening light, cream scarf",
    "description": "走廊里的自拍",
    "usage": "scene_photo"
  }
}
```

原 RP 与世界 RP 的 `tool_wechat` 使用同一 `image` 对象。`selfPortrait` 只能是 generate 模式的布尔值。有启用的固定外貌资料时，所有新 generate 请求必须明确填 true/false；本人入镜为 true，饭菜、风景或他人为 false。漏填在付费前校验，原单卡与世界微信均最多一次模型格式修正；原 RP 工具参数也有执行守卫，仍漏填就失败，绝不推断本人后直接计费。

模型只补本轮衣服、动作、环境、光线等场景提示；共享 `characterRequest` 在实际 API 调用前拼入当前角色固定特征，只删除完全重复的前缀，不猜测图片是谁。false 不加人物固定特征；资料缺失或停用时标记可省略，仍沿用普通场景提示。合计超过 1500 字符在付费前报错。

STA1N NAI 使用其“负面提示词:”标签加入本人负面词，并保留基础负面词；普通 `chat-image` / `openai-images` 协议只拼正面特征，不发送未经确认的负面参数。资料不包含密钥或参考图片像素，固定英文提示不写入微信气泡或历史图片描述；图片任务仍保留原请求用于恢复。

## 文件与可重复更新

| 文件 | 责任 |
| --- | --- |
| `core-utils.js`、`app/22-character-io.js` | 资料规范化、导入导出 |
| `image-generation.js` | 当前人物资料、提示词拼接、NAI 负面标签 |
| `wechat-media.js`、`app/14-tools-runtime.js`、`app/25-wechat.js` | 本人标记、主动 schema、原生编辑保存 |
| `app/27-wechat-media.js` | 按需工具返回资料、原微信实际请求 |
| `actor-runtime.js`、`world-orchestrator.js`、`world-media.js` | 世界绑定人物资料、实际请求、原有像素检查点 |
| `index.html` | 原生微信外貌编辑项 |
| `tools/character-cards/patch-suqixue-image-identity.cjs` | 可重复运行的苏祈雪 v2 补丁，完整英文资料与卡片世界书 |

补丁脚本先检查人物姓名和世界书结构，按内容哈希备份原文件到 `.refactor-tmp/character-card-backups/`，重复运行不追加同一世界书或人格段落。卡目录本身被工程忽略；修改的实际卡文件保留在本地，脚本是可追踪的更新入口。原 `_build_v2.py` 重建可能覆盖补丁，重建后再运行：

```powershell
node tools/character-cards/patch-suqixue-image-identity.cjs
```

本次原卡备份：`.refactor-tmp/character-card-backups/苏祈雪v2.json.a36a382fd039.bak`。已逐项比较原卡：原 16 条世界书、UI、正则、地理扩展、开场等保留。

## 验证

单元与执行回归 **234 项通过**，覆盖卡片往返、禁用/清除、补丁幂等与备份、本人标记类型、固定特征与 NAI 负面词的实际载荷、非本人不套脸、按需工具返回、外貌不落微信历史、原 RP schema、世界两人物隔离、世界包往返及原有付费图片缓存恢复。新增原单卡与世界微信的漏标记修正、反复漏填付费前失败验证。

隔离 Edge + Vue + IndexedDB 的原单卡场景 **13 项通过**：原生外貌字段、保存重开、导出契约、原场景三次连发、描述请求纠正、本人载荷固定特征、图片与资料刷新恢复。新增 `--missing-portrait-flag` 场景同为 **13 项通过**，验证生图漏本人标记时先修正一次、后付费一次。fixture 图片只验证管线，不能评价人物画面。原微信媒体专项通过；世界图片浏览器专项 **11 项通过**。

```powershell
node --test tools/refactor/test-card-image-identity.cjs tools/refactor/test-image-generation.cjs tools/refactor/test-wechat-media.cjs tools/refactor/test-wechat-silence.cjs tools/refactor/test-world-images.cjs tools/refactor/test-world-turns.cjs tools/refactor/test-world-store.cjs tools/refactor/test-player-agency.cjs tools/refactor/test-wechat-time.cjs tools/refactor/test-wechat-voice.cjs tools/refactor/test-wechat-documents.cjs
node tools/refactor/smoke-wechat-photo-flow.cjs
node tools/refactor/smoke-wechat-photo-flow.cjs --missing-portrait-flag --out .refactor-tmp/wechat-image-identity/fixture
node tools/refactor/smoke-wechat-media.cjs
node tools/refactor/smoke-wechat-image-generation.cjs
```

真实调用使用用户授权的 Key 与默认 STA1N NAI 模型，测试输入与产物单独放在 `.refactor-tmp/wechat-image-identity/`，未写入仓库。报告记录是否实际拼入固定特征；不能把角色拒绝、场景图或仅 HTTP 200 当成本人画面验收。

第一次真实调用暴露模型自行拷贝部分外貌、漏填 `selfPortrait` 的问题，未套入完整特征与负面词，故不能算外貌复用成功。随后补上显式 true/false 校验、完整示例与付费前有界修正，再以同一卡的 **15 条世界书、9 条预设选择** 重跑原拍照场景：角色回复“干嘛啦 / 拍就拍”，发送自拍后说“满意了没”。聊天 **2 次**、生图 **1 次**，没有使用补充景色请求；这次模型直接填对标记，无需修正。请求包含完整 **606 字符**固定特征和 **150 字符**人物负面词，两个载荷断言都为 true；STA1N HTTP 200，下载 PNG **1,785,727 字节**，浏览器保存 WebP **151,540 字节**，刷新保留照片与资料。**12 项真实浏览器断言通过**。

最终报告 `.refactor-tmp/wechat-image-identity/verified/live-report.json`，界面截图 `live-chat.png`，实测图 `live-image.webp`。查看实测图仍有明显插画质感，不能称为真实照片或与参考人物锁脸成功。临时密钥配置在实测完成后删除，原用户 Key 文件保留。

## 能力边界

这实现固定文字外貌复用，提高人物相似度；尚未传参考图像素，不能锁定同一张脸。核查的 Nai2API 版本仍是文字输入，默认 NAI 模型偏插画；写实提示词和负面词不能保证照片级效果。参考图/身份保持模型接入属于后续能力，详见 `docs/sta1n-image-generation.md` 的核查记录。
