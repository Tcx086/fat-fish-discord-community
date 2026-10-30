const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createVoiceValidation, createValidationLogger } = require('../voice-e2e-diagnostic');
const { loadDeepSeekConfig } = require('../deepseek-config');
const until = async fn => { const end = Date.now() + 3500; while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); assert.ok(fn()); };
const chunk = content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const ending = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":60,"completion_tokens":7,"total_tokens":67}}\n\ndata: [DONE]\n\n';

function setup(mode = '') {
  const events = [], calls = [], players = [], connections = [];
  const console = Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => {
    if (args[0] === '[phase15]') events.push(JSON.parse(args[1]));
  }]));
  const voice = {
    VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected', Destroyed: 'destroyed' },
    AudioPlayerStatus: { Idle: 'idle', Playing: 'playing' }, StreamType: { Arbitrary: 'arbitrary' },
    EndBehaviorType: { AfterSilence: 1 },
    joinVoiceChannel() {
      const c = new EventEmitter(); c.state = { status: 'ready' };
      c.receiver = { speaking: new EventEmitter(), subscriptions: new Map(), subscribe(id) {
        const s = new PassThrough(); this.subscriptions.set(id, s); s.once('close', () => this.subscriptions.delete(id)); return s;
      } };
      c.subscribe = () => ({ unsubscribe() {} }); c.destroy = () => { c.state.status = 'destroyed'; };
      connections.push(c); return c;
    },
    createAudioResource: stream => ({ playStream: stream }),
    createAudioPlayer() {
      const p = new EventEmitter(); p.stop = () => { p.stopped = true; p.emit('idle'); };
      p.play = resource => {
        players.push(p); p.emit('playing');
        resource.playStream.once('end', () => { if (mode !== 'playback') p.emit('idle'); }); resource.playStream.resume();
      }; return p;
    },
  };
  class Members extends Map { filter(fn) { return new Members([...this].filter(([, v]) => fn(v))); } }
  const channel = { id: '100000000000000103', guild: { id: '100000000000000104', voiceAdapterCreator: {} },
    isVoiceBased: () => true, members: new Members([['human', { id: 'human', user: { bot: false } }], ['other', { id: 'other', user: { bot: false } }]]) };
  const validation = createVoiceValidation({ voice, console, OpusEncoder: class { decode(packet) { return packet; } },
    WakeWordEngine: {}, botId: () => 'bot', tokenConfig: loadDeepSeekConfig({ DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'fake' }),
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/inference')) {
        if (mode === 'stt') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
        return Response.json({ text: 'Hey Luna, what is two plus two?' });
      }
      if (url.includes('/chat/completions')) {
        const bytes = new TextEncoder().encode(chunk('Two plus two ') + chunk('is four.') + (mode === 'generation' ? '' : ending));
        return new Response(new ReadableStream({ start(c) { c.enqueue(bytes); if (mode !== 'generation') c.close(); } }),
          { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.includes('/audio/speech')) {
        if (mode === 'tts') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
        let timer;
        return new Response(new ReadableStream({ start(c) {
          c.enqueue(new Uint8Array(44));
          timer = setTimeout(() => { c.enqueue(Uint8Array.of(1, 2, 3, 4)); c.close(); }, 10);
        }, cancel() { clearTimeout(timer); } }));
      }
      throw new Error('Unexpected endpoint');
    },
  });
  function speak() { const pcm = Buffer.alloc(1920); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(2000, i);
    for (let i = 0; i < 25; i++) connections[0].receiver.subscriptions.get('human').write(pcm); }
  return { validation, channel, events, calls, players, connections, speak };
}

test('production capture -> STT -> streaming adapter -> TTS -> playback, one request and measured event order', async t => {
  const f = setup(); t.after(() => f.validation.close()); await f.validation.init();
  f.validation.join(f.channel, 'human'); assert.equal(f.connections[0].receiver.subscriptions.size, 1);
  f.validation.arm(); f.speak(); await until(() => f.events.some(e => e.event === 'turnFinished'));
  assert.equal(f.validation.requests, 1);
  assert.equal(f.calls.filter(c => c.url.includes('/chat/completions')).length, 1);
  assert.equal(f.calls.filter(c => c.url.includes('/audio/speech')).length, 1);
  const trace = f.events.find(e => e.event === 'turnFinished').trace;
  for (const key of ['speechEndedAt', 'flushedAt', 'sttStart', 'sttComplete', 'llmRequest', 'llmFirstContent', 'ttsRequest', 'ttsFirstAudio', 'playerPlaying', 'lastPlaybackEnd'])
    assert.equal(typeof trace[key], 'number', key);
  assert.ok(trace.flushedAt >= trace.speechEndedAt + 900);
  assert.ok(trace.sttComplete <= trace.llmFirstContent && trace.llmFirstContent <= trace.ttsRequest);
  assert.ok(f.events.some(e => e.event === 'playbackFinished' && e.ok));
  assert.equal(f.events.filter(e => e.event === 'llmFirstContent').length, 1);
  assert.throws(() => f.validation.arm());
  f.validation.stop(); assert.equal(f.validation.session.active, false);
  assert.throws(() => f.validation.join(f.channel, 'human')); assert.equal(f.connections.length, 1);
});

for (const mode of ['stt', 'generation', 'tts', 'playback']) test(`stop during ${mode} aborts work, destroys subscriptions and cannot restart`, async t => {
  const f = setup(mode); t.after(() => f.validation.close());
  f.validation.join(f.channel, 'human'); f.validation.arm(); f.speak();
  const event = { stt: 'sttStart', generation: 'llmFirstContent', tts: 'ttsRequest', playback: 'playerPlaying' }[mode];
  await until(() => f.events.some(e => e.event === event)); f.validation.stop();
  await until(() => f.events.some(e => e.event === 'turnFinished'));
  const request = f.calls.find(c => c.url.includes(mode === 'stt' ? '/inference' : '/chat/completions'));
  assert.ok(request.init.signal.aborted); assert.equal(f.validation.session.active, false);
  assert.equal(f.connections[0].receiver.subscriptions.size, 0);
  assert.equal(f.validation.requests, mode === 'stt' ? 0 : 1); assert.throws(() => f.validation.arm());
  if (mode === 'playback') assert.ok(f.players[0].stopped);
});

test('wrong channel, absent consenting participant and unarmed speech cannot request API', async t => {
  const f = setup(); t.after(() => f.validation.close());
  assert.throws(() => f.validation.join({ ...f.channel, id: 'wrong' }, 'human'));
  assert.throws(() => f.validation.join(f.channel, 'absent'));
  assert.equal(f.connections.length, 0);
  f.validation.join(f.channel, 'human'); f.speak(); await new Promise(r => setTimeout(r, 1150));
  assert.equal(f.calls.length, 0); f.validation.stop(); assert.equal(f.validation.session.active, false);
});

test('entry point is disabled without separate live authorizations', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../voice-e2e-diagnostic.js')],
    { env: { ...process.env, NODE_ENV: 'test', PHASE15_ENABLED: 'false' }, encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /disabled/);
});

test('diagnostic text logging removes both credentials and suppresses raw error objects', () => {
  const disk = [], screen = [];
  const output = Object.fromEntries(['log', 'warn', 'error'].map(level => [level, line => screen.push(line)]));
  const log = createValidationLogger({ write: line => disk.push(line), output, secrets: ['discord-secret', 'deepseek-secret'] });
  log.log('discord-secret deepseek-secret discord-secret'); log.error(new Error('private payload'));
  assert.ok(!disk.join('').includes('secret')); assert.ok(!screen.join('').includes('private payload'));
  assert.match(disk.join(''), /REDACTED/);
});
