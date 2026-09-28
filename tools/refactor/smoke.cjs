// 冒烟测试：静态服务器 + 无头 Edge 加载页面，收集控制台错误与页面结构
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 18123;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  const warnings = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push('[console.error] ' + msg.text());
    if (msg.type() === 'warning') warnings.push('[warn] ' + msg.text().slice(0, 200));
  });
  page.on('pageerror', err => errors.push('[pageerror] ' + err.message));
  page.on('requestfailed', req => {
    if (!req.url().includes('favicon')) errors.push('[requestfailed] ' + req.url().slice(0, 150) + ' :: ' + (req.failure()?.errorText || ''));
  });

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(6000);

  const info = await page.evaluate(() => {
    const app = document.getElementById('app');
    const sections = window.RPHubAppSections ? Object.keys(window.RPHubAppSections).length : -1;
    return {
      appChildren: app ? app.children.length : -1,
      appHtmlLen: app ? app.innerHTML.length : -1,
      sections,
      hasNav: !!document.querySelector('nav, [class*=navigation], [class*=sidebar]'),
      bodyText: document.body.innerText.slice(0, 300),
    };
  });
  console.log('PAGE INFO:', JSON.stringify(info, null, 2));
  console.log('\nERRORS (' + errors.length + '):');
  errors.slice(0, 30).forEach(e => console.log('  ' + e));
  console.log('\nWARNINGS (' + warnings.length + '):');
  [...new Set(warnings)].slice(0, 10).forEach(w => console.log('  ' + w));
  await page.screenshot({ path: path.join(__dirname, 'smoke.png') });
  await browser.close();
  server.close();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('SMOKE CRASH:', e); server.close(); process.exit(2); });
