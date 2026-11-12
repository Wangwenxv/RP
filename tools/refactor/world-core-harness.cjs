const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const plain = value => value == null ? value : JSON.parse(JSON.stringify(value));
function harness() {
  const data = new Map(); let tail = Promise.resolve();
  const storage = {
    getStoredValue: async key => plain(data.get(key)),
    readStorageSnapshot: async () => [...data].map(([k, v]) => [k, plain(v)]),
    getStoredEntriesByPrefix: async prefix => [...data].filter(([key]) => key.startsWith(prefix)).map(([k, v]) => [k, plain(v)]),
    updateStoredValue: (key, fn) => {
      const run = tail.then(() => {
        const next = fn(plain(data.get(key)));
        if (next && typeof next.then === 'function') throw Error('async transaction');
        if (next !== undefined) data.set(key, plain(next));
        return plain(next);
      });
      tail = run.catch(() => {}); return run;
    },
    updateStoredValues: (keys, fn) => {
      const run = tail.then(() => {
        const next = fn(Object.fromEntries(keys.map(key => [key, plain(data.get(key))])));
        for (const [key, value] of Object.entries(next)) { if (!keys.includes(key)) throw Error('unread key'); if (value !== undefined) data.set(key, plain(value)); }
        return plain(next);
      });
      tail = run.catch(() => {}); return run;
    }
  };
  const context = vm.createContext({ window: { RPHubStorage: storage }, Date, Math, JSON, Set, Map, TextEncoder,
    Uint8Array, crypto: webcrypto, console, setTimeout });
  for (const file of ['world-model.js', 'world-projections.js', 'world-store.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../assets/js', file), 'utf8'), context, { filename: file });
  return { M: context.window.RPHubWorldModel, P: context.window.RPHubWorldProjections,
    S: context.window.RPHubWorldStore, data, context };
}
function definition() {
  return { worldId: 'jiangnan', name: '江南大学', playerActorId: 'player',
    actors: [
      { actorId: 'player', name: '玩家', role: 'player', initialState: {} },
      { actorId: 'suqixue', name: '苏祈雪', card: { name: '苏祈雪', personality: '细心，微信口吻简短。' }, bindings: { user: 'player' } },
      { actorId: 'qing', name: '卿', card: { name: '卿', personality: '直率，珍惜朋友。' }, bindings: { user: 'player' } },
      { actorId: 'linwan', name: '林晚', card: { name: '林晚', personality: '对朋友认真，恋人是 {{user}}。' }, bindings: { user: 'qing', partner: 'qing' } }
    ], map: { id: 'campus', nodes: [] } };
}
function conversation(id, people, kind = 'dm') {
  return { conversationId: id, kind, name: id, participantActorIds: people,
    memberships: people.map(actorId => ({ actorId, joinedAtSeq: 0 })) };
}
function sent(id, actorId, conversationId, people, text) {
  return { eventId: id, kind: 'message.sent', actorId, conversationId, access: { principals: people }, payload: { text } };
}
function read(id, actorId, conversationId, eventIds) {
  return { eventId: id, kind: 'message.read', actorId, conversationId, access: { principals: [actorId] }, payload: { eventIds } };
}
async function commit(S, snapshot, events, patch = {}, key) {
  return S.commit({ sessionId: snapshot.sessionId, branchId: snapshot.branchId, expectedRevision: snapshot.revision,
    idempotencyKey: key || `batch-${snapshot.revision}`, events, patch });
}
module.exports = { harness, definition, conversation, sent, read, commit, plain };
