/** Native-style world workspace; all actions use the world adapter. */
(function () {
    window.RPHubWorldSessionView = {
        props: { hub: { type: Object, required: true }, characters: { type: Array, default: () => [] }, maps: { type: Array, default: () => [] } },
        template: `
        <section class="world-view" aria-label="多角色世界">
            <header class="world-header">
                <button class="app-nav-trigger world-nav" @click="$emit('navigate')" aria-label="打开导航">☰</button>
                <div><h1>{{ hub.worldSnapshot && !hub.worldShowSetup ? hub.worldSnapshot.definition.name : '多角色世界' }}</h1>
                    <p>{{ hub.worldSnapshot && !hub.worldShowSetup ? hub.worldSnapshot.storyTime.replace('T', ' ') : '同一条时间线，各自的生活与记忆' }}</p></div>
                <div class="world-toolbar">
                    <select aria-label="选择世界存档" :value="hub.worldSnapshot?.sessionId || ''" @change="hub.worldOpen($event.target.value)">
                        <option value="" disabled>世界存档</option><option v-for="s in hub.worldSessions" :key="s.sessionId" :value="s.sessionId">{{ s.name || s.definition?.name || s.sessionId }}</option>
                    </select>
                    <button @click="hub.worldNew">新建世界</button>
                    <label class="world-button">导入世界<input type="file" accept=".json,.rpworld" @change="hub.worldImport" hidden></label>
                    <button v-if="hub.worldSnapshot" @click="hub.worldExport">导出</button>
                </div>
            </header>
            <p v-if="hub.worldError" class="world-error" role="alert">{{ hub.worldError }}</p>
            <section v-if="hub.worldImportPreview" class="world-import" aria-label="导入世界预览">
                <p>导入“{{ (hub.worldImportPreview.session || hub.worldImportPreview).definition?.name }}”。世界包将作为独立存档保存。</p>
                <button @click="hub.worldConfirmImport">确认导入</button><button @click="hub.worldImportPreview = null">取消</button>
            </section>
            <div v-if="hub.worldShowSetup" class="world-setup custom-scrollbar">
                <section class="world-form">
                    <h2>世界起点</h2>
                    <p class="world-hint">以苏祈雪在校时间线为基准。角色卡和地图会保存版本快照；旧单卡存档仍可从「聊天」打开。</p>
                    <div class="world-fields">
                        <label>世界名称<input v-model="hub.worldDraft.name" maxlength="100"></label>
                        <label>玩家姓名<input v-model="hub.worldDraft.playerName" maxlength="80" placeholder="玩家与卿是两个人"></label>
                        <label>开局剧情时间<input type="datetime-local" v-model="hub.worldDraft.storyTime"></label>
                        <label>地图<select v-model="hub.worldDraft.mapId"><option value="">暂不使用地图</option><option v-for="map in maps" :key="map.id" :value="map.id">{{ map.name }}</option></select></label>
                    </div>
                    <label>玩家人设<textarea v-model="hub.worldDraft.playerDescription" rows="3" placeholder="在这个世界中的身份"></textarea></label>
                    <label>公共世界设定<textarea v-model="hub.worldDraft.publicLore" rows="3" placeholder="所有角色可用的世界背景；人物秘密放在对应卡中"></textarea></label>
                    <h2>人物名册</h2>
                    <p class="world-hint">先加入适配的角色卡。没有卡的人物保留身份，暂不参与模拟。林晚卡中的恋人占位符绑定卿。</p>
                    <article v-for="a in hub.worldDraft.actors" :key="a.actorId" class="world-card-slot">
                        <header><strong>{{ a.name }}</strong><code>{{ a.actorId }}</code><label class="world-check"><input type="checkbox" v-model="a.enabled">启用</label></header>
                        <div class="world-fields">
                            <label>显示姓名<input v-model="a.name" maxlength="80"></label>
                            <label>使用已有卡<select @change="hub.worldUseCard(a, $event.target.value)"><option value="">选择角色卡</option><option v-for="c in characters" :key="c.uuid" :value="c.uuid">{{ c.name }}</option></select></label>
                            <label>卡中 {{ '{' + '{user}' + '}' }} 指向<select v-model="a.bindings.user"><option value="player">玩家</option><option v-for="target in hub.worldDraft.actors" :key="target.actorId" :value="target.actorId">{{ target.name }}</option></select></label>
                            <label class="world-upload">{{ a.card ? '替换 JSON 角色卡' : '导入 JSON 角色卡' }}<input type="file" accept=".json" @change="hub.worldReadCard($event, a)"></label>
                        </div>
                        <p class="world-hint" v-if="a.sourcePath">{{ a.sourcePath }}</p>
                        <p v-for="issue in hub.worldCardIssues(a)" :key="issue" class="world-card-warning">{{ issue }}</p>
                    </article>
                    <div class="world-toolbar"><button @click="hub.worldAddActor">添加人物</button><button class="world-primary" @click="hub.worldCreate" :disabled="hub.worldBusy">{{ hub.worldBusy ? '正在保存…' : '创建世界' }}</button><button v-if="hub.worldSnapshot" @click="hub.worldShowSetup = false">返回世界</button></div>
                </section>
            </div>
            <div v-else-if="hub.worldSnapshot" class="world-workspace">
                <aside class="world-sidebar custom-scrollbar" aria-label="会话与世界状态">
                    <div class="world-sidebar-header"><h2>会话</h2><button @click="hub.worldGroupEditor = !hub.worldGroupEditor" aria-label="创建群聊">＋</button></div>
                    <button v-for="c in hub.worldConversations" :key="c.conversationId" class="world-contact" :class="{ active: hub.worldConversationId === c.conversationId }" @click="hub.worldSelectConversation(c.conversationId)">
                        <span class="world-contact-avatar">{{ c.kind === 'rp' ? 'RP' : c.kind === 'group' ? '群' : c.name.charAt(0) }}</span><span>{{ c.name }}<small>{{ c.kind === 'rp' ? '共享世界剧情' : c.kind === 'group' ? c.participantActorIds.length + ' 人群聊' : '独立私聊' }}</small></span>
                    </button>
                    <section v-if="hub.worldGroupEditor" class="world-side-form">
                        <label>群名<input v-model="hub.worldGroupName" maxlength="60"></label>
                        <label v-for="a in hub.worldNpcs" :key="a.actorId" class="world-check"><input type="checkbox" :value="a.actorId" v-model="hub.worldGroupMembers">{{ a.name }}</label>
                        <button @click="hub.worldCreateGroup" :disabled="hub.worldBusy">创建群聊</button>
                    </section>
                    <details class="world-details"><summary>剧情时间与状态</summary>
                        <label>推进到<input type="datetime-local" v-model="hub.worldNextTime"></label><button @click="hub.worldAdvance" :disabled="hub.worldBusy">推进剧情时间</button>
                        <label>人物<select v-model="hub.worldStateActor"><option value="">选择人物</option><option v-for="a in hub.worldActors" :key="a.actorId" :value="a.actorId">{{ a.name }}</option></select></label>
                        <template v-if="hub.worldStateActor">
                            <label>手机状态<select v-model="hub.worldStatePhone"><option value="unknown">未知</option><option value="available">可查看</option><option value="blocked">无法查看</option></select></label>
                            <label v-if="hub.worldStatePhone === 'blocked'">限制结束时间<input type="datetime-local" v-model="hub.worldStateUntil"></label>
                            <label>当前活动<input v-model="hub.worldStateActivity" placeholder="未知可留空"></label>
                            <label>确认地点<select v-model="hub.worldStatePlace"><option value="">未知</option><option v-for="p in hub.worldSnapshot.definition.map?.places || []" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
                            <button @click="hub.worldSaveActorState" :disabled="hub.worldBusy">保存剧情前提</button>
                        </template>
                    </details>
                    <details class="world-details"><summary>世界分支与回档</summary>
                        <label>当前分支<select :value="hub.worldSnapshot.branchId" @change="hub.worldOpen(hub.worldSnapshot.sessionId, $event.target.value)"><option v-for="b in hub.worldBranches" :key="b.branchId" :value="b.branchId">{{ b.name }}</option></select></label>
                        <label>保留到事件序号<input type="number" min="0" :max="hub.worldSnapshot.events.length" v-model.number="hub.worldCheckpointSeq"></label>
                        <label>新分支名称<input v-model="hub.worldBranchName" placeholder="新分支"></label><button @click="hub.worldFork">从此处建立分支</button>
                        <p class="world-hint">人物记忆、会话、未读与待办一起回到该时刻，原分支保留。</p>
                    </details>
                    <button class="world-evidence-toggle" @click="hub.worldShowEvidence = !hub.worldShowEvidence">查看人物知情来源</button>
                    <details class="world-details"><summary>更新角色卡</summary>
                        <label>人物<select v-model="hub.worldUpdateActor"><option value="">选择人物</option><option v-for="a in hub.worldActors.filter(a => a.actorId !== hub.worldSnapshot.definition.playerActorId)" :key="a.actorId" :value="a.actorId">{{ a.name }}{{ a.enabled === false ? '（待启用）' : '' }}</option></select></label>
                        <label>适配后的卡<input type="file" accept=".json" @change="hub.worldReadReplacement"></label>
                        <p class="world-hint" v-if="hub.worldUpdateSource">{{ hub.worldUpdateSource }}</p>
                        <button @click="hub.worldApplyReplacement" :disabled="hub.worldBusy || !hub.worldUpdateActor || !hub.worldUpdateCard">保存为新世界副本</button>
                        <p class="world-hint">保留各分支剧情并启用新卡，原世界保留原卡版本。</p>
                    </details>
                </aside>
                <main class="world-chat">
                    <header class="world-chat-header"><div><h2>{{ hub.worldConversation?.name || '世界剧情' }}</h2><p>{{ hub.worldConversation?.kind === 'rp' ? '允许 NPC 镜头；读者看到的秘密不会自动成为玩家角色的记忆。' : '每位人物按自己的卡与已读记忆回应。' }}</p></div><span v-if="hub.worldBusy" role="status">正在推进…</span></header>
                    <div :ref="el => hub.worldTranscript = el" class="world-transcript custom-scrollbar" aria-live="polite">
                        <p v-if="!hub.worldMessages.length" class="world-empty">{{ hub.worldConversation?.kind === 'rp' ? '写下你的行动或剧情前提，开始这个世界。' : '发一条消息，人物的故事从这里交汇。' }}</p>
                        <article v-for="e in hub.worldMessages" :key="e.eventId" class="world-message" :class="{ self: hub.worldIsSelf(e), narration: e.kind === 'narration.published' }">
                            <header><strong>{{ hub.worldSpeaker(e) }}</strong><small>{{ e.storyTime?.replace('T', ' ') }}</small></header><div>{{ hub.worldEventText(e) }}</div>
                            <small class="world-event-source">#{{ e.seq }}</small>
                        </article>
                    </div>
                    <section v-if="hub.worldRetryable.length" class="world-recovery" aria-label="未完成回合">
                        <div v-for="t in hub.worldRetryable" :key="t.turnId"><span>{{ t.error?.message || t.error || '该回合尚未完成，已保存的回复会保留。' }}</span><button @click="hub.worldRetry(t.turnId)" :disabled="hub.worldBusy">继续未完成回合</button><button @click="hub.worldEndTurn(t.turnId)" :disabled="hub.worldBusy">结束此回合</button></div>
                    </section>
                    <form class="world-composer" @submit.prevent="hub.worldSend">
                        <div v-if="hub.worldConversation?.kind === 'rp'" class="world-witnesses"><select v-model="hub.worldInputMode" aria-label="剧情输入类型"><option value="player_action">玩家行动／对话</option><option value="author_premise">作者剧情前提</option></select><span>本轮在场／听到：</span><label v-for="a in hub.worldNpcs" :key="a.actorId" class="world-check"><input type="checkbox" :value="a.actorId" v-model="hub.worldActorSelection" :disabled="hub.worldBusy">{{ a.name }}</label></div>
                        <textarea v-model="hub.worldInput" :disabled="hub.worldBusy" rows="3" :placeholder="hub.worldConversation?.kind === 'rp' ? '你的行动、对话或作者剧情前提…' : '发送消息…'" aria-label="世界消息输入" @keydown.ctrl.enter.prevent="hub.worldSend"></textarea>
                        <div class="world-composer-footer"><small>Ctrl + Enter 发送 · 仅玩家操作推进剧情</small><button v-if="hub.worldBusy" type="button" @click="hub.worldStop">停止</button><button v-else type="submit" class="world-primary" :disabled="!hub.worldInput.trim()">{{ hub.worldConversation?.kind === 'rp' ? '推进剧情' : '发送' }}</button></div>
                    </form>
                </main>
                <aside v-if="hub.worldShowEvidence" class="world-evidence custom-scrollbar" aria-label="角色认知调试">
                    <header><h2>知情来源</h2><button @click="hub.worldShowEvidence = false" aria-label="关闭知情来源">×</button></header>
                    <select v-model="hub.worldEvidenceActor" aria-label="查看人物记忆"><option v-for="a in hub.worldActors" :key="a.actorId" :value="a.actorId">{{ a.name }}</option></select>
                    <p class="world-hint">这里只展示该人物已经观察到的事件。调试阅读不会增加玩家角色知识。</p>
                    <article v-for="e in hub.worldEvidence" :key="e.eventId"><small>#{{ e.seq }} · {{ e.kind }} · {{ hub.worldActorName(e.actorId) }}</small><p>{{ hub.worldEventText(e) || JSON.stringify(e.payload) }}</p></article>
                    <p v-if="!hub.worldEvidence.length" class="world-hint">尚无已观察事件</p>
                </aside>
            </div>
            <div v-else class="world-empty"><button @click="hub.worldNew">创建第一个世界</button></div>
        </section>`
    };
})();
