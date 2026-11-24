// Diagnostic reproduction: actual lifecycle + WeChat modules, fixture storage only.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
function harness() {
  const stored = new Map(), watches = [], timers = new Map(), toasts = [];
  let id = 0;
  const get = async (key, scope) => clone(stored.get(`${key}/${scope}`));
  const set = async (key, scope, value) => stored.set(`${key}/${scope}`, clone(value));
  const c = vm.createContext({ Blob, window: {}, console, AbortController, DOMException,
    ref: value => ({ value }), reactive: value => value,
    computed: get => ({ get value() { return get(); } }), watch: (get, fn) => watches.push({ get, fn }),
    nextTick: async () => {}, requestAnimationFrame: fn => fn(), document: { getElementById: () => null },
    setTimeout: fn => { const key = ++id; timers.set(key, fn); return key; }, clearTimeout: key => timers.delete(key),
    setInterval: () => 1, clearInterval() {}, generateUUID: () => `fixture-${++id}`,
    getMainDb: () => ({}), initDB: async () => {}, cloneForStorage: clone,
    getScopedStoredValue: get, setScopedStoredValue: set,
    deleteScopedStoredValue: async (key, scope) => stored.delete(`${key}/${scope}`),
    getStoredValue: async key => clone(stored.get(key)), setStoredValue: async (key, value) => stored.set(key, clone(value)),
    prepareClassicMemoriesForRuntime: value => clone(value || []),
    getConversationBodyLength: items => items.reduce((n, item) => n + (item.content || '').length, 0),
    STORY_BRANCH_MAIN_ID: 'main'
  });
  for (const file of ['built-in-content.js', 'wechat-time.js', 'wechat-protocol.js', 'branch-chat-utils.js', 'app/21-character-lifecycle.js', 'app/25-wechat.js'])
    vm.runInContext(fs.readFileSync(path.join(root, 'assets/js', file), 'utf8'), c, { filename: file });
  const s = {
    currentCharacter: { value: { uuid: 'fixture-char', name: '测试角色', first_mes: '开场', wechatEnabled: true } },
    chatHistory: { value: [{ id: 'opening', role: 'assistant', content: '开场' }, { id: 'u1', role: 'user', content: 'RP1' }, { id: 'a1', role: 'assistant', content: '答复1' }] },
    classicMemories: { value: [] }, storyRecap: { value: null }, memorySettings: { enabled: false },
    activeStoryBranchId: { value: 'main' }, selectedStoryBranchId: { value: 'main' },
    storyBranches: { value: [{ id: 'main', name: '主线' }, { id: 'other', name: '另支' }] },
    storyBranchSwitching: { value: false }, showStoryBranchModal: { value: false },
    lastContextMessages: { value: [] }, lastTriggeredWorldInfos: { value: [] },
    globalUiTemplates: { value: [] }, retryingClassicMemoryId: { value: null }, isConversationBusy: { value: false },
    isConversationClearing: { value: false }, conversationRevision: 0, _characterSwitchEpoch: 0,
    worldInfo: { value: [] }, presets: { value: [] }, user: { name: '玩家' }, settings: {}, currentView: { value: 'chat' },
    getStoryBranchScopeId: (owner, branch) => branch === 'main' ? owner : `${owner}__branch__${branch}`,
    prepareLoadedChatHistoryForDisplay: clone, getPostprocessedChatMessages: items => items,
    buildConversationTurnSnapshot: items => ({ turns: items.filter(item => item.role === 'user') }),
    trimClassicMemoriesToTurn: (items, turn) => items.filter(item => item.turn <= turn),
    saveClassicMemoriesNow: (scope, value) => set('classic_memories', scope, value),
    saveChatHistoryNow: (scope, value) => set('chat', scope, value),
    saveMemorySettingsNow: async () => {}, saveCharactersNow: async () => {}, flushPendingChatHistorySave: async () => {},
    abortConversationBackgroundWork() {}, saveGlobalUiTemplateRuntimeForCharacter() {}, loadGlobalUiTemplateRuntimeForCharacter() {},
    getUiTemplatesForRuntime: () => [], resetChatRenderWindow() {}, finishApplyingCharacterScopedData() {}, resetActiveToolResultContext() {},
    clearPendingChatImages() {}, clearPendingCardInteraction() {}, scrollChatToBottom: async () => {},
    showToast: (...args) => toasts.push(args), buildUserInfoPrompt: () => '', processRegex: text => text
  };
  s.getCurrentStoryBranchScopeId = () => s.getStoryBranchScopeId(s.currentCharacter.value.uuid, s.activeStoryBranchId.value);
  s.currentStoryBranch = { get value() { return s.storyBranches.value.find(b => b.id === s.activeStoryBranchId.value); } };
  c.window.RPHubStorage = {
    getStoredValue: async key => stored.get(key),
    deleteStoredValue: async key => stored.delete(key),
    setStoredValues: async entries => { for (const [key, value] of entries) stored.set(key, value); }
  };
  c.window.RPHubAppSections.characterLife(s);
  c.window.RPHubAppSections.wechat(s);
  const notify = async () => { watches.at(-1).fn(); await s.ensureWechatTimelineLoaded(); };
  const flushTimers = async () => { for (const [key, fn] of [...timers]) { timers.delete(key); fn(); } await Promise.resolve(); await Promise.resolve(); };
  return { s, stored, toasts, notify, flushTimers, context: c };
}

module.exports = { harness };
