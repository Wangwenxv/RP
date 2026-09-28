// 校验拆分结果：
// 1) 每个新文件语法可解析
// 2) __s 上赋值的名称集合 == 原 setup 顶层声明集合（662）
// 3) 每个模块函数体内，对原 setup 名的裸引用只允许是：本模块声明 / bootstrap 全局名
// 4) return 对象中不允许残留对非 bootstrap setup 名的裸引用
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const OUT_DIR = path.resolve(__dirname, '../../assets/js/app');
const manifest = require('./manifest2.json');
const setupNames = new Set(manifest.declaredNames);
const bootstrapNames = new Set(manifest.stmts.slice(0, 18).flatMap(s => s.decl));

let fail = 0;
const err = (m) => { console.error('FAIL: ' + m); fail++; };

// 收集某函数体内所有"裸引用"（解析到模块函数顶层的名字）
function analyzeModule(file, src) {
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script', locations: true }); }
  catch (e) { err(file + ' parse error: ' + e.message); return null; }
  // 找 window.RPHubAppSections.x = function(__s) { ... }
  let fn = null;
  (function rec(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'AssignmentExpression' && node.right.type === 'FunctionExpression' &&
        node.left.type === 'MemberExpression' && node.left.object.type === 'MemberExpression') fn = node.right;
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(rec);
      else if (v && typeof v.type === 'string') rec(v);
    }
  })(ast);
  if (!fn) { err(file + ': module function not found'); return null; }

  // 模块函数顶层声明
  const local = new Set(['__s']);
  function collectPat(pat, out) {
    if (!pat) return;
    switch (pat.type) {
      case 'Identifier': out.push(pat.name); break;
      case 'RestElement': collectPat(pat.argument, out); break;
      case 'AssignmentPattern': collectPat(pat.left, out); break;
      case 'ArrayPattern': pat.elements.forEach(e => collectPat(e, out)); break;
      case 'ObjectPattern': pat.properties.forEach(p => p.type === 'RestElement' ? collectPat(p.argument, out) : collectPat(p.value, out)); break;
    }
  }
  for (const st of fn.body.body) {
    const names = [];
    if (st.type === 'VariableDeclaration') st.declarations.forEach(d => collectPat(d.id, names));
    else if ((st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') && st.id) names.push(st.id.name);
    names.forEach(n => local.add(n));
  }

  // 作用域解析（同 analyze2，但遮蔽集合 = local ∪ 任意嵌套绑定）
  const leaks = [];
  function collectHoisted(fnBody, scopeNames) {
    (function rec(node) {
      if (!node || typeof node.type !== 'string') return;
      if (node !== fnBody && /Function/.test(node.type)) return;
      if (node.type === 'FunctionDeclaration' && node.id) scopeNames.add(node.id.name);
      if (node.type === 'VariableDeclaration' && node.kind === 'var') {
        const names = []; node.declarations.forEach(d => collectPat(d.id, names));
        names.forEach(n => scopeNames.add(n));
      }
      for (const k of Object.keys(node)) {
        if (k === 'loc' || k === 'start' || k === 'end') continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach(rec);
        else if (v && typeof v.type === 'string') rec(v);
      }
    })(fnBody);
  }
  function visitFunction(node, scopes) {
    const s = new Set();
    if (node.type === 'FunctionExpression' && node.id) s.add(node.id.name);
    const names = []; node.params.forEach(p => collectPat(p, names));
    names.forEach(n => s.add(n));
    if (node.body.type === 'BlockStatement') collectHoisted(node.body, s);
    const inner = [...scopes, s];
    node.params.forEach(p => visitDefaults(p, inner));
    visit(node.body, inner);
  }
  function visitDefaults(pat, scopes) {
    if (!pat) return;
    switch (pat.type) {
      case 'AssignmentPattern': visitDefaults(pat.left, scopes); visit(pat.right, scopes); break;
      case 'RestElement': visitDefaults(pat.argument, scopes); break;
      case 'ArrayPattern': pat.elements.forEach(e => visitDefaults(e, scopes)); break;
      case 'ObjectPattern': pat.properties.forEach(p => p.type === 'RestElement' ? visitDefaults(p.argument, scopes) : visitDefaults(p.value, scopes)); break;
    }
  }
  function shadowed(scopes, name) {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return true;
    return false;
  }
  function visit(node, scopes) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Identifier': {
        if (setupNames.has(node.name) && !bootstrapNames.has(node.name) && !local.has(node.name) && !shadowed(scopes, node.name)) {
          leaks.push(node.name + '@L' + node.loc.start.line);
        }
        return;
      }
      case 'FunctionDeclaration': visitFunction(node, scopes); return;
      case 'FunctionExpression': case 'ArrowFunctionExpression': visitFunction(node, scopes); return;
      case 'BlockStatement': case 'StaticBlock': {
        const s = new Set();
        for (const st of node.body || []) {
          if (st.type === 'VariableDeclaration' && st.kind !== 'var') { const names = []; st.declarations.forEach(d => collectPat(d.id, names)); names.forEach(n => s.add(n)); }
          if ((st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') && st.id) s.add(st.id.name);
        }
        const inner = s.size ? [...scopes, s] : scopes;
        (node.body || []).forEach(st => visit(st, inner));
        return;
      }
      case 'ForStatement': {
        let inner = scopes;
        if (node.init && node.init.type === 'VariableDeclaration') {
          const names = []; node.init.declarations.forEach(d => collectPat(d.id, names));
          const s = new Set(names); if (s.size) inner = [...scopes, s];
          node.init.declarations.forEach(d => { visitDefaults(d.id, inner); if (d.init) visit(d.init, inner); });
        } else if (node.init) visit(node.init, inner);
        if (node.test) visit(node.test, inner);
        if (node.update) visit(node.update, inner);
        visit(node.body, inner);
        return;
      }
      case 'ForInStatement': case 'ForOfStatement': {
        let inner = scopes;
        if (node.left.type === 'VariableDeclaration') {
          const names = []; node.left.declarations.forEach(d => collectPat(d.id, names));
          const s = new Set(names); if (s.size) inner = [...scopes, s];
          node.left.declarations.forEach(d => visitDefaults(d.id, inner));
        } else visit(node.left, inner);
        visit(node.right, inner); visit(node.body, inner);
        return;
      }
      case 'CatchClause': {
        const names = []; collectPat(node.param, names);
        const s = new Set(names);
        const inner = s.size ? [...scopes, s] : scopes;
        if (node.param) visitDefaults(node.param, inner);
        visit(node.body, inner);
        return;
      }
      case 'MemberExpression': case 'OptionalMemberExpression': {
        visit(node.object, scopes);
        if (node.computed) visit(node.property, scopes);
        return;
      }
      case 'Property': {
        if (node.computed) visit(node.key, scopes);
        if (!(node.shorthand && node.value.type === 'Identifier')) visit(node.value, scopes);
        return;
      }
      case 'LabeledStatement': visit(node.body, scopes); return;
      case 'BreakStatement': case 'ContinueStatement': return;
      case 'MethodDefinition': case 'PropertyDefinition': {
        if (node.computed) visit(node.key, scopes);
        if (node.value) visit(node.value, scopes);
        return;
      }
      case 'SwitchStatement': {
        visit(node.discriminant, scopes);
        const s = new Set();
        for (const c of node.cases) for (const st of c.consequent) {
          if (st.type === 'VariableDeclaration' && st.kind !== 'var') { const names = []; st.declarations.forEach(d => collectPat(d.id, names)); names.forEach(n => s.add(n)); }
        }
        const inner = s.size ? [...scopes, s] : scopes;
        for (const c of node.cases) { if (c.test) visit(c.test, inner); c.consequent.forEach(st => visit(st, inner)); }
        return;
      }
      default: {
        for (const k of Object.keys(node)) {
          if (k === 'loc' || k === 'start' || k === 'end') continue;
          if (k === 'id' && /Function/.test(node.type)) continue;
          const v = node[k];
          if (Array.isArray(v)) v.forEach(c => visit(c, scopes));
          else if (v && typeof v.type === 'string') visit(v, scopes);
        }
      }
    }
  }
  const topScope = new Set(); // local 已在外层判断，无需重复
  fn.body.body.forEach(st => visit(st, [topScope]));
  return { local, leaks, ast };
}

// 1+3) 模块文件
const assigned = new Map(); // name -> file
const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.js')).sort();
for (const f of files) {
  const src = fs.readFileSync(path.join(OUT_DIR, f), 'utf8');
  const r = analyzeModule(f, src);
  if (!r) continue;
  if (r.leaks.length) err(f + ' bare leaks: ' + [...new Set(r.leaks)].slice(0, 10).join(', '));
  // 收集模块函数顶层的 __s.x = 赋值（镜像与驻留声明都是 8 空格缩进；
  // 函数体内的再赋值缩进更深，不匹配此模式，避免误报）
  const re = /^ {8}__s\.([A-Za-z_$][\w$]*) =/gm;
  let m;
  while ((m = re.exec(src))) {
    if (assigned.has(m[1]) && assigned.get(m[1]) !== f) err(`name ${m[1]} assigned in both ${assigned.get(m[1])} and ${f}`);
    assigned.set(m[1], f);
  }
}

// 2) 名称集合一致
const missing = [...setupNames].filter(n => !bootstrapNames.has(n) && !assigned.has(n));
const extra = [...assigned.keys()].filter(n => !setupNames.has(n));
if (missing.length) err('names not assigned to __s: ' + missing.slice(0, 20).join(',') + (missing.length > 20 ? '...' : ''));
if (extra.length) err('extra __s names not in original: ' + extra.slice(0, 20).join(','));
console.log(`__s assigned names: ${assigned.size}, original setup names: ${setupNames.size} (bootstrap: ${bootstrapNames.size})`);

// 4) return 检查（AST 级）
const appNew = fs.readFileSync(path.resolve(__dirname, '../../assets/js/app.js.new'), 'utf8');
let appAst = null;
try { appAst = acorn.parse(appNew, { ecmaVersion: 2022, sourceType: 'script', locations: true }); console.log('app.js.new parses OK'); }
catch (e) { err('app.js.new parse error: ' + e.message); }
if (appAst) {
  // 文件级全局名
  const fileGlobals = new Set(['Vue', 'marked', 'window', 'document', 'localStorage', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'confirm', 'alert', 'Blob', 'URL', 'FileReader', 'Image', 'navigator', 'location', 'history', 'JSON', 'Math', 'Date', 'Number', 'String', 'Array', 'Object', 'Map', 'Set', 'WeakMap', 'Promise', 'RegExp', 'Error', 'console', 'Intl', 'crypto', 'indexedDB', 'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'CustomEvent', 'Event', 'HTMLElement', 'FormData', 'AbortController', 'TextDecoder', 'TextEncoder', 'atob', 'btoa', 'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Infinity', 'NaN', 'undefined', 'DOMPurify', 'Sortable', '__s', '__sections']);
  function collectPatG(pat, out) {
    if (!pat) return;
    switch (pat.type) {
      case 'Identifier': out.push(pat.name); break;
      case 'RestElement': collectPatG(pat.argument, out); break;
      case 'AssignmentPattern': collectPatG(pat.left, out); break;
      case 'ArrayPattern': pat.elements.forEach(e => collectPatG(e, out)); break;
      case 'ObjectPattern': pat.properties.forEach(p => p.type === 'RestElement' ? collectPatG(p.argument, out) : collectPatG(p.value, out)); break;
    }
  }
  for (const st of appAst.body) {
    const names = [];
    if (st.type === 'VariableDeclaration') st.declarations.forEach(d => collectPatG(d.id, names));
    else if ((st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') && st.id) names.push(st.id.name);
    names.forEach(n => fileGlobals.add(n));
  }
  // 找 setup 的 return 对象，做泄漏扫描（遮蔽分析复用简化版：只看是否引用 setup 名且未被局部绑定）
  let setupFn2 = null;
  (function rec(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Property' && (node.key.name === 'setup' || node.key.value === 'setup')) setupFn2 = node.value;
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(rec);
      else if (v && typeof v.type === 'string') rec(v);
    }
  })(appAst);
  const ret = setupFn2 && setupFn2.body.body.find(s => s.type === 'ReturnStatement');
  if (!ret) err('return not found in new setup');
  else {
    const leaks = [];
    // 通用访问器：收集 Identifier 引用（排除属性键/标签/绑定），检查是否为 setup 名
    function shadowed(scopes, name) { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return true; return false; }
    function visitFn(node, scopes) {
      const s = new Set();
      if (node.type === 'FunctionExpression' && node.id) s.add(node.id.name);
      const names = []; node.params.forEach(p => collectPatG(p, names));
      names.forEach(n => s.add(n));
      if (node.body.type === 'BlockStatement') {
        (function recH(b) {
          (function rec2(x) {
            if (!x || typeof x.type !== 'string') return;
            if (x !== b && /Function/.test(x.type)) return;
            if (x.type === 'FunctionDeclaration' && x.id) s.add(x.id.name);
            if (x.type === 'VariableDeclaration' && x.kind === 'var') { const ns = []; x.declarations.forEach(d => collectPatG(d.id, ns)); ns.forEach(n => s.add(n)); }
            for (const k of Object.keys(x)) { if (k === 'loc' || k === 'start' || k === 'end') continue; const v = x[k]; if (Array.isArray(v)) v.forEach(rec2); else if (v && typeof v.type === 'string') rec2(v); }
          })(b);
        })(node.body);
      }
      const inner = [...scopes, s];
      node.params.forEach(p => visitDef(p, inner));
      visit2(node.body, inner);
    }
    function visitDef(pat, scopes) {
      if (!pat) return;
      switch (pat.type) {
        case 'AssignmentPattern': visitDef(pat.left, scopes); visit2(pat.right, scopes); break;
        case 'RestElement': visitDef(pat.argument, scopes); break;
        case 'ArrayPattern': pat.elements.forEach(e => visitDef(e, scopes)); break;
        case 'ObjectPattern': pat.properties.forEach(p => p.type === 'RestElement' ? visitDef(p.argument, scopes) : visitDef(p.value, scopes)); break;
      }
    }
    function visit2(node, scopes) {
      if (!node || typeof node.type !== 'string') return;
      switch (node.type) {
        case 'Identifier':
          if (setupNames.has(node.name) && !bootstrapNames.has(node.name) && !fileGlobals.has(node.name) && !shadowed(scopes, node.name)) leaks.push(node.name + '@L' + node.loc.start.line);
          return;
        case 'FunctionDeclaration': visitFn(node, scopes); return;
        case 'FunctionExpression': case 'ArrowFunctionExpression': visitFn(node, scopes); return;
        case 'MemberExpression': case 'OptionalMemberExpression':
          visit2(node.object, scopes); if (node.computed) visit2(node.property, scopes); return;
        case 'Property':
          if (node.computed) visit2(node.key, scopes);
          if (!(node.shorthand && node.value.type === 'Identifier')) visit2(node.value, scopes);
          else if (setupNames.has(node.value.name) && !bootstrapNames.has(node.value.name) && !fileGlobals.has(node.value.name) && !shadowed(scopes, node.value.name)) leaks.push(node.value.name + '(shorthand)@L' + node.loc.start.line);
          return;
        case 'BlockStatement': case 'StaticBlock': {
          const s = new Set();
          for (const st of node.body || []) {
            if (st.type === 'VariableDeclaration' && st.kind !== 'var') { const ns = []; st.declarations.forEach(d => collectPatG(d.id, ns)); ns.forEach(n => s.add(n)); }
            if ((st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') && st.id) s.add(st.id.name);
          }
          const inner = s.size ? [...scopes, s] : scopes;
          (node.body || []).forEach(st => visit2(st, inner));
          return;
        }
        case 'LabeledStatement': visit2(node.body, scopes); return;
        case 'BreakStatement': case 'ContinueStatement': return;
        case 'MethodDefinition': case 'PropertyDefinition':
          if (node.computed) visit2(node.key, scopes); if (node.value) visit2(node.value, scopes); return;
        default:
          for (const k of Object.keys(node)) {
            if (k === 'loc' || k === 'start' || k === 'end') continue;
            if (k === 'id' && /Function/.test(node.type)) continue;
            const v = node[k];
            if (Array.isArray(v)) v.forEach(c => visit2(c, scopes));
            else if (v && typeof v.type === 'string') visit2(v, scopes);
          }
      }
    }
    visit2(ret.argument, [new Set()]);
    if (leaks.length) err('return bare refs to setup names: ' + [...new Set(leaks)].slice(0, 20).join(','));
    else console.log('return object: no bare setup-name refs (AST scan)');
  }
}

console.log(fail === 0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECKS FAILED`);
process.exit(fail ? 1 : 0);
