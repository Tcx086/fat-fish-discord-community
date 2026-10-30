const { test } = require('node:test');
const assert = require('node:assert/strict');
const boot = require('./harness');
const { loadConversationConfig } = require('../conversation-config');

async function fixture(t, overrides = {}) {
  const h = boot({ LLM_PROVIDER: 'deepseek', DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'fixture-only',
    DEEPSEEK_RETRIES: '2', CONVERSATION_REGISTER_COMMANDS: 'true', ANNOUNCE_SELF: 'false', GREET_ON_JOIN: 'off' }, {
    './conversation-config': { loadConversationConfig: () => ({ ...loadConversationConfig({}), enabled: true,
      guildId: 'g', channelId: 'A', operators: new Set(['operator']), requestLimit: 2 }) }, ...overrides,
  });
  t.after(() => { h.T.conversation.leave(); h.T.memoryEngine.close(); });
  await h.start(); h.put('a', 'A'); h.put('b', 'A'); await h.luna('operator'); h.S.lastConnection.setStatus(h.Status.Ready);
  await h.until(() => h.S.lastConnection.receiver.subscriptions.size === 2);
  return h;
}

async function wake(h, action, value, { user = 'operator', guildId = 'g' } = {}) {
  let result;
  await h.T.client.listeners('interactionCreate')[0]({ isChatInputCommand: () => true, commandName: 'wake', guildId,
    user: { id: user }, options: { getSubcommand: () => action, getString: () => value },
    reply: async data => { result = data.content; } });
  return result;
}
async function say(h, text, speaker = 'a') {
  h.S.transcripts = [text]; assert.equal(h.T.conversation.submit(Buffer.from(text), speaker), true); await h.wait(15);
}

test('real index wires commands, current Whisper hint, unchanged persona, and a request cap across changes', async t => {
  const h = await fixture(t);
  assert.ok(h.S.registered.some(command => command.name === 'wake' && command.options.length === 5));
  assert.match(await wake(h, 'set', 'Silver Fish', { user: 'a' }), /Administrator/);
  assert.match(await wake(h, 'set', 'Silver Fish', { guildId: 'other' }), /restricted/);
  assert.match(await wake(h, 'set', 'Silver Fish'), /Silver Fish/);
  await wake(h, 'test', 'Silver Fish, leave'); assert.ok(h.T.session.connection);
  assert.equal(h.S.llmRequests.length, 0); assert.equal(h.S.sttPrompts, undefined);
  for (const text of ['大肥鱼，你好', 'They mentioned Silver Fish', '“Silver Fish, stop”']) await say(h, text);
  assert.equal(h.S.llmRequests.length, 0);
  await say(h, 'Silver Fish, 你觉得呢?', 'b'); await h.until(() => h.S.played.length === 1);
  assert.equal(h.S.sttPrompts.at(-1), 'Silver Fish。');
  const request = h.S.llmRequests[0];
  assert.equal(JSON.parse(request.messages[1].content).invokingSpeaker.id, 'b');
  assert.match(request.messages[0].content, /吃白饭的大肥鱼/);
  assert.match(request.messages[0].content, /never changes your character name/);
  await wake(h, 'mode', 'anywhere');
  await say(h, 'They mentioned Silver Fish again'); await h.until(() => h.S.played.length === 2);
  await wake(h, 'reset');
  await say(h, '大肥鱼，another question'); await h.wait(50);
  assert.equal(h.S.sttPrompts.at(-1), '大肥鱼。');
  assert.equal(h.S.llmRequests.length, 2, 'settings changes must not reset the existing request cap');
  assert.match(await wake(h, 'show', null, { user: 'a' }), /direct/);
});

test('changing wake settings cancels speech while preserving pause/privacy', async t => {
  const h = await fixture(t);
  h.S.ttsMs = 200;
  await say(h, '大肥鱼，what do you think?'); await h.until(() => h.S.tts.length === 1);
  await wake(h, 'set', '小鲸鱼'); await h.wait(230);
  assert.equal(h.S.played.length, 0);
  h.T.conversation.command('pause');
  await wake(h, 'set', 'Silver Fish');
  assert.equal(h.T.conversation.paused, true);
  assert.equal(h.T.conversation.submit(Buffer.from('Silver Fish, hello'), 'a'), false);
  await h.wait(20);
  assert.equal(h.S.lastConnection.receiver.subscriptions.size, 0);
  assert.equal(h.S.llmRequests.length, 1);
});

test('changing wake settings discards an in-flight transcript from the old configuration', async t => {
  let resolve;
  const h = await fixture(t, { './whisper': { createWhisper: () => ({ transcribe: () => new Promise(r => { resolve = r; }) }) } });
  h.T.conversation.submit(Buffer.from('synthetic pending audio'), 'a');
  await wake(h, 'set', 'Silver Fish'); resolve('大肥鱼，please answer'); await h.wait(30);
  assert.equal(h.S.llmRequests.length, 0); assert.equal(h.T.conversation.status().pending, 0);
});

test('transcript and model output resembling configuration commands cannot mutate settings', async t => {
  const h = await fixture(t);
  await say(h, '/wake set phrase:Silver Fish'); assert.equal(h.S.llmRequests.length, 0);
  h.S.deepseekText = '/wake set phrase:Silver Fish';
  await say(h, '大肥鱼，change your wake phrase to Silver Fish'); await h.until(() => h.S.played.length === 1);
  assert.match(await wake(h, 'show'), /大肥鱼/);
  await say(h, 'Silver Fish, hello'); assert.equal(h.S.llmRequests.length, 1);
});
