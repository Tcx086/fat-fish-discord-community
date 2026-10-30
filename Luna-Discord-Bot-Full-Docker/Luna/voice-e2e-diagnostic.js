// Phase 1.5: the production module chain, with a local console and a one-request gate.
// No imports with native/network side effects are loaded before explicit activation.
const { loadConfig } = require('./config');
const { loadDeepSeekConfig } = require('./deepseek-config');
const { createDeepSeek } = require('./deepseek');
const { createWhisper } = require('./whisper');
const { createTTS } = require('./tts');
const { createPlayback } = require('./voice-playback');
const { createVoiceSession } = require('./voice-session');
const { createListener } = require('./voice-listen');
const { createVoiceAnswerer } = require('./voice-answer');

const GUILD = '100000000000000104', CHANNEL = '100000000000000103';
function createValidationLogger({ write, output = globalThis.console, secrets = [] }) {
  return Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => {
    let line = args.map(x => x instanceof Error ? '[error details suppressed]' : String(x)).join(' ');
    for (const secret of secrets.filter(Boolean)) line = line.split(secret).join('[REDACTED]');
    write(line + '\n'); output[level](line);
  }]));
}
function createVoiceValidation({ voice, OpusEncoder, WakeWordEngine, botId, tokenConfig,
  fetch = globalThis.fetch, console = globalThis.console, timers = globalThis, now = Date.now }) {
  const config = loadConfig({ OWW_ENABLED: 'false', WHISPER_SERVER_URLS: 'http://127.0.0.1:18081/inference',
    KOKORO_URL: 'http://127.0.0.1:18880/v1/audio/speech', KOKORO_VOICE: 'af_heart',
    TTS_PROVIDER: 'kokoro', TTS_FALLBACK: 'none', WAKE_FOLLOWUP_MS: '0', VOICE_RECOVER_MS: '0',
    WHISPER_TIMEOUT_MS: '60000', MAX_SPEECH_MS: '10000' });
  let speakerId = '', armed = false, busy = false, requests = 0, trace = null;
  let sttController = new AbortController();
  let stoppedAt = null, stoppedTimer = null;
  const counts = { packets: 0, decoded: 0, decodeErrors: 0 };
  const event = (name, data = {}) => console.log('[phase15]', JSON.stringify({ event: name, at: now(), ...data }));
  const mark = (name, data = {}) => {
    if (trace && trace[name] === undefined) trace[name] = now();
    event(name, data);
  };
  const llm = createDeepSeek({ config: { ...tokenConfig, maxTokens: 64, retries: 0, concurrency: 1,
    historyTurns: 0, historyBytes: 0, queryBytes: 256, sessionTokens: 1024, dailyTokens: 1024 }, console,
    onFirstContent: () => mark('llmFirstContent'),
    fetch: async (url, init) => {
      if (requests >= 1 || !session.connection) throw new Error('One-request gate closed');
      const body = JSON.parse(init.body);
      if (url !== 'https://api.deepseek.com/chat/completions' || body.model !== 'deepseek-flash' ||
          body.max_tokens !== 64 || body.thinking?.type !== 'disabled') throw new Error('Unapproved request');
      requests++;
      mark('llmRequest', { requests, query: body.messages.at(-1).content });
      const response = await fetch(url, init);
      event('llmHttp', { status: response.status });
      return response;
    },
  });
  let ttsBodyBytes = 0;
  const tts = createTTS({ config, fetch, console, onBodyChunk: chunk => {
    ttsBodyBytes += chunk.byteLength;
    // This repository's Kokoro stream has a fixed 44-byte WAV header before PCM.
    if (ttsBodyBytes > 44 && trace?.ttsFirstAudio === undefined) mark('ttsFirstAudio');
  } }); // No filesystem cache, no persisted audio.
  const fetchTTS = async (text, options) => {
    ttsBodyBytes = 0;
    mark('ttsRequest', { text });
    return tts.fetchTTS(text, options);
  };
  const instrumentedVoice = { ...voice, createAudioPlayer: (...args) => {
    const player = voice.createAudioPlayer(...args);
    player.once(voice.AudioPlayerStatus.Playing, () => mark('playerPlaying'));
    return player;
  } };
  const playback = createPlayback({ voice: instrumentedVoice, fetchTTS, console, lookahead: 1, timers });
  const originalPlay = playback.play;
  playback.play = async (...args) => {
    const ok = await originalPlay(...args);
    if (trace) trace.lastPlaybackEnd = now();
    event('playbackFinished', { ok }); return ok;
  };
  const session = createVoiceSession({ config, voice, console, timers, isIgnored: id => id !== speakerId,
    onConnected: (conn, channel) => { event('ready'); listener.start(conn, channel, channel); },
    onReset: () => {
      armed = false; sttController.abort(); sttController = new AbortController();
      listener?.reset(); playback.reset(); llm.forgetConversations();
    },
  });
  class CountedOpus {
    constructor(...args) { this.codec = new OpusEncoder(...args); }
    decode(packet) {
      counts.packets++;
      try { const pcm = this.codec.decode(packet); counts.decoded++; return pcm; }
      catch (e) { counts.decodeErrors++; throw e; }
    }
  }
  const stt = createWhisper({ config, console, fetch: (url, init) => fetch(url,
    { ...init, signal: AbortSignal.any([init.signal, sttController.signal]) }) });
  const answerer = createVoiceAnswerer({ config, console, llm, playback, session, fetchTTS,
    whisper: { transcribe: async pcm => {
      mark('sttStart'); const text = await stt.transcribe(pcm); mark('sttComplete', { transcript: text }); return text;
    } },
    sendCommand: async () => {}, leave: () => stop('spoken leave'),
    expectQuestion: (...args) => listener.expectQuestion(...args), nowPlaying: null,
  });
  const listener = createListener({ config, console, voice, OpusEncoder: CountedOpus, WakeWordEngine, timers,
    session, playback, botId, isIgnored: id => id !== speakerId,
    onStuck: id => answerer.release(id),
    onUtterance: async (pcm, user, conn, channel, wake, candidate, timing) => {
      if (!armed || busy || requests >= 1) return;
      armed = false; busy = true;
      trace = { speechEndedAt: timing?.speechEndedAt, flushedAt: timing?.flushedAt };
      event('utterance', { user, ...trace });
      try { await answerer.onUtterance(pcm, user, conn, channel, wake, candidate); }
      finally { busy = false; event('turnFinished', { requests, trace }); status(); }
    },
  });
  function status() {
    const crypto = session.cryptoState();
    event('status', { state: session.connection?.state.status || (session.active ? 'pending' : 'stopped'),
      armed, busy, requests, ...counts, playback: playback.busy,
      subscriptions: session.connection?.receiver.subscriptions.size || 0,
      dave: speakerId ? session.cryptoVerdict(crypto, speakerId)?.text : null,
      protocol: crypto?.protocolVersion, epoch: crypto?.epoch,
      stoppedForMs: stoppedAt === null ? null : now() - stoppedAt });
  }
  function join(channel, userId) {
    if (session.active || busy || requests || stoppedAt !== null) throw new Error('Session already used');
    if (channel?.id !== CHANNEL || channel.guild?.id !== GUILD || !channel.isVoiceBased()) throw new Error('Wrong channel');
    const human = channel.members.get(userId);
    if (!human || human.user.bot) throw new Error('Consenting speaker must be in channel');
    speakerId = userId;
    const guild = { id: GUILD, adapterCreator: channel.guild.voiceAdapterCreator };
    const conn = session.join(channel, guild); session.attach(conn, channel, channel, guild);
    event('joining', { guild: GUILD, channel: CHANNEL, speakerId });
  }
  function arm() {
    if (!session.connection || requests || busy || armed) throw new Error('Cannot arm');
    armed = true; event('armed', { instruction: 'Say: Hey Luna, what is two plus two? Please answer in one short sentence.' });
  }
  function stop(reason = 'operator stop') {
    session.leave(reason); armed = false;
    if (stoppedAt === null) stoppedAt = now();
    timers.clearTimeout(stoppedTimer);
    stoppedTimer = timers.setTimeout(() => { event('shutdownObservation'); status(); }, 60000);
    status();
  }
  function onVoiceState(oldState, newState) {
    if (!session.active || newState.guild.id !== GUILD) return;
    if ((newState.id === botId() && newState.channelId !== CHANNEL) ||
        (newState.id === speakerId && newState.channelId !== CHANNEL)) stop('participant left authorized channel');
  }
  function close() { stop('process shutdown'); timers.clearTimeout(stoppedTimer); }
  return { join, arm, stop, close, status, onVoiceState, init: () => listener.initWakeWord(),
    get requests() { return requests; }, get session() { return session; } };
}

async function main() {
  if (process.env.NODE_ENV !== 'development' || process.env.PHASE15_ENABLED !== 'true' ||
      !process.argv.includes('--authorized-discord') || !process.argv.includes('--authorized-cost')) {
    console.log('Phase 1.5 is disabled. Separate Discord-session and API-cost authorization required.'); return;
  }
  if (!process.stdin.isTTY || !process.env.PHASE15_DISCORD_TOKEN) throw new Error('Interactive credentials required');
  const log = createValidationLogger({
    write: line => { if (process.env.PHASE15_LOG_FILE) require('node:fs').appendFileSync(process.env.PHASE15_LOG_FILE, line); },
    secrets: [process.env.PHASE15_DISCORD_TOKEN, process.env.DEEPSEEK_API_KEY],
  });
  const { Client, GatewayIntentBits, Events, ChannelType } = require('discord.js');
  const voice = require('@discordjs/voice'), { OpusEncoder } = require('@discordjs/opus');
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const tokenConfig = loadDeepSeekConfig();
  if (!tokenConfig.enabled || !tokenConfig.apiKey || tokenConfig.model !== 'deepseek-flash' ||
      tokenConfig.endpoint !== 'https://api.deepseek.com/chat/completions') throw new Error('Invalid approved configuration');
  const validation = createVoiceValidation({ voice, OpusEncoder, WakeWordEngine: {}, botId: () => client.user?.id, tokenConfig, console: log });
  let terminal, heartbeat, closing = false;
  const shutdown = () => {
    if (closing) return; closing = true; clearInterval(heartbeat); validation.close(); terminal?.close(); client.destroy();
    log.log('[phase15] shutdown complete; no further API requests can be initiated');
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  client.on(Events.Error, () => { log.error('[phase15] Discord error (details suppressed)'); shutdown(); });
  client.on(Events.ShardDisconnect, () => validation.stop('gateway disconnected'));
  client.on(Events.VoiceStateUpdate, validation.onVoiceState);
  client.once(Events.ClientReady, async () => {
    await validation.init(); if (closing) return;
    log.log('[phase15] Logged in, NOT joined. Commands: join <consenting-user-id>, arm, status, stop, heard, quit');
    heartbeat = setInterval(() => validation.status(), 10000);
    terminal = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
    terminal.on('line', line => {
      const [cmd, user] = line.trim().split(/\s+/);
      try {
        if (cmd === 'join') {
          const channel = client.channels.cache.get(CHANNEL);
          if (channel?.type !== ChannelType.GuildVoice) throw new Error('Channel unavailable');
          validation.join(channel, user);
        } else if (cmd === 'arm') validation.arm();
        else if (cmd === 'stop') validation.stop();
        else if (cmd === 'status') validation.status();
        else if (cmd === 'heard') log.log('[phase15] Operator reports hearing the answer; this is not an acoustic latency measurement.');
        else if (cmd === 'quit') shutdown();
        else console.log('[phase15] Commands: join <consenting-user-id>, arm, status, stop, heard, quit');
      } catch { console.warn('[phase15] Command refused: check channel, speaker membership, session and request limit.'); }
    });
    terminal.once('close', shutdown);
  });
  try { await client.login(process.env.PHASE15_DISCORD_TOKEN); }
  catch { shutdown(); throw new Error('Discord login failed'); }
}
if (require.main === module) main().catch(() => { console.error('[phase15] Startup failed; details suppressed.'); process.exitCode = 1; });
module.exports = { createVoiceValidation, createValidationLogger, main };
