const { test } = require('node:test');
const assert = require('node:assert/strict');
const boot = require('./harness');
const { loadConversationConfig } = require('../conversation-config');
const memoryModule = require('../memory/engine');
const { fixture: storageFixture } = require('./v02-fixture');

function fixture(t, { overrides = {}, env = {}, options = {} } = {}) {
  const h = boot({ LLM_PROVIDER: 'deepseek', DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'fixture-only',
    ANNOUNCE_SELF: 'false', GREET_ON_JOIN: 'off', ...env }, {
    './conversation-config': { loadConversationConfig: () => ({ ...loadConversationConfig({}), enabled: true,
      dynamicChannels: true, guildId: 'g', channelId: null, operators: new Set(['operator']), ...options }) }, ...overrides });
  t.after(() => { h.T.conversation.leave(); h.T.memoryEngine.close(); });
  return h;
}
async function control(h, commandName, { user = 'operator', channel = null, target, guild = 'g', admin = false, fields = {}, defer } = {}) {
  let reply;
  const member = { id: user, voice: { channelId: channel, channel: channel ? h.channel(channel) : null },
    permissions: { has: p => admin && p === 'ManageGuild' } };
  const interaction = { commandName, guildId: guild, user: { id: user }, member, isChatInputCommand: () => true,
    options: { getChannel: () => target, getString: n => fields[n], getBoolean: n => fields[n], getInteger: n => fields[n] },
    reply: async data => { reply = data; }, editReply: async data => { reply = data; },
    ...(defer ? { deferReply: async () => { await defer; interaction.deferred = true; } } : {}) };
  const task = h.T.client.listeners('interactionCreate')[0](interaction);
  if (defer) return { task, get reply() { return reply; } };
  await task; assert.ok(reply, commandName); assert.equal(reply.flags, 64); return reply.content;
}
async function join(h) {
  await h.start(); h.put('a', 'A'); h.put('b', 'A');
  assert.match(await control(h, 'join', { user: 'a', channel: 'A' }), /Connecting/);
  assert.equal(h.T.conversation.submit(Buffer.from('before-ready'), 'a'), false);
  h.S.lastConnection.setStatus(h.Status.Ready);
  await h.until(() => h.S.lastConnection.receiver.subscriptions.size === 2);
  assert.equal(h.S.lastConnection.receiver.subscriptions.size, 2);
}
async function move(h, destination = 'B') {
  h.put('destination-human', destination);
  const reply = await control(h, 'move', { target: h.channel(destination) });
  assert.match(reply, /Connecting/);
  h.S.lastConnection.setStatus(h.Status.Ready);
  await h.until(() => h.T.session.channel?.id === destination && h.S.lastConnection.receiver.speaking.listenerCount('start') === 1);
  assert.equal(h.S.lastConnection.receiver.speaking.listenerCount('start'), 1);
}
async function say(h, text, user = 'a') {
  h.S.transcripts = [text]; assert.equal(h.T.conversation.submit(Buffer.from(text), user), true); await h.wait(15);
}

test('passive production config needs a guild, not a fixed channel or manual speaker IDs', () => {
  const c = loadConversationConfig({ CONVERSATION_ENABLED: 'true', CONVERSATION_GUILD_ID: '123456789012345678' });
  assert.equal(c.dynamicChannels, true); assert.equal(c.channelId, null); assert.equal(c.allParticipants, true);
  assert.throws(() => loadConversationConfig({ CONVERSATION_ENABLED: 'true' }));
});

test('guild slash registration is opt-in and includes channel-restricted move without global registration', async t => {
  const h = fixture(t, { env: { CONVERSATION_REGISTER_COMMANDS: 'true' } }); await h.start();
  assert.deepEqual([...h.S.registered.find(c => c.name === 'move').options[0].channel_types], [2]);
  for (const name of ['join', 'move', 'leave', 'stop', 'status', 'pause', 'resume', 'clear-context', 'opt-out', 'opt-in', 'memory'])
    assert.ok(h.S.registered.some(c => c.name === name), name);
  assert.equal(h.T.session.active, false);
});

test('join admits multiple humans after notice; already joined never moves or reconnects; status shows resources', async t => {
  const h = fixture(t); await join(h); const conn = h.S.lastConnection, generation = h.T.session.generation;
  h.put('c', 'B'); assert.match(await control(h, 'join', { user: 'c', channel: 'B' }), /Already active.*A/);
  assert.equal(h.T.session.generation, generation); assert.equal(h.T.session.connection, conn);
  assert.ok(h.S.sends.some(m => /本地转写/.test(m.content))); assert.equal(h.S.registered, undefined);
  const status = JSON.parse(await control(h, 'status', { user: 'a', channel: 'A' }));
  assert.equal(status.guild, 'g'); assert.equal(status.channel, 'A'); assert.equal(status.participants, 2);
  assert.equal(status.subscriptions, 2); assert.equal(status.connectionState, 'ready');
  h.T.autoJoin(); assert.equal(h.T.session.connection, conn);
});

test('move authorization, channel type, guild and bot/member permissions fail closed without changing current session', async t => {
  const h = fixture(t); await join(h); h.put('c', 'B'); const owner = h.T.session.generation;
  assert.match(await control(h, 'move', { user: 'a', channel: 'A', target: h.channel('B') }), /Administrator/);
  assert.match(await control(h, 'move', { guild: 'other', target: h.channel('B') }), /restricted/);
  for (const target of [{ ...h.channel('B'), type: 13 }, { ...h.channel('B'), guild: { id: 'other' } }, null])
    assert.match(await control(h, 'move', { target }), /authorized ordinary/);
  for (const permission of ['ViewChannel', 'Connect', 'Speak']) {
    h.S.deniedPermissions = [permission]; assert.match(await control(h, 'move', { target: h.channel('B') }), /authorized ordinary/);
  }
  h.S.deniedPermissions = [];
  const deniedMember = { ...h.channel('B'), permissionsFor: actor => ({ has: () => actor.id === 'luna' }) };
  assert.match(await control(h, 'move', { target: deniedMember }), /authorized ordinary/);
  assert.equal(h.T.session.generation, owner); assert.equal(h.T.session.channel.id, 'A');
  assert.match(await control(h, 'move', { user: 'admin', admin: true, target: h.channel('B') }), /Connecting/);
});

test('A to B reuses transport but resets context/subscriptions; ordinary speech is silent and explicit invocation answers once', async t => {
  const h = fixture(t); await join(h); await say(h, 'Synthetic secret in channel A');
  assert.equal(h.S.llmRequests.length, 0); const conn = h.S.lastConnection, stream = conn.receiver.subscriptions.get('a');
  const staleReady = conn.listeners(h.Status.Ready)[0];
  await move(h); staleReady();
  assert.equal(h.T.session.connection, conn); assert.equal(stream.destroyed, true);
  assert.deepEqual([...conn.receiver.subscriptions.keys()], ['destination-human']);
  assert.equal(h.T.conversation.status().contextEntries, 0);
  assert.equal(h.T.conversation.submit(Buffer.from('stale-a'), 'a'), false);
  await say(h, '大肥鱼，你知道之前聊了什么吗？', 'destination-human');
  await h.until(() => h.S.played.length === 1);
  assert.equal(h.S.llmRequests.length, 1); assert.doesNotMatch(JSON.stringify(h.S.llmRequests), /Synthetic secret/);
  assert.equal(conn.receiver.speaking.listenerCount('start'), 1);
});

test('late notices, new arrivals, bots, consent allowlist and opt-out stay gated', async t => {
  const h = fixture(t); await join(h); await control(h, 'opt-out', { user: 'b', channel: 'A' });
  h.S.bots = ['bot']; h.S.sendMs = 40; h.move('new', null, 'A'); h.move('bot', null, 'A');
  assert.equal(h.T.conversation.submit(Buffer.from('before-notice'), 'new'), false);
  await h.wait(65); assert.deepEqual([...h.S.lastConnection.receiver.subscriptions.keys()].sort(), ['a', 'new']);
  await control(h, 'pause', { user: 'a', channel: 'A' });
  assert.equal(h.T.conversation.submit(Buffer.from('paused'), 'a'), false);
  await control(h, 'resume'); await h.wait(15);
  assert.equal(h.T.conversation.submit(Buffer.from('opted-out'), 'b'), false);
  await control(h, 'opt-in', { user: 'b', channel: 'A' }); await h.wait(15);
  assert.ok(h.S.lastConnection.receiver.subscriptions.has('b'));
  h.move('late', null, 'A'); await move(h); await h.wait(60);
  assert.deepEqual([...h.S.lastConnection.receiver.subscriptions.keys()], ['destination-human']);
});

test('required configured speaker consent remains enforced when all-participant mode is disabled', async t => {
  const h = fixture(t, { options: { allParticipants: false, users: new Set(['a']) } });
  await h.start(); h.put('a', 'A'); h.put('b', 'A'); await control(h, 'join', { user: 'a', channel: 'A' });
  h.S.lastConnection.setStatus(h.Status.Ready); await h.wait(20);
  assert.deepEqual([...h.S.lastConnection.receiver.subscriptions.keys()], ['a']);
  assert.equal(h.T.conversation.submit(Buffer.from('not-consented'), 'b'), false);
});

for (const stage of ['tts', 'playback']) test(`move cancels ${stage} and rejects late old-channel audio`, async t => {
  const h = fixture(t); await join(h); h.S.ttsMs = stage === 'tts' ? 120 : 1; h.S.playMs = 200;
  await say(h, '大肥鱼，你怎么看？'); await h.until(() => stage === 'tts' ? h.S.tts.length : h.S.played.length);
  const played = h.S.played.length; await move(h); await h.wait(140);
  assert.equal(h.S.tts[0].signal.aborted, true); assert.equal(h.S.played.length, played);
  assert.equal(h.T.conversation.status().contextEntries, 0); assert.equal(h.T.session.channel.id, 'B');
});

for (const action of ['leave', 'stop']) test(`${action} during playback clears resources and rejects late Ready`, async t => {
  const h = fixture(t); await join(h); h.S.playMs = 150;
  await say(h, '大肥鱼，你怎么看？'); await h.until(() => h.S.played.length === 1);
  const conn = h.S.lastConnection, stale = conn.listeners(h.Status.Ready)[0];
  await control(h, action, { user: 'a', channel: 'A' }); stale(); await h.wait(15);
  assert.equal(h.T.session.active, false); assert.equal(h.T.conversation.state, 'DISCONNECTED');
  assert.equal(conn.receiver.subscriptions.size, 0); assert.equal(h.T.conversation.status().contextEntries, 0);
  h.T.autoJoin(); assert.equal(h.T.session.active, false);
});

test('failed move is disconnected; failed destination notice pauses with zero subscribers', async t => {
  const h = fixture(t); await join(h); const old = h.S.lastConnection; h.put('c', 'B'); h.S.joinFails = true;
  assert.match(await control(h, 'move', { target: h.channel('B') }), /failed; disconnected/);
  assert.equal(h.T.session.active, false); assert.equal(old.state.status, h.Status.Destroyed);
  h.S.joinFails = false; await control(h, 'join', { user: 'c', channel: 'B' }); h.S.noticeDown = true;
  h.S.lastConnection.setStatus(h.Status.Ready); await h.wait(20);
  assert.equal(h.T.conversation.paused, true); assert.equal(h.S.lastConnection.receiver.subscriptions.size, 0);
});

test('last human leaves, unrequested bot dragging and repeated transitions leave no automatic follow or stacked listeners', async t => {
  const h = fixture(t); await join(h);
  for (let i = 0; i < 12; i++) await move(h, i % 2 ? 'A' : 'B');
  assert.equal(h.S.lastConnection.listenerCount('error'), 1);
  assert.equal(h.S.lastConnection.receiver.speaking.listenerCount('start'), 1, JSON.stringify({ status: h.T.conversation.status(), logs: h.S.logs.slice(-15) }));
  h.move('a', 'A', 'B'); h.move('b', 'A', 'B'); h.move('destination-human', 'A', null);
  assert.equal(h.T.session.active, false); h.T.autoJoin(); assert.equal(h.T.session.active, false);
  await control(h, 'join', { user: 'a', channel: 'B' }); h.S.lastConnection.setStatus(h.Status.Ready); await h.wait(15);
  h.T.client.emit('voiceStateUpdate', { channelId: 'B' }, { id: 'luna', guild: { id: 'g' }, channelId: 'A', channel: h.channel('A') });
  assert.equal(h.T.session.active, false);
});

test('persistent synthetic history stays in A; B requires its own enablement/consent and cannot retrieve A', async t => {
  const storage = storageFixture(t);
  const h = fixture(t, { overrides: { './memory/engine': { ...memoryModule, loadMemoryConfig: () => storage.memoryConfig } } });
  storage.dispose(() => h.T.conversation.leave());
  await join(h);
  await control(h, 'memory', { user: 'a', channel: 'A', admin: true, fields: { action: 'enable-history', confirm: true } });
  await control(h, 'memory', { user: 'a', channel: 'A', fields: { action: 'consent', confirm: true } });
  await control(h, 'memory', { user: 'b', channel: 'A', fields: { action: 'consent', confirm: true } });
  await h.wait(15); const at = Date.now(); h.S.transcripts = ['Synthetic Celeste plan in channel A'];
  h.T.conversation.submit(Buffer.from('synthetic-memory'), 'a', { speechStartedAt: at, speechEndedAt: at }); await h.wait(20);
  assert.equal(h.T.memoryEngine.store.episodes({ viewer: 'a' }).length, 1);
  const oldEngine = h.T.memoryEngine; await move(h);
  assert.equal(oldEngine.store, null); assert.equal(h.T.memoryEngine.store.channel, 'B');
  assert.equal(h.T.memoryEngine.store.settings().enabled, 0); assert.equal(h.T.memoryEngine.canRead('a'), false);
  assert.deepEqual(h.T.memoryEngine.store.episodes({ viewer: 'a' }), []);
  await say(h, '大肥鱼，上次的游戏是什么？', 'destination-human'); await h.until(() => h.S.played.length === 1);
  assert.doesNotMatch(JSON.stringify(h.S.llmRequests), /Celeste/);
  await move(h, 'A'); assert.equal(h.T.memoryEngine.store.channel, 'A');
  assert.equal(h.T.memoryEngine.store.episodes({ viewer: 'a' })[0].text, 'Synthetic Celeste plan in channel A');
  assert.equal(h.T.conversation.status().contextEntries, 0);
  // Close before the shared fixture removes its disposable directory.
  h.T.conversation.leave();
});

test('a memory command deferred across a move cannot mutate the new scope', async t => {
  const h = fixture(t); await join(h); let release;
  const pending = await control(h, 'memory', { fields: { action: 'withdraw' }, defer: new Promise(r => { release = r; }) });
  await move(h); const generation = h.T.conversation.generation; release(); await pending.task;
  assert.match(pending.reply.content, /scope changed/); assert.equal(h.T.conversation.generation, generation);
});

for (const stage of ['stt', 'llm']) test(`move aborts in-flight ${stage}; deliberately late completion cannot populate B`, async t => {
  let signal, release;
  const held = new Promise(resolve => { release = resolve; });
  const overrides = stage === 'stt' ? { './whisper': { createWhisper: () => ({ transcribe: (_pcm, options) => { signal = options.signal; return held; } }) } } : {
    './llm-providers': { ...require('../llm-providers'), createProvider: options => require('../llm-providers').createProvider({ ...options,
      fetch: (_url, init) => { signal = init.signal; return held; } }) },
  };
  const h = fixture(t, { overrides }); await join(h); await say(h, '大肥鱼，你怎么看？');
  await h.until(() => !!signal); assert.ok(signal); assert.equal(signal.aborted, false);
  await move(h); assert.equal(signal.aborted, true);
  release(stage === 'stt' ? '大肥鱼，旧频道秘密' : new Response('data: {"choices":[{"delta":{"content":"old channel secret"}}]}\n\ndata: [DONE]\n\n'));
  await h.wait(20); assert.equal(h.S.played.length, 0); assert.equal(h.S.tts.length, 0);
  assert.equal(h.T.conversation.status().contextEntries, 0); assert.equal(h.T.conversation.status().stt, 0);
});

test('pending join can be stopped; late ready cannot restore it and legacy join still uses the invoking channel', async t => {
  const h = fixture(t); await h.start(); h.put('a', 'A'); await h.luna('a');
  assert.equal(h.T.session.channel.id, 'A'); const conn = h.S.lastConnection;
  await control(h, 'stop', { user: 'a', channel: 'A' }); conn.setStatus(h.Status.Ready);
  assert.equal(h.T.session.active, false); assert.equal(h.T.conversation.state, 'DISCONNECTED');
  await h.luna('a'); h.S.lastConnection.setStatus(h.Status.Ready); await h.until(() => h.S.lastConnection.receiver.subscriptions.size === 1);
  assert.equal(h.S.lastConnection.receiver.subscriptions.size, 1);
});

test('permission revocation before readiness prevents binding or notice; revocation before speech prevents STT', async t => {
  const h = fixture(t); await h.start(); h.put('a', 'A'); await control(h, 'join', { user: 'a', channel: 'A' });
  h.S.deniedPermissions = ['Speak']; h.S.lastConnection.setStatus(h.Status.Ready);
  assert.equal(h.T.session.active, false); assert.equal(h.S.sends.length, 0);
  h.S.deniedPermissions = []; await control(h, 'join', { user: 'a', channel: 'A' }); h.S.lastConnection.setStatus(h.Status.Ready);
  await h.until(() => h.S.lastConnection.receiver.subscriptions.size === 1);
  h.S.deniedPermissions = ['ViewChannel']; assert.equal(h.T.conversation.submit(Buffer.from('denied'), 'a'), false);
});

test('stale speaking callback cannot recreate capture after moving the same connection', async t => {
  const h = fixture(t); await join(h); const oldSpeaking = h.S.lastConnection.receiver.speaking.listeners('start')[0];
  await move(h); const receiver = h.S.lastConnection.receiver;
  receiver.subscriptions.get('destination-human').destroy(); await h.wait(10);
  assert.equal(receiver.subscriptions.size, 0); oldSpeaking('destination-human');
  assert.equal(receiver.subscriptions.size, 0);
  receiver.speaking.emit('start', 'destination-human'); assert.equal(receiver.subscriptions.size, 1);
});

test('repeated dynamic join/move/leave cycles release every connection and preserve paused recovery', async t => {
  const timers = new Map(); let next = 0;
  const h = fixture(t, { overrides: { './voice-session': { createVoiceSession: options => require('../voice-session').createVoiceSession({ ...options,
    timers: { setTimeout(fn, ms) { timers.set(++next, { fn, ms }); return next; }, clearTimeout(id) { timers.delete(id); } } }) } } });
  await h.start(); h.put('a', 'A');
  for (let i = 0; i < 3; i++) {
    await control(h, 'join', { user: 'a', channel: 'A' }); h.S.lastConnection.setStatus(h.Status.Ready);
    await h.until(() => h.S.lastConnection.receiver.subscriptions.size === 1);
    await move(h); await control(h, 'leave');
    assert.equal(h.T.session.active, false); assert.equal(timers.size, 0);
    assert.equal(h.S.lastConnection.state.status, h.Status.Destroyed);
  }
  await control(h, 'join', { user: 'a', channel: 'A' }); h.S.lastConnection.setStatus(h.Status.Ready); await h.wait(15);
  await control(h, 'pause', { user: 'a', channel: 'A' }); h.T.session.reconnect();
  const [id, recovery] = [...timers].find(([, timer]) => timer.ms === 1500); timers.delete(id); recovery.fn();
  h.S.lastConnection.setStatus(h.Status.Ready); await h.wait(15);
  assert.equal(h.T.conversation.paused, true); assert.equal(h.S.lastConnection.receiver.subscriptions.size, 0);
  await control(h, 'resume'); await h.until(() => h.S.lastConnection.receiver.subscriptions.size === 1);
  assert.equal(h.S.lastConnection.receiver.subscriptions.size, 1);
});

test('Ready on reused transport is insufficient: B must be acknowledged before notice, binding or capture', async t => {
  const h = fixture(t); await join(h); const conn = h.S.lastConnection, notices = h.S.sends.length;
  h.S.holdVoiceConfirmation = true; h.put('c', 'B');
  assert.match(await control(h, 'move', { target: h.channel('B') }), /Connecting/);
  conn.setStatus(h.Status.Ready); await h.wait(15);
  assert.equal(h.T.session.connection, null); assert.equal(conn.receiver.subscriptions.size, 0);
  assert.equal(h.S.sends.length, notices); assert.equal(h.T.conversation.submit(Buffer.from('old-transport'), 'c'), false);
  h.T.client.emit('voiceStateUpdate', { channelId: 'A' }, { id: 'luna', guild: { id: 'g' }, channelId: 'B', channel: h.channel('B') });
  await h.until(() => conn.receiver.subscriptions.size === 1);
  assert.equal(h.T.session.connection, conn); assert.deepEqual([...conn.receiver.subscriptions.keys()], ['c']);
});
