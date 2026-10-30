const { test } = require('node:test');
const assert = require('node:assert/strict');
const boot = require('./harness');
const { loadConversationConfig } = require('../conversation-config');
const memoryModule = require('../memory/engine');

function fixture(t, voiceCalls = null) {
  const memoryErrors = [];
  const h = boot({ LLM_PROVIDER: 'deepseek', DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'fixture-only',
    ANNOUNCE_SELF: 'false', GREET_ON_JOIN: 'off', MEMORY_STORAGE_ENABLED: 'true', MEMORY_DB_PATH: ':memory:',
    TTS_PROVIDER: 'feiyu', FEIYU_TTS_URL: 'http://feiyu.invalid/speech', TTS_FALLBACK: 'none',
    MEMORY_POLICY_REVIEWED: 'true', MEMORY_ENCRYPTED_STORAGE_CONFIRMED: 'true', MEMORY_PRIVACY_URL: 'https://example.org/privacy' },
  { ...(voiceCalls ? { './tts': { createTTS: options => require('../tts').createTTS({ ...options,
      fetch: async (url, init) => { voiceCalls.push(JSON.parse(init.body)); return new Response('fixture audio'); } }) } } : {}),
    './memory/engine': { ...memoryModule, createMemoryEngine: options => memoryModule.createMemoryEngine({ ...options,
    onFailure: error => { memoryErrors.push(error?.stack); options.onFailure(error); } }) },
    './conversation-config': { loadConversationConfig: () => ({ ...loadConversationConfig({}), enabled: true,
    guildId: 'g', channelId: 'A', operators: new Set(['computer']), requestLimit: 6 }) } });
  t.after(() => { h.T.conversation.leave(); h.T.memoryEngine.close(); });
  h.memoryErrors = memoryErrors; return h;
}
async function join(h) { await h.start(); h.put('a', 'A'); h.put('b', 'A'); await h.luna('computer'); h.S.lastConnection.setStatus(h.Status.Ready); await h.until(() => h.S.lastConnection.receiver.subscriptions.size === 2); }
async function command(h, action, user = 'a', fields = {}, admin = false, commandName = 'memory') {
  let reply;
  h.T.client.emit('interactionCreate', { isChatInputCommand: () => true, guildId: 'g', user: { id: user }, commandName,
    member: { voice: { channelId: 'A' }, permissions: { has: permission => admin && permission === 'ManageGuild' } },
    options: { getString: name => name === 'action' ? action : fields[name], getBoolean: name => fields[name], getInteger: name => fields[name] },
    reply: async data => { reply = data; } });
  await h.until(() => !!reply); assert.ok(reply); assert.equal(reply.flags, 64); return reply;
}
async function say(h, text, speaker = 'a') {
  await h.wait(20);
  h.S.transcripts = [text]; const at = Date.now() - 10;
  assert.equal(h.T.conversation.submit(Buffer.from(text), speaker, { speechStartedAt: at, speechEndedAt: at }), true);
  await h.wait(15);
}
async function enroll(h) {
  await command(h, 'enable-history', 'a', { confirm: true }, true);
  await command(h, 'consent', 'a', { confirm: true }); await command(h, 'consent', 'b', { confirm: true });
}

test('consented memory recall composes with the real Feiyu adapter', async t => {
  const calls = [], h = fixture(t, calls); await join(h); await enroll(h);
  await say(h, '我们计划周末一起玩原神游戏');
  assert.equal(calls.length, 0); assert.equal(h.S.llmRequests.length, 0);
  await command(h, 'clear-context', 'a', {}, true, 'clear-context');
  await say(h, '大肥鱼，上次的游戏计划是什么？');
  await h.until(() => h.S.played.length === 1 && h.T.conversation.state === 'PASSIVE_LISTENING');
  assert.equal(h.S.llmRequests.length, 1); assert.equal(calls.length, 1);
  assert.ok(JSON.parse(h.S.llmRequests[0].messages[1].content).historicalMemory.length > 0);
  assert.equal(calls[0].voice, 'cute'); assert.equal(calls[0].stream, false);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['input', 'stream', 'voice']);
});

test('production memory commands require ManageGuild, visible notice, and separate participant consent', async t => {
  const h = fixture(t); await join(h);
  assert.match((await command(h, 'enable-history', 'computer', { confirm: true })).content, /administrator/);
  await say(h, '这句话不能补存'); assert.equal(h.T.memoryEngine.store.episodes({ viewer: 'a' }).length, 0);
  await enroll(h); assert.ok(h.S.sends.some(m => /持久记忆：已启用/.test(m.content)));
  await say(h, '我们确认原神游戏'); assert.equal(h.S.llmRequests.length, 0); assert.equal(h.S.tts.length, 0);
  assert.deepEqual(h.T.memoryEngine.store.episodes({ viewer: 'a' }).map(e => e.text), ['我们确认原神游戏']);
  await command(h, 'clear-context', 'a', {}, true, 'clear-context');
  await say(h, '大肥鱼，讨论的游戏是什么？'); await h.until(() => h.S.played.length === 1);
  const messages = h.S.llmRequests[0].messages, data = JSON.parse(messages[1].content);
  assert.ok(data.historicalMemory.some(e => e.text === '我们确认原神游戏'), JSON.stringify({ data, status: h.T.memoryEngine.status(), logs: h.S.logs }));
  assert.match(messages[0].content, /虚构 AI 助手/); assert.match(messages[0].content, /untrusted evidence/);
  assert.equal(h.S.llmRequests.length, 1); assert.equal(messages.length, 2);
});

test('production new audience cancels historical playback and prevents retrieval until consent', async t => {
  const h = fixture(t); await join(h); await enroll(h);
  await say(h, '我们计划玩原神游戏'); await command(h, 'clear-context', 'a', {}, true, 'clear-context');
  h.S.ttsMs = 200; await say(h, '大肥鱼，游戏计划呢？'); await h.until(() => h.S.tts.length === 1);
  h.put('new', 'A'); h.T.client.emit('voiceStateUpdate', { channelId: null }, { id: 'new', guild: { id: 'g' }, channelId: 'A', member: { user: { bot: false } } });
  await h.wait(240); assert.equal(h.S.played.length, 0);
  h.S.ttsMs = 1; await say(h, '大肥鱼，上次的游戏是什么？'); await h.until(() => h.S.played.length === 1);
  assert.equal(JSON.parse(h.S.llmRequests.at(-1).messages[1].content).historicalMemory.length, 0);
  assert.ok(h.S.sends.some(m => m.content.startsWith('<@new>') && /持久记忆/.test(m.content)));
});

test('production transcription opt-out removes persisted events and shutdown closes storage', async t => {
  const h = fixture(t); await join(h); await enroll(h); await say(h, '乙的授权游戏记录', 'b');
  const out = await command(h, 'opt-out', 'b', {}, false, 'opt-out');
  assert.ok(h.T.memoryEngine.store, JSON.stringify({ out, logs: h.S.logs }));
  assert.equal(h.T.memoryEngine.store.exportOwn('b').episodes.length, 0);
  assert.equal(h.T.memoryEngine.canRead('b'), false);
  assert.equal(h.T.conversation.submit(Buffer.from('大肥鱼，你好吗'), 'b'), false);
  h.S.signals.SIGTERM(); assert.equal(h.T.memoryEngine.store, null); assert.equal(h.S.clientDestroyed, true);
});

test('production withdrawal cancels an in-flight response and unavailable storage makes no extra API requests', async t => {
  const h = fixture(t); await join(h); await enroll(h); await say(h, '游戏计划已暂定');
  h.S.ttsMs = 200; await say(h, '大肥鱼，游戏计划怎么样？'); await h.until(() => h.S.tts.length === 1);
  const withdrawn = await command(h, 'withdraw', 'a'); await h.wait(220); assert.equal(h.S.played.length, 0, JSON.stringify({ withdrawn, errors: h.memoryErrors }));
  assert.equal(h.T.memoryEngine.store.exportOwn('a').episodes.length, 0);
  h.T.memoryEngine.store.close(); h.S.ttsMs = 1;
  await say(h, '现在的临时内容'); await say(h, '大肥鱼，你觉得呢？'); await h.until(() => h.S.played.length === 1);
  assert.equal(h.S.llmRequests.length, 2); assert.equal(h.T.memoryEngine.status().backend, 'unavailable');
  assert.ok(JSON.parse(h.S.llmRequests.at(-1).messages[1].content).recentDialogue.some(e => e.text === '现在的临时内容'));
});
