// card/preview.html 冒烟 + 截图（无头 Edge）
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const FILE = path.resolve(__dirname, '../../card/preview.html');
const OUT = path.resolve(__dirname, '../../.refactor-tmp');

let STEP = 'init';
const step = s => { STEP = s; console.error('[step] ' + s); };
const HEADFUL = process.argv.includes('--headful');
// headless Edge 处理 blob 下载时会关掉进程，playwright 内部 promise 会留下噪音
process.on('unhandledRejection', () => {});

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const checks = [];
  const ok = (name, cond, extra) => checks.push({ name, pass: !!cond, extra: extra || '' });
  let broken = '';
  let page, browser;

  try {
    browser = await chromium.launch({ channel: 'msedge', headless: !HEADFUL });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('crash', () => errors.push('page crashed'));

    step('open');
    await page.goto('file:///' + FILE.replace(/\\/g, '/'));
    await page.waitForTimeout(600);

    step('structure');
    const meta = await page.evaluate(() => (window.__CARDS__ || []).map(c => c.name));
    ok('内联卡片数 = 3', meta.length === 3, meta.join(' / '));
    const firstName = await page.evaluate(() => window.__CARDS__[0].name);
    ok('默认打开最近修改的卡', (await page.textContent('#inner h1')).includes(firstName), firstName);
    ok('人物设定已分节', (await page.$$('#sec-personality details.block')).length > 0);
    ok('目录有词条链接', (await page.$$('#tocInner [data-t^="e-"]')).length > 0);
    ok('原始 JSON 区块存在', !!(await page.$('#sec-raw')));
    ok('统计卡已渲染', (await page.$$('.stat')).length >= 5);

    step('shot-overview');
    await page.screenshot({ path: path.join(OUT, 'card-1-overview.png') });

    step('shot-personality');
    await page.evaluate(() => document.getElementById('sec-personality').scrollIntoView());
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, 'card-2-personality.png') });

    step('worldbook');
    await page.evaluate(() => document.getElementById('sec-book').scrollIntoView());
    await page.waitForTimeout(200);
    await page.click('#e-0 summary');
    await page.waitForTimeout(250);
    ok('词条展开后可见正文', await page.isVisible('#e-0 .rich .h-sub'));
    const chips = await page.$$('#e-0 .key[data-k]');
    ok('关键词 chip 带计数', chips.length > 3, chips.length + ' 个');
    await page.screenshot({ path: path.join(OUT, 'card-3-worldbook.png') });

    step('search');
    const kw = await page.getAttribute('#e-0 .key[data-k]', 'data-k');
    await page.fill('#search', kw);
    await page.waitForTimeout(500);
    const info = await page.textContent('#searchInfo');
    const marks = await page.$$('mark.hl');
    ok('搜索命中并高亮', marks.length > 0, kw + ' → ' + info);
    await page.evaluate(() => document.getElementById('sec-personality').scrollIntoView());
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, 'card-4-search.png') });
    await page.fill('#search', '');
    await page.waitForTimeout(350);

    step('edit');
    await page.evaluate(() => document.getElementById('sec-book').scrollIntoView());
    await page.waitForTimeout(200);
    await page.hover('#e-0 summary');
    await page.click('#e-0 [data-act="edit"]');
    await page.waitForTimeout(200);
    ok('编辑态出现标题与关键词输入', (await page.$$('#e-0 .ed-i')).length === 2);
    await page.fill('#e-0 .ed-i[data-f="comment"]', '改过的标题');
    await page.fill('#e-0 .ed-i[data-f="keys"]', '甲、乙');
    await page.fill('#e-0 textarea.ed', '【新小节】\n改过的正文。');
    await page.screenshot({ path: path.join(OUT, 'card-5-editing.png') });

    step('save');
    await page.click('#e-0 [data-ed="save"]');
    await page.waitForTimeout(400);
    ok('保存后提示修改数', (await page.textContent('#dirtyText')).includes('1 处'));
    ok('标题已回写', (await page.textContent('#e-0 summary')).includes('改过的标题'));
    const newKeys = await page.$$eval('#e-0 .key[data-k]', els => els.map(e => e.getAttribute('data-k')));
    ok('关键词已回写', newKeys.join(',') === '甲,乙', newKeys.join(','));
    ok('正文已回写', (await page.textContent('#e-0 .rich')).includes('改过的正文'));

    step('export-check');
    const j = JSON.parse(await page.evaluate(() => window.__CARD_API__.json()));
    const e0 = j.data.character_book.entries[0];
    ok('导出 JSON 含修改且结构合法',
      e0.comment === '改过的标题' && (e0.keys || []).join(',') === '甲,乙' && e0.content.indexOf('改过的正文') >= 0,
      (e0.keys || []).join(','));
    ok('导出 JSON 可被原格式解析', !!(j.data && j.data.character_book && j.data.character_book.entries.length));
    const md = await page.evaluate(() => window.__CARD_API__.md());
    ok('导出 Markdown 结构完整', md.includes('## 人物设定') && md.includes('## 世界书') && md.includes('改过的标题'), md.split('\n')[0]);

    step('revert');
    await page.click('#exportBtn');
    page.once('dialog', d => d.accept());
    await page.click('[data-export="revert"]');
    await page.waitForTimeout(400);
    ok('还原后提示消失', !(await page.evaluate(() => document.getElementById('dirtyPill').classList.contains('show'))));
    ok('还原后词条标题复原', !(await page.textContent('#e-0 summary')).includes('改过的标题'));

    step('switch');
    await page.selectOption('#cardSelect', '2');
    await page.waitForTimeout(500);
    const h1b = await page.textContent('#inner h1');
    ok('切卡生效', h1b.trim().length > 0, h1b.trim());
    await page.screenshot({ path: path.join(OUT, 'card-6-switch.png') });

    step('download-click');
    try {
      let dlName = '';
      page.on('download', d => { dlName = d.suggestedFilename(); });
      await page.click('#exportBtn');
      await page.click('[data-export="json"]');
      await page.waitForTimeout(700);
      ok('点击导出后页面仍可用', await page.evaluate(() => !!document.querySelector('#inner h1')), dlName || '无 download 事件');
    } catch (e) {
      ok('点击导出后页面仍可用', false, e.message.slice(0, 60));
    }

    if (errors.length) {
      console.error('\n控制台错误：');
      [...new Set(errors)].forEach(e => console.error('  ! ' + e));
    }
  } catch (e) {
    broken = STEP + ' → ' + e.message.split('\n')[0].slice(0, 90);
  }

  try { await browser.close(); } catch (e) {}

  checks.forEach(c => console.log((c.pass ? '  ok  ' : '  FAIL') + '  ' + c.name + (c.extra ? '   [' + c.extra + ']' : '')));
  if (broken) console.log('\n中断于：' + broken);
  const fail = checks.filter(c => !c.pass);
  console.log('\n' + (checks.length - fail.length) + '/' + checks.length + ' 通过' + (broken ? '（未跑完）' : ''));
  process.exit(fail.length || broken ? 1 : 0);
})();
