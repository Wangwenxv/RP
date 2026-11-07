// 隔离 Edge + 假 API：检查真实 RP/微信/工具续写请求，而非仅检查提示词定义。
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), OUT = path.join(ROOT, '.refactor-tmp/player-agency');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.resolve(ROOT, '.' + decodeURIComponent(url === '/' ? '/index.html' : url));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': `${mime[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
  fs.createReadStream(file).pipe(res);
});
function assertAgency(request, player = '测试玩家') {
  const systems = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.equal((systems.match(/<player_agency>/g) || []).length, 1);
  assert.match(systems, new RegExp(`玩家是「${player}」`));
  for (const clause of ['明确一步不授权', '不等于已决定、已执行或已到达', '玩家的拒绝、犹豫、沉默',
    '外力造成的客观影响不等于玩家自愿配合', '当前玩家的明确更正', '明确要求代写、托管', '不能补写玩家走进去并答应留下',
    '姓名：消息', '没有每轮必须完成的字数', '不得为满足这些要求代玩家', '不是本轮双方必须执行的脚本']) {
    assert.ok(systems.includes(clause), clause);
  }
  if (!request.model.startsWith('wx-')) {
    assert.equal((systems.match(/<rp_narrative_scope>/g) || []).length, 1);
    assert.match(systems, /角色卡定义人物，不把该人物或玩家固定成每轮的叙事中心/);
    assert.match(systems, /这只让读者看见，不会自动让玩家或别的NPC知道/);
  } else assert.ok(!systems.includes('<rp_narrative_scope>'));
}
(async () => {
  let browser;
  const errors = [], requests = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); fs.mkdirSync(OUT, { recursive: true });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.marked = { use() {}, parse: String }; window.DOMPurify = { sanitize: String };
    });
    await page.route('**/assets/js/app.js?*', route => route.fulfill({ contentType: 'text/javascript',
      body: fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8')
        .replace('const __s = {};', 'const __s = window.__AGENCY_SCOPE__ = {};')
        .replace("app.mount('#app');", "window.__APP_PROXY__ = app.mount('#app');") }));
    await page.route('https://mock.local/**', async route => {
      const body = route.request().postDataJSON();
      if (!body) return route.fulfill({ contentType: 'application/json', body: '{"data":[]}' });
      if (body) requests.push(body);
      if (route.request().url().endsWith('/embeddings')) return route.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }) });
      let message = { role: 'assistant', content: body.model.startsWith('wx-')
        ? '{"messages":[{"type":"text","content":"你慢慢考虑。"}]}' : '林晚点点头，留在门旁等待回应。' };
      if (body.model.startsWith('deepseek-suqixue')) message.content = '卿抬起头：“你现在去吃饭吗？”';
      if (body.model === 'rp-world-life') message.content = '同一时段，苏祈雪和沈鹿从B栋走出来。沈鹿说起课堂上的趣事，她听着笑了一下，两人慢慢聊着。';
      if (body.model === 'rp-world-invitation') message.content = '苏祈雪拿出一根转接线：“文学社的投影连不上，你有空帮我看看吗？”她留在门口等陈璃回答。';
      if (body.model === 'rp-world-refusal') message.content = '“那我问问师姐。”苏祈雪收起转接线，准备去找林晚。';
      if (['rp-world-contact', 'rp-world-contact-multi', 'rp-world-contact-next'].includes(body.model)) {
        if (body.messages.some(item => item.role === 'tool')) throw new Error('主动联系成功后不应继续请求模型');
        else {
          const tool = body.tools.find(tool => tool.function.name.startsWith('tool_wechat'));
          assert.ok(tool, '角色主动联系使用真实提供的微信工具');
          const contents = body.model === 'rp-world-contact-multi' ? ['在忙吗', '图书馆', '好', '你早点弄完 别太晚']
            : [body.model === 'rp-world-contact-next' ? '我在图书馆看书' : '吃饭了吗 我跟沈鹿在二饭'];
          message = { role: 'assistant', content: '苏祈雪放下筷子，拿起手机，准备给陈璃发消息。',
            tool_calls: contents.map((content, i) => ({ id: `world-contact-call-${i}`, type: 'function',
              function: { name: tool.function.name, arguments: JSON.stringify({ content }) } })) };
        }
      }
      if (body.model === 'gemini-reply-tool') message = { role: 'assistant', content: '', tool_calls: [{
        id: 'agency-reply', type: 'function', function: { name: 'output_reply', arguments: JSON.stringify({ content: '林晚等待回应。' }) }
      }] };
      if (body.model === 'rp-tools' && !body.messages.some(message => message.role === 'tool')) {
        const tool = body.tools.find(tool => tool.function.name.startsWith('tool_random'));
        assert.ok(tool, '真实随机工具已开放');
        message = { role: 'assistant', content: '', tool_calls: [{ id: 'agency-call', type: 'function',
          function: { name: tool.function.name, arguments: '{"min":1,"max":6}' } }] };
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      }) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load', timeout: 45000 });
    await page.waitForFunction(() => window.__APP_PROXY__ && window.__AGENCY_SCOPE__._initComplete);
    await page.evaluate(async () => {
      const s = window.__AGENCY_SCOPE__; window.__APP_PROXY__.showUserSetupModal = false;
      s.characters.value.push({ uuid: 'agency-fixture', name: '林晚', description: '独立生活的朋友', first_mes: '', wechatEnabled: true, wechatSpeed: 'fast' });
      await window.__APP_PROXY__.selectCharacter(s.characters.value.length - 1, false, { silent: true });
      s.user.name = '测试玩家';
      Object.assign(s.settings, { apiUrl: 'https://mock.local/v1', apiKey: 'fixture', stream: false,
        uiTemplateEnabled: false, activeToolsEnabled: false });
      s.worldInfo.value = []; s.presets.value = []; s.memorySettings.enabled = false;
      // 本测试只验证主请求；逐轮/二次压缩实际请求另有离线回归，不启动后台巡检。
      s.startAutomaticMemoryPatrol = async () => {};
    });
    for (const model of ['rp-base', 'rp-cot', 'gemini-reply-tool', 'rp-classic', 'rp-enhanced', 'rp-recap', 'rp-tools']) {
      await page.evaluate(async model => {
        const s = window.__AGENCY_SCOPE__, builtin = window.RPHubBuiltinPresets;
        s.settings.model = model; s.settings.preventTruncation = model === 'gemini-reply-tool';
        s.settings.activeToolsEnabled = model === 'rp-tools';
        s.activeTools.value.forEach(tool => { tool.enabled = model === 'rp-tools' && tool.type === 'random_number'; });
        const cotOn = model === 'rp-cot' || model === 'gemini-reply-tool';
        s.presets.value = cotOn ? [{ name: 'COT', enabled: true, role: 'system', content: builtin.buildCotPresetContent({
          memoryEnabled: false, uiTemplateAnalysisEnabled: false }) }] : [];
        Object.assign(s.memorySettings, { enabled: /rp-(classic|enhanced)/.test(model), mode: model === 'rp-enhanced' ? 'enhanced' : 'classic',
          summaryKeepFloors: 0, embeddingModel: 'vector-fixture', classicModel: 'summary-fixture' });
        s.chatHistory.value = [{ id: 'u1', role: 'user', content: '我想去图书馆，但还没决定' },
          { id: 'a1', role: 'assistant', content: '<cot>STALE_PLAYER_DECISION：玩家接下来会自动发微信</cot>旧AI叙述：测试玩家已经出门',
            reasoning: 'STALE_NATIVE_PLAYER_DECISION：玩家准备离开' },
          { id: 'u2', role: 'user', content: '我没有出门，仍在房间。请继续写你的角色。' }];
        s.classicMemories.value = [{ id: 'm1', turn: 1, summary: '旧摘要：测试玩家想去图书馆，是否出门未确认',
          sourceUserText: '我想去图书馆，但还没决定', sourceUserIds: ['u1'], sourceAssistantIds: ['a1'],
          classicMemory: true, enabled: true, embeddingModel: 'vector-fixture', embeddingApiUrl: s.settings.apiUrl,
          ...window.RPHubMemoryUtils.quantizeEmbeddingForStorage([1, 0]) }];
        s.storyRecap.value = model === 'rp-recap' ? { text: '历史摘要：测试玩家考虑出门，尚未决定',
          coversThroughTurn: 1, coversWechatCount: 0, keepRPTurns: 1, keepWechatCount: 0 } : null;
        await Vue.nextTick(); // 配置变更守卫先完成；模拟用户改完设置后再发消息。
        // 模拟用户正则抹去所有先前的本体边界：末尾追加的规则仍必须到达API。
        const process = s.processRegex;
        s.processRegex = (text, options) => process(text, options).replace(/<player_agency>[\s\S]*?<\/player_agency>/g, '');
        try { await s.generateResponse(); } finally { s.processRegex = process; }
      }, model);
      const matching = requests.filter(request => request.model === model);
      assert.equal(await page.evaluate(() => !!window.__AGENCY_SCOPE__.chatHistory.value.at(-1).responseError), false);
      assert.ok(matching.length, `${model} 发出了主请求`); matching.forEach(request => assertAgency(request));
      for (const request of matching) {
        assert.ok(!request.messages.some(message => String(message.content).includes('STALE_PLAYER_DECISION') || String(message.content).includes('STALE_NATIVE_PLAYER_DECISION')));
        const lastUser = request.messages.findLast(message => message.role === 'user');
        assert.ok(lastUser.content.endsWith('</player_turn_boundary>'));
        assert.equal((request.messages.map(message => message.content).join('\n').match(/<player_turn_boundary>/g) || []).length, 1);
      }
      if (model === 'rp-cot') assert.match(matching[0].messages[0].content, /只设计回应点，不提前写出结果/);
      assert.equal(await page.evaluate(() => window.__AGENCY_SCOPE__.chatHistory.value.find(message => message.id === 'a1').reasoning),
        'STALE_NATIVE_PLAYER_DECISION：玩家准备离开');
      if (model === 'gemini-reply-tool') {
        assert.ok(matching[0].tools.some(tool => tool.function.name === 'output_reply'));
        assert.ok(!matching[0].messages[0].content.includes('<thinking_protocol>'));
      }
      if (model === 'rp-classic') assert.ok(matching[0].messages.some(message => String(message.content).includes('旧摘要：')));
      if (model === 'rp-enhanced') assert.ok(matching[0].messages.some(message => String(message.content).includes('<enhanced_memory_recall>')),
        JSON.stringify(await page.evaluate(() => { const s = window.__AGENCY_SCOPE__; return { state: s.memoryRecallState.value,
          settings: s.memorySettings, memories: s.classicMemories.value, valid: s.hasCurrentSummaryEmbedding(s.classicMemories.value[0]) }; })));
      if (model === 'rp-recap') assert.ok(matching[0].messages.some(message => String(message.content).includes('【RP玩家原输入｜测试玩家】')));
      if (model === 'rp-tools') {
        assert.equal(matching.length, 2); assert.ok(matching[1].messages.some(message => message.tool_call_id === 'agency-call'));
        assert.ok(matching[1].messages.some(message => message.tool_calls?.some(call => call.id === 'agency-call')));
      }
      console.log(`PASS ${model}：真实请求保留玩家决定权约束`);
    }
    const card = JSON.parse(fs.readFileSync(path.join(ROOT, 'card/suqixue/苏祈雪.json'), 'utf8'));
    for (const legacy of [false, true]) {
      await page.evaluate(async ({ card, legacy }) => {
        const s = window.__AGENCY_SCOPE__, parsed = window.RPHubCardUtils.parseImportedCharacterCard(card);
        if (legacy) {
          parsed.personality = parsed.personality.slice(parsed.personality.indexOf('【基础档案】'));
          const sweet = parsed.worldInfoEntries.find(entry => entry.comment === '恋爱日常·甜的发生机制（本卡主引擎）');
          sweet.content = sweet.content.replace('1. 甜的表现方式（按当前情境选用，不设每轮或每几轮的数量指标；涉及{{user}}的动作须由玩家明确给出）：',
            '1. 甜的三条硬指标（每一到两轮对话至少落一条）：');
        }
        Object.assign(s.currentCharacter.value, parsed); s.worldInfo.value = parsed.worldInfoEntries;
        s.user.name = '陈璃'; s.settings.model = legacy ? 'deepseek-suqixue-legacy' : 'deepseek-suqixue';
        s.settings.activeToolsEnabled = false; s.settings.preventTruncation = false;
        s.activeTools.value.forEach(tool => { tool.enabled = false; }); s.memorySettings.enabled = false;
        s.storyRecap.value = null; s.classicMemories.value = [];
        const builtin = window.RPHubBuiltinPresets;
        s.presets.value = Object.values(builtin.managedPresets).filter(preset => ['防抢话', '文风（抗八股）', '活人感', '去User中心化'].includes(preset.name))
          .map(preset => ({ ...preset, enabled: true }));
        s.chatHistory.value = [{ id: 'chenli-input', role: 'user', name: '陈璃', content: '我还在实验室，暂时没有离开，也没有发微信。继续。' }];
        await Vue.nextTick(); await s.generateResponse();
      }, { card, legacy });
      const model = legacy ? 'deepseek-suqixue-legacy' : 'deepseek-suqixue';
      const matching = requests.filter(request => request.model === model); assert.equal(matching.length, 1);
      const request = matching[0]; assertAgency(request, '陈璃');
      const prompt = request.messages.map(message => message.content).join('\n');
      assert.ok(!prompt.includes('正文最少700字。'));
      assert.match(prompt, /本轮玩家是「陈璃」，你扮演「苏祈雪」/);
      assert.match(prompt, /玩家未明确发送或授权的微信\/对白不能补写/);
      if (legacy) assert.match(prompt, /每一到两轮对话至少落一条/);
      else { assert.ok(!prompt.includes('每一到两轮对话至少落一条')); assert.match(prompt, /【玩家控制边界｜适用于本卡全部条目】/); }
      const last = await page.evaluate(() => { const message = window.__AGENCY_SCOPE__.chatHistory.value.at(-1); return { content: message.content, error: message.responseError }; });
      assert.equal(last.content, '卿抬起头：“你现在去吃饭吗？”'); assert.ok(!last.error);
      console.log(`PASS ${model}：真实角色卡与陈璃身份进入API，无700字下限，短回复一次完成`);
    }
    for (const [model, input] of [
      ['rp-world-life', '我在实验室继续跑数据。我们刚分开，各自忙自己的事。'],
      ['rp-world-contact', '我完成了这一轮数据记录，仍留在实验室。苏祈雪和室友刚下课。'],
      ['rp-world-contact-multi', '我留在实验室，现在没有发新微信，也没有约定见面。'],
      ['rp-world-contact-next', '我回复她：还在实验室，你在哪？'],
      ['rp-world-invitation', '苏祈雪在实验室门口找我，我抬头看向她。'],
      ['rp-world-refusal', '我今天不去，还要完成这轮训练。']
    ]) {
      await page.evaluate(async ({ model, input }) => {
        const s = window.__AGENCY_SCOPE__; s.settings.model = model;
        s.activeTools.value.forEach(tool => { tool.enabled = model.startsWith('rp-world-contact') && tool.type === 'wechat_message'; });
        s.settings.activeToolsEnabled = model.startsWith('rp-world-contact');
        s.currentCharacter.value.wechatEnabled = true;
        s.chatHistory.value.push({ id: model + '-player', role: 'user', name: '陈璃', content: input });
        await Vue.nextTick(); await s.generateResponse();
      }, { model, input });
      const matching = requests.filter(request => request.model === model); assert.ok(matching.length);
      matching.forEach(request => assertAgency(request, '陈璃'));
      const last = await page.evaluate(() => { const m = window.__AGENCY_SCOPE__.chatHistory.value.at(-1); return { content: m.content, error: m.responseError }; });
      assert.ok(!last.error);
      if (model.startsWith('rp-world-contact')) {
        assert.equal(matching.length, 1, '主动联系后交给玩家，不请求工具续写');
        const expected = model === 'rp-world-contact-multi' ? '在忙吗' : model === 'rp-world-contact-next' ? '我在图书馆看书' : '吃饭了吗 我跟沈鹿在二饭';
        await page.waitForFunction(content => window.__AGENCY_SCOPE__.wechatTimeline.value.some(item => item.role === 'assistant' && item.content === content), expected);
        const contact = await page.evaluate(content => window.__AGENCY_SCOPE__.wechatTimeline.value.filter(item => item.content === content).map(item => ({ role: item.role, channel: item.channel })), expected);
        assert.deepEqual(contact, [{ role: 'assistant', channel: 'wechat' }]);
        if (model === 'rp-world-contact-multi') {
          const prohibited = await page.evaluate(() => window.__AGENCY_SCOPE__.wechatTimeline.value.filter(item => ['图书馆', '好', '你早点弄完 别太晚'].includes(item.content)));
          assert.deepEqual(prohibited, []);
        }
      } else assert.equal(matching.length, 1);
      console.log(`PASS ${model}：独立NPC片段/请求/拒绝可正常结束，主动联系由角色工具发入微信`);
    }
    await page.evaluate(async () => {
      const s = window.__AGENCY_SCOPE__; s.settings.model = 'wx-base'; s.settings.preventTruncation = false;
      s.user.name = '测试玩家';
      s.presets.value = []; s.memorySettings.enabled = true;
      s.storyRecap.value = null; s.wechatInput.value = '我不想出门，刚才也没答应。';
      await s.sendWechatMessage();
    });
    const wx = requests.find(request => request.model === 'wx-base'); assert.ok(wx); assertAgency(wx);
    assert.match(wx.messages[0].content, /微信中的“你”指AI角色/);
    assert.ok(wx.messages.some(message => String(message.content).includes('我不想出门，刚才也没答应。')));
    assert.equal(await page.evaluate(() => window.__AGENCY_SCOPE__.wechatTimeline.value.at(-1).content), '你慢慢考虑。');
    console.log('PASS 微信未选预设仍注入玩家边界，并保留原消息及回复协议');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(OUT, 'requests.json'), JSON.stringify(requests, null, 2));
    console.log('PASS 无页面运行时错误；模拟请求证据已保存');
  } finally {
    if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
