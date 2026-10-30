const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createVoiceSession } = require('../voice-session');
const { createPlayback } = require('../voice-playback');
const { createListener } = require('../voice-listen');
const { createVoiceDiagnostic, testTone } = require('../voice-diagnostic');

const Status = { Ready: 'ready', Connecting: 'connecting', Signalling: 'signalling', Disconnected: 'disconnected', Destroyed: 'destroyed' };
const flush = () => new Promise(resolve => setImmediate(resolve));
class Members extends Map {
  filter(fn) { return new Members([...this].filter(([, v]) => fn(v))); }
}
function clock() {
  let now = 0, next = 0;
  const pending = new Map();
  const timers = {
    pending,
    setTimeout(fn, ms) { const id = ++next; pending.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    setInterval(fn, ms) { const id = timers.setTimeout(fn, ms); pending.get(id).repeat = ms; return id; },
    clearInterval(id) { pending.delete(id); },
    tick(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.repeat) t.at += t.repeat; else pending.delete(id);
        t.fn();
      }
      now = until;
    },
  };
  return timers;
}

function fixture() {
  const timers = clock(), connections = [], players = [], logs = [], joins = [];
  const console = Object.fromEntries(['log', 'warn', 'error'].map(k => [k, (...args) => logs.push(args.join(' '))]));
  const guild = { id: 'g', voiceAdapterCreator() {} };
  const channel = { id: 'c', guild, isVoiceBased: () => true, members: new Members([
    ['a', { id: 'a', user: { bot: false } }], ['b', { id: 'b', user: { bot: false } }],
    ['bot', { id: 'bot', user: { bot: true } }],
  ]) };
  class Connection extends EventEmitter {
    constructor() {
      super();
      this.state = { status: Status.Signalling };
      this.receiver = {
        speaking: new EventEmitter(), subscriptions: new Map(),
        subscribe: id => {
          if (this.receiver.subscriptions.has(id)) return this.receiver.subscriptions.get(id);
          const stream = new PassThrough();
          this.receiver.subscriptions.set(id, stream);
          stream.once('close', () => this.receiver.subscriptions.delete(id));
          return stream;
        },
      };
    }
    setStatus(status) {
      const old = this.state;
      this.state = { ...old, status };
      this.emit(status, old, this.state);
      this.emit('stateChange', old, this.state);
    }
    destroy() { this.destroyed = true; this.setStatus(Status.Destroyed); }
    subscribe(player) { this.player = player; return { unsubscribe: () => { this.player = null; } }; }
  }
  const voice = {
    VoiceConnectionStatus: Status, EndBehaviorType: { Manual: 0, AfterSilence: 2 },
    AudioPlayerStatus: { Idle: 'idle' }, StreamType: { Arbitrary: 'arbitrary', Raw: 'raw' },
    joinVoiceChannel: options => { joins.push(options); const c = new Connection(); connections.push(c); return c; },
    createAudioPlayer: () => {
      const p = new EventEmitter();
      p.play = resource => { p.resource = resource; };
      p.stop = () => { p.stopped = true; p.emit('idle'); };
      players.push(p); return p;
    },
    createAudioResource: (stream, options) => ({ playStream: stream, options, volume: { setVolume() {} } }),
  };
  class OpusEncoder {
    decode(packet) { if (packet[0] === 255) throw new Error('private payload'); return Buffer.alloc(1920); }
  }
  return { timers, voice, connections, joins, players, logs, console, channel, guild, OpusEncoder };
}
function setupSession() {
  const f = fixture();
  let connected = 0, resets = 0;
  const session = createVoiceSession({ ...f, config: { VOICE_RECOVER_MS: 1000 }, isIgnored: () => false,
    onConnected: () => connected++, onReset: () => resets++ });
  const join = () => {
    const conn = session.join(f.channel, { id: f.guild.id, adapterCreator: f.guild.voiceAdapterCreator });
    session.attach(conn, f.channel, null, f.guild);
    return conn;
  };
  return { ...f, session, join, get connected() { return connected; }, get resets() { return resets; } };
}
function setupDiagnostic() {
  const f = fixture();
  const diagnostic = createVoiceDiagnostic({ ...f, guildId: 'g', channelId: 'c', botId: () => 'bot', log: f.console.log });
  const ready = () => { diagnostic.join(f.channel); const c = f.connections.at(-1); c.setStatus(Status.Ready); return c; };
  return { ...f, diagnostic, ready };
}

test('join enables receive explicitly; listening starts once at Ready', () => {
  const f = setupSession(), c = f.join();
  assert.equal(f.joins[0].selfDeaf, false);
  assert.equal(f.joins[0].selfMute, false);
  assert.equal(f.joins[0].adapterCreator, f.guild.voiceAdapterCreator);
  assert.equal(f.session.connection, null);
  assert.equal(f.connected, 0);
  c.setStatus(Status.Ready); c.setStatus(Status.Ready);
  assert.equal(f.connected, 1);
  assert.equal(f.timers.pending.size, 0);
  f.session.leave('test');
});

test('stop cancels pending join, ignores late Ready, and tolerates late errors', () => {
  const f = setupSession(), c = f.join();
  const staleReady = c.listeners(Status.Ready)[0];
  f.session.leave('stop');
  staleReady(); c.setStatus(Status.Ready); c.emit('error', new Error('late'));
  assert.equal(f.connected, 0);
  assert.equal(f.session.active, false);
  assert.equal(c.destroyed, true);
  assert.equal(f.timers.pending.size, 0);
});

test('stop cancels delayed reconnect, including an already queued stale timer callback', () => {
  const f = setupSession(), c = f.join(); c.setStatus(Status.Ready);
  f.session.reconnect();
  const staleTimer = [...f.timers.pending.values()][0].fn;
  f.session.leave('stop'); staleTimer(); f.timers.tick(600000);
  assert.equal(f.connections.length, 1);
  assert.equal(f.timers.pending.size, 0);
});

test('stop also cancels a reconnect that has already created a pending connection', () => {
  const f = setupSession(); f.join().setStatus(Status.Ready);
  f.session.reconnect(); f.timers.tick(1500);
  assert.equal(f.connections.length, 2);
  f.session.leave('stop'); f.connections[1].setStatus(Status.Ready);
  assert.equal(f.connected, 1);
  assert.equal(f.timers.pending.size, 0);
});

test('new join supersedes old pending Ready and delayed recovery', () => {
  const f = setupSession(), first = f.join(), second = f.join();
  first.setStatus(Status.Ready); second.setStatus(Status.Ready);
  assert.equal(f.session.connection, second);
  assert.equal(f.connected, 1);
  f.session.reconnect(); const third = f.join(); third.setStatus(Status.Ready);
  f.timers.tick(2000);
  assert.equal(f.connections.length, 3);
  f.session.leave('test');
});

test('transient disconnect recovers once; failed disconnect and readiness are bounded', () => {
  const f = setupSession(), c = f.join(); c.setStatus(Status.Ready);
  c.setStatus(Status.Disconnected); f.timers.tick(1000);
  c.setStatus(Status.Connecting); f.timers.tick(1000); c.setStatus(Status.Ready);
  f.timers.tick(30000);
  assert.equal(f.connected, 1);
  assert.equal(f.session.connection, c);
  c.setStatus(Status.Disconnected); f.timers.tick(5000);
  assert.equal(c.destroyed, true);
  assert.equal(f.session.active, false);
  const pending = f.join(); f.timers.tick(30000);
  assert.equal(pending.destroyed, true);
  const recovering = f.join(); recovering.setStatus(Status.Ready);
  recovering.setStatus(Status.Disconnected); recovering.setStatus(Status.Connecting);
  f.timers.tick(30000);
  assert.equal(recovering.destroyed, true);
  assert.equal(f.timers.pending.size, 0);
});

test('connection error destroys the session and cancels silent-speaker timers', () => {
  const f = setupSession(), c = f.join(); c.setStatus(Status.Ready);
  f.session.noteSpeaking('a'); f.session.noteSpeaking('b');
  f.session.noteAudio('a'); assert.equal(f.timers.pending.size, 1);
  c.emit('error', new Error('private error payload'));
  assert.equal(f.timers.pending.size, 0);
  assert.equal(f.session.active, false);
  assert.ok(!f.logs.join('\n').includes('private error payload'));
});

test('reconnect does not join a now-empty channel; join errors are contained', () => {
  const f = setupSession(); f.join().setStatus(Status.Ready);
  f.session.reconnect(); f.channel.members.clear(); f.timers.tick(1500);
  assert.equal(f.connections.length, 1);
  assert.equal(f.session.active, false);
  const d = setupDiagnostic(); d.voice.joinVoiceChannel = () => { throw new Error('join failed'); };
  // The dependency is captured at construction; test failure through a fresh diagnostic.
  const diagnostic = createVoiceDiagnostic({ ...d, guildId: 'g', channelId: 'c', botId: () => 'bot', log: d.console.log });
  diagnostic.join(d.channel);
  assert.equal(d.timers.pending.size, 0);
  assert.match(d.logs.join('\n'), /join failed/);
});

test('diagnostic isolates multiple speakers, rejects bots, counts decoding failures, and retains no PCM', async () => {
  const f = setupDiagnostic(), c = f.ready();
  assert.deepEqual([...c.receiver.subscriptions.keys()], ['a', 'b']);
  c.receiver.speaking.emit('start', 'bot'); c.receiver.speaking.emit('start', 'unknown');
  c.receiver.subscriptions.get('a').write(Buffer.from([1]));
  c.receiver.subscriptions.get('a').write(Buffer.from([255]));
  c.receiver.subscriptions.get('a').write(Buffer.from([2]));
  c.receiver.subscriptions.get('b').write(Buffer.from([3]));
  f.diagnostic.status();
  assert.match(f.logs.join('\n'), /user=a .*"packets":3,"decoded":2,"decodeErrors":1/);
  assert.match(f.logs.join('\n'), /user=b .*"packets":1,"decoded":1,"decodeErrors":0/);
  assert.ok(!f.logs.join('\n').includes('private payload'));
  const old = c.receiver.subscriptions.get('a'); old.destroy(new Error('transport payload'));
  await flush(); f.timers.tick(5000);
  assert.notEqual(c.receiver.subscriptions.get('a'), old);
  assert.equal(c.receiver.speaking.listenerCount('start'), 1);
  f.diagnostic.stop(); await flush();
  assert.equal(c.receiver.subscriptions.size, 0);
  assert.equal(c.receiver.speaking.listenerCount('start'), 0);
  assert.equal(f.timers.pending.size, 0);
});

test('membership changes remove subscriptions, capture new humans, and stop on empty channel', async () => {
  const f = setupDiagnostic(), c = f.ready(), old = c.receiver.subscriptions.get('a');
  const event = id => f.diagnostic.onVoiceState({ channelId: 'c' }, { id, guild: f.guild, channelId: null });
  f.channel.members.delete('a'); event('a');
  assert.equal(old.destroyed, true);
  f.channel.members.set('new', { id: 'new', user: { bot: false } }); event('new');
  assert.ok(c.receiver.subscriptions.has('new'));
  f.channel.members.delete('b'); f.channel.members.delete('new'); event('new');
  await flush();
  assert.equal(c.destroyed, true);
  assert.equal(f.timers.pending.size, 0);
});

test('diagnostic refuses unauthorized targets and empty joins; move outside target stops it', () => {
  const f = setupDiagnostic();
  assert.throws(() => f.diagnostic.join({ ...f.channel, id: 'other' }), /authorized/);
  const c = f.ready();
  f.diagnostic.onVoiceState({ channelId: 'c' }, { id: 'bot', guild: f.guild, channelId: 'other' });
  assert.equal(c.destroyed, true);
  f.channel.members.clear(); f.diagnostic.join(f.channel);
  assert.equal(f.connections.length, 1);
});

test('empty channel during pending join or recovery cannot become active later', () => {
  const f = setupDiagnostic(); f.diagnostic.join(f.channel);
  f.channel.members.clear(); f.connections[0].setStatus(Status.Ready);
  assert.equal(f.connections[0].destroyed, true);
  assert.equal(f.timers.pending.size, 0);
  const g = setupDiagnostic(); g.ready(); g.diagnostic.recover();
  g.channel.members.clear();
  g.diagnostic.onVoiceState({ channelId: 'c' }, { id: 'a', guild: g.guild, channelId: null });
  g.timers.tick(10000);
  assert.equal(g.connections.length, 1);
  assert.equal(g.timers.pending.size, 0);
});

test('20 join/leave cycles leave no subscriptions, listeners, playback, or timers', async () => {
  const f = setupDiagnostic();
  for (let i = 0; i < 20; i++) {
    const c = f.ready();
    c.receiver.speaking.emit('start', 'a');
    const playing = f.diagnostic.play();
    f.diagnostic.stop(); await playing; await flush();
    c.receiver.speaking.emit('start', 'a'); c.setStatus(Status.Ready);
    assert.equal(c.receiver.subscriptions.size, 0);
    assert.equal(c.receiver.speaking.listenerCount('start'), 0);
    assert.equal(c.listenerCount(Status.Ready), 0);
    assert.equal(c.listenerCount('stateChange'), 0);
    assert.equal(f.timers.pending.size, 0);
    assert.equal(f.players.at(-1).stopped, true);
  }
});

test('DAVE diagnostics report native stats separately from decode and redact debug payloads', () => {
  const f = setupDiagnostic(), c = f.ready();
  c.state.networking = { state: { dave: { protocolVersion: 1, session: {
    status: 3, epoch: 9, getUserIds: () => ['a', 'b'],
    getDecryptionStats: () => ({ successes: 4, failures: 2 }),
  } } } };
  c.emit('debug', '[DAVE] Failed to decrypt a packet PRIVATE_KEY');
  c.emit('debug', '[DAVE] MLS welcome errored PRIVATE_KEY');
  f.diagnostic.status();
  assert.match(f.logs.join('\n'), /DAVE protocol=1 state=active epoch=9/);
  assert.match(f.logs.join('\n'), /4 decrypted\/2 failed/);
  assert.match(f.logs.join('\n'), /DAVE error reported/);
  assert.ok(!f.logs.join('\n').includes('PRIVATE_KEY'));
  f.diagnostic.stop();
});

test('playback reset cancels active tone and chime, closes streams, and clears deadlines', async () => {
  const f = fixture(), p = createPlayback(f), c = f.voice.joinVoiceChannel({});
  const tone = new PassThrough(), chime = new PassThrough();
  const a = p.play(tone, c), b = p.playSound(chime, c);
  p.reset();
  assert.deepEqual(await Promise.all([a, b]), [false, false]);
  assert.ok(f.players.every(player => player.stopped));
  assert.equal(tone.destroyed, true); assert.equal(chime.destroyed, true);
  assert.equal(f.timers.pending.size, 0);
  assert.equal(p.busy, false);
});

test('playback handles synchronous errors and idle, timeout, and failed subscription with cleanup', async () => {
  for (const outcome of ['error', 'idle', 'timeout', 'subscription']) {
    const f = fixture(), p = createPlayback(f), c = f.voice.joinVoiceChannel({}), stream = new PassThrough();
    if (outcome === 'subscription') c.subscribe = () => undefined;
    const result = p.play(stream, c);
    if (outcome === 'error') f.players[0].emit('error', new Error('private'));
    if (outcome === 'idle') f.players[0].emit('idle');
    if (outcome === 'timeout') f.timers.tick(30000);
    assert.equal(await result, outcome === 'idle');
    assert.equal(f.timers.pending.size, 0); assert.equal(stream.destroyed, true);
    assert.equal(p.busy, false);
  }
});

test('reset rejects old queued work and late rendered audio even when the same user rejoins', async () => {
  const f = fixture(), p = createPlayback(f), c = f.voice.joinVoiceChannel({});
  let resolveAudio, oldRan = false, afterPlayed = false;
  const oldGeneration = p.nextGeneration('a');
  p.say('test', { connection: c, userId: 'a', generation: oldGeneration,
    render: () => new Promise(resolve => { resolveAudio = resolve; }), then: () => { afterPlayed = true; } });
  p.queue(() => { oldRan = true; }, 'a', oldGeneration);
  await flush(); p.reset();
  assert.notEqual(p.nextGeneration('a'), oldGeneration);
  const lateAudio = new PassThrough(); resolveAudio(lateAudio); await flush();
  assert.equal(oldRan, false); assert.equal(afterPlayed, false); assert.equal(lateAudio.destroyed, true);
  assert.equal(f.players.length, 0);
});

test('shared listener reset closes captures and stale callbacks cannot recreate them', async () => {
  const f = fixture(), c = f.voice.joinVoiceChannel({});
  const listener = createListener({ ...f, config: { PREROLL_MS: 0, SILENCE_MS: 500, ENERGY_THRESHOLD: 300 },
    session: { channel: f.channel, noteSpeaking() {}, noteAudio() {} }, playback: {}, botId: () => 'bot',
    isIgnored: () => false, onUtterance: async () => {}, onStuck() {} });
  listener.start(c, f.channel, null);
  const staleSpeaking = c.receiver.speaking.listeners('start')[0];
  const old = [...c.receiver.subscriptions.values()];
  listener.reset(); staleSpeaking('a'); await flush();
  assert.ok(old.every(s => s.destroyed));
  assert.equal(c.receiver.subscriptions.size, 0); assert.equal(f.timers.pending.size, 0);
  assert.equal(c.receiver.speaking.listenerCount('start'), 0);
});

test('entry point requires explicit activation and loads no AI or native dependencies by default', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'voice-diagnostic.js')], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /opt-in/);
  assert.ok(!Object.keys(require.cache).some(p => /(?:wakeword|whisper|answer-llm|onnxruntime|discord\.js)[\\/\.]?/.test(p)));
});

test('fixed test tone is exactly half a second and contains equal stereo channels', () => {
  const pcm = testTone(); assert.equal(pcm.length, 96000);
  let max = 0;
  for (let i = 0; i < pcm.length; i += 4) {
    assert.equal(pcm.readInt16LE(i), pcm.readInt16LE(i + 2));
    max = Math.max(max, Math.abs(pcm.readInt16LE(i)));
  }
  assert.equal(max, 2000);
});

test('existing !luna leave cancels pending joins and keeps auto-join paused after channel empties', async () => {
  const boot = require('./harness');
  const h = boot({ AUTO_JOIN_CHANNELS: 'A', VOICE_RECOVER_MS: '0' });
  await h.start(); h.put('u1', 'A'); await h.luna('u1');
  const pending = h.S.lastConnection;
  const stop = () => h.T.client.emit('messageCreate', {
    content: '!luna leave', author: { id: 'u1' }, reply: async () => {},
  });
  stop(); pending.emit(h.Status.Ready);
  assert.equal(h.T.activeConnection, null);
  h.move('u1', 'A', null); h.move('u1', null, 'A'); h.T.autoJoin();
  assert.equal(h.T.autoJoinPaused, true);
  assert.equal(h.S.lastConnection, pending);
  await h.luna('u1');
  assert.equal(h.T.autoJoinPaused, false);
  assert.notEqual(h.S.lastConnection, pending);
  h.S.lastConnection.setStatus(h.Status.Ready);
  h.T.session.reconnect(); stop();
  assert.equal(h.T.session.active, false);
  h.T.autoJoin();
  assert.equal(h.T.session.active, false);
  await flush();
});

test('failed receiver setup cleans the session and never announces a successful join', () => {
  const f = fixture(); let announced = false;
  const session = createVoiceSession({ ...f, config: {}, isIgnored: () => false,
    onConnected: () => { throw new Error('decoder unavailable'); },
    onReset: () => { throw new Error('cleanup callback failed'); } });
  const c = session.join(f.channel, f.guild);
  session.attach(c, f.channel, null, f.guild, () => { announced = true; });
  c.setStatus(Status.Ready);
  assert.equal(announced, false); assert.equal(c.destroyed, true);
  assert.equal(f.timers.pending.size, 0);
});

test('late timers from an old generation cannot orphan current cancellation handles', () => {
  const f = setupSession(); f.join().setStatus(Status.Ready);
  f.session.noteSpeaking('a'); const staleSpeaker = [...f.timers.pending.values()][0].fn;
  f.session.leave('stop'); f.join().setStatus(Status.Ready); f.session.noteSpeaking('a');
  staleSpeaker(); f.session.leave('stop');
  assert.equal(f.timers.pending.size, 0);
  f.join().setStatus(Status.Ready); f.session.reconnect();
  const staleReconnect = [...f.timers.pending.values()][0].fn;
  f.session.leave('stop'); f.join().setStatus(Status.Ready); f.session.reconnect();
  staleReconnect(); f.session.leave('stop');
  assert.equal(f.timers.pending.size, 0);
});

test('own leave notification during recovery does not cancel it; operator stop still does', () => {
  const f = setupDiagnostic(); f.ready(); f.diagnostic.recover();
  f.diagnostic.onVoiceState({ channelId: 'c' }, { id: 'bot', guild: f.guild, channelId: null });
  f.timers.tick(1500);
  assert.equal(f.connections.length, 2);
  f.connections[1].setStatus(Status.Ready);
  assert.equal(f.connections[1].receiver.subscriptions.size, 2);
  f.diagnostic.stop(); f.timers.tick(600000);
  assert.equal(f.connections.length, 2); assert.equal(f.timers.pending.size, 0);
});
