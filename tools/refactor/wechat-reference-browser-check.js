// Loaded only by serve-wechat-reference-check.cjs; production index.html is untouched.
(() => {
    const checks = [], errors = [];
    let initialized = false, failure = '';
    window.addEventListener('error', event => errors.push(event.message));
    const wait = async predicate => {
        const deadline = Date.now() + 30000;
        while (!predicate()) { if (Date.now() > deadline) throw new Error('等待应用状态超时'); await new Promise(resolve => setTimeout(resolve, 50)); }
    };
    const check = (label, condition) => {
        if (!condition) throw new Error(label);
        checks.push(label);
        document.querySelector('#reference-check-results').textContent = checks.map(c => '通过：' + c).join('\n');
    };
    document.addEventListener('DOMContentLoaded', () => {
        const panel = document.createElement('section');
        panel.style = 'position:fixed;z-index:99999;top:8px;left:8px;max-width:590px;padding:12px;background:#fff;border:1px solid #ccc;border-radius:8px;color:#222;font:13px/1.6 sans-serif;max-height:48vh;overflow:auto;box-shadow:0 2px 8px #0002';
        panel.innerHTML = '<strong>参考图离线验证（独立数据库／模拟 API）</strong><br><button id="reference-check-init">初始化更新角色卡</button> <button id="reference-check-run" disabled>验证请求与历史图片</button> <button id="generation-check-run" disabled>验证生图选图与模型切换</button><pre id="reference-check-results" style="white-space:pre-wrap;margin:6px 0"></pre>';
        document.body.append(panel);
        const perform = async action => {
            try { await action(); } catch (error) { failure = error.message; document.querySelector('#reference-check-results').textContent += '\n失败：' + failure; await save('failed'); }
        };
        const save = async status => {
            const traffic = await (await fetch('/__check/requests')).json();
            await fetch('/__check/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, checks, errors, failure, ...traffic }) });
        };
        document.querySelector('#reference-check-init').onclick = () => perform(async () => {
            if (initialized) return;
            await wait(() => window.__REFERENCE_CHECK_SCOPE__?._initComplete);
            const s = window.__REFERENCE_CHECK_SCOPE__;
            s.showUserSetupModal.value = false;
            s.user.name = '陆清淮';
            const raw = await (await fetch('/card/suqixue/' + encodeURIComponent('苏祈雪v2.json'))).json();
            const imported = await s.importCharacterData(raw.data || raw, null, { activate: false, askImageGeneration: false });
            Object.assign(imported, { wechatEnabled: true, wechatSpeed: 'fast', wechatStickerRate: 'off', wechatPresetNames: [], wechatWorldInfoComments: [], wechatImageGenerationEnabled: false });
            await s.selectCharacter(s.characters.value.length - 1, false, { silent: true });
            Object.assign(s.settings, { apiUrl: location.origin + '/__fixture/v1', apiKey: 'offline-fixture', model: 'fixture-multimodal', visionModel: 'fixture-multimodal', debugModelRequests: true });
            s.settings.wechatImageApi.apiKey = '';
            s.currentView.value = 'chat';
            await s.openWechat(); s.wechatBurstMode.value = true;
            check('更新卡导入后保留三条路径，不生成内嵌 base64', s.currentCharacter.value.imageReferences.length === 3 && s.currentCharacter.value.imageReferences.every(r => r.src && !r.dataUrl));
            const exported = RPHubCardUtils.buildCharacterCardData(s.currentCharacter.value);
            check('角色卡导出保留路径与说明', exported.data.extensions.rp_hub_image_references.every(r => r.src && r.description && !r.dataUrl));
            s.openWechatSettings();
            await wait(() => document.querySelectorAll('.wx-image-reference-settings img').length === 3 && [...document.querySelectorAll('.wx-image-reference-settings img')].every(img => img.naturalWidth > 0));
            check('原生设置中三张路径缩略图均正常加载', true);
            await s.saveWechatSettings(); s.openWechatSettings();
            check('保存再打开仍为三条路径', s.wechatSettingsDraft.imageReferences.length === 3 && s.wechatSettingsDraft.imageReferences.every(r => r.src && !r.dataUrl));
            initialized = true;
            document.querySelector('#reference-check-run').disabled = false;
            document.querySelector('#reference-check-init').disabled = true;
        });
        document.querySelector('#reference-check-run').onclick = () => perform(async () => {
            document.querySelector('#reference-check-run').disabled = true;
            const s = window.__REFERENCE_CHECK_SCOPE__;
            s.showWechatSettings.value = false;
            const before = (await (await fetch('/__check/requests')).json()).requests.length;
            for (const name of ['1.jpg', '2.png', '3.jpg', '4.jpg']) {
                const source = await RPHubWeChatMedia.rasterize('card/suqixue/sqx_test/' + name);
                s.wechatPendingImage.value = await RPHubWeChatMedia.blobToDataURL(source.blob);
                s.wechatInput.value = '';
                await s.sendWechatMessage();
            }
            const originalQuestion = '下面这4张照片，哪张好看？';
            s.wechatInput.value = originalQuestion;
            await s.sendWechatMessage();
            await s.requestWechatReplyNow();
            let traffic = await (await fetch('/__check/requests')).json();
            const turn = traffic.requests.slice(before);
            check('主聊天按需调用一次子问题，之后继续回复', turn.length === 3 && turn[0].images === 4 && turn[1].images === 7 && turn[2].images === 4);
            check('子问题完整收到三张参考与四张待判断图', turn[1].visualCheckImageLabels === 7 && turn[1].visualCheckReferenceLabels === 3);
            check('子问题按参考在前组织并保留玩家原话', turn[1].comparisonTask.includes('前3张') && turn[1].comparisonTask.includes('后4张') && turn[1].comparisonTask.endsWith(originalQuestion));
            check('主聊天使用核对结果，参考像素不重复附送', turn[2].hasVisualCheck && turn[2].hasReferenceReturn && turn[2].toolResults === 1);
            check('真实路径读取不回写角色卡内嵌数据', s.currentCharacter.value.imageReferences.every(r => r.src && !r.dataUrl));
            const photo = s.wechatTimeline.value.find(i => i.role === 'user' && i.type === 'image');
            check('用户图片存为资源 ID 并保留模型给出的短描述', photo?.media?.assetId && photo.media.caption === '离线测试：围巾与长发的人物照片' && !photo.content);
            const count = traffic.requests.length;
            s.wechatInput.value = '好，马上'; await s.sendWechatMessage(); await s.requestWechatReplyNow();
            traffic = await (await fetch('/__check/requests')).json();
            const next = traffic.requests.slice(count);
            check('下一轮只有一次请求，保留描述且不重带任何像素或参考结果', next.length === 1 && next[0].images === 0 && next[0].hasDescription && !next[0].hasReferenceReturn && !next[0].hasVisualCheck && next[0].toolCalls.length === 0);
            check('下一轮空回正常，不产生空白气泡', s.wechatTimeline.value.at(-1).replyDecision === 'silent');
            check('无页面 JavaScript 错误', errors.length === 0);
            await save('passed');
            document.querySelector('#generation-check-run').disabled = false;
            document.querySelector('#reference-check-results').textContent += '\n全部验证通过，报告已保存。';
        });
        document.querySelector('#generation-check-run').onclick = () => perform(async () => {
            document.querySelector('#generation-check-run').disabled = true;
            const s = window.__REFERENCE_CHECK_SCOPE__;
            s.settings.visionModel = 'qwen3.7-plus';
            s.selectChatModel('fixture-switched');
            await wait(() => s.settings.model === 'fixture-switched');
            check('微信默认跟随聊天模型，旧独立识图设置保留', s.settings.wechatVisionFollowsChat === true && s.resolveWechatVisionModel() === 'fixture-switched' && s.settings.visionModel === 'qwen3.7-plus');
            const before = (await (await fetch('/__check/requests')).json()).requests.length;
            const source = await RPHubWeChatMedia.rasterize('card/suqixue/sqx_test/1.jpg');
            s.wechatPendingImage.value = await RPHubWeChatMedia.blobToDataURL(source.blob);
            s.wechatInput.value = '这张照片怎么样'; await s.sendWechatMessage(); await s.requestWechatReplyNow();
            let traffic = await (await fetch('/__check/requests')).json();
            check('真实Vue模型选择器切换后，微信主请求与独立比对均采用新模型', traffic.requests.slice(before).length === 3 && traffic.requests.slice(before).every(request => request.model === 'fixture-switched'));
            s.currentCharacter.value.wechatImageGenerationEnabled = true;
            Object.assign(s.settings.wechatImageApi, RPHubImageGeneration.PRESETS.yeelo, { baseUrl: location.origin + '/__fixture/v1', apiKey: 'offline-fixture', model: 'fixture-image', enabled: true });
            const photos = s.wechatTimeline.value.filter(item => item.role === 'user' && item.type === 'image');
            const hash = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
            const hashes = await Promise.all(photos.slice(0, 2).map(async item => hash(await RPHubWeChatMedia.blobToDataURL(await s.wechatMediaLibrary.read(item.media.assetId, false)))));
            const cardBefore = JSON.stringify(s.currentCharacter.value.imageReferences);
            const portrait = [{ type: 'image_request', media: { mode: 'generate', selfPortrait: true, prompt: '参考服装和环境的自拍', description: '离线模拟自拍',
                generationReferences: [{ messageId: photos[0].id, purpose: 'clothing' }, { messageId: photos[1].id, purpose: 'background' }] } }];
            const generated = await s.prepareWechatReplyMedia(portrait, new AbortController().signal);
            traffic = await (await fetch('/__check/requests')).json();
            const first = traffic.imageRequests.at(-1);
            check('生图实际载荷含三张人物参考加服装与背景，共五张', first.images === 5 && first.purposes.join(',') === 'identity,identity,identity,clothing,background');
            check('生图收到的服装与背景像素确实来自所选微信消息', first.imageHashes.slice(-2).join(',') === hashes.join(','));
            check('生成资源落库且微信选图没有改写角色参考目录', generated[0].media.assetId && JSON.stringify(s.currentCharacter.value.imageReferences) === cardBefore);
            await s.prepareWechatReplyMedia([{ type: 'image_request', media: { mode: 'generate', selfPortrait: false, prompt: '仅拍空宿舍环境', generationReferences: [{ messageId: photos[1].id, purpose: 'background' }] } }], new AbortController().signal);
            traffic = await (await fetch('/__check/requests')).json();
            check('纯宿舍图只传一张背景参考，没有人物参考', traffic.imageRequests.at(-1).images === 1 && traffic.imageRequests.at(-1).purposes.join(',') === 'background');
            await s.prepareWechatReplyMedia([{ type: 'image_request', media: { mode: 'generate', selfPortrait: false, prompt: '没有参考的宿舍书桌' } }], new AbortController().signal);
            traffic = await (await fetch('/__check/requests')).json();
            check('无需参考的环境图为零图生成请求', traffic.imageRequests.at(-1).images === 0 && traffic.imageRequests.at(-1).endpoint.endsWith('/images/generations'));
            s.settings.wechatVisionFollowsChat = false;
            check('显式独立识图选项仍可使用原visionModel', s.resolveWechatVisionModel() === 'qwen3.7-plus');
            s.settings.wechatVisionFollowsChat = true;
            check('生图与模型切换验证无页面JavaScript错误', errors.length === 0);
            await save('passed');
            document.querySelector('#reference-check-results').textContent += '\n生图选图与模型切换验证全部通过。';
        });
    });
})();
