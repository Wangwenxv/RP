const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const plain = value => JSON.parse(JSON.stringify(value));
async function harness(options = {}) {
    const stored = new Map(); let serial = Promise.resolve(), counter = 0;
    const context = vm.createContext({ window: {}, console, crypto: webcrypto, TextEncoder,
        AbortController, Date, Set, Map, setTimeout, clearTimeout });
    context.window.RPHubUtils = { generateUUID: () => `test-turn-${++counter}` };
    context.window.RPHubStorage = {
        async getStoredValue(key) { await serial; return stored.has(key) ? plain(stored.get(key)) : null; },
        updateStoredValue(key, updater) {
            const operation = serial.then(() => { const updated = updater(stored.has(key) ? plain(stored.get(key)) : null);
                stored.set(key, plain(updated)); return plain(updated); });
            serial = operation.catch(() => {}); return operation;
        },
        async readStorageSnapshot() { await serial; return [...stored].map(([key, value]) => [key, plain(value)]); }
    };
    for (const file of ['world-model.js', 'world-projections.js', 'world-store.js', 'wechat-time.js', 'wechat-protocol.js',
        'geography.js', 'actor-context.js', 'actor-runtime.js', 'world-chat.js', 'world-memory.js', 'scene-narrator.js', 'world-orchestrator.js'])
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js', file), 'utf8'), context, { filename: file });
    const actors = [
        { actorId: 'player', name: '玩家', card: null },
        ...['suqixue', 'qing', 'linwan'].map((actorId, i) => ({ actorId, name: ['苏祈雪', '卿', '林晚'][i],
            card: { name: ['苏祈雪', '卿', '林晚'][i], personality: '合成测试卡，保持自己的观点。',
                character_book: { entries: [{ comment: '风格范例', content: '风格例句：今天风真好。', constant: true }] } },
            knownActorIds: ['player', 'suqixue', 'qing', 'linwan'], bindings: { user: actorId === 'linwan' ? 'qing' : 'player' },
            initialState: { phoneAccess: 'available', replyOrder: actorId === 'qing' ? 0 : actorId === 'linwan' ? 1 : 2 } }))
    ];
    const conversations = [
        ...['suqixue', 'qing', 'linwan'].map(id => ({ conversationId: `dm-player-${id}`, kind: 'dm',
            participantActorIds: ['player', id], name: id })),
        { conversationId: 'group', kind: 'group', participantActorIds: ['player', 'suqixue', 'qing', 'linwan'], name: '朋友们' },
        { conversationId: 'rp-main', kind: 'rp', participantActorIds: ['player', 'suqixue', 'qing', 'linwan'], name: 'RP' }
    ];
    const Store = context.window.RPHubWorldStore;
    let snapshot = await Store.create({ definition: { worldId: 'test-world', name: '合成世界', playerActorId: 'player', actors,
        ...(options.definition || {}) }, storyTime: '2026-05-12T17:00:00', conversations, actorStates: options.actorStates || {} });
    const requests = [], Engine = context.window.RPHubWorldOrchestrator;
    const run = async (args, responder) => {
        const runner = async request => { requests.push(plain({ purpose: request.purpose, actorId: request.actorId, messages: request.messages }));
            return responder ? responder(request) : { decision: 'reply', actions: [{ kind: 'reply', text: 'ok' }], referencedEvidenceIds: [] }; };
        try { snapshot = await Engine.runTurn({ sessionId: snapshot.sessionId, branchId: snapshot.branchId,
            ...args, modelRunner: runner, onUpdate: next => { snapshot = next; } }); }
        finally { snapshot = await Store.load(snapshot.sessionId, snapshot.branchId); }
        return snapshot;
    };
    return { context, Store, Engine, requests, stored, run, get snapshot() { return snapshot; },
        async update(patch, events = []) { snapshot = await Store.commit({ sessionId: snapshot.sessionId, branchId: snapshot.branchId,
            expectedRevision: snapshot.revision, idempotencyKey: `manual-${++counter}`, patch, events }); return snapshot; },
        async retry(turnId, responder) { snapshot = await Engine.retryTurn({ sessionId: snapshot.sessionId, branchId: snapshot.branchId, turnId,
            modelRunner: async request => { requests.push(plain({ purpose: request.purpose, actorId: request.actorId, messages: request.messages })); return responder(request); },
            onUpdate: next => { snapshot = next; } }); return snapshot; } };
}
module.exports = { harness, plain };
