# 请求规则去重与角色内核保留交接

> 后续配对返回表明去重已生效，默认镜头仍会错误延续玩家流程。该问题另由本体/COT/准备对话修正，人物原文继续保留。见 [NPC镜头交接](./rp-scene-routing.md)。

日期：2026-11-08。承接 [实际请求审计](./request-context-audit.md)。用户确认本次优化请求重复，保留角色内核、personality 和世界书。沿用原 UI。

## 范围

角色卡、personality、mes_example 和世界书条目原文均保留，包括亲密互动频次和台词范例。世界书的触发、预算、插入位置及记忆覆盖机制沿用原流程。没有新增人物素材裁切、摘要或语义去重。

四条固定 user/assistant 预注入也保留，不因“不是实际剧情”自动删除。已保存预设的内容和开关不被本次去重写回修改。

## 请求现在怎样组装

| 内容 | 本次处理 |
| --- | --- |
| 文风预设 | 留在原 system 位置，不再在最新玩家消息后复制整段 |
| 相同的系统预设 | 发送副本按内容完全相同去重，仅忽略首尾空白；不同内容仍保留。COT组与普通system组分别处理 |
| 玩家决定权/发送归属 | 保留完整本体 system 规则，取消最新 user 后重复的 player_turn_boundary |
| 主动工具提醒 | 保留 system 说明和原生工具 schema，取消最新 user 后的再次追加 |
| 本轮输出开关 | 短 response_protocol 放入现有最后一条 system，保留分析标签、图片数量、变量、面板和 output_reply 开关；不复制文风及本体规则 |
| 角色与世界背景 | user 背景独立成条，不与玩家输入合并；全文保留、不冠玩家姓名 |
| 最新玩家输入 | 不再附加上述程序规则；原配置的深度世界书、记忆召回和UI纠错仍按原机制提供 |

本体和输出协议在正则、记忆、地理及原生工具信息组装后注入，通常追加到主 system 末尾。appendSystemPrompt 对同一段完全相同的规则重复调用时不重复追加，保留其他消息顺序、元数据、多模态内容和原生工具签名。

此前没有提要隔开时，角色背景 user 和紧随其后的玩家 user 可能被同 role 合并，背景还可能继承玩家 name。现在角色背景标注 `_contextOrigin:'character_background'`、`_preventContextMerge:true`，标准化后保持独立，API映射仍剔除内部字段。角色内容本身不改写。

Gemini nonce 在系统预设去重后加入发送副本，重复预设不会因一个副本加了随机前缀就漏过去重；保存的预设保持原内容。

## 实现入口

- `assets/js/built-in-content.js`：共用 appendSystemPrompt、精简 buildResponseProtocolPrompt、本体规则集中 system。旧 buildNextResponsePrompt 名称保留为构造函数别名，不再生成 next_response 规则块。
- `assets/js/app/14-tools-runtime.js`：appendResponseProtocolPrompt 接入本轮开关，删除最新 user 工具提醒入口。
- `assets/js/app/15-generate.js`：系统预设精确去重、角色背景防合并、取消最新 user 重复追加、末尾 system 接线。
- `.gitignore`：新增 `/card/suqixue/`，忽略整个目录及子目录内容。目录当前没有已跟踪的文件，本次不涉及取消跟踪或删除本地文件；规则不会自动清除过去提交中的文件。

## 验证

```powershell
node --test tools/refactor/test-player-agency.cjs tools/refactor/test-wechat-silence.cjs
node tools/refactor/smoke-player-agency.cjs
node tools/refactor/smoke-history-retrieval.cjs
git check-ignore card/suqixue/tmp.txt
git diff --check
```

54 项 Node 检查通过。玩家决定权浏览器覆盖普通/COT/抗截断/基础增强记忆/提要/工具续写、普通和Gemini重复预设、真实与旧苏祈雪卡、三类微信发送归属；原文检索浏览器 19/19，页面无 JS 异常。

去重 fixture 验证：同一 system 文风只发一份，两个相同系统条目合并，不同系统内容保留；personality 中故意放入的相同文风全文保留，两个相同世界书条目均保留；用户提供的 44 字输入单独发送；请求前后的 personality、世界书与保存预设 JSON 相同。文风检查只计完整开闭块，不把其他规则对 writing_style 标签的文字引用算成第二份。

另验证输出开关、玩家图文不混入规则、主 system 选择和重复追加的幂等性，原生工具签名及执行方向保持。浏览器使用隔离 Edge/IndexedDB 和假 API，没有连接用户模型；检查不代表已测量真实模型幻觉率下降。

刷新页面即可使用新组装。前一份 tmp.txt 是旧请求快照；在 Console 查看新请求，最新玩家消息不再带 next_response/player_turn_boundary，输出开关集中在 system 的 response_protocol。

真实验证后另加入一条紧邻最新玩家输入的短 system `rp_turn_task`，用于当前续写对象和来源判定，不再次复制完整文风/本体边界，也不改玩家 user。历史摘要、RP原文与微信原文的内部类别经过标准化保留，传输到 API 时剔除。详见 [真实验证与来源边界](./rp-live-evaluation.md)。

