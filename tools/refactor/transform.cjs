// 把 app.js setup() 拆成 24 个模块文件 + 重写 app.js
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const SRC_FILE = path.resolve(__dirname, '../../assets/js/app.js');
const OUT_DIR = path.resolve(__dirname, '../../assets/js/app');
const src = fs.readFileSync(SRC_FILE, 'utf8');
const manifest = require('./manifest2.json');

const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script', locations: true });

// ---- 找 setup 与 components ----
let optionsObj = null, appDecl = null;
for (const st of ast.body) {
  if (st.type === 'VariableDeclaration') {
    for (const d of st.declarations) {
      if (d.init && d.init.type === 'CallExpression' && d.init.callee.type === 'Identifier' && d.init.callee.name === 'createApp') {
        optionsObj = d.init.arguments[0]; appDecl = st;
      }
    }
  }
}
let setupFn = null, compProp = null;
for (const prop of optionsObj.properties) {
  const name = prop.key.name || prop.key.value;
  if (name === 'setup') setupFn = prop.value;
  if (name === 'components') compProp = prop;
}
const body = setupFn.body.body;

// ---- 模块表 ----
const MODULES = [
  { key: 'stateAppShell',    file: '01-state-app-shell.js',      title: '应用外壳：全局 UI / 弹窗 / 生成状态 / 移动端视口', range: [18, 106] },
  { key: 'stateSettings',    file: '02-state-settings.js',       title: '用户人设、应用设置、API 提供商与模型槽位', range: [107, 155] },
  { key: 'stateChat',        file: '03-state-chat.js',           title: '角色 / 聊天记录 / 预设 / 正则 / 世界书等数据状态', range: [156, 212] },
  { key: 'stateMemoryTools', file: '04-state-memory-tools.js',   title: '记忆系统与主动工具的状态及归一化', range: [213, 259] },
  { key: 'stateEditing',     file: '05-state-editing-export.js', title: '编辑器草稿、剧情分支视图状态、导出弹窗、内嵌页与拖拽排序', range: [260, 314] },
  { key: 'persistence',      file: '06-persistence.js',          title: '持久化：聊天 / 角色 / 记忆 / 设置的读写与失败重试', range: [315, 335] },
  { key: 'imageGenAutosave', file: '07-image-gen-autosave.js',   title: '自动生图任务、生成图重抽与防抖自动保存', range: [336, 364] },
  { key: 'scopedUiTemplate', file: '08-scoped-uitemplate.js',    title: '角色作用域资源辅助与 UI 模板运行时', range: [365, 400] },
  { key: 'chatDisplay',      file: '09-chat-display-branch.js',  title: '对话展示窗口、滚动锚点、剧情分支视图与统计', range: [401, 435] },
  { key: 'methodsCore',      file: '10-methods-core.js',         title: '通用方法：Toast / 确认框 / 正则处理 / Markdown 渲染', range: [436, 453] },
  { key: 'methodsModels',    file: '11-methods-models.js',       title: '模型列表拉取、模型选择与连接状态检查', range: [454, 465] },
  { key: 'methodsChatSend',  file: '12-methods-chat-send.js',    title: '发送消息、聊天图片识别与附件管理', range: [466, 478] },
  { key: 'methodsMsgOps',    file: '13-methods-message-ops.js',  title: '消息操作：清空 / 全屏 / 复制 / 编辑 / 删除 / 重新生成 / UI 模板更新', range: [479, 501] },
  { key: 'toolsRuntime',     file: '14-tools-runtime.js',        title: '主动工具：定义装配与系统提示词', range: [502, 512] },
  { key: 'generate',         file: '15-generate.js',             title: '主生成管线 generateResponse（流式、工具调用、思考链）', range: [513, 513] },
  { key: 'memoryExtraction', file: '16-memory-extraction.js',    title: '经典记忆抽取、二级压缩与向量索引', range: [514, 538] },
  { key: 'retrievalWeb',     file: '17-retrieval-web-tools.js',  title: '增强记忆召回、关键词检索工具与 Tavily 联网工具', range: [539, 555] },
  { key: 'toolsUi',          file: '18-tools-ui.js',             title: '工具调用的 UI 呈现、状态机与时间线', range: [556, 575] },
  { key: 'memoryBatch',      file: '19-memory-batch.js',         title: '记忆批量抽取、后台巡逻与中断恢复', range: [576, 582] },
  { key: 'characterCrud',    file: '20-character-crud.js',       title: '角色 / UI 模板增删改、批量删除与特殊规则', range: [583, 604] },
  { key: 'characterLife',    file: '21-character-lifecycle.js',  title: '角色切换、会话加载、剧情分支持久化与角色记忆加载', range: [605, 624] },
  { key: 'characterIo',      file: '22-character-io.js',         title: '世界书辅助函数与角色卡 / 聊天记录导入导出', range: [625, 642] },
  { key: 'lifecycle',        file: '23-lifecycle.js',            title: '启动初始化（onMounted）与卸载清理（onBeforeUnmount）', range: [643, 645] },
  { key: 'lateHelpers',      file: '24-late-helpers.js',         title: '正文流式截断、用户人设切换与记忆展示统计', range: [646, 659] },
];
const stmtModule = new Array(body.length).fill(-1);
MODULES.forEach((m, mi) => { for (let i = m.range[0]; i <= m.range[1]; i++) stmtModule[i] = mi; });
const BOOTSTRAP_RANGE = [0, 17];
const RETURN_IDX = body.length - 1;

// ---- 名称表 ----
function collectPatternNames(pat, out) {
  if (!pat) return;
  switch (pat.type) {
    case 'Identifier': out.push(pat.name); break;
    case 'RestElement': collectPatternNames(pat.argument, out); break;
    case 'AssignmentPattern': collectPatternNames(pat.left, out); break;
    case 'ArrayPattern': pat.elements.forEach(e => collectPatternNames(e, out)); break;
    case 'ObjectPattern': pat.properties.forEach(p => p.type === 'RestElement' ? collectPatternNames(p.argument, out) : collectPatternNames(p.value, out)); break;
  }
}
const declOf = new Map(); // name -> stmtIdx
body.forEach((stmt, i) => {
  const names = [];
  if (stmt.type === 'VariableDeclaration') stmt.declarations.forEach(d => collectPatternNames(d.id, names));
  else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id) names.push(stmt.id.name);
  names.forEach(n => declOf.set(n, i));
});
const bootstrapNames = new Set();
for (let i = BOOTSTRAP_RANGE[0]; i <= BOOTSTRAP_RANGE[1]; i++) {
  const stmt = body[i];
  if (stmt.type === 'VariableDeclaration') stmt.declarations.forEach(d => collectPatternNames(d.id, [...bootstrapNames].length ? [] : [])); // noop
}
// bootstrap 名集合（从 manifest stmts 取）
for (let i = BOOTSTRAP_RANGE[0]; i <= BOOTSTRAP_RANGE[1]; i++) manifest.stmts[i].decl.forEach(n => bootstrapNames.add(n));

// ---- 驻留名（有裸赋值/自增的 34 个）----
const residentNames = new Set(manifest.mutations.map(m => m.name));
// 校验：驻留名的声明必须是单声明符、id 为 Identifier 的 VariableDeclaration
for (const n of residentNames) {
  const stmt = body[declOf.get(n)];
  if (stmt.type !== 'VariableDeclaration' || stmt.declarations.length !== 1 || stmt.declarations[0].id.type !== 'Identifier') {
    console.error('resident decl not simple: ' + n + ' at stmt#' + declOf.get(n));
    process.exit(1);
  }
}
// 校验：没有 destr-assign / for-target 形式的 mutation
for (const m of manifest.mutations) {
  if (m.form === 'destr-assign' || m.form === 'for-target') {
    console.error('unsupported mutation form: ' + JSON.stringify(m));
    process.exit(1);
  }
}

// ---- 文本编辑 ----
function applyEdits(text, base, edits) {
  const sorted = edits.filter(e => e.start >= base && e.end <= base + text.length).sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start - base) + e.text + out.slice(e.end - base);
  return out;
}

// 为每条语句生成改写后的文本（不含镜像赋值）
function statementText(stmtIdx, mi /*-1=bootstrap, -2=return*/) {
  const stmt = body[stmtIdx];
  const edits = [];
  const myRefs = manifest.refs.filter(r => r.stmtIdx === stmtIdx);
  for (const r of myRefs) {
    const dIdx = declOf.get(r.name);
    const isBootstrap = bootstrapNames.has(r.name);
    const isResident = residentNames.has(r.name);
    const crossModule = isResident || (!isBootstrap && dIdx !== undefined && stmtModule[dIdx] !== mi);
    if (!crossModule) continue;
    if (r.kind === 'shorthand') edits.push({ start: r.start, end: r.end, text: `${r.name}: __s.${r.name}` });
    else edits.push({ start: r.start, end: r.end, text: `__s.${r.name}` });
  }
  for (const m of manifest.mutations.filter(x => x.stmtIdx === stmtIdx)) {
    if (!residentNames.has(m.name)) { console.error('mutation of non-resident: ' + m.name); process.exit(1); }
    edits.push({ start: m.start, end: m.end, text: `__s.${m.name}` });
  }
  let text = applyEdits(src.slice(stmt.start, stmt.end), stmt.start, edits);

  // 驻留名声明改写：let x = init; -> __s.x = init;
  if (stmt.type === 'VariableDeclaration') {
    const d = stmt.declarations[0];
    if (d.id.type === 'Identifier' && residentNames.has(d.id.name)) {
      if (d.init) {
        const re = new RegExp('^(\\s*)(?:let|var|const)\\s+' + d.id.name + '\\s*=');
        if (!re.test(text)) { console.error('resident decl rewrite failed: ' + d.id.name + ' text=' + text.slice(0, 80)); process.exit(1); }
        text = text.replace(re, `$1__s.${d.id.name} =`);
      } else {
        const re = new RegExp('^(\\s*)(?:let|var|const)\\s+' + d.id.name + '\\s*;?\\s*$');
        if (!re.test(text)) { console.error('resident decl(no-init) rewrite failed: ' + d.id.name); process.exit(1); }
        text = text.replace(re, `$1__s.${d.id.name} = void 0;`);
      }
    }
  }
  // 尾部分号保护（防 ASI  hazard）
  if (!/[\s;}]$/.test(text)) text += ';';
  return { text, stmt };
}

// 语句声明的、需要镜像到 __s 的名字（排除驻留名与 bootstrap）
function mirrorNames(stmtIdx) {
  const stmt = body[stmtIdx];
  const names = [];
  if (stmt.type === 'VariableDeclaration') stmt.declarations.forEach(d => collectPatternNames(d.id, names));
  else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id) names.push(stmt.id.name);
  return names.filter(n => !residentNames.has(n) && !bootstrapNames.has(n));
}

// 语句前的注释（含 banner）
function triviaBefore(stmtIdx) {
  // 注意：stmt0 的 prevEnd 是 setup 函数体的 '{' 之后（不含花括号本身）
  const prevEnd = stmtIdx === 0 ? setupFn.body.start + 1 : body[stmtIdx - 1].end;
  let t = src.slice(prevEnd, body[stmtIdx].start);
  // 规范化为最多一个前导空行
  t = t.replace(/^\s*\n/, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trimEnd() ? '\n' + t.replace(/^\n+/, '').replace(/ +$/gm, '') : '';
}

// ---- 生成模块文件 ----
fs.mkdirSync(OUT_DIR, { recursive: true });
const emitted = [];
MODULES.forEach((m, mi) => {
  const chunks = [];
  let firstLine = null, lastLine = null;
  for (let i = m.range[0]; i <= m.range[1]; i++) {
    const { text, stmt } = statementText(i, mi);
    if (firstLine === null) firstLine = stmt.loc.start.line;
    lastLine = stmt.loc.end.line;
    // acorn 的 stmt.start 指向首个 token（不含行首空白），模块函数体内统一补 8 空格基准缩进
    chunks.push(triviaBefore(i) + '        ' + text);
    const mirrors = mirrorNames(i);
    if (mirrors.length) chunks.push(mirrors.map(n => `        __s.${n} = ${n};`).join('\n'));
  }
  const out = `/**
 * RP-Hub 应用模块 ${String(mi + 1).padStart(2, '0')} · ${m.title}
 *
 * 拆分自原 assets/js/app.js 中 setup() 的第 ${firstLine}–${lastLine} 行。
 * 本文件是一个 App 模块函数，在 app.js 的 setup() 里按序号依次调用。
 *
 * 约定：
 * - 模块内顶层的 const/let 就是原 setup() 的顶层声明，语义保持不变；
 * - 每个声明会镜像到共享上下文 __s（return 给模板用的也是它）；
 * - 跨模块引用统一写作 __s.<name>；可被重新赋值的变量直接驻留在 __s 上；
 * - 文件顶部的全局辅助（ref/computed、RPHubXxx、bootstrap 常量）由 app.js
 *   顶部与 7 个基础 JS 提供，经典 script 共享全局词法作用域，直接用即可。
 */
(function () {
    window.RPHubAppSections = window.RPHubAppSections || {};
    window.RPHubAppSections.${m.key} = function (__s) {
${chunks.join('\n')}
    };
})();
`;
  fs.writeFileSync(path.join(OUT_DIR, m.file), out);
  emitted.push({ file: m.file, bytes: out.length });
});

// ---- bootstrap 文本（提升到 app.js 顶层）----
const bootstrapChunks = [];
for (let i = BOOTSTRAP_RANGE[0]; i <= BOOTSTRAP_RANGE[1]; i++) {
  const { text } = statementText(i, -1);
  bootstrapChunks.push(triviaBefore(i) + text);
}
const bootstrapText = `
// ============================================================================
// setup() 引导常量（原 setup() 前 29 行，提升到文件顶层，供各 App 模块共享。
// 经典 script 的全局词法作用域跨文件共享，app/*.js 模块可直接引用。）
// ============================================================================
${bootstrapChunks.join('\n').replace(/^ {8}/gm, '')}
`;

// ---- return 语句改写 ----
// return 里的引用：bootstrap 名保持裸引用（全局），其余 setup 名已全部改写为 __s.x。
// 原 return 缩进（8 空格）与新 setup 函数体缩进一致，无需调整。
const { text: returnText } = statementText(RETURN_IDX, -2);

// ---- 新 app.js ----
const headEnd = appDecl.start;
const tailStart = optionsObj.end + 1; // 跳过分号? optionsObj.end 是 } 之后
const head = src.slice(0, headEnd);
const tail = src.slice(appDecl.end);

const compText = src.slice(compProp.start, compProp.end);
const sectionCalls = MODULES.map(m => `        __sections.${m.key}(__s);`).join('\n');
const newApp = `${head}${bootstrapText}
const app = createApp({
    ${compText},
    setup() {
        // 共享上下文：全部 App 模块（assets/js/app/*.js）声明的状态与方法都镜像在此。
        // 模块按依赖顺序调用（与原 setup() 内的声明顺序一致），跨模块一律通过 __s 互访。
        const __s = {};
        const __sections = window.RPHubAppSections;
${sectionCalls}

        ${returnText}
    }
});
${tail}`;
fs.writeFileSync(SRC_FILE + '.new', newApp);

console.log('modules written:');
emitted.forEach(e => console.log('  ' + e.file + '  ' + e.bytes + 'B'));
console.log('app.js.new written: ' + newApp.length + 'B (orig ' + src.length + 'B)');
