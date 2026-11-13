# 世界开场白与本轮调用状态交接

更新：2026-11-13。范围：多角色世界的开场白、清空记录语义、模型/工具调用反馈与对应视觉交互。

## 用户可见行为

1. 世界编辑新增“世界开场白”，可选择：
   - 从角色卡读取：优先苏祈雪，其次名册中第一张带 `first_mes` 的已启用角色卡；
   - 自定义世界开场：保存到世界定义，支持 Markdown；
   - 直接开始：显式保存空开场，不再从角色卡回退。
2. 开场正文显示“开场”标记，编辑按钮会直接进入世界开场编辑，不再把开场当成普通叙述记录回档。
3. 清空当前世界分支时，删除 RP、私聊、群聊、人物记忆、待办和未完成回合，但开场白属于世界定义，不属于聊天记录。新分支在同一事务内恢复当前配置的开场；原故事仍保存在旧分支。
4. 每个需要模型的世界回合在输入区上方显示低打扰状态条：当前阶段、已用秒数、模型请求次数、工具调用次数和失败次数。展开后按人物/叙述/记忆查看请求明细；接口返回 usage 时显示输入/输出 token。
5. 停止入口仍位于发送按钮位置，处理中显示“停止本轮”。成功、失败或停止后的统计保留在当前会话；切会话、切世界、切分支和清空记录会移除临时状态。刷新后从已落盘 turn 恢复上轮统计。

## 计数口径

- 模型请求：人物提案、协议修复、场景前提解析、剧情叙述、人物记忆总结等逻辑请求。已发起但失败或停止的请求也计入。
- 工具调用：模型实际返回且进入世界工具分发的调用；参数失败仍属于一次调用。未知或未提供的工具不计入。
- 失败次数：请求以错误结束；用户停止单独标记为停止，不冒充失败。
- token：只累计接口或测试 runner 明确返回的 usage；接口内部自动重试不单列。
- 继续未完成回合：在原 turn 的统计上累计，便于看完整回合的真实成本。

统计对象只包含操作元数据，不保存 prompt、回复正文或思维过程。

## 视觉方向

沿用世界模式既有“冷纸档案”体系，不引入 CWUI 或第三方组件：

- 冷纸 `--world-canvas`、正文纸 `--world-paper`、松石 `--world-accent`、薄雾 `--world-soft`、危险色 `--world-danger`；
- 标题继续使用宋体系，正文使用现有无衬线，调用数字使用等宽字体；
- 独特元素是输入区上方的“剧场场记条”：像微信输入状态一样只露出当前阶段和三项计数，详细调用按需展开；
- 开场来源使用三张语义选择卡，开场预览像一页可展开的序章手稿；
- 只在运行状态点上使用一次脉冲动效，`prefers-reduced-motion` 下完全关闭。

`cwui-knowledge` 对 `index.html` 的解析结果为 `resolution.status: unsupported`：工程使用 CDN Vue 3 与原生模板/CSS，没有 `@canway/cwui-vue` 或 `@canway/cw-magic-vue` 证据。本次因此不生成版本相关 CWUI 代码，所有新增颜色均来自现有 `--world-*` 变量。

## 数据与代码入口

| 文件 | 责任 |
| --- | --- |
| `assets/js/world-model.js` | 校验并规范化可选 `definition.openingText`；缺失表示角色卡模式，空字符串表示直接开始 |
| `assets/js/world-chat.js` | 统一解析角色卡/自定义/空开场，生成带 `payload.opening` 的读者旁白 |
| `assets/js/world-store.js` | 创建世界时原子保存开场；清空分支时同事务恢复当前开场 |
| `assets/js/actor-runtime.js` | 请求/工具活动事件与不含正文的计数器 |
| `assets/js/world-orchestrator.js` | 将活动计数累计到 turn，失败与重试也持久化 |
| `assets/js/app/35-world-session.js` | 编辑草稿、实时状态、停止、上轮统计恢复与中文阶段文案 |
| `assets/js/world-components.js` | 开场编辑、正文开场入口、调用状态条与清空说明 |
| `assets/css/world.css` | 开场来源卡、序章预览、场记条、桌面/手机/深色/减弱动效样式 |

旧世界没有 `openingText` 时继续使用角色卡开场，不需要迁移。世界导入、导出、整库备份和修订副本会自然携带该字段。

## 验证

重点覆盖：角色卡开场清空后恢复；自定义开场清空后恢复；显式无开场；30000 字上限；三次模型请求/一次工具调用/token 汇总；失败请求；未完成回合累计；实时状态、停止入口、桌面与 390 像素布局、深色主题和正文直达开场编辑。

```powershell
node --test tools/refactor/test-world-store.cjs tools/refactor/test-world-turns.cjs
node --test tools/refactor/test-world-events.cjs tools/refactor/test-world-chat-memory.cjs tools/refactor/test-world-backup.cjs
node tools/refactor/smoke-world-ui.cjs
node tools/refactor/smoke-world-chat.cjs
git diff --check
```

fixture 浏览器测试使用隔离 Edge/IndexedDB 和固定 HTTP 响应，不调用用户真实 API。正式模型是否选择工具、人物口吻与等待时间仍需线上实际使用评估。
