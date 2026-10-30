const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { loadConfig } = require('../config');
const { loadDeepSeekConfig } = require('../deepseek-config');
const { createDeepSeek } = require('../deepseek');
const { createVoiceAnswerer } = require('../voice-answer');
const { createVoiceSession } = require('../voice-session');
const { createPlayback } = require('../voice-playback');
const boot = require('./harness');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let i = 0; i < 100 && !fn(); i++) await tick(); assert.ok(fn(), 'expected progress'); }
const chunk = (content, finish = null) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`;
const ending = chunk('', 'stop') + 'data: [DONE]\n\n';
const encode = s => new TextEncoder().encode(s);

function setup(options = {}) {
  const calls = [], spoken = [], players = [], logs = [];
  const console = Object.fromEntries(['log', 'warn', 'error'].map(k => [k, (...args) => logs.push(args.join(' '))]));
  let network;
  const llm = createDeepSeek({ config: { ...loadDeepSeekConfig({ DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'private-key' }), retries: 0 }, console,
    fetch: async (_, init) => {
      calls.push(init);
      return { ok: true, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({
        start(c) { network = c; c.enqueue(encode(chunk(options.content || 'First. ')));
          if (!options.open) { c.enqueue(encode(ending)); c.close(); } },
      }) };
    } });
  const voice = {
    VoiceConnectionStatus: { Ready: 'ready', Destroyed: 'destroyed', Disconnected: 'disconnected', Connecting: 'connecting' },
    AudioPlayerStatus: { Idle: 'idle' }, StreamType: { Arbitrary: 'arbitrary' },
    joinVoiceChannel() {
      const conn = new EventEmitter(); conn.state = { status: 'ready' };
      conn.receiver = { subscriptions: new Map() };
      conn.subscribe = () => ({ unsubscribe() {} });
      conn.destroy = () => { conn.state.status = 'destroyed'; };
      return conn;
    },
    createAudioResource: audio => ({ playStream: { readableEnded: !options.earlyIdle, destroy() { audio.destroy(); } } }),
    createAudioPlayer() {
      const p = new EventEmitter(); p.play = () => { players.push(p); if (!options.holdPlayback) queueMicrotask(() => p.emit('idle')); };
      p.stop = () => { p.stopped = true; p.emit('idle'); }; return p;
    },
  };
  const fetchTTS = options.fetchTTS || (async (text, opts) => { spoken.push({ text, ...opts }); return new PassThrough(); });
  const playback = createPlayback({ voice, console, fetchTTS, lookahead: 2 });
  const session = createVoiceSession({ voice, console, config: { VOICE_RECOVER_MS: 1000 }, isIgnored: () => false,
    onConnected() {}, onReset() { playback.reset(); llm.forgetConversations(); } });
  const channel = { id: 'c', guild: { id: 'g' } }, guild = { id: 'g', adapterCreator: {} };
  const connection = session.join(channel, guild); session.attach(connection, channel, null, guild);
  const answerer = createVoiceAnswerer({ config: loadConfig({}), console, llm, playback, session, fetchTTS,
    whisper: { transcribe: options.transcribe || (async () => 'Hey Luna, hello') },
    sendCommand: () => { throw new Error('music must not run'); }, leave: () => session.leave('voice command'),
    expectQuestion() {}, nowPlaying: { get() { throw new Error('music must not run'); } } });
  const answer = query => answerer.answer(query, connection, channel, Date.now(), 'u');
  return { llm, session, connection, channel, answerer, answer, playback, fetchTTS, players, spoken, calls, logs,
    more(s) { network.enqueue(encode(s)); }, close() { network.close(); } };
}

test('existing STT -> answerer -> DeepSeek -> existing queue/player; history only after playback', async () => {
  const f = setup({ holdPlayback: true });
  const result = f.answerer.onUtterance(Buffer.alloc(4), 'u', f.connection, f.channel, true);
  await until(() => f.players.length === 1);
  assert.deepEqual(f.spoken.map(x => x.text), ['First.']);
  assert.equal(JSON.parse(f.calls[0].body).messages.at(-1).content, 'hello');
  assert.equal(f.spoken[0].cache, false);
  f.players[0].emit('idle'); await result;
  const second = f.answer('follow up'); await until(() => f.players.length === 2);
  assert.deepEqual(JSON.parse(f.calls[1].body).messages.map(m => m.role), ['system', 'user', 'assistant', 'user']);
  f.players[1].emit('idle'); assert.equal(await second, true); f.session.leave('test');
});

test('voice TTS starts while stream is still open; reasoning never enters speech', async () => {
  const f = setup({ open: true }), result = f.answer('hi');
  await until(() => f.players.length === 1);
  f.more('data: {"choices":[{"delta":{"reasoning_content":"PRIVATE THOUGHT"}}]}\n\n' + chunk('你好。') + ending); f.close();
  assert.equal(await result, true); assert.deepEqual(f.spoken.map(x => x.text), ['First.', '你好。']);
  assert.ok(!f.logs.join('').includes('PRIVATE')); f.session.leave('test');
});

test('DeepSeek prefetches bounded next-sentence audio while the first sentence is still playing', async () => {
  const sentences = ['First.', 'Second.', 'Third.', 'Fourth.', 'Fifth.', 'Sixth.'];
  const f = setup({ content: sentences.join(' '), holdPlayback: true });
  const result = f.answer('synthetic continuity test');
  try {
    await until(() => f.players.length === 1 && f.spoken.length >= 2);
    assert.ok(f.spoken.length <= 4, 'lookahead must not synthesize the entire answer');
    assert.ok(f.spoken.every(s => s.cache === false));
    for (let i = 0; i < sentences.length; i++) {
      await until(() => f.players.length === i + 1);
      f.players[i].emit('idle');
    }
    assert.equal(await result, true);
    assert.deepEqual(f.spoken.map(s => s.text), sentences);
    assert.equal(f.playback.responses.size, 0);
  } finally { f.session.leave('test'); await result; }
});

test('stop cancels prefetched TTS and destroys every late stream without playback', async () => {
  const renders = [];
  const f = setup({ content: 'First. Second. Third. Fourth. Fifth.', fetchTTS: (text, options) =>
    new Promise(resolve => renders.push({ text, options, resolve })) });
  const result = f.answer('synthetic cancellation test');
  try {
    await until(() => renders.length >= 2);
    assert.ok(renders.length <= 4);
    f.session.leave('stop'); assert.equal(await result, false);
    for (const render of renders) {
      assert.ok(render.options.signal.aborted);
      render.audio = new PassThrough(); render.resolve(render.audio);
    }
    await tick();
    assert.ok(renders.every(r => r.audio.destroyed));
    assert.equal(f.players.length, 0);
    assert.equal(f.playback.responses.size, 0);
  } finally { f.session.leave('test'); await result; }
});

test('prefetched rejection is handled before consumption and cannot commit an unheard answer', async () => {
  let rejected = false;
  const f = setup({ content: 'First. Second. Third.', holdPlayback: true, fetchTTS: async text => {
    if (text === 'Second.') { rejected = true; throw new Error('synthetic TTS failure'); }
    return new PassThrough();
  } });
  const result = f.answer('synthetic prefetch failure');
  try {
    await until(() => f.players.length === 1 && rejected);
    await tick();
    f.players[0].emit('idle');
    assert.equal(await result, false);
    assert.equal(f.players.length, 1);
    assert.equal(f.playback.responses.size, 0);
  } finally { f.session.leave('test'); await result; }
});

test('Phase 0 session stop aborts network and playback, rejects late output, clears history', async () => {
  const f = setup({ open: true, holdPlayback: true }), result = f.answer('hi');
  await until(() => f.players.length === 1);
  f.session.leave('stop'); assert.equal(await result, false);
  assert.ok(f.calls[0].signal.aborted); assert.ok(f.players[0].stopped); assert.equal(f.session.active, false);
  assert.equal(f.playback.busy, false); assert.equal(f.spoken.length, 1);
  assert.equal(await f.answer('stale'), false); assert.equal(f.calls.length, 1);
});

test('stop during STT never starts a paid request after transcription resolves', async () => {
  let finish;
  const f = setup({ transcribe: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.answerer.onUtterance(Buffer.alloc(4), 'u', f.connection, f.channel, true);
  f.session.leave('stop'); finish('Hey Luna, late result'); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.spoken.length, 0);
});

test('stop during TTS releases the queue and destroys audio that arrives late', async () => {
  let resolveAudio;
  const f = setup({ fetchTTS: () => new Promise(resolve => { resolveAudio = resolve; }) });
  const pending = f.answer('hi'); await until(() => !!resolveAudio); f.session.leave('stop');
  assert.equal(await pending, false);
  const audio = new PassThrough(); resolveAudio(audio); await tick();
  assert.ok(audio.destroyed); assert.equal(f.players.length, 0);
});

test('barge-in cancels stalled TTS without blocking the next answer or committing the old one', async () => {
  let renders = 0, late;
  const f = setup({ fetchTTS: async () => {
    if (++renders === 1) return new Promise(resolve => { late = resolve; });
    return new PassThrough();
  } });
  const old = f.answer('old'); await until(() => !!late);
  assert.equal(await f.answer('new'), true); assert.equal(await old, false);
  assert.equal(JSON.parse(f.calls[1].body).messages.length, 2);
  const audio = new PassThrough(); late(audio); await tick(); assert.ok(audio.destroyed);
  f.session.leave('test');
});

test('existing spoken leave command stops locally without calling DeepSeek', async () => {
  const f = setup(); assert.equal(await f.answer('leave the voice channel'), true);
  assert.equal(f.session.active, false); assert.equal(f.calls.length, 0);
});

test('incomplete TTS playback is not committed as heard (premature Idle regression)', async () => {
  const f = setup({ earlyIdle: true }); assert.equal(await f.answer('first'), false);
  assert.equal(await f.answer('second'), false);
  assert.equal(JSON.parse(f.calls[1].body).messages.length, 2);
  assert.ok(f.logs.some(x => x.includes('before the source stream ended'))); f.session.leave('test');
});

test('TTS failure and partial LLM stream do not commit unheard answers', async () => {
  const f = setup({ fetchTTS: async () => null });
  assert.equal(await f.answer('first'), false); assert.equal(await f.answer('second'), false);
  assert.equal(JSON.parse(f.calls[1].body).messages.length, 2); f.session.leave('test');
  const partial = setup({ open: true }); const result = partial.answer('hi');
  await until(() => partial.players.length === 1); partial.close();
  assert.equal(await result, false); partial.session.leave('test');
});

test('default DeepSeek application boots without model discovery, MCP or text-chat calls', async () => {
  const h = boot({ LLM_PROVIDER: 'deepseek', LLM_TOOLS: 'true', TEXT_CHAT_CHANNELS: 'general' });
  await h.start(); assert.equal(h.T.ready, true); assert.equal(h.T.model, 'deepseek-flash');
  assert.equal(h.S.llmRequests.length, 0); assert.equal(h.S.mcpPort, undefined);
  h.T.client.emit('messageCreate', { content: 'hi', author: { id: 'u', bot: false }, channel: { id: 'c', name: 'general' } });
  await tick(); assert.equal(h.S.llmRequests.length, 0); h.T.session.leave('test');
});

for (const stage of ['generation', 'tts', 'playback']) test(`shared owner external cancellation during ${stage} rejects stale delivery`, async () => {
  let rendering;
  const f = setup({ open: stage === 'generation', holdPlayback: stage === 'playback',
    ...(stage === 'tts' ? { fetchTTS: () => new Promise(resolve => { rendering = resolve; }) } : {}) });
  const controller = new AbortController();
  const result = require('../deepseek-response').answerDeepSeek({ ...f, console: { warn() {} },
    query: 'Speaker u: hello', userId: 'shared', scopeId: 'channel:context', signal: controller.signal });
  await until(() => stage === 'tts' ? !!rendering : f.players.length === 1);
  controller.abort(); assert.equal(await result, false); assert.ok(f.calls[0].signal.aborted);
  if (rendering) { const audio = new PassThrough(); rendering(audio); await tick(); assert.ok(audio.destroyed); }
  f.session.leave('test');
});
