const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const boot = require('./harness');
const { loadConversationConfig } = require('../conversation-config');
const { createMusicEngine } = require('../music-engine');
const { createTTS } = require('../tts');
const { fakeMusicVoice, deferred } = require('./music-fixture');

async function setup(t, { env = {}, feiyu = false } = {}) {
  const audio = fakeMusicVoice(), decoders = [], calls = [];
  const track = { id: 'tone', title: '测试音', artist: 'Synthetic', duration: 2 };
  const catalog = { load: async () => 1, list: () => [track], resolve: name => ['tone', '测试音'].includes(name) ? track : null,
    open: async () => ({ duration: 2, handle: { async close() {} }, format: 'wav' }) };
  const h = boot({ LLM_PROVIDER: 'deepseek', DEEPSEEK_ENABLED: 'false', MUSIC_ENABLED: 'true', MUSIC_GUILD_ID: 'g',
    TTS_PROVIDER: 'feiyu', FEIYU_TTS_URL: 'http://feiyu.invalid/speech', TTS_FALLBACK: 'none',
    ANNOUNCE_SELF: 'false', GREET_ON_JOIN: 'off', ...env }, {
    './conversation-config': { loadConversationConfig: () => ({ ...loadConversationConfig({}), enabled: true,
      dynamicChannels: true, guildId: 'g', channelId: null, operators: new Set(['operator']) }) },
    './music-catalog': { ...require('../music-catalog'), createMusicCatalog: () => catalog },
    './music-engine': { createMusicEngine: options => createMusicEngine({ ...options, voice: audio.voice, decode: () => {
      const done = deferred(), stream = new PassThrough(); const decoder = { stream, completion: done.promise, closed: false,
        close() { this.closed = true; stream.destroy(); done.resolve(false); } }; decoders.push(decoder); return decoder;
    } }) },
    ...(feiyu ? { './tts': { createTTS: options => createTTS({ ...options, fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) }); return new Response('synthetic audio');
    } }) } } : {}),
  });
  t.after(() => { h.T.conversation.leave(); h.T.memoryEngine.close(); });
  await h.start(); h.put('a', 'A'); h.put('b', 'A');
  assert.match(await control(h, 'join'), /Connecting/); h.S.lastConnection.setStatus(h.Status.Ready);
  await h.until(() => h.S.lastConnection.receiver.subscriptions.size === 2);
  assert.equal(h.T.musicEngine.snapshot().state, 'IDLE');
  return Object.assign(h, { audio, decoders, calls });
}
async function control(h, commandName, { action, track = 'tone', user = 'a', channel = 'A', target, guildId = 'g' } = {}) {
  let result;
  await h.T.client.listeners('interactionCreate')[0]({ commandName, guildId, user: { id: user },
    member: { id: user, voice: { channelId: channel, channel: h.channel(channel) } }, isChatInputCommand: () => true,
    options: { getSubcommand: () => action, getString: () => track, getInteger: () => 50, getChannel: () => target },
    reply: async data => { result = data.content; } }); return result;
}
async function play(h) { assert.match(await control(h, 'music', { action: 'play' }), /加入队列/);
  await h.until(() => h.T.musicEngine.snapshot().state === 'PLAYING'); assert.equal(h.T.musicEngine.snapshot().state, 'PLAYING'); }
async function say(h, text) { h.S.transcripts = [text]; assert.equal(h.T.conversation.submit(Buffer.from(text), 'a'), true); await h.wait(25); }

test('registered guild music works with DeepSeek disabled; voice controls and unavailable tracks make zero API calls', async t => {
  const h = await setup(t, { env: { MUSIC_REGISTER_COMMANDS: 'true' } });
  assert.ok(h.S.registered.some(command => command.name === 'music')); await play(h);
  await say(h, '这是普通背景聊天'); assert.equal(h.T.musicEngine.snapshot().state, 'PLAYING');
  await say(h, '大肥鱼，暂停音乐'); assert.equal(h.T.musicEngine.snapshot().state, 'PAUSED');
  assert.equal(h.T.conversation.paused, false); await say(h, '大肥鱼，继续播放'); assert.equal(h.T.musicEngine.snapshot().state, 'PLAYING');
  await say(h, '大肥鱼，播放晴天'); assert.ok(h.S.sends.some(m => /不在授权曲库/.test(m.content)));
  assert.equal(h.S.llmRequests.length, 0); assert.equal(h.S.tts.length, 0);
  assert.match(await control(h, 'music', { action: 'stop', channel: 'B', user: 'operator' }), /授权/);
  assert.equal(h.T.musicEngine.snapshot().state, 'PLAYING');
  await control(h, 'music', { action: 'stop' }); assert.equal(h.T.musicEngine.snapshot().state, 'IDLE'); assert.ok(h.T.session.connection);
});

test('full passive response through real Feiyu adapter pauses music until completion and preserves incoming capture', async t => {
  const h = await setup(t, { env: { DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'fixture-only' }, feiyu: true });
  await play(h); const player = h.audio.players[0]; player.resource.playbackDuration = 600; h.S.playMs = 100;
  const subscriptions = h.S.lastConnection.receiver.subscriptions;
  await say(h, '大肥鱼，你觉得呢？');
  assert.equal(h.T.musicEngine.snapshot().state, 'INTERRUPTED_FOR_SPEECH');
  await h.until(() => h.T.conversation.state === 'PASSIVE_LISTENING');
  assert.equal(h.T.musicEngine.snapshot().state, 'PLAYING'); assert.equal(h.T.musicEngine.snapshot().elapsed, 0.6);
  assert.equal(h.audio.players.length, 1); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].body.voice, 'cute');
  assert.equal(subscriptions.size, 2); assert.equal(h.S.llmRequests.length, 1);
});

for (const action of ['interrupt', 'music-stop', 'stop', 'leave', 'move', 'disconnect', 'drag'])
  test(`${action} during a spoken answer cleans music ownership and rejects stale resumption`, async t => {
    const h = await setup(t, { env: { DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'fixture-only' } });
    await play(h); await control(h, 'music', { action: 'play' }); h.S.playMs = 300;
    await say(h, '大肥鱼，你觉得呢？'); await h.until(() => h.S.played.length === 1);
    assert.equal(h.T.musicEngine.snapshot().state, 'INTERRUPTED_FOR_SPEECH');
    if (action === 'music-stop') await control(h, 'music', { action: 'stop' });
    else if (action === 'move') {
      h.put('c', 'B'); await control(h, 'move', { user: 'operator', target: h.channel('B') });
      h.S.lastConnection.setStatus(h.Status.Ready);
    } else if (action === 'disconnect') h.S.lastConnection.setStatus(h.Status.Disconnected);
    else if (action === 'drag') h.T.client.emit('voiceStateUpdate', { channelId: 'A' }, { id: 'luna', guild: { id: 'g' }, channelId: 'B', channel: h.channel('B') });
    else await control(h, action);
    await h.wait(340);
    assert.equal(h.T.musicEngine.snapshot().state, action === 'interrupt' ? 'PLAYING' : 'IDLE');
    if (action === 'interrupt') { assert.equal(h.decoders.length, 1); assert.equal(h.decoders[0].closed, false); }
    else { assert.equal(h.T.musicEngine.snapshot().queue.length, 0); assert.ok(h.decoders.every(decoder => decoder.closed)); }
    if (action === 'disconnect') {
      h.S.lastConnection.setStatus(h.Status.Ready); await h.wait(15);
      assert.equal(h.T.musicEngine.snapshot().state, 'IDLE'); await play(h);
    }
  });

test('failed DeepSeek generation automatically releases interrupted music without synthesis', async t => {
  const h = await setup(t); await play(h); await say(h, '大肥鱼，你觉得呢？');
  await h.until(() => h.T.conversation.state === 'PASSIVE_LISTENING');
  assert.equal(h.T.musicEngine.snapshot().state, 'PLAYING'); assert.equal(h.decoders.length, 1);
  assert.equal(h.S.llmRequests.length, 0); assert.equal(h.S.tts.length, 0);
});
