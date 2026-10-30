// Phase 0 only. No config.js, model, transcription, TTS or AI service imports.
const { Readable } = require('node:stream');
const { createVoiceSession } = require('./voice-session');
const { createPlayback } = require('./voice-playback');
const { createPacketDecoder } = require('./voice-input');

// Fixed half-second, low-volume 440 Hz tone, 48 kHz signed 16-bit stereo.
function testTone() {
  const pcm = Buffer.alloc(48000 * 4 / 2);
  for (let i = 0; i < 24000; i++) {
    const fade = Math.min(1, i / 240, (23999 - i) / 240);
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 2000 * fade);
    pcm.writeInt16LE(sample, i * 4);
    pcm.writeInt16LE(sample, i * 4 + 2);
  }
  return pcm;
}

function createVoiceDiagnostic({ voice, OpusEncoder, guildId, channelId, botId, log = console.log, timers = globalThis }) {
  const captures = new Map();
  const counts = new Map();
  let target = null;
  let heartbeat = null;
  let stopSpeaking = () => {};
  let stopStateLog = () => {};
  const safeConsole = { log, warn: log, error: log };
  const playback = createPlayback({ voice, console: safeConsole, timers });
  const session = createVoiceSession({
    config: { VOICE_RECOVER_MS: 15000 }, voice, console: safeConsole, timers,
    isIgnored: () => false,
    onReset: reset,
    onConnected: conn => {
      if (!session.realMemberCount(target)) return stop('channel empty at readiness');
      const onSpeaking = id => {
        if (session.connection !== conn || !isHuman(id)) return;
        log(`[phase0] speaking user=${id}`);
        session.noteSpeaking(id);
        capture(conn, id);
      };
      conn.receiver.speaking.on('start', onSpeaking);
      stopSpeaking = () => conn.receiver.speaking.off('start', onSpeaking);
      syncMembers();
      heartbeat = timers.setInterval(() => { syncMembers(); status(); }, 5000);
      log('[phase0] voice ready; waiting for human audio');
    },
  });

  function isHuman(id) { return id !== botId() && target?.members.get(id)?.user.bot === false; }

  function capture(conn, id) {
    if (captures.has(id) || !isHuman(id) || session.connection !== conn) return;
    const owner = session.generation;
    const stats = counts.get(id) || { packets: 0, decoded: 0, decodeErrors: 0, receiveErrors: 0 };
    counts.set(id, stats);
    let stream;
    try {
      const decoder = new OpusEncoder(48000, 1);
      stream = conn.receiver.subscribe(id, { end: { behavior: voice.EndBehaviorType.Manual } });
      const decode = createPacketDecoder(decoder, {
        reportEveryMs: 0,
        onUndecodable: n => { stats.decodeErrors += n; },
        onPcm: pcm => {
          if (!pcm.length || pcm.length % 2) { stats.decodeErrors++; return; }
          stats.decoded++;
          session.noteAudio(id);
          // No reference to PCM is retained, written, or sent anywhere.
        },
      });
      const onData = packet => {
        if (owner !== session.generation || captures.get(id)?.stream !== stream) return;
        stats.packets++;
        decode(packet);
      };
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        stream.off('data', onData);
        if (captures.get(id)?.stream === stream) captures.delete(id);
        stream.destroy();
      };
      captures.set(id, { stream, close });
      stream.on('data', onData);
      stream.once('close', close);
      stream.on('error', () => {
        if (closed || owner !== session.generation) return;
        stats.receiveErrors++;
        log(`[phase0] receive error user=${id}; retry on next speech or heartbeat`);
        close();
      });
    } catch {
      stream?.destroy();
      stats.receiveErrors++;
      log(`[phase0] subscription/decoder setup failed user=${id}`);
    }
  }

  function syncMembers() {
    if (!session.active) return;
    if (!session.realMemberCount(target)) return stop('last human left');
    for (const [id, capture] of captures) {
      if (!isHuman(id)) {
        log(`[phase0] departed user=${id} ${JSON.stringify(counts.get(id))}`);
        capture.close();
        counts.delete(id);
        session.noteAudio(id); // cancel that speaker's recovery timer
      }
    }
    for (const id of counts.keys()) if (!isHuman(id)) counts.delete(id);
    const conn = session.connection;
    if (conn?.state.status === voice.VoiceConnectionStatus.Ready) {
      for (const id of target.members.keys()) capture(conn, id);
    }
  }

  function reset() {
    stopSpeaking();
    stopStateLog();
    stopSpeaking = stopStateLog = () => {};
    timers.clearInterval(heartbeat);
    heartbeat = null;
    for (const capture of captures.values()) capture.close();
    counts.clear();
    playback.reset();
  }

  function join(channel) {
    if (channel.id !== channelId || channel.guild.id !== guildId || !channel.isVoiceBased()) {
      throw new Error('Channel is outside the authorized target');
    }
    if (session.active) { log('[phase0] already joining, connected, or recovering'); return; }
    if (!session.realMemberCount(channel)) { log('[phase0] join refused: no human participants'); return; }
    target = channel;
    const guild = { id: guildId, adapterCreator: channel.guild.voiceAdapterCreator };
    try {
      const conn = session.join(channel, guild);
      const owner = session.generation;
      const onState = (oldState, newState) => {
        if (owner !== session.generation) return;
        log(`[phase0] connection=${newState.status}`);
      };
      conn.on('stateChange', onState);
      stopStateLog = () => conn.off('stateChange', onState);
      log(`[phase0] joining guild=${guildId} channel=${channelId}; selfDeaf=false`);
      session.attach(conn, channel, null, guild);
    } catch {
      stop('join failed');
    }
  }

  function stop(reason = 'operator stop') {
    session.leave(reason);
    log('[phase0] stopped; only a new console join can start another session');
  }

  function onVoiceState(oldState, newState) {
    if (!session.active || newState.guild.id !== guildId) return;
    if (newState.id === botId() && newState.channelId !== channelId) {
      // Destroying the old connection during recovery emits our own leave event.
      if (!newState.channelId && !session.connection) return;
      stop('bot removed or moved outside authorized channel');
      return;
    }
    if (oldState.channelId === channelId || newState.channelId === channelId) syncMembers();
  }

  function status() {
    const crypto = session.cryptoState();
    log(`[phase0] status=${session.connection?.state.status || (session.active ? 'pending' : 'stopped')} subscriptions=${captures.size} playback=${playback.busy}`);
    log(`[phase0] DAVE protocol=${crypto?.protocolVersion ?? 'unknown'} state=${crypto?.status ?? 'unknown'} epoch=${crypto?.epoch ?? 'unknown'}`);
    for (const [id, stats] of counts) {
      const verdict = session.cryptoVerdict(crypto, id);
      log(`[phase0] user=${id} ${JSON.stringify(stats)} DAVE=${verdict?.text ?? 'unavailable'}`);
    }
  }

  async function play() {
    const conn = session.connection;
    if (conn?.state.status !== voice.VoiceConnectionStatus.Ready) { log('[phase0] play refused: voice is not ready'); return; }
    if (playback.busy) { log('[phase0] test tone already playing'); return; }
    const owner = session.generation;
    const ok = await playback.play(Readable.from([testTone()]), conn, { inputType: voice.StreamType.Raw, timeoutMs: 5000 });
    if (owner === session.generation) log(`[phase0] test tone ${ok ? 'player completed; confirm it was audible' : 'failed or cancelled'}`);
  }

  return { join, stop, play, status, onVoiceState, recover: () => session.reconnect() };
}

async function main() {
  if (!process.argv.includes('--live') || !process.argv.includes('--authorized')) {
    console.log('Phase 0 is opt-in. Read ../../README.md. Live use requires --live --authorized plus PHASE0_GUILD_ID, PHASE0_CHANNEL_ID and PHASE0_DISCORD_TOKEN in this process environment.');
    return;
  }
  const { PHASE0_GUILD_ID: guildId, PHASE0_CHANNEL_ID: channelId, PHASE0_DISCORD_TOKEN: token } = process.env;
  if (!/^\d{17,20}$/.test(guildId || '') || !/^\d{17,20}$/.test(channelId || '') || !token || !process.stdin.isTTY) {
    throw new Error('Missing valid Phase 0 environment or interactive console');
  }
  const { Client, GatewayIntentBits, Events, ChannelType } = require('discord.js');
  const voice = require('@discordjs/voice');
  const { OpusEncoder } = require('@discordjs/opus');
  // Fail before login if the native binding is unavailable.
  new OpusEncoder(48000, 1).decode(new OpusEncoder(48000, 1).encode(Buffer.alloc(1920)));
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const diagnostic = createVoiceDiagnostic({ voice, OpusEncoder, guildId, channelId, botId: () => client.user?.id });
  let terminal, closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    diagnostic.stop('process shutdown'); terminal?.close(); client.destroy();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  client.on(Events.Error, () => console.error('[phase0] Discord client error (details suppressed)'));
  client.on(Events.ShardDisconnect, () => diagnostic.stop('gateway disconnected'));
  client.on(Events.VoiceStateUpdate, diagnostic.onVoiceState);
  client.once(Events.ClientReady, () => {
    if (closing) return;
    console.log('[phase0] logged in; NOT joined. Notify participants before joining. Commands: join, play, status, recover, stop, quit');
    terminal = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
    terminal.on('line', line => {
      try {
        switch (line.trim().toLowerCase()) {
          case 'join': {
            const channel = client.channels.cache.get(channelId);
            if (channel?.type !== ChannelType.GuildVoice || channel.guild.id !== guildId) {
              console.log('[phase0] authorized ordinary voice channel unavailable'); break;
            }
            diagnostic.join(channel); break;
          }
          case 'play': void diagnostic.play().catch(() => diagnostic.stop('playback failed')); break;
          case 'status': diagnostic.status(); break;
          case 'recover': diagnostic.recover(); break;
          case 'stop': diagnostic.stop(); break;
          case 'quit': shutdown(); break;
          default: console.log('[phase0] commands: join, play, status, recover, stop, quit');
        }
      } catch { diagnostic.stop('command failed'); }
    });
    terminal.once('close', shutdown);
  });
  try { await client.login(token); }
  catch { shutdown(); throw new Error('Discord login failed'); }
}

if (require.main === module) main().catch(() => {
  console.error('[phase0] startup failed; check local environment, native Opus, and bot permissions. No credentials or error payloads are printed.');
  process.exitCode = 1;
});

module.exports = { createVoiceDiagnostic, testTone };
