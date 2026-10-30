const { test } = require('node:test');
const assert = require('node:assert/strict');
const boot = require('./harness');
const { loadConversationConfig } = require('../conversation-config');
const override = { './conversation-config': { loadConversationConfig: () => ({ enabled: true, guildId: 'g', channelId: 'A',
  users: new Set(['u1', 'u2']), inactivityMs: 45000, maxTurns: 3, requestLimit: 3 }) } };
function fixture() { return boot({ LLM_PROVIDER: 'deepseek', OWW_ENABLED: 'false', AUTO_JOIN_CHANNELS: 'A',
  GREET_ON_JOIN: 'off', ANNOUNCE_SELF: 'false' }, override); }

test('entry point attaches shared controller, filters consent, disables autojoin, and emergency stop cancels recovery', async () => {
  const h = fixture(); await h.start(); h.put('u1', 'A'); h.put('u2', 'A'); h.put('unconsented', 'A');
  h.T.autoJoin(); assert.equal(h.S.lastConnection, undefined);
  await h.luna('u1'); h.S.lastConnection.setStatus(h.Status.Ready);
  assert.equal(h.T.conversation.state, 'STANDBY');
  assert.deepEqual([...h.S.lastConnection.receiver.subscriptions.keys()].sort(), ['u1', 'u2']);
  h.T.session.reconnect();
  h.T.client.emit('messageCreate', { content: '/stop', author: { id: 'u1' }, guild: { id: 'g' } });
  assert.equal(h.T.conversation.state, 'DISCONNECTED'); assert.equal(h.T.session.active, false);
  assert.equal(h.S.llmRequests.length, 0);
});

test('production slash interrupt/end/stop execute deterministic controls and reject other participants', async () => {
  const h = fixture(); await h.start(); h.put('u1', 'A'); await h.luna('u1'); h.S.lastConnection.setStatus(h.Status.Ready);
  await h.T.conversation.submit(Buffer.from('local audio'), 'u1'); await h.wait(5);
  const invoke = (name, user = 'u1', channel = 'A') => {
    h.T.client.emit('interactionCreate', { isChatInputCommand: () => true, guildId: 'g', user: { id: user },
      member: { voice: { channelId: channel } }, commandName: name, reply: async () => {} });
  };
  invoke('stop', 'stranger'); assert.equal(h.T.session.active, true);
  invoke('end-conversation'); assert.equal(h.T.conversation.state, 'STANDBY'); assert.equal(h.T.session.active, true);
  invoke('stop'); assert.equal(h.T.conversation.state, 'DISCONNECTED'); assert.equal(h.T.session.active, false);
});

test('production join is restricted to configured guild/channel, other bots/messages ignored', async () => {
  const h = fixture(); await h.start(); h.put('u1', 'B'); await h.luna('u1'); assert.equal(h.S.lastConnection, undefined);
  h.put('stranger', 'A'); await h.luna('stranger'); assert.equal(h.S.lastConnection, undefined);
  assert.equal(loadConversationConfig({}).enabled, false);
});

test('process-wide API request gate survives end and new activation', async () => {
  const h = boot({ LLM_PROVIDER: 'deepseek', OWW_ENABLED: 'false', DEEPSEEK_ENABLED: 'true',
    DEEPSEEK_API_KEY: 'fake', DEEPSEEK_RETRIES: '0', ANNOUNCE_SELF: 'false' },
    { './conversation-config': { loadConversationConfig: () => ({ ...override['./conversation-config'].loadConversationConfig(), requestLimit: 1 }) } });
  await h.start(); h.put('u1', 'A'); await h.luna('u1'); h.S.lastConnection.setStatus(h.Status.Ready);
  h.S.transcripts = ['Hey Luna first', 'Hey Luna second'];
  h.T.conversation.submit(Buffer.from('one'), 'u1'); await h.until(() => h.T.conversation.state === 'ACTIVE');
  assert.equal(h.S.llmRequests.length, 1);
  h.T.conversation.end(); h.T.conversation.submit(Buffer.from('two'), 'u1');
  await h.until(() => h.T.conversation.state === 'ACTIVE'); assert.equal(h.S.llmRequests.length, 1);
  h.T.conversation.leave();
});

test('dragging the bot outside the authorized channel immediately disconnects and clears captures', async () => {
  const h = fixture(); await h.start(); h.put('u1', 'A'); await h.luna('u1'); h.S.lastConnection.setStatus(h.Status.Ready);
  h.T.client.emit('voiceStateUpdate', { channelId: 'A' }, { id: 'luna', guild: { id: 'g' }, channelId: 'B', channel: h.channel('B') });
  assert.equal(h.T.conversation.state, 'DISCONNECTED'); assert.equal(h.T.session.active, false);
  await h.wait(5); // Streams remove themselves from the receiver map on close.
  assert.equal(h.S.lastConnection.receiver.subscriptions.size, 0);
});

test('separate computer operator joins only the configured channel without voice membership and gains no audio consent', async () => {
  const operatorOverride = { './conversation-config': { loadConversationConfig: () => ({
    ...override['./conversation-config'].loadConversationConfig(), operators: new Set(['computer']) }) } };
  const h = boot({ LLM_PROVIDER: 'deepseek', OWW_ENABLED: 'false', ANNOUNCE_SELF: 'false' }, operatorOverride);
  await h.start(); h.put('u1', 'A'); h.put('u2', 'A'); h.put('computer', 'B');
  await h.luna('computer'); assert.ok(h.S.lastConnection); h.S.lastConnection.setStatus(h.Status.Ready);
  assert.equal(h.S.lastConnection.channelId, 'A');
  assert.deepEqual([...h.S.lastConnection.receiver.subscriptions.keys()].sort(), ['u1', 'u2']);
  assert.equal(h.T.conversation.submit(Buffer.from('Hey Luna'), 'computer'), false);
  let reply;
  const invoke = (name, guild = 'g') => h.T.client.emit('interactionCreate', { isChatInputCommand: () => true,
    guildId: guild, user: { id: 'computer' }, member: { voice: {} }, commandName: name,
    reply: async data => { reply = data.content; } });
  invoke('conversation-status'); await h.wait(1); assert.match(reply, /STANDBY/);
  invoke('stop', 'other'); assert.equal(h.T.session.active, true);
  invoke('end-conversation'); assert.equal(h.T.session.active, true);
  invoke('stop'); assert.equal(h.T.session.active, false);
});

test('operator cannot join an empty or operator-only channel', async () => {
  const h = boot({ LLM_PROVIDER: 'deepseek', OWW_ENABLED: 'false' },
    { './conversation-config': { loadConversationConfig: () => ({
      ...override['./conversation-config'].loadConversationConfig(), operators: new Set(['computer']) }) } });
  await h.start(); h.put('computer', 'A'); await h.luna('computer');
  assert.equal(h.S.lastConnection, undefined); assert.ok(h.S.replies.some(r => /consenting speaker/.test(r)));
});
