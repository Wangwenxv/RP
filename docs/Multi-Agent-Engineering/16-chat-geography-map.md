# 聊天右侧地图抽屉与事实位置更新

日期：2026-11-17。工程：`D:\aiops_wwx\RP-Hub`，分支 `multi_agent`。按用户最后确认的右侧抽屉实现，沿用 RP-Hub 原生 Vue 和主题，不使用 CWUI。代码在本地工作树，尚未提交或发布到 GitHub Pages。

## 使用入口

- 左侧导航新增「地理地图」，打开右侧地图抽屉；原「地图与地理环境」继续管理底图、地点和道路。
- RP、微信、世界聊天顶栏都有地图按钮，可随时打开。
- 桌面默认固定右侧，给聊天留出空间；可切换覆盖式抽屉。手机自动覆盖显示，支持 Escape 关闭和返回入口焦点。
- 角色需在编辑 → 地理环境绑定可用地图。缺少地图时显示设置和地图管理入口，住址不会被当作当前位置。

地图使用已绑定的原图与标注坐标。人物标记为姓名、圆形头像和彩色尖角，类似用户的定位截图；同址人物头像错开，尖角仍落在同一坐标。可拖动、缩放、定位人物、显示双方/全图、搜索地点或用途、查看地点介绍。双方位置已确认时沿已有路网画路线，显示步行/骑行估算及区间；同址不伪造楼内距离，在途或未知不画成已经到达。

玩家选择已有地图地点，点击「把我的位置设在这里」，或「清除我的位置」。操作直接保存本分支，不请求模型。单卡 RP 中显示可读的「📍 我的位置：…」，模型上下文仍读取明确的 `/geo user 地点ID` 原始设定。

## 单卡 RP / 微信工具契约

扩展已有 `tool_geo`，查询能力保持原有行为，新增独立的 `update_location` 操作：

```json
{
  "operation": "update_location",
  "locationStatus": "last_confirmed",
  "query": "library",
  "sourceMessageId": "current",
  "evidence": "她走进了图书馆。"
}
```

`current` 仅绑定 RP 当前响应已写出的正文消息；微信必须引用已有正文消息 ID。状态支持 `last_confirmed`、`in_transit`、`unknown`；在途/未知不带到达地点 `query`。不接受 `actor:user`，更新不能放入 `batch`。

程序逐字核对当前分支中的完整事实原句，地点需唯一并与原文一致。拒绝未来计划、疑问、条件、猜测、引用、推理（包括未闭合推理标签）、附件、图片描述、工具结果和自创依据。玩家第一人称不能被当成角色位置。明确角色姓名、角色自述、受支持的第三人称在场/到达/离开句可以作为依据。

通过验证后，在依据消息上保存 `geographyUpdates`（地图 ID、状态、地点、原句、调用 ID），不另建坐标表。重放时重新验证，编辑/删除依据或分支回档后，失效标注不继续作为坐标。保存失败回滚标注；已有较新的位置事实时拒绝旧证据覆盖。同一响应中的地理更新和查询按模型顺序执行，后续 `status` 可看到已保存的位置；其它独立工具保持原有执行策略。原有每轮 4 次地理调用、查询结果预算继续生效。

## 多人物世界

世界抽屉展示玩家和所有启用 NPC，选关注人物后切换与其的路程。位置直接投影当前世界分支的 `actorStates.position`，兼容旧字符串位置和 `location` 字段。`travelling` 显示在途；未知、未录入或未确认的位置不落标记。

世界 NPC 继续使用既有角色行动/移动工具及路程、剧情时间结算，未另加绕过调度器的 `tool_geo` 写入入口。玩家设置位置通过 `RPHubWorldStore.commit` 提交自己的状态，保留手机等其他状态并采用版本校验，形成可回档的状态事件。打开地图不推进时间，也不赋予人物额外认知。

## 文件接缝

| 文件 | 作用 |
| --- | --- |
| `assets/js/chat-map.js` | 抽屉、底图、头像标记、路线、搜索/定位、响应式和键盘行为 |
| `assets/js/app/36-chat-map.js` | 单卡/世界地图与位置适配、玩家设定及保存、模板导出 |
| `assets/css/maps.css` | 抽屉与标记样式、桌面聊天避让、手机和减少动画 |
| `assets/js/geography.js` | 位置原句校验、标注重放、schema；统一推理/图片过滤 |
| `assets/js/app/30-geography.js` | 当前分支来源、更新执行/回滚、模型提示和原句 ID |
| `assets/js/app/18-tools-ui.js`、`25-wechat.js` | 有序执行地理调用，保留原生工具结果续写 |
| `assets/js/app.js`、`index.html` | 新模块/组件注册、脚本加载、RP/微信入口及可读设定 |
| `assets/js/ui-components.js`、`world-components.js` | 导航和世界顶栏入口 |

本轮修正微信根层重复的 `:class`，将附件拖动和地图避让合并，避免新旧 UI 接缝覆盖。窗口缩到手机宽度时保留地图可视中心，手机使用对话框语义。

## 验证与真实体验

```powershell
node --test tools/geography/test-*.cjs
node tools/geography/smoke-chat-map.cjs
node --test tools/refactor/test-player-agency.cjs tools/refactor/test-world-store.cjs tools/refactor/test-world-turns.cjs tools/refactor/test-wechat-media.cjs tools/refactor/test-wechat-time.cjs tools/refactor/test-wechat-silence.cjs tools/refactor/test-card-image-identity.cjs
```

地理测试 **54 项通过**；玩家控制、世界提交/调度、微信和固定外貌相关回归 **184 项通过**；地图浏览器测试 **22 项通过**。浏览器测试使用隔离 Edge、真实 Vue 和 IndexedDB，模型响应为确定性 fixture，不能称为真实模型验收。覆盖 RP/微信工具更新与续写、玩家不调用模型、编辑失效、刷新恢复、同址头像、手机、世界多人物、状态保留与分支回档。截图保留于忽略目录 `.refactor-tmp/chat-map/`。

用户授权在内置浏览器现有配置中使用 `qwen3.7-plus`、苏祈雪。线上 `https://wangwenxv.github.io/RP/` 的「地理地图实测-20261117」分支保留真实体验：她通过原生微信说明在图书馆四楼，到南苑13栋需三十多分钟；玩家明确「先别出发」「还在13栋」「只是在想等会儿要不要去」，后续 RP 留在图书馆，继续商量吃饭，没有替玩家出发。模型菜单确认选择 `qwen3.7-plus`。实测截图为 `.refactor-tmp/chat-map/live-qwen.jpg`；没有读取、复制或提交 API Key。

线上尚未包含本轮的新抽屉和 `update_location`，真实体验仅验证已有地理行为；新工具的保存由本地浏览器 fixture 验证，不能将线上聊天当成新工具实测。真实回复还出现 RP 文本 19:00、微信剧情时间 18:30 不一致，属于既有单卡时间问题，本轮未修复或据此推进位置。

旧 `tools/refactor/verify.cjs` 比较早期拆分基线，依赖不存在的 `assets/js/app.js.new`，并将已有适配器包装赋值视为重复，无法用于当前工作树验收。未为通过该脚本生成假基线文件。

## 同步与后续边界

本轮执行 `git fetch origin`、`git pull --ff-only origin multi_agent`，返回 `Already up to date`，本地 HEAD 与远端均为 `66322e5`。最近生图和固定外貌交接已阅读，相关回归保留；当前没有未解决的 Git 冲突。

本功能使用 RP 示意坐标，尚无 GPS、高德在线地图、自动识图或连续轨迹。只能选择已收录地点；未确认位置显示未知。原句校验为保守规则，不理解所有文学句式，也不能保证叙述本身完全真实；复杂句无法确认时应保留未知，不能降低校验来填满地图。

发布后可用苏祈雪验证真实模型对 `update_location` 的调用意愿和修正体验；检查明确到达、实际离开、编辑依据、切换分支的连续行为。先检查本地差异并提交/部署，线上刷新后再作此验收。
