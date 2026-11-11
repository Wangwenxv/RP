#!/usr/bin/env node
/**
 * card 目录角色卡 → 单文件预览生成器
 *
 * 扫描 card/ 下所有角色卡 JSON（含子目录），把卡片数据内联进 viewer.html，
 * 输出预览文件（双击即可打开，无需本地服务器）。
 *
 * 用法：
 *   node build-preview.cjs            # 生成 preview.html + manifest.json
 *   node build-preview.cjs --list     # 只看识别到哪些卡
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const VIEWER = path.join(ROOT, 'viewer.html');
const OUT = path.join(ROOT, 'preview.html');
const MANIFEST = path.join(ROOT, 'manifest.json');
const MAX_SIZE = 3 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.refactor-tmp']);

function walk(dir, acc) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return acc; }
  for (const name of names) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) walk(p, acc);
    else if (/\.json$/i.test(name) && st.size <= MAX_SIZE) acc.push(p);
  }
  return acc;
}

/** 判断并归一化角色卡；不是卡就返回 null */
function asCard(file, json) {
  const d = json && json.data ? json.data : json;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (!d.name || typeof d.name !== 'string') return null;
  const hasProfile = typeof d.personality === 'string' || typeof d.description === 'string';
  const hasBook = d.character_book && Array.isArray(d.character_book.entries);
  if (!hasProfile && !hasBook) return null;
  const entries = hasBook ? d.character_book.entries.length : 0;
  const chars =
    (d.personality || '').length +
    (d.first_mes || '').length +
    (hasBook ? d.character_book.entries.reduce((a, e) => a + String(e.content || '').length, 0) : 0);
  return {
    file: path.relative(ROOT, file).split(path.sep).join('/'),
    name: d.name,
    entries,
    chars,
    data: json
  };
}

function main() {
  const files = walk(ROOT, []);
  const cards = [];
  const skipped = [];

  for (const f of files) {
    if (path.resolve(f) === path.resolve(MANIFEST)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(f, 'utf8'));
      const c = asCard(f, json);
      if (c) {
        c.mtime = fs.statSync(f).mtimeMs;
        cards.push(c);
      } else skipped.push(path.relative(ROOT, f));
    } catch (e) {
      skipped.push(path.relative(ROOT, f) + '  (解析失败)');
    }
  }

  // 最近改过的卡排在最前，打开就是手上正在写的那张
  cards.sort((a, b) => (b.mtime - a.mtime) || (a.file < b.file ? -1 : 1));

  if (process.argv.includes('--list')) {
    console.log('识别到 ' + cards.length + ' 张卡：');
    cards.forEach(c => console.log('  · ' + c.file + '  →  ' + c.name + ' / ' + c.entries + ' 词条 / ' + c.chars + ' 字'));
    if (skipped.length) {
      console.log('跳过 ' + skipped.length + ' 个 JSON：');
      skipped.forEach(s => console.log('  - ' + s));
    }
    return;
  }

  if (!cards.length) {
    console.error('没有在 card/ 下找到角色卡 JSON。');
    process.exit(1);
  }

  const viewer = fs.readFileSync(VIEWER, 'utf8');
  const payload = JSON.stringify(cards.map(c => ({ file: c.file, name: c.name, data: c.data })))
    .replace(/</g, '\\u003c');

  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  const inject =
    '<script id="inline-cards">window.__CARDS__=' + payload + ';window.__BUILT_AT__=' +
    JSON.stringify(stamp) + ';</script>';

  if (viewer.indexOf('</head>') < 0) {
    console.error('viewer.html 结构异常：找不到 </head>');
    process.exit(1);
  }
  const html = viewer.replace('</head>', inject + '\n</head>');

  fs.writeFileSync(OUT, html, 'utf8');
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify(cards.map(c => ({ file: c.file, name: c.name })), null, 2),
    'utf8'
  );

  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log('已生成 ' + path.relative(process.cwd(), OUT) + '  (' + kb + ' KB)');
  console.log('共 ' + cards.length + ' 张卡：');
  cards.forEach(c => console.log('  · ' + c.name + '  ←  ' + c.file + '  (' + c.entries + ' 词条 / ' + c.chars + ' 字)'));
  if (skipped.length) console.log('跳过 ' + skipped.length + ' 个非卡片 JSON');
}

main();
