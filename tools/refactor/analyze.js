// 解析 app.js：列出 createApp 选项对象的顶层结构，
// 以及 data() 返回对象 / computed / methods / watch 的每个顶层成员的行列范围。
const fs = require('fs');
const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');

// ---- 轻量 tokenizer：跳过字符串/模板串/注释/正则，输出括号配对 ----
function scan(src) {
  const n = src.length;
  let i = 0, line = 1;
  const pairs = []; // {open, close, oLine, cLine, oIdx, cIdx, ch}
  const stack = [];
  let prevSig = ''; // 上一个有效字符（判断正则用）
  const canStartRegex = (p) => p === '' || '(,=:[!&|?{};+-*%<>~^'.includes(p) || p === '\n';
  while (i < n) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; prevSig = '\n'; continue; }
    // 注释
    if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    // 字符串
    if (ch === '"' || ch === "'") {
      const q = ch; i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i++; if (src[i] === '\n') line++; i++; }
      i++; prevSig = q; continue;
    }
    // 模板串（含 ${} 嵌套）
    if (ch === '`') {
      i++;
      let tDepth = 0;
      while (i < n) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '\n') { line++; i++; continue; }
        if (c === '`' && tDepth === 0) { i++; break; }
        if (c === '$' && src[i + 1] === '{') { tDepth++; i += 2; continue; }
        if (c === '}' && tDepth > 0) { tDepth--; i++; continue; }
        i++;
      }
      prevSig = '`'; continue;
    }
    // 正则字面量（启发式）
    if (ch === '/' && canStartRegex(prevSig)) {
      let j = i + 1, ok = false, inClass = false;
      while (j < n) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { ok = true; break; }
        j++;
      }
      if (ok) { i = j + 1; while (i < n && /[a-z]/i.test(src[i])) i++; prevSig = '/'; continue; }
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      stack.push({ ch, line, idx: i }); i++; prevSig = ch; continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      const open = stack.pop();
      if (open) pairs.push({ ch: open.ch, oLine: open.line, cLine: line, oIdx: open.idx, cIdx: i });
      i++; prevSig = ch; continue;
    }
    if (!/\s/.test(ch)) prevSig = ch;
    i++;
  }
  return pairs;
}

const pairs = scan(src);
// 找包含某 idx 的最内层配对
function innermost(idx, ch) {
  let best = null;
  for (const p of pairs) {
    if (ch && p.ch !== ch) continue;
    if (p.oIdx <= idx && p.cIdx >= idx) {
      if (!best || p.oIdx > best.oIdx) best = p;
    }
  }
  return best;
}
// 找直接子级对象/函数成员：给定父配对的 oIdx/cIdx，扫描其内部 depth+1 层的 "key:" 或 "key(...){" 或 "key() { return {...} }"
const lineStartIdx = [0];
for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStartIdx.push(k + 1);
function lineOf(idx) { let lo = 0, hi = lineStartIdx.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStartIdx[mid] <= idx) lo = mid; else hi = mid - 1; } return lo + 1; }

// createApp( { ... } )
const caIdx = src.indexOf('createApp({');
if (caIdx < 0) { console.error('createApp({ not found'); process.exit(1); }
const appObj = innermost(caIdx + 'createApp('.length, '{');
console.log(`createApp options object: lines ${appObj.oLine}-${appObj.cLine}`);

// 列出某对象配对内的顶层成员名与行范围（按逗号分隔，depth = 父层+1）
function listMembers(objPair) {
  const members = [];
  const childPairs = pairs.filter(p => p.oIdx > objPair.oIdx && p.cIdx < objPair.cIdx);
  const depthOf = (idx) => pairs.filter(p => p.oIdx < idx && p.cIdx > idx && (p.ch === '{' || p.ch === '[' || p.ch === '(')).length;
  const baseDepth = depthOf(objPair.oIdx + 1);
  // 在父层文本里按 depth==baseDepth 扫描标识符
  let i = objPair.oIdx + 1;
  const end = objPair.cIdx;
  const skipString = (i) => {
    const ch = src[i];
    if (ch === '"' || ch === "'") { const q = ch; i++; while (i < end && src[i] !== q) { if (src[i] === '\\') i++; i++; } return i + 1; }
    if (ch === '`') { i++; let d = 0; while (i < end) { const c = src[i]; if (c === '\\') { i += 2; continue; } if (c === '`' && d === 0) { i++; break; } if (c === '$' && src[i+1] === '{') { d++; i += 2; continue; } if (c === '}' && d > 0) { d--; } i++; } return i; }
    return i + 1;
  };
  while (i < end) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(i); continue; }
    if (ch === '/' && src[i+1] === '/') { while (i < end && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i+1] === '*') { i += 2; while (i < end && !(src[i] === '*' && src[i+1] === '/')) i++; i += 2; continue; }
    if ('{[('.includes(ch)) { const p = innermost(i, ch); if (p && p.oIdx === i) { i = p.cIdx + 1; continue; } }
    // 尝试匹配成员名
    const m = src.slice(i).match(/^(?:\/\*[\s\S]*?\*\/\s*)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*|\'[^\']+\'|"[^"]+")\s*(?::|\()/);
    if (m && depthOf(i) === baseDepth) {
      const nameRaw = m[1];
      const name = nameRaw.replace(/^['"]|['"]$/g, '');
      members.push({ name, line: lineOf(i), idx: i });
      i += m[0].length;
      continue;
    }
    i++;
  }
  // 计算每个成员的结束行（到下一个成员前）
  for (let k = 0; k < members.length; k++) {
    const nextStart = k + 1 < members.length ? members[k + 1].idx : end;
    members[k].endLine = lineOf(nextStart) - (k + 1 < members.length ? 1 : 0);
    delete members[k].idx;
  }
  return members;
}

// 顶层选项
const top = listMembers(appObj);
console.log('\n== top-level options ==');
for (const t of top) console.log(`  ${t.name}  L${t.line}-${t.endLine}`);

// 对 data()（函数）找 return { }
const report = {};
for (const t of top) {
  if (['computed', 'methods', 'watch', 'directives', 'components'].includes(t.name)) {
    // 找该成员名下的第一个 { 对象
    const segStart = src.indexOf(t.name, appObj.oIdx);
    const braceIdx = src.indexOf('{', segStart + t.name.length);
    const p = innermost(braceIdx, '{');
    report[t.name] = listMembers(p);
  }
}
// data() -> return 对象
{
  const dataM = top.find(t => t.name === 'data');
  if (dataM) {
    const retIdx = src.indexOf('return', src.indexOf('data', appObj.oIdx));
    const braceIdx = src.indexOf('{', retIdx);
    const p = innermost(braceIdx, '{');
    report.data = listMembers(p);
  }
}
console.log('\n== member counts ==');
for (const k of Object.keys(report)) console.log(`  ${k}: ${report[k].length}`);
fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
console.log('manifest written to ' + process.argv[3]);
