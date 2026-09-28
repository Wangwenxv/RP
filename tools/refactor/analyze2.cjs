// 分析 app.js setup() 的顶层声明与引用关系，输出 manifest.json
const fs = require('fs');
const acorn = require('acorn');

const FILE = process.argv[2];
const src = fs.readFileSync(FILE, 'utf8');

const comments = [];
const ast = acorn.parse(src, {
  ecmaVersion: 2022,
  sourceType: 'script',
  locations: true,
  onComment: comments,
});

const lineOf = (pos) => ast.locations ? null : null; // placeholder
function loc(node) { return { start: node.loc.start.line, end: node.loc.end.line }; }

// ---------- 找 createApp({...}) 的 setup ----------
let setupFn = null, optionsObj = null;
(function find(node) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'createApp') {
    optionsObj = node.arguments[0];
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'range') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach(find);
    else if (v && typeof v.type === 'string') find(v);
  }
})(ast);
if (!optionsObj) { console.error('createApp options not found'); process.exit(1); }
for (const prop of optionsObj.properties) {
  const name = prop.key.name || prop.key.value;
  if (name === 'setup') setupFn = prop.value;
}
if (!setupFn) { console.error('setup not found'); process.exit(1); }
const body = setupFn.body.body; // 顶层语句数组
console.log(`setup() top-level statements: ${body.length}, lines ${setupFn.body.loc.start.line}-${setupFn.body.loc.end.line}`);

// ---------- 收集 setup 顶层声明名 ----------
const declared = new Map(); // name -> {stmtIdx, kind}
function collectPatternNames(pat, out) {
  if (!pat) return;
  switch (pat.type) {
    case 'Identifier': out.push(pat.name); break;
    case 'RestElement': collectPatternNames(pat.argument, out); break;
    case 'AssignmentPattern': collectPatternNames(pat.left, out); break;
    case 'ArrayPattern': pat.elements.forEach(e => collectPatternNames(e, out)); break;
    case 'ObjectPattern':
      for (const p of pat.properties) {
        if (p.type === 'RestElement') collectPatternNames(p.argument, out);
        else collectPatternNames(p.value, out);
      }
      break;
  }
}
body.forEach((stmt, i) => {
  const names = [];
  if (stmt.type === 'VariableDeclaration') {
    for (const d of stmt.declarations) collectPatternNames(d.id, names);
  } else if (stmt.type === 'FunctionDeclaration') {
    names.push(stmt.id.name);
  } else if (stmt.type === 'ClassDeclaration') {
    names.push(stmt.id.name);
  }
  for (const n of names) {
    if (declared.has(n)) console.warn(`!! duplicate declaration: ${n} (stmt ${declared.get(n).stmtIdx} and ${i})`);
    declared.set(n, { stmtIdx: i, kind: stmt.type });
  }
});
const N = declared; // setup 名集合
console.log(`setup top-level declared names: ${N.size}`);

// ---------- banner 注释归属 ----------
function bannerFor(stmt, prevEnd) {
  // 找 stmt 之前、prevEnd 之后的最后一个 `// --- xxx ---` 注释
  let banner = null;
  for (const c of comments) {
    if (c.start >= prevEnd && c.end <= stmt.start && c.type === 'Line') {
      const m = c.value.match(/^\s*-{3,}\s*(.+?)\s*-{3,}\s*$/) || c.value.match(/^\s*={3,}\s*(.+?)\s*={3,}\s*$/);
      if (m) banner = m[1];
    }
  }
  return banner;
}

// ---------- 作用域感知的引用收集 ----------
// scope: 对象数组（Set），只装 N 里的名字（只有 N 的名字需要判断遮蔽）
const isN = (n) => N.has(n);

// 收集函数体内的 var/函数声明（不跨函数边界）∩ N
function collectHoisted(fnBody) {
  const out = new Set();
  (function rec(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node !== fnBody && /Function/.test(node.type)) return; // 不跨函数
    if (node.type === 'FunctionDeclaration' && node.id && isN(node.id.name)) out.add(node.id.name);
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
      const names = []; node.declarations.forEach(d => collectPatternNames(d.id, names));
      names.filter(isN).forEach(n => out.add(n));
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'range' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(rec);
      else if (v && typeof v.type === 'string') rec(v);
    }
  })(fnBody);
  return out;
}
// 收集块级直接声明 ∩ N
function collectBlockScoped(block) {
  const out = new Set();
  for (const s of block.body || []) {
    if (s.type === 'VariableDeclaration' && (s.kind === 'let' || s.kind === 'const')) {
      const names = []; s.declarations.forEach(d => collectPatternNames(d.id, names));
      names.filter(isN).forEach(n => out.add(n));
    }
    if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id && isN(s.id.name)) out.add(s.id.name);
  }
  return out;
}

const refs = [];       // {name, start, end, stmtIdx, line, kind:'ref'|'shorthand', deferred}
const mutations = [];  // {name, start, end, stmtIdx, line, form:'assign'|'update'|'destr-assign'|'for-target'}
const warnings = [];

function resolve(scopes, name) {
  if (!isN(name)) return false; // 非 setup 名，不需要改写
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i].has(name)) return false; // 被局部遮蔽
  }
  return true; // 解析到 setup 顶层
}

function visitFunction(node, scopes, deferred, stmtIdx) {
  const fnScope = new Set();
  // 函数表达式名
  if (node.type === 'FunctionExpression' && node.id && isN(node.id.name)) fnScope.add(node.id.name);
  // 参数
  const paramNames = [];
  node.params.forEach(p => collectPatternNames(p, paramNames));
  paramNames.filter(isN).forEach(n => fnScope.add(n));
  // 函数体内 var/函数声明提升
  if (node.body.type === 'BlockStatement') collectHoisted(node.body).forEach(n => fnScope.add(n));
  const inner = [...scopes, fnScope];
  // 参数默认值在外层求值但在调用时 -> deferred；为简单起见在 inner 作用域访问（参数名已注册）
  for (const p of node.params) visitPatternDefaults(p, inner, true, stmtIdx);
  visit(node.body, inner, true, stmtIdx, node, 'body');
}
function visitPatternDefaults(pat, scopes, deferred, stmtIdx) {
  if (!pat) return;
  switch (pat.type) {
    case 'AssignmentPattern':
      visitPatternDefaults(pat.left, scopes, deferred, stmtIdx);
      visit(pat.right, scopes, deferred, stmtIdx, pat, 'right');
      break;
    case 'RestElement': visitPatternDefaults(pat.argument, scopes, deferred, stmtIdx); break;
    case 'ArrayPattern': pat.elements.forEach(e => visitPatternDefaults(e, scopes, deferred, stmtIdx)); break;
    case 'ObjectPattern':
      for (const p of pat.properties) {
        if (p.type === 'RestElement') visitPatternDefaults(p.argument, scopes, deferred, stmtIdx);
        else visitPatternDefaults(p.value, scopes, deferred, stmtIdx);
      }
      break;
  }
}

function visit(node, scopes, deferred, stmtIdx, parent, role) {
  if (!node || typeof node.type !== 'string') return;
  switch (node.type) {
    case 'Identifier': {
      if (resolve(scopes, node.name)) {
        refs.push({ name: node.name, start: node.start, end: node.end, stmtIdx, line: node.loc.start.line, kind: role === 'shorthand' ? 'shorthand' : 'ref', deferred });
      }
      return;
    }
    case 'FunctionDeclaration':
      // 函数声明：访问其默认参数与主体（函数名本身是绑定）
      visitFunction(node, scopes, deferred, stmtIdx);
      return;
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      visitFunction(node, scopes, true, stmtIdx);
      return;
    case 'BlockStatement':
    case 'StaticBlock': {
      const bs = collectBlockScoped(node);
      const inner = bs.size ? [...scopes, bs] : scopes;
      for (const s of node.body) visit(s, inner, deferred, stmtIdx, node, 'stmt');
      return;
    }
    case 'ForStatement': {
      let inner = scopes;
      if (node.init && node.init.type === 'VariableDeclaration') {
        const names = []; node.init.declarations.forEach(d => collectPatternNames(d.id, names));
        const s = new Set(names.filter(isN));
        if (s.size) inner = [...scopes, s];
        for (const d of node.init.declarations) {
          visitPatternDefaults(d.id, inner, deferred, stmtIdx);
          if (d.init) visit(d.init, inner, deferred, stmtIdx, d, 'init');
        }
      } else if (node.init) visit(node.init, inner, deferred, stmtIdx, node, 'init');
      if (node.test) visit(node.test, inner, deferred, stmtIdx, node, 'test');
      if (node.update) visit(node.update, inner, deferred, stmtIdx, node, 'update');
      visit(node.body, inner, deferred, stmtIdx, node, 'body');
      return;
    }
    case 'ForInStatement':
    case 'ForOfStatement': {
      let inner = scopes;
      if (node.left.type === 'VariableDeclaration') {
        const names = []; node.left.declarations.forEach(d => collectPatternNames(d.id, names));
        const s = new Set(names.filter(isN));
        if (s.size) inner = [...scopes, s];
        node.left.declarations.forEach(d => visitPatternDefaults(d.id, inner, deferred, stmtIdx));
      } else {
        visitAssignTarget(node.left, scopes, deferred, stmtIdx, 'for-target');
      }
      visit(node.right, inner, deferred, stmtIdx, node, 'right');
      visit(node.body, inner, deferred, stmtIdx, node, 'body');
      return;
    }
    case 'CatchClause': {
      const s = new Set();
      const names = []; collectPatternNames(node.param, names);
      names.filter(isN).forEach(n => s.add(n));
      const inner = s.size ? [...scopes, s] : scopes;
      if (node.param) visitPatternDefaults(node.param, inner, deferred, stmtIdx);
      visit(node.body, inner, deferred, stmtIdx, node, 'body');
      return;
    }
    case 'SwitchStatement': {
      visit(node.discriminant, scopes, deferred, stmtIdx, node, 'disc');
      // case 共享一个块作用域
      const s = new Set();
      for (const c of node.cases) for (const st of c.consequent) {
        if (st.type === 'VariableDeclaration' && st.kind !== 'var') {
          const names = []; st.declarations.forEach(d => collectPatternNames(d.id, names));
          names.filter(isN).forEach(n => s.add(n));
        }
      }
      const inner = s.size ? [...scopes, s] : scopes;
      for (const c of node.cases) {
        if (c.test) visit(c.test, inner, deferred, stmtIdx, c, 'test');
        c.consequent.forEach(st => visit(st, inner, deferred, stmtIdx, c, 'cons'));
      }
      return;
    }
    case 'VariableDeclaration': {
      for (const d of node.declarations) {
        visitPatternDefaults(d.id, scopes, deferred, stmtIdx);
        if (d.init) visit(d.init, scopes, deferred, stmtIdx, d, 'init');
      }
      return;
    }
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      visit(node.object, scopes, deferred, stmtIdx, node, 'object');
      if (node.computed) visit(node.property, scopes, deferred, stmtIdx, node, 'property');
      return;
    }
    case 'Property': {
      // ObjectExpression/ObjectPattern 中的 Property 由父级分派；走到这里说明是对象字面量
      if (node.computed) visit(node.key, scopes, deferred, stmtIdx, node, 'key');
      if (node.shorthand && node.value.type === 'Identifier') {
        if (resolve(scopes, node.value.name)) {
          refs.push({ name: node.value.name, start: node.value.start, end: node.value.end, stmtIdx, line: node.loc.start.line, kind: 'shorthand', deferred });
        }
        return;
      }
      visit(node.value, scopes, deferred, stmtIdx, node, 'value');
      return;
    }
    case 'ObjectExpression': {
      for (const p of node.properties) {
        if (p.type === 'SpreadElement') visit(p.argument, scopes, deferred, stmtIdx, p, 'arg');
        else visit(p, scopes, deferred, stmtIdx, node, 'prop');
      }
      return;
    }
    case 'AssignmentExpression': {
      visitAssignTarget(node.left, scopes, deferred, stmtIdx, node.operator === '=' ? 'assign' : 'compound');
      visit(node.right, scopes, deferred, stmtIdx, node, 'right');
      return;
    }
    case 'UpdateExpression': {
      if (node.argument.type === 'Identifier') {
        if (resolve(scopes, node.argument.name)) {
          mutations.push({ name: node.argument.name, start: node.argument.start, end: node.argument.end, stmtIdx, line: node.loc.start.line, form: 'update', deferred });
        }
      } else visit(node.argument, scopes, deferred, stmtIdx, node, 'arg');
      return;
    }
    case 'LabeledStatement': {
      visit(node.body, scopes, deferred, stmtIdx, node, 'body');
      return;
    }
    case 'BreakStatement': case 'ContinueStatement': return;
    case 'MethodDefinition': case 'PropertyDefinition': {
      if (node.computed) visit(node.key, scopes, deferred, stmtIdx, node, 'key');
      if (node.value) visit(node.value, scopes, deferred, stmtIdx, node, 'value');
      return;
    }
    case 'ClassDeclaration': case 'ClassExpression': {
      if (node.superClass) visit(node.superClass, scopes, deferred, stmtIdx, node, 'super');
      node.body.body.forEach(m => visit(m, scopes, deferred, stmtIdx, node, 'member'));
      return;
    }
    case 'ThisExpression':
      warnings.push({ msg: 'this in setup', line: node.loc.start.line, stmtIdx });
      return;
    case 'AwaitExpression':
      if (!deferred) warnings.push({ msg: 'top-level await in setup', line: node.loc.start.line, stmtIdx });
      visit(node.argument, scopes, deferred, stmtIdx, node, 'arg');
      return;
    default: {
      // 通用递归
      for (const k of Object.keys(node)) {
        if (k === 'loc' || k === 'range' || k === 'start' || k === 'end') continue;
        if (k === 'id' && /Function/.test(node.type)) continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach(c => visit(c, scopes, deferred, stmtIdx, node, k));
        else if (v && typeof v.type === 'string') visit(v, scopes, deferred, stmtIdx, node, k);
      }
    }
  }
}

function visitAssignTarget(target, scopes, deferred, stmtIdx, form) {
  if (!target) return;
  if (target.type === 'Identifier') {
    if (resolve(scopes, target.name)) {
      mutations.push({ name: target.name, start: target.start, end: target.end, stmtIdx, line: target.loc.start.line, form, deferred });
    }
    return;
  }
  if (target.type === 'ObjectPattern' || target.type === 'ArrayPattern') {
    const names = []; collectPatternNames(target, names);
    for (const n of names) {
      if (resolve(scopes, n)) {
        const idNode = (function findId(p) {
          let found = null;
          (function rec(x) {
            if (!x || typeof x.type !== 'string') return;
            if (x.type === 'Identifier' && x.name === n && !found) { found = x; return; }
            for (const k of Object.keys(x)) {
              if (k === 'loc' || k === 'start' || k === 'end') continue;
              const v = x[k];
              if (Array.isArray(v)) v.forEach(rec);
              else if (v && typeof v.type === 'string') rec(v);
            }
          })(p);
          return found;
        })(target);
        mutations.push({ name: n, start: idNode ? idNode.start : target.start, end: idNode ? idNode.end : target.end, stmtIdx, line: target.loc.start.line, form: 'destr-assign', deferred });
      }
    }
    visitPatternDefaults(target, scopes, deferred, stmtIdx);
    return;
  }
  visit(target, scopes, deferred, stmtIdx, null, 'target');
}

// 顶层：setup 作用域为空（所有 N 名都是 setup 级绑定）
const setupScopes = [new Set()];
body.forEach((stmt, i) => visit(stmt, setupScopes, false, i, null, 'top'));

// ---------- return 语句分析 ----------
const returnStmt = body[body.length - 1];
const isReturn = returnStmt.type === 'ReturnStatement';
console.log(`last stmt is ReturnStatement: ${isReturn}`);

// ---------- 汇总输出 ----------
const stmts = body.map((stmt, i) => {
  const prevEnd = i === 0 ? setupFn.body.start : body[i - 1].end;
  const names = [];
  if (stmt.type === 'VariableDeclaration') stmt.declarations.forEach(d => collectPatternNames(d.id, names));
  else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id) names.push(stmt.id.name);
  const myRefs = refs.filter(r => r.stmtIdx === i);
  const myMuts = mutations.filter(m => m.stmtIdx === i);
  return {
    idx: i,
    type: stmt.type,
    lines: [stmt.loc.start.line, stmt.loc.end.line],
    decl: names,
    banner: bannerFor(stmt, prevEnd),
    refsImmediate: [...new Set(myRefs.filter(r => !r.deferred).map(r => r.name))],
    refsDeferred: [...new Set(myRefs.filter(r => r.deferred).map(r => r.name))],
    mutations: [...new Set(myMuts.map(m => m.name))],
  };
});

const mutatedNames = [...new Set(mutations.map(m => m.name))];
console.log(`\nnames with bare reassignment/update: ${mutatedNames.length}`);
for (const n of mutatedNames) {
  const decl = N.get(n);
  const muts = mutations.filter(m => m.name === n);
  console.log(`  ${n} (decl stmt#${decl.stmtIdx} L${stmts[decl.stmtIdx].lines[0]}) mutated in stmts: ${[...new Set(muts.map(m => m.stmtIdx))].join(',')} forms:${[...new Set(muts.map(m => m.form))].join(',')}`);
}
console.log(`\nwarnings: ${warnings.length}`);
warnings.slice(0, 20).forEach(w => console.log('  ', JSON.stringify(w)));

fs.writeFileSync(process.argv[3], JSON.stringify({ stmts, refs, mutations, warnings, declaredNames: [...N.keys()] }, null, 1));
console.log('\nmanifest written');
