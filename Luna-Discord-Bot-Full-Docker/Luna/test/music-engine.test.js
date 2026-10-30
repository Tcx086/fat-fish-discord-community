const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, tick, deferred } = require('./music-fixture');
const { createPlayback } = require('../voice-playback');
const { PassThrough } = require('node:stream');
function setup(t, options) { const f = fixture(options); t.after(() => f.coordinator.reset()); return f; }

test('simultaneous requests reserve FIFO order, bound queue, reject unknown tracks and complete once', async t => {
  const f = setup(t), completed = []; f.engine.events.on('completed', event => completed.push(event.id));
  await Promise.all(['a', 'b', 'c'].map(id => Promise.resolve().then(() => f.engine.play(id, 'u')))); await tick();
  assert.equal(f.engine.snapshot().current.id, 'a'); assert.deepEqual(f.engine.snapshot().queue.map(t => t.id), ['b', 'c']);
  assert.throws(() => f.engine.play('a', 'u'), /满/); assert.throws(() => f.engine.play('../secret', 'u'), /授权曲库/);
  f.decoders[0].end(true); f.players[0].stop(); await tick();
  assert.deepEqual(completed, ['a']); assert.equal(f.engine.snapshot().current.id, 'b');
  f.players[0].emit('idle'); f.players[0].emit('error', new Error()); await tick();
  assert.equal(f.engine.snapshot().current.id, 'b'); assert.equal(f.players.length, 2);
  f.decoders[1].end(true); f.players[1].stop(); await tick();
  f.decoders[2].end(true); f.players[2].stop(); await tick();
  assert.deepEqual(completed, ['a', 'b', 'c']); assert.equal(f.engine.snapshot().state, 'IDLE');
});

test('pause/resume preserves player, decoder and position; volume validates and applies to later tracks', async t => {
  const f = setup(t); f.engine.play('a', 'u'); await tick(); const player = f.players[0];
  player.resource.playbackDuration = 700; f.engine.pause(); assert.equal(f.engine.snapshot().state, 'PAUSED'); assert.equal(f.subscription, null);
  f.engine.setVolume(0); assert.equal(player.resource.volume.value, 0); f.engine.setVolume(85);
  for (const value of [-1, 101, NaN, 3.5, '50']) assert.throws(() => f.engine.setVolume(value));
  f.engine.resume(); assert.equal(f.engine.snapshot().elapsed, 0.7); assert.equal(f.players.length, 1); assert.equal(f.decoders[0].closed, false);
  assert.equal(f.engine.snapshot().state, 'PLAYING'); f.engine.play('b', 'u'); f.engine.skip(); await tick();
  assert.equal(f.players[1].resource.volume.value, 0.85); assert.equal(f.decoders[0].closed, true);
  f.engine.stop(); assert.equal(f.engine.snapshot().current, null); assert.deepEqual(f.engine.snapshot().queue, []); assert.equal(f.subscription, null);
});

test('stop during validation rejects late resources; skip during validation cannot reorder new track', async t => {
  const waiting = deferred(), closed = [];
  const catalog = { resolve: id => ({ id, duration: 2 }), open: (track, signal) => track.id === 'a' ? waiting.promise :
    Promise.resolve({ duration: 2, handle: { close() {} } }) };
  const f = setup(t, { catalog }); f.engine.play('a', 'u'); f.engine.play('b', 'u'); f.engine.skip(); await tick();
  waiting.resolve({ duration: 2, handle: { async close() { closed.push('a'); } } }); await tick();
  assert.deepEqual(closed, ['a']); assert.equal(f.engine.snapshot().current.id, 'b'); assert.equal(f.players.length, 1);
  const waiting2 = deferred(); catalog.open = () => waiting2.promise; f.engine.stop(); f.engine.play('a', 'u'); f.engine.stop();
  waiting2.resolve({ handle: { async close() { closed.push('stopped'); } } }); await tick();
  assert.deepEqual(closed, ['a', 'stopped']); assert.equal(f.engine.snapshot().state, 'IDLE'); assert.equal(f.players.length, 1);
});

test('decoder and missing-file failures are observable and recover to the next track', async t => {
  const f = setup(t), errors = []; f.engine.events.on('trackError', event => errors.push(event));
  f.engine.play('a', 'u'); f.engine.play('b', 'u'); await tick(); f.decoders[0].end(false); await tick();
  assert.equal(f.engine.snapshot().current.id, 'b'); assert.equal(errors.length, 1);
  f.catalog.open = async () => { throw new Error('ENOENT'); }; f.engine.play('c', 'u'); f.engine.skip(); await tick();
  assert.equal(errors.length, 2); assert.equal(f.engine.snapshot().state, 'IDLE'); assert.ok(f.decoders.every(d => d.closed));
});

test('Feiyu playback owns the only subscription and resumes the same music resource after its full answer', async t => {
  const f = setup(t); f.engine.play('a', 'u'); await tick(); f.players[0].resource.playbackDuration = 900;
  const release = f.coordinator.beginSpeech(); assert.equal(f.engine.snapshot().state, 'INTERRUPTED_FOR_SPEECH');
  const playback = createPlayback({ voice: f.voice, fetchTTS: async () => new PassThrough(), console, lookahead: 0, coordinator: f.coordinator });
  const task = playback.play(new PassThrough(), f.connection); assert.equal(f.subscription.player, f.players[1]);
  f.players[1].stop(); await task; assert.equal(f.subscription, null); assert.equal(f.engine.snapshot().state, 'INTERRUPTED_FOR_SPEECH');
  release(); assert.equal(f.subscription.player, f.players[0]); assert.equal(f.engine.snapshot().elapsed, 0.9); assert.equal(f.decoders.length, 1);
});

test('nested speech, user pause, skip, play and explicit stop while interrupted cannot resume unwanted music', async t => {
  const f = setup(t); f.engine.play('a', 'u'); await tick();
  const first = f.coordinator.beginSpeech(), second = f.coordinator.beginSpeech(); first(); assert.equal(f.subscription, null);
  f.engine.pause(); second(); assert.equal(f.engine.snapshot().state, 'PAUSED'); f.engine.resume();
  const third = f.coordinator.beginSpeech(); f.engine.play('b', 'u'); f.engine.skip(); await tick();
  assert.equal(f.engine.snapshot().current.id, 'b'); assert.equal(f.subscription, null);
  f.engine.stop(); third(); assert.equal(f.engine.snapshot().state, 'IDLE'); assert.equal(f.subscription, null);
  const fourth = f.coordinator.beginSpeech(); f.engine.play('c', 'u'); await tick(); assert.equal(f.subscription, null);
  fourth(); assert.equal(f.engine.snapshot().state, 'PLAYING');
});

test('channel move/reset clears queue and invalidates late speech leases and stale connection playback', async t => {
  const f = setup(t); f.engine.play('a', 'u'); f.engine.play('b', 'u'); await tick(); const release = f.coordinator.beginSpeech();
  f.coordinator.bind({ subscribe: () => ({ unsubscribe() {} }) }); release();
  assert.equal(f.engine.snapshot().state, 'IDLE'); assert.deepEqual(f.engine.snapshot().queue, []);
  assert.throws(() => f.coordinator.speechOutput({}, f.connection), /Stale/); assert.ok(f.decoders[0].closed);
  f.coordinator.reset(); assert.throws(() => f.engine.play('a', 'u'), /授权语音/);
});

test('canceled speech releases resources; generation failure releases outer hold without restarting track', async t => {
  const f = setup(t); f.engine.play('a', 'u'); await tick();
  const playback = createPlayback({ voice: f.voice, console, lookahead: 0, coordinator: f.coordinator });
  const release = f.coordinator.beginSpeech(); const task = playback.play(new PassThrough(), f.connection);
  playback.reset(); await task; release(); assert.equal(f.engine.snapshot().state, 'PLAYING');
  const failure = f.coordinator.beginSpeech(); try { throw new Error('generation failed'); } catch {} finally { failure(); }
  assert.equal(f.engine.snapshot().state, 'PLAYING'); assert.equal(f.decoders.length, 1);
});

test('stalled decoding is bounded and ERROR/STOPPING transitions are observable', async t => {
  let watchdog, cleared = 0;
  const f = setup(t, { timers: { setInterval(fn) { watchdog = fn; return 1; }, clearInterval() { cleared++; } } });
  const states = []; f.engine.events.on('state', event => states.push(event.state));
  f.engine.play('a', 'u'); await tick();
  for (let i = 0; i < 15; i++) watchdog();
  assert.equal(f.engine.snapshot().state, 'IDLE'); assert.match(f.engine.snapshot().lastError, /timed out/);
  assert.ok(states.includes('ERROR')); assert.ok(f.decoders[0].closed); assert.ok(cleared > 0);
  f.engine.stop(); assert.ok(states.includes('STOPPING')); assert.equal(f.engine.snapshot().lastError, null);
});
