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
        panel.innerHTML = '<strong>参考图离线验证（独立数据库／模拟 API）</strong><br><button id="reference-check-init">初始化更新角色卡</button> <button id="reference-check-run" disabled>验证请求与历史图片</button><pre id="reference-check-results" style="white-space:pre-wrap;margin:6px 0"></pre>';
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
            const source = await RPHubWeChatMedia.rasterize('assets/images/wechat/salad.jpg');
            s.wechatPendingImage.value = await RPHubWeChatMedia.blobToDataURL(source.blob);
            s.wechatInput.value = '我到啦，这张照片像你吗';
            await s.sendWechatMessage();
            await s.requestWechatReplyNow();
            let traffic = await (await fetch('/__check/requests')).json();
            const turn = traffic.requests.slice(before);
            check('同模型先独立核对再聊天，两次请求且不重复调用参考工具', turn.length === 2 && turn.every(r => r.model === 'fixture-multimodal' && r.toolCalls.length === 0));
            check('独立核对为新图加两张参考，聊天只带一张用户新图', turn[0].images === 3 && turn[0].visualCheckImageLabels === 3 && turn[0].visualCheckReferenceLabels === 2 && turn[1].images === 1 && turn[1].freshLabels === 1 && turn[1].referenceLabels === 0);
            check('真实模型编号变体通过校验，资料进入聊天且参考像素不重附', turn[1].hasVisualCheck && !turn[1].hasReferenceReturn && turn[1].toolResults === 0);
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
            document.querySelector('#reference-check-results').textContent += '\n全部验证通过，报告已保存。';
        });
    });
})();
