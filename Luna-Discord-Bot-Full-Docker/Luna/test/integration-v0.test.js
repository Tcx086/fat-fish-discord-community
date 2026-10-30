// Offline application replay: real capture/codec/STT/SSE/memory/TTS/resource pipeline.
// Only Discord transport/player and network responses are synthetic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { OpusEncoder } = require('@discordjs/opus');
const voice = require('@discordjs/voice');
const boot = require('./harness');
const { loadConversationConfig } = require('../conversation-config');
const { createTTS } = require('../tts');
const { createPlayback } = require('../voice-playback');
const { createListener } = require('../voice-listen');
const profile = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '../fat-fish.env.example')));
const until = async (h, fn) => { await h.until(fn); assert.ok(fn(), h.S.logs.join('\n')); };
const chunk = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const ending = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\ndata: [DONE]\n\n';

function wav() {
  const pcm = Buffer.alloc(24000);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(2500 * Math.sin(i * Math.PI / 24)), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function fixture(t) {
  const calls = [], transcripts = [], players = [];
  let hold = '', release = () => {}, packets = 0, utterances = 0;
  const transport = async (url, init) => {
    const stage = url.endsWith('/inference') ? 'stt' : url.endsWith('/chat/completions') ? 'generation' :
      url === profile.FEIYU_TTS_URL ? 'tts' : assert.fail(`Unexpected network destination: ${url}`);
    const call = { stage, signal: init.signal, at: performance.now() }; calls.push(call);
    if (stage === 'stt') {
      assert.equal(init.body.get('language'), 'auto'); assert.equal(init.body.get('translate'), 'false');
      const audio = Buffer.from(await init.body.get('file').arrayBuffer());
      assert.equal(audio.toString('ascii', 0, 4), 'RIFF'); assert.equal(audio.readUInt32LE(24), 48000);
    } else call.body = JSON.parse(init.body);
    // Deliberately ignore abort so late network completion is also tested.
    if (hold === stage) await new Promise(resolve => { release = resolve; });
    if (stage === 'stt') return Response.json({ text: transcripts.shift() });
    if (stage === 'generation') {
      const bytes = Buffer.from(chunk('可以先确认') + chunk('大家的时间。') + ending);
      return new Response(new ReadableStream({ start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.subarray(i, i + 7)); c.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    assert.deepEqual(Object.keys(call.body).sort(), ['input', 'stream', 'voice']);
    assert.equal(call.body.voice, 'cute'); assert.equal(call.body.stream, false);
    return new Response(wav(), { headers: { 'content-type': 'audio/wav' } });
  };
  const h = boot({ ...profile, CONVERSATION_ENABLED: 'true', DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'fixture',
    CONVERSATION_GUILD_ID: '100000000000000104', CONVERSATION_CHANNEL_ID: '100000000000000103',
    CONVERSATION_ALL_PARTICIPANTS: 'false', CONVERSATION_USER_IDS: '100000000000000101',
    MEMORY_STORAGE_ENABLED: 'true', MEMORY_DB_PATH: ':memory:', MEMORY_POLICY_REVIEWED: 'true',
    MEMORY_ENCRYPTED_STORAGE_CONFIRMED: 'true', MEMORY_PRIVACY_URL: 'https://example.org/privacy', SILENCE_MS: '50' }, {
    '@discordjs/opus': { OpusEncoder },
    './conversation-config': { loadConversationConfig: env => ({ ...loadConversationConfig(env),
      guildId: 'g', channelId: 'A', users: new Set(['a']), operators: new Set(['operator']) }) },
    './tts': { createTTS },
    './voice-listen': { createListener: options => createListener({ ...options, timers: globalThis }) },
    './voice-playback': { createPlayback: options => createPlayback({ ...options, voice: { ...options.voice,
      createAudioResource: voice.createAudioResource, StreamType: voice.StreamType,
      createAudioPlayer: () => {
        const player = new EventEmitter(); players.push(player);
        player.stop = () => { player.stopped = true; return true; };
        player.play = resource => {
          player.resource = resource;
          resource.playStream.on('data', packet => { new OpusEncoder(48000, 2).decode(packet); packets++; });
          resource.playStream.once('error', error => player.emit('error', error));
          resource.playStream.once('end', () => { if (hold !== 'playback') player.emit('idle'); });
        }; return player;
      } } }) },
  }, transport);
  t.after(() => { release(); h.T.conversation.leave(); h.T.memoryEngine.close(); });
  async function control(commandName, action, admin = false) {
    let reply;
    h.T.client.emit('interactionCreate', { isChatInputCommand: () => true, guildId: 'g', user: { id: admin ? 'operator' : 'a' },
      member: { voice: { channelId: 'A' }, permissions: { has: () => admin } }, commandName,
      options: { getString: key => key === 'action' ? action : undefined, getBoolean: () => true, getInteger: () => null },
      reply: async data => { reply = data; } });
    await until(h, () => !!reply); return reply;
  }
  async function join() {
    await h.start(); h.put('a', 'A'); h.put('excluded', 'A'); await h.luna('operator');
    h.S.lastConnection.setStatus(h.Status.Ready);
    await until(h, () => h.S.lastConnection.receiver.subscriptions.size === 1);
    assert.deepEqual([...h.S.lastConnection.receiver.subscriptions.keys()], ['a']);
    assert.equal(calls.length, 0); assert.equal(players.length, 0);
    h.put('excluded', null);
  }
  async function say(text) {
    await until(h, () => !!h.S.audio?.a && !h.S.audio.a.destroyed);
    transcripts.push(text);
    const encoder = new OpusEncoder(48000, 1), pcm = Buffer.alloc(1920);
    const period = 24 + ++utterances;
    for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(5000 * Math.sin(i * Math.PI / period)), i * 2);
    const before = calls.length;
    // Preserve capture time: a burst would falsely predate participant consent.
    for (let i = 0; i < 25; i++) { h.S.audio.a.write(encoder.encode(pcm)); await h.wait(20); }
    await until(h, () => calls.length > before);
    if (hold !== 'stt') await until(h, () => h.T.conversation.status().stt === 0);
  }
  return { h, calls, players, join, say, control, hold: stage => { hold = stage; }, release: () => { hold = ''; release(); },
    get packets() { return packets; } };
}

test('v0 synthetic conversation traverses capture, consented recall, character, fragmented SSE, Feiyu WAV and native Opus', async t => {
  assert.equal(profile.DEEPSEEK_ENABLED, 'false'); assert.equal(profile.CONVERSATION_ENABLED, 'false');
  assert.equal(profile.MEMORY_STORAGE_ENABLED, 'false'); assert.equal(profile.TTS_FALLBACK, 'none');
  assert.equal(profile.CONVERSATION_ALL_PARTICIPANTS, 'false');
  assert.throws(() => loadConversationConfig({ ...profile, CONVERSATION_ENABLED: 'true',
    CONVERSATION_GUILD_ID: '100000000000000104', CONVERSATION_CHANNEL_ID: '100000000000000103' }), /consenting user IDs/);
  const f = fixture(t); await f.join();
  assert.match((await f.control('memory', 'enable-history', true)).content, /History enabled/);
  assert.match((await f.control('memory', 'consent')).content, /Consent recorded/);
  await f.say('我们计划周末一起玩原神游戏');
  assert.equal(f.h.T.memoryEngine.store.exportOwn('a').episodes.length, 1,
    JSON.stringify({ status: f.h.T.memoryEngine.status(), consent: f.h.T.memoryEngine.store.consent('a'), logs: f.h.S.logs }));
  assert.equal(f.calls.filter(c => c.stage !== 'stt').length, 0);
  await f.control('clear-context', null, true);
  await f.say('大肥鱼，上次的游戏计划是什么？');
  await until(f.h, () => f.players.length === 1 && f.h.T.conversation.state === 'PASSIVE_LISTENING');
  const requests = f.calls.filter(c => c.stage === 'generation'); assert.equal(requests.length, 1);
  const messages = requests[0].body.messages, context = JSON.parse(messages[1].content);
  assert.equal(messages.length, 2); assert.match(messages[0].content, /原创 AI/);
  assert.match(messages[0].content, /untrusted evidence/);
  assert.ok(context.historicalMemory.some(e => e.text.includes('原神')));
  assert.ok(Buffer.byteLength(messages[1].content) <= 4096);
  assert.ok(messages.reduce((sum, m) => sum + Buffer.byteLength(m.content), 0) <= 8192);
  assert.equal(f.calls.filter(c => c.stage === 'tts').length, 1); assert.ok(f.packets > 0);
  await f.say('那就这样定了'); assert.equal(f.calls.filter(c => c.stage === 'generation').length, 1);
  assert.doesNotMatch(f.h.S.logs.join('\n'), /原神|那就这样|可以先确认/);
  await f.control('pause'); assert.equal(f.h.T.conversation.status().contextEntries, 0);
  assert.equal(f.h.T.conversation.submit(Buffer.alloc(1920), 'a'), false);
  await f.control('resume', null, true); await f.control('opt-out');
  assert.equal(f.h.T.memoryEngine.store.exportOwn('a').episodes.length, 0);
  f.h.S.signals.SIGTERM(); assert.equal(f.h.T.memoryEngine.store, null);
  assert.equal(f.h.T.session.active, false); assert.equal(f.h.S.clientDestroyed, true);
  t.diagnostic(JSON.stringify({ networkCalls: f.calls.map(c => c.stage), decodedOpusPackets: f.packets,
    systemBytes: Buffer.byteLength(messages[0].content), contextBytes: Buffer.byteLength(messages[1].content) }));
});

for (const stage of ['stt', 'generation', 'tts', 'playback']) test(`v0 interruption during ${stage} suppresses late audio and permits the next explicit invocation`, async t => {
  const f = fixture(t); await f.join(); f.hold(stage); await f.say('大肥鱼，你觉得呢？');
  await until(f.h, () => stage === 'playback' ? f.players.length === 1 : f.calls.some(c => c.stage === stage));
  const played = f.players.length, packets = f.packets, started = performance.now();
  await f.control('interrupt');
  if (stage === 'playback') assert.equal(f.players[0].stopped, true);
  else assert.equal(f.calls.find(c => c.stage === stage).signal.aborted, true);
  f.release(); await f.h.wait(80); assert.equal(f.players.length, played);
  assert.equal(f.packets, packets, 'no stale Opus packets after interruption');
  await f.say('大肥鱼，请回答下一个问题');
  await until(f.h, () => f.players.length === played + 1 && f.h.T.conversation.state === 'PASSIVE_LISTENING');
  await f.control('stop'); assert.equal(f.h.T.session.active, false);
  f.h.T.autoJoin(); assert.equal(f.h.T.session.active, false);
  t.diagnostic(`Synthetic ${stage} interrupt + late completion + next turn: ${(performance.now() - started).toFixed(1)} ms; not model latency`);
});
