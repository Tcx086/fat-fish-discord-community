const test = require('node:test');
const assert = require('node:assert/strict');
const { createTTS } = require('../tts');
const { loadConfig } = require('../config');
const { replay } = require('./helpers/feiyu-replay');
const tick = () => new Promise(resolve => setImmediate(resolve));
const console = { log() {}, warn() {}, error() {} };
const config = loadConfig({ TTS_PROVIDER: 'feiyu', TTS_FALLBACK: 'none', FEIYU_TTS_URL: 'http://fixture' });
async function consume(stream) { if (stream) for await (const _ of stream) {} }

test('Feiyu holds later dispatches until previous buffered synthesis headers, preserving FIFO', async () => {
  const dispatched = [];
  let releaseFirst;
  const tts = createTTS({ config, console, fetch: async (_, init) => {
    const input = JSON.parse(init.body).input; dispatched.push(input);
    if (input === 'first') await new Promise(resolve => { releaseFirst = resolve; });
    return new Response('audio');
  } });
  const tasks = ['first', 'second', 'third'].map(text => tts.fetchTTS(text).then(consume));
  try {
    await tick();
    assert.deepEqual(dispatched, ['first']);
    releaseFirst(); await Promise.all(tasks);
    assert.deepEqual(dispatched, ['first', 'second', 'third']);
  } finally { releaseFirst?.(); await Promise.allSettled(tasks); }
});

test('queued cancelled Feiyu audio never dispatches; later valid work still progresses', async () => {
  const dispatched = [], cancel = new AbortController();
  let releaseFirst;
  const tts = createTTS({ config, console, fetch: async (_, init) => {
    const input = JSON.parse(init.body).input; dispatched.push(input);
    if (input === 'first') await new Promise(resolve => { releaseFirst = resolve; });
    return new Response('audio');
  } });
  const first = tts.fetchTTS('first').then(consume);
  const cancelled = tts.fetchTTS('cancelled', { signal: cancel.signal });
  const last = tts.fetchTTS('last').then(consume);
  try {
    await tick(); cancel.abort();
    assert.equal(await cancelled, null);
    releaseFirst(); await Promise.all([first, last]);
    assert.deepEqual(dispatched, ['first', 'last']);
  } finally { releaseFirst?.(); await Promise.allSettled([first, last, cancelled]); }
});

test('active Feiyu transport cancellation and failures release the lane without fallback', async () => {
  for (const outcome of ['cancel', 'failure']) {
    const cancel = new AbortController(), dispatched = [];
    const tts = createTTS({ config, console, fetch: async (_, init) => {
      const input = JSON.parse(init.body).input; dispatched.push(input);
      if (input === 'first') {
        if (outcome === 'failure') return new Response('busy', { status: 503 });
        await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      }
      return new Response('audio');
    } });
    const first = tts.fetchTTS('first', { signal: cancel.signal });
    const second = tts.fetchTTS('second').then(consume);
    await tick(); cancel.abort();
    assert.equal(await first, null); await second;
    assert.deepEqual(dispatched, ['first', 'second']);
  }
});

test('Feiyu FIFO matches ordered admission without losing prefetch/playback overlap', async () => {
  for (const ordered of [false, true]) {
    const result = await replay(createTTS, { ordered });
    assert.equal(result.delivered, true);
    assert.deepEqual(result.admission, [0, 1, 2]);
    assert.deepEqual(result.playing, [0, 1, 2]);
    assert.equal(result.gap_ms, 40);
    const at = (event, index) => result.events.find(e => e.event === event && e.index === index).at_ms;
    assert.ok(at('worker_complete', 1) > at('playing', 0));
    assert.ok(at('worker_complete', 1) < at('idle', 0));
  }
});

test('cancellation rejects drained late audio and never dispatches the queued third sentence', async () => {
  const result = await replay(createTTS, { cancelAt: 1600 });
  assert.equal(result.delivered, false);
  assert.deepEqual(result.admission, [0, 1]);
  assert.deepEqual(result.playing, [0]);
  assert.ok(result.events.find(e => e.event === 'worker_complete' && e.index === 1).at_ms > 1600);
});
