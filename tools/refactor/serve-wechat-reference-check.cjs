// Interactive browser regression: isolated origin/IndexedDB, local fixture API only.
// Run from any directory, then open the printed URL and use the test panel.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, '.refactor-tmp/wechat-reference-check');
const requests = [], assetReads = [];
const json = (res, value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const bodyOf = async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body); };
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost'), pathname = decodeURIComponent(url.pathname);
        if (pathname === '/__check/requests') return json(res, { requests, assetReads });
        if (pathname === '/__check/report' && req.method === 'POST') {
            const report = await bodyOf(req);
            fs.mkdirSync(OUT, { recursive: true });
            fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
            console.log(JSON.stringify({ status: report.status, checks: report.checks.length, requests: requests.length }));
            return json(res, { saved: true });
        }
        if (pathname === '/__fixture/v1/chat/completions') {
            const body = await bodyOf(req);
            const parts = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []);
            const fresh = parts.filter(p => p.type === 'text' && p.text.startsWith('【本轮新图 #'));
            const checks = parts.filter(p => p.type === 'text' && p.text.startsWith('【核对图片 #'));
            const calls = body.messages.flatMap(m => m.tool_calls || []);
            requests.push({ model: body.model, images: parts.filter(p => p.type === 'image_url').length,
                freshLabels: fresh.length, referenceLabels: parts.filter(p => p.type === 'text' && /^【(?:人物|地点)参考 #/.test(p.text)).length,
                toolCalls: calls.map(c => c.function.name), toolResults: body.messages.filter(m => m.role === 'tool').length,
                visualCheckImageLabels: checks.length,
                visualCheckReferenceLabels: checks.filter(p => p.text.startsWith('【核对图片 #reference:')).length,
                hasVisualCheck: JSON.stringify(body.messages).includes('【独立画面核对资料｜仅本轮使用】'),
                hasDescription: JSON.stringify(body.messages).includes('离线测试：围巾与长发的人物照片'),
                hasReferenceReturn: JSON.stringify(body.messages).includes('工具返回的角色参考资料') });
            let message = { role: 'assistant', content: '{"messages":[]}' }, finish = 'stop';
            if (checks.length) {
                // Reproduce both real-model display-ID variants, without a paid request.
                message.content = JSON.stringify({ observations: checks.map(part => ({
                    imageId: '#' + /^【核对图片 #([^｜]+)｜/.exec(part.text)[1].replace(/^reference:/, ''),
                    details: '离线预设画面资料：光线、机位与造型；不是实际识图结果。'
                })), differences: ['离线预设差异：拍摄角度不同。'], uncertainties: ['离线预设结果不用于评价视觉能力。'] });
            } else if (fresh.length && !calls.length && !JSON.stringify(body.messages).includes('【独立画面核对资料｜仅本轮使用】')) {
                message = { role: 'assistant', content: '', tool_calls: [{ id: 'reference-batch', type: 'function', function: {
                    name: 'tool_view_character_reference', arguments: JSON.stringify({ question: '核对可见发型与角色设定是否相容' }) } }] };
                finish = 'tool_calls';
            } else if (fresh.length) {
                const id = fresh[0].text.match(/本轮新图 #([^｜]+)/)[1];
                message.content = JSON.stringify({ messages: [{ type: 'text', content: '这张发型不太对呀，你发的是哪张？' }],
                    image_descriptions: [{ messageId: id, caption: '离线测试：围巾与长发的人物照片' }] });
            }
            return json(res, { choices: [{ message, finish_reason: finish }] });
        }
        const file = path.resolve(ROOT, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
        // Test chat traffic cannot connect to an external model provider.
        res.setHeader('Content-Security-Policy', "connect-src 'self' data: blob:");
        res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
        if (pathname.startsWith('/card/suqixue/') && pathname.endsWith('.jpg')) assetReads.push(pathname);
        if (pathname === '/index.html' || pathname === '/') {
            const html = fs.readFileSync(file, 'utf8').replace('<head>', '<head><script src="/tools/refactor/wechat-reference-browser-check.js"></script>');
            res.end(html);
        } else if (pathname === '/assets/js/app.js') {
            res.end(fs.readFileSync(file, 'utf8').replace('const __s = {};', 'const __s = window.__REFERENCE_CHECK_SCOPE__ = {};'));
        } else fs.createReadStream(file).pipe(res);
    } catch (error) { console.error(error.message); res.writeHead(500).end('Fixture error'); }
});
server.listen(0, '127.0.0.1', () => console.log(`Reference check: http://127.0.0.1:${server.address().port}/`));
