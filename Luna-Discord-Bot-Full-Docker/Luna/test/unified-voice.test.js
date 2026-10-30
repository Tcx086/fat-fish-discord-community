const { test } = require('node:test');
const assert = require('node:assert/strict');
const boot = require('./harness');
const { createTTS } = require('../tts');
const { loadConversationConfig } = require('../conversation-config');

test('passive invocation uses the real Feiyu adapter once and returns to silence', async t => {
  const calls = [];
  const h = boot({ LLM_PROVIDER: 'deepseek', DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'fixture',
    TTS_PROVIDER: 'feiyu', FEIYU_TTS_URL: 'http://feiyu.invalid/speech', TTS_FALLBACK: 'none',
    ANNOUNCE_SELF: 'false', GREET_ON_JOIN: 'off' }, {
    './conversation-config': { loadConversationConfig: () => ({ ...loadConversationConfig({}),
      enabled: true, guildId: 'g', channelId: 'A', operators: new Set(['operator']) }) },
    './tts': { createTTS: options => createTTS({ ...options, fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('fixture audio');
    } }) },
  });
  t.after(() => h.T.conversation.leave());
  await h.start(); h.put('a', 'A'); await h.luna('operator');
  h.S.lastConnection.setStatus(h.Status.Ready);
  await h.until(() => h.S.lastConnection.receiver.subscriptions.size === 1);
  h.S.transcripts = ['普通聊天，不需要回答。'];
  assert.equal(h.T.conversation.submit(Buffer.from('ordinary speech fixture'), 'a'), true); await h.wait(30);
  assert.equal(calls.length, 0); assert.equal(h.S.llmRequests.length, 0);
  h.S.transcripts = ['大肥鱼，你觉得呢？'];
  assert.equal(h.T.conversation.submit(Buffer.from('addressed question fixture'), 'a'), true);
  await h.until(() => h.S.played.length === 1 && h.T.conversation.state === 'PASSIVE_LISTENING');
  assert.equal(h.S.llmRequests.length, 1, JSON.stringify(h.S.logs)); assert.equal(calls.length, 1, JSON.stringify(h.S.logs));
  assert.equal(calls[0].url, 'http://feiyu.invalid/speech');
  assert.equal(calls[0].body.voice, 'cute'); assert.equal(calls[0].body.stream, false);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['input', 'stream', 'voice']);
  assert.ok(calls[0].body.input.length > 0);
});
