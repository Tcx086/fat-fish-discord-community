// Synthetic virtual time only: actual TTS/response/prefetch code with fake HTTP, worker and player.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { resolve } = require('node:path');
const { loadConfig } = require('../../config');
const { createLimiter } = require('../../tts');
const { createPlayback } = require('../../voice-playback');
const { answerDeepSeek } = require('../../deepseek-response');
const sentences = ['可以先检查语音输入。', '然后测量语音合成。', '最后比较各个阶段的时间。'];

async function replay(createTTS, { ordered = false, cancelAt } = {}) {
  let now = 0, sequence = 0, busy = false, done = false, delivered, commits = 0;
  const timers = [], pending = [], events = [], streams = [];
  const record = (event, index) => {
    assert.ok(events.length < 128, 'fixture event limit');
    events.push({ event, index, at_ms: now });
  };
  const schedule = (at, fn) => timers.push({ at, fn, sequence: sequence++ });
  const console = { log() {}, warn() {}, error() {} };
  function drain() {
    if (busy || !pending.length) return;
    busy = true;
    const job = pending.shift(); record('worker_start', job.index);
    schedule(now + [1400, 2000, 1300][job.index], () => {
      record('worker_complete', job.index);
      // Ignore upstream cancellation to exercise stale-audio rejection after worker drainage.
      job.resolve(new Response('synthetic-audio')); busy = false; drain();
    });
  }
  const slots = ordered ? createLimiter(1, 'Fixture FIFO') : null;
  const tts = createTTS({ config: loadConfig({ TTS_PROVIDER: 'feiyu', TTS_FALLBACK: 'none', FEIYU_TTS_URL: 'http://fixture.invalid/speech' }), console,
    fetch: async (_, init) => {
      const body = JSON.parse(init.body), index = sentences.indexOf(body.input);
      assert.notEqual(index, -1);
      assert.deepEqual(body, { input: sentences[index], voice: 'cute', stream: false });
      const release = slots ? await slots.acquire(init.signal, 100000) : null;
      try {
        record('dispatch', index);
        return await new Promise(resolve => schedule(now + (index === 1 ? 10 : 0), () => {
          record('worker_admitted', index); pending.push({ index, resolve }); drain();
        }));
      } finally { release?.(); }
    } });
  const fetchTTS = async (text, options) => {
    const audio = await tts.fetchTTS(text, options);
    if (audio) { audio.fixtureIndex = sentences.indexOf(text); streams.push(audio); record('audio_ready', audio.fixtureIndex); }
    return audio;
  };
  const voice = {
    StreamType: { Arbitrary: 'arbitrary' }, AudioPlayerStatus: { Idle: 'idle' },
    createAudioResource(audio) {
      record('resource_start', audio.fixtureIndex);
      return { index: audio.fixtureIndex, playStream: { readableEnded: false, destroy() { audio.destroy(); } } };
    },
    createAudioPlayer() {
      const player = new EventEmitter();
      player.play = resource => {
        schedule(now + 40, () => { if (!player.stopped) record('playing', resource.index); });
        schedule(now + 2040, () => { if (!player.stopped) {
          resource.playStream.readableEnded = true; record('idle', resource.index); player.emit('idle');
        } });
      };
      player.stop = () => { player.stopped = true; }; return player;
    },
  };
  const playback = createPlayback({ voice, fetchTTS, console, lookahead: 2 });
  const connection = { joinConfig: { guildId: 'fixture' }, subscribe: () => ({ unsubscribe() {} }) };
  const session = { generation: 1, connection };
  const llm = { createTurn({ signal }) { return { signal, async *stream() { yield* sentences; },
    acknowledge: () => true, commit: () => { commits++; return true; }, dispose() {} }; } };
  try {
    const task = answerDeepSeek({ llm, playback, session, fetchTTS, console,
      query: 'public fixture', connection, userId: 'fixture' }).then(value => { delivered = value; done = true; });
    if (cancelAt !== undefined) schedule(cancelAt, () => playback.interrupt('fixture'));
    for (let step = 0; step < 100 && (!done || timers.length); step++) {
      await new Promise(resolve => setImmediate(resolve));
      timers.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
      const timer = timers.shift(); if (timer) { now = timer.at; timer.fn(); }
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(done, 'fixture must settle'); await task;
    const order = event => events.filter(e => e.event === event).map(e => e.index);
    const at = (event, index) => events.find(e => e.event === event && e.index === index)?.at_ms;
    assert.ok(streams.every(stream => stream.destroyed), 'including late audio that was never played');
    assert.equal(commits, cancelAt === undefined ? 1 : 0);
    return { classification: 'SYNTHETIC', delivered, admission: order('worker_admitted'), playing: order('playing'),
      gap_ms: at('playing', 1) - at('idle', 0), events };
  } finally { playback.reset(); }
}

if (require.main === module) replay((process.argv[2] ? require(resolve(process.argv[2])) : require('../../tts')).createTTS)
  .then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n'))
  .catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { replay };
