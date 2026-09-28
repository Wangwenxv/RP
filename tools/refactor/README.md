# app.js 拆分工具链（tools/refactor/）

2026-09-28 的拆分把 8560 行的 `assets/js/app.js`（`setup()` 内 662 个顶层声明）
机械拆成 `assets/js/app/01..24-*.js` 共 24 个模块函数 + 一个 642 行的引导 `app.js`。
本目录保存了全部迁移脚本、数据与验证工具，供审计与二次迁移使用。

## 文件清单

| 文件 | 作用 |
| --- | --- |
| `app.js.orig` | **拆分前的原始 app.js（回滚备份）** |
| `analyze2.cjs` | AST 分析：枚举 setup() 顶层语句/声明、作用域级引用收集、危险模式检测（裸赋值、this、顶层 await） |
| `transform.cjs` | 转换器：按模块表切分语句、改写跨模块引用为 `__s.x`、处理驻留变量、生成新 app.js |
| `verify.cjs` | 校验：语法解析、名称集合一致（634+28=662）、模块内裸引用泄漏扫描、return 对象泄漏扫描 |
| `smoke.cjs` / `smoke2.cjs` / `smoke3.cjs` | 无头浏览器冒烟：加载检查 → 交互+跨模块函数调用 → 建角色/选中/刷新持久化 |
| `manifest2.json` | 分析产物（661 条语句的声明/引用/banner 清单） |
| `stmts.txt` / `module-members.txt` | 语句地图与各模块成员清单（人读） |
| `analyze.js` / `manifest.json` | 早期的括号扫描版分析器（已被 analyze2 取代，留档） |

## 环境

```bash
npm install        # acorn（分析/转换/校验）、playwright-core（冒烟，用系统 Edge: channel msedge）
```

## 复现 / 审计流程

```bash
# 1) 恢复原始文件（如需重跑）
cp app.js.orig ../../assets/js/app.js

# 2) 分析 -> 转换 -> 校验
node analyze2.cjs ../../assets/js/app.js manifest2.json
node transform.cjs        # 生成 ../../assets/js/app/*.js 与 app.js.new
node verify.cjs           # 必须输出 ALL CHECKS PASSED
mv ../../assets/js/app.js.new ../../assets/js/app.js

# 3) 语法 + 运行时冒烟
for f in ../../assets/js/app/*.js ../../assets/js/app.js; do node --check "$f"; done
node smoke.cjs && node smoke2.cjs && node smoke3.cjs
```

> transform.cjs 是一次性迁移脚本：输入必须是**旧版单文件 app.js**（即 app.js.orig 形态），
> 对拆分后的 app.js 重跑会找不到 661 条语句。如需调整模块划分，改脚本里的 `MODULES` 表后按上面流程重跑。

## 等价性论证（为什么行为不变）

1. **语句级原样搬运**：每条顶层语句的文本原封不动进入某个模块函数，只做两类定点改写：
   跨模块引用 `name` → `__s.name`；对象简写属性展开为 `name: __s.name`。
2. **作用域等价**：模块函数在 setup() 中被同步调用，其函数作用域与原 setup 作用域一一对应；
   所有顶层声明通过 `__s` 共享，`return` 给模板的名字逐一映射，模板（index.html）零改动。
3. **顺序等价**：模块调用顺序与语句在模块内的顺序都保持原声明顺序；
   分析器已证明不存在"初始化期前向引用"（原程序依赖函数提升的地方不受影响）。
4. **可变变量特判**：34 个会被裸重新赋值的 `let`（timer/flag/epoch）改为直接驻留 `__s`，
   杜绝"本地镜像与 __s 不同步"。
5. **验证**：静态（名称集合 662=634+28、零泄漏、零重复赋值）+ 运行时
   （首渲染、用户设置保存、跨模块函数调用、建角色→选中→刷新持久化恢复，均零报错）。

## 回滚

```bash
cp tools/refactor/app.js.orig assets/js/app.js
# 并把 index.html 底部 24 行 assets/js/app/*.js 的 document.write 删掉
rm -rf assets/js/app
```
