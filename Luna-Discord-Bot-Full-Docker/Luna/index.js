require('dotenv').config();
if (process.env.CONVERSATION_DIAGNOSTIC === 'true' && process.env.CONVERSATION_MODE === 'active') {
  if (process.env.NODE_ENV !== 'development' || process.env.CONVERSATION_ENABLED !== 'true') throw new Error('Diagnostic requires local shared development mode');
  const { createValidationLogger } = require('./voice-e2e-diagnostic');
  const file = require('path').join(__dirname, 'local', 'phase2-live-result.log');
  globalThis.console = createValidationLogger({ write: line => require('fs').appendFileSync(file, line),
    secrets: [process.env.DISCORD_TOKEN, process.env.DEEPSEEK_API_KEY] });
}

const voiceLib = require('@discordjs/voice');
const { GatewayIntentBits } = require('discord-api-types/v10');
const { Events, Client } = require('discord.js');
const { OpusEncoder } = require('@discordjs/opus');
const http = require('http');
const { WakeWordEngine } = require('./wakeword');
const { createMcpServer } = require('./mcp-server');
const { createTextChat, SAY_MAX_CHARS } = require('./text-chat');
const { sendSmakbotCommand: postSmakbotCommand } = require('./commands');
const { LLM_TOOLS, LLM_TOOL_NAMES } = require('./llm-tools');
const { createTTS } = require('./tts');
const { speakableName } = require('./phrases');
const { createAnnouncer } = require('./announce');
const { loadConfig } = require('./config');
const { createPlayback } = require('./voice-playback');
const { createVoiceSession } = require('./voice-session');
const { createListener } = require('./voice-listen');
const { createVoiceAnswerer } = require('./voice-answer');
const { createWhisper } = require('./whisper');
const { createWakeBackup } = require('./wake-backup');
const { createWakeLog } = require('./wake-log');
const { createLlm, TOOLS_PLUGIN_ID } = require('./answer-llm');
const { createProvider } = require('./llm-providers');
const { loadDeepSeekConfig } = require('./deepseek-config');
const { createNowPlaying } = require('./now-playing');
const { createConversation } = require('./voice-conversation');
const { createPassiveListener, PASSIVE_INSTRUCTIONS } = require('./passive-listener');
const { loadConversationConfig } = require('./conversation-config');
const { answerDeepSeek } = require('./deepseek-response');
const { createConversationDiagnostics } = require('./conversation-diagnostics');
const { createMemoryEngine, loadMemoryConfig } = require('./memory/engine');
const { createMemoryCommands, commandDefinition: memoryCommandDefinition, historyNotice } = require('./memory/commands');
const { createConversationCore, conversationInstructions, staticTurn } = require('./conversation-core');
const { createConversationRuntime } = require('./conversation-runtime');
const { createSearchTools, loadSearchConfig } = require('./search-tools');
const { createDiscordTextAdapter, loadTextConfig, commandDefinition: fishCommandDefinition } = require('./discord-text-adapter');
const { loadMusicConfig, createMusicCatalog } = require('./music-catalog');
const { createMusicEngine } = require('./music-engine');
const { createAudioCoordinator } = require('./audio-coordinator');
const { createMusicCommands, commandDefinition: musicCommandDefinition } = require('./music-commands');
const { createWakeSettings } = require('./wake-settings');
const { createWakeCommands, commandDefinition: wakeCommandDefinition } = require('./wake-commands');

// ─── Config ───────────────────────────────────────────────────────────────────

// Every setting, parsed and checked in one place (config.js).
const config = loadConfig(process.env, { warn: message => console.warn(message) });
const conversationConfig = loadConversationConfig(process.env);
const passiveMode = conversationConfig.enabled && conversationConfig.mode === 'passive';
const wakeSettings = passiveMode ? createWakeSettings() : null;
const dynamicVoice = passiveMode && conversationConfig.dynamicChannels;
const musicConfig = loadMusicConfig(process.env);
const musicCatalog = musicConfig.enabled ? createMusicCatalog(musicConfig) : null;
const audioCoordinator = musicConfig.enabled ? createAudioCoordinator() : null;
const musicEngine = musicConfig.enabled ? createMusicEngine({ voice: voiceLib, catalog: musicCatalog,
  config: musicConfig, coordinator: audioCoordinator }) : null;
musicEngine?.events.on('state', ({ state }) => console.log(`[music] state=${state}`));
musicEngine?.events.on('trackError', () => console.warn('[music] Track unavailable; skipped. Inspect the authorized library.'));
const memoryConfig = passiveMode ? loadMemoryConfig(process.env) : null;
let memoryEngine = passiveMode ? createMemoryEngine({ config: dynamicVoice ? { ...memoryConfig, enabled: false } : memoryConfig,
  guildId: conversationConfig.guildId, channelId: conversationConfig.channelId,
  onFailure: () => console.warn('[memory] Storage unavailable; working-context fallback; inspect storage before restart.') }) : null;
const optedOut = new Set(), notified = new Set();
const fishTextConfig = loadTextConfig(process.env);
const sharedSearch = createSearchTools({ config: loadSearchConfig(process.env), fetch });
const textCore = fishTextConfig.enabled ? createConversationRuntime({ env: process.env, fetch, console, search: sharedSearch }) : null;
const handleFishText = textCore ? createDiscordTextAdapter({ core: textCore, config: fishTextConfig }) : null;
if (textCore) { process.once?.('SIGINT', () => textCore.close()); process.once?.('SIGTERM', () => textCore.close()); }
const isConversationOperator = id => conversationConfig.operators?.has(id) === true;
const isAdministrator = (id, member) => isConversationOperator(id) || member?.permissions?.has('ManageGuild') === true;
const speechAllowed = id => !IGNORED_USERS.has(id) && !optedOut.has(id) &&
  (conversationConfig.allParticipants || conversationConfig.users.has(id));
const canControlConversation = (id, member) => isAdministrator(id, member) ||
  (passiveMode ? !!member?.voice?.channelId && member.voice.channelId === activeChannelId() : conversationConfig.users.has(id));
const activeChannelId = () => dynamicVoice ? session.channel?.id : conversationConfig.channelId;
let conversation = null, captureRestartTimer = null;
const diagnosticEnabled = process.env.CONVERSATION_DIAGNOSTIC === 'true' && conversationConfig.enabled;
const diagnostics = createConversationDiagnostics({ enabled: diagnosticEnabled, metadataOnly: passiveMode,
  log: event => console.log('[conversation-trace]', JSON.stringify(event)) });
if (conversationConfig.enabled && config.LLM_PROVIDER !== 'deepseek') throw new Error('Shared conversation requires DeepSeek');
if (passiveMode && (!config.WHISPER_SERVER_URLS.length || config.WHISPER_SERVER_URLS.some(endpoint => {
  try { const url = new URL(endpoint); return !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]', 'whisper', 'host.docker.internal'].includes(url.hostname) || !!url.username || !!url.password; }
  catch { return true; }
}))) throw new Error('Passive transcription requires a local Whisper endpoint');

// A person's display name in the channel, for the logs (their ID if unknown).
const nameOf = userId => session.channel?.members?.get(userId)?.displayName || userId;

// Wake-word events, one JSON line each, kept across rebuilds (wake-log.js).
const wakeLog = createWakeLog({ config, fs: require('fs').promises, path: require('path'), console, nameOf });

// Text to speech: ElevenLabs, local voices and the fallback between them (tts.js).
const { fetchTTS, fetchTTSInVoice, checkElevenLabsVoice, describeTTS, expressivePrompt } =
  createTTS({ config, fetch, console, fs: require('fs'), onBodyChunk: diagnostics.bodyChunk });

// Internal metadata takes precedence when music is enabled; legacy status remains opt-in otherwise.
const nowPlaying = createNowPlaying({ config, fetch, console, music: musicEngine, musicGuildId: musicConfig.guildId });

// DeepSeek is the default; its API remains disabled until explicitly opted in.
let conversationRequests = 0;
const deepSeekConfig = config.LLM_PROVIDER === 'deepseek' ? loadDeepSeekConfig(process.env) : null;
const passiveSystemPrompt = () => conversationInstructions(memoryEngine.character, `${deepSeekConfig.systemPrompt}\n${PASSIVE_INSTRUCTIONS}`);
const llm = config.LLM_PROVIDER !== 'lmstudio'
  ? createProvider({ id: config.LLM_PROVIDER, config: passiveMode ? { ...deepSeekConfig, retries: 0, concurrency: 1, historyTurns: 0, historyBytes: 0,
    systemPrompt: passiveSystemPrompt(), getSystemPrompt: passiveSystemPrompt } : deepSeekConfig,
    console, onFirstContent: diagnostics.firstContent, fetch: async (...args) => {
    if (conversationConfig.enabled) {
      if (conversationRequests >= conversationConfig.requestLimit) throw new Error('Conversation request limit reached');
      conversationRequests++;
      console.log(`[conversation] API request ${conversationRequests}/${conversationConfig.requestLimit}`);
    }
    const response = await fetch(...args);
    diagnostics.emit('apiHttp', { requestCount: conversationRequests, status: response.status });
    return response;
  } })
  : createLlm({ config, fetch, console, expressivePrompt, nameOf,
  musicLine: async () => nowPlaying.promptLine(await nowPlaying.get(session.channel?.guild?.id || '')) });
const voiceCore = passiveMode ? createConversationCore({ memoryConfig, llm,
  search: sharedSearch,
  requestBytes: deepSeekConfig.queryBytes, systemBytes: () => Buffer.byteLength(passiveSystemPrompt()) }) : null;

// Everything said in the voice channel goes through one queue (voice-playback.js).
const diagnosticVoice = diagnosticEnabled ? { ...voiceLib, createAudioPlayer: (...args) =>
  diagnostics.observePlayer(voiceLib.createAudioPlayer(...args), voiceLib.AudioPlayerStatus) } : voiceLib;
const playback = createPlayback({ voice: diagnosticVoice, fetchTTS, console, lookahead: config.TTS_LOOKAHEAD, coordinator: audioCoordinator });

// ─── Wake phrase ──────────────────────────────────────────────────────────────
//
// The spoken wake phrase is "hey luna". A single-word "luna" is a poor wake word
// for openWakeWord — two syllables of common phonemes with no distinctive onset —
// and trains badly. Every official openWakeWord model is 3–4 syllables.
//
// WAKE_RE matches the phrase at the START of a transcript, tolerating Whisper's
// punctuation ("Hey, Luna, ...") and its usual mishearings. It is used for:
//   1. the fallback path when the ONNX model is unavailable
//   2. stripping the phrase off the front of a transcript before it reaches
//      the LLM or the music-command parser
//   3. the backup (WAKE_WHISPER_BACKUP): spotting a "hey Luna" the model missed
// Detection itself is the ONNX model's job.
// (WAKE_RE and the other voice-input stages live in voice-input.js.)

// Text command to summon the bot. Deliberately NOT derived from the spoken
// phrase — "!hey luna" would be an awkward thing to type.
const BOT_COMMAND = '!luna';

// Human-readable phrase for user-facing messages.
const WAKE_LABEL = 'hey Luna';

const IGNORED_USERS = new Set(
  config.IGNORED_USER_IDS
);

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.Guilds,
  ],
});

// Luna's place in a voice channel (voice-session.js) and hearing the people in
// it (voice-listen.js). Leaving forgets the session's listening, playback and
// conversations.
const session = createVoiceSession({
  config, voice: voiceLib, console,
  validateChannel: channel => !dynamicVoice || authorizedVoiceChannel(channel),
  requireChannelConfirmation: dynamicVoice,
  isIgnored: id => conversationConfig.enabled ? !speechAllowed(id) : IGNORED_USERS.has(id),
  onConnected: (connection, channel, textChannel) => {
    audioCoordinator?.bind(connection);
    if (dynamicVoice) {
      memoryEngine.close();
      memoryEngine = createMemoryEngine({ config: memoryConfig, guildId: channel.guild.id, channelId: channel.id,
        onFailure: () => console.warn('[memory] Storage unavailable; inspect storage before restart.') });
      conversation.rebind(channel.guild.id, channel.id, memoryEngine);
      handleMemoryCommand = memoryCommandsFor(channel.id);
    }
    conversation?.attach(channel.guild.id, channel.id);
    if (passiveMode) void notifyListening(connection, channel, textChannel);
    else listener.start(connection, channel, textChannel);
  },
  onUnavailable: () => { audioCoordinator?.reset(); if (musicEngine) playback.reset(); },
  onAvailable: connection => { if (audioCoordinator && session.connection === connection && audioCoordinator.connection !== connection) audioCoordinator.bind(connection); },
  onReset: () => { audioCoordinator?.reset(); clearTimeout(captureRestartTimer); notified.clear(); listener.reset(); playback.reset(); conversation?.reset();
    if (dynamicVoice) { memoryEngine.close(); handleMemoryCommand = null; }
    llm.forgetConversations(); },
});
const musicCommands = musicEngine ? createMusicCommands({ engine: musicEngine, catalog: musicCatalog,
  guildId: musicConfig.guildId, session,
  isAllowed: id => !IGNORED_USERS.has(id) && (!conversationConfig.enabled || speechAllowed(id) || isConversationOperator(id)),
  isChannelAllowed: (channel, member) => (!conversationConfig.enabled || !dynamicVoice || authorizedVoiceChannel(channel, member)) &&
    ['ViewChannel', 'Connect', 'Speak'].every(p => channel.permissionsFor?.(client.user)?.has(p) === true) &&
    ['ViewChannel', 'Connect'].every(p => channel.permissionsFor?.(member)?.has(p) === true),
}) : null;
if (musicEngine) for (const signal of ['SIGINT', 'SIGTERM']) process.once?.(signal, () => { session.leave('process stopping'); client.destroy(); });
const listener = createListener({
  config: passiveMode ? { ...config, OWW_ENABLED: false } : config,
  console, voice: voiceLib, OpusEncoder, WakeWordEngine, timers: { setInterval, clearInterval },
  session, playback,
  botId: () => client.user.id,
  isIgnored: id => conversationConfig.enabled ? !speechAllowed(id) ||
    (passiveMode && (conversation?.paused || !notified.has(id) || (dynamicVoice && !authorizedVoiceChannel(session.channel)))) : IGNORED_USERS.has(id),
  shouldTranscribe: () => conversationConfig.enabled,
  onUtterance: (...args) => conversation
    ? Promise.resolve(conversation.submit(args[0], args[1], args[6])) : answerer.onUtterance(...args),
  onStuck: userId => answerer.release(userId),
  onDiscard: (...args) => { if (!conversation) wakeBackup.onDiscard(...args); },
  nameOf, wakeLog,
});
setInterval(() => listener.healthReport(), 30000).unref?.();

// Speech to text (whisper.js).
const whisper = createWhisper({ config, fetch, console,
  initialPrompt: passiveMode ? () => wakeSettings.get(conversationConfig.guildId).phrase + '。' : '' });
if (conversationConfig.enabled) {
  const eligible = id => {
    const channel = session.channel;
    if (!channel || channel.id !== activeChannelId() || channel.guild.id !== conversationConfig.guildId) return false;
    const member = channel.members.get(id);
    return speechAllowed(id) && (!passiveMode || notified.has(id)) && (!dynamicVoice || authorizedVoiceChannel(channel)) && !!member && !member.user.bot;
  };
  conversation = (passiveMode ? createPassiveListener : createConversation)({ ...conversationConfig, isAuthorized: eligible,
    getWakeSettings: guildId => wakeSettings.get(guildId),
    beginSpeech: () => audioCoordinator?.beginSpeech() || (() => {}),
    musicCommand: musicCommands ? (command, userId) => {
      const content = musicCommands.voice(command, userId), connection = session.connection, owner = session.generation;
      if (command.action === 'now-playing') playback.say(content, { connection, userId: 'music-status', cache: false,
        wanted: () => session.connection === connection && session.generation === owner });
      return session.textChannel?.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
    } : null,
    memory: memoryEngine, systemBytes: () => Buffer.byteLength(passiveSystemPrompt()),
    prepareInteraction: voiceCore ? (input, context) => voiceCore.prepare(input, context) : null,
    audienceEligible: () => !!session.channel && !session.channel.members.some(m => !m.user.bot && !memoryEngine?.canRead(m.id)),
    hasParticipants: () => session.realMemberCount(session.channel) > 0,
    nameOf, requestBytes: deepSeekConfig?.queryBytes,
    transcribe: (pcm, options) => whisper.transcribe(pcm, passiveMode ? { ...options, language: 'auto', translate: false } : options),
    respond: options => answerDeepSeek({ ...options, llm: options.prepared?.answer !== undefined ?
      { createTurn: ({ signal }) => staticTurn(options.prepared.answer, signal) } : llm, playback, session, fetchTTS, console,
      connection: session.connection, userId: 'shared-conversation', onEvent: diagnostics.responseObserver() }),
    cancelPlayback: () => playback.interrupt('shared-conversation'),
    clearHistory: () => llm.forgetConversations(), disconnect: () => leaveOnRequest('conversation'),
    resetCapture: next => {
      clearTimeout(captureRestartTimer); captureRestartTimer = null;
      listener.reset();
      if (next !== 'DISCONNECTED' && session.connection && (!passiveMode || !conversation.paused)) {
        if (passiveMode) scheduleCapture(session.connection, session.channel, session.textChannel);
        else listener.start(session.connection, session.channel, session.textChannel);
      }
    },
    onEvent: event => { console.log('[conversation]', JSON.stringify(event)); diagnostics.state(event); },
    onTranscript: diagnostics.transcript,
  });
  const stopSharedProcess = () => { conversation.leave(); voiceCore?.close(); memoryEngine?.close(); textCore?.close(); client.destroy(); };
  process.once?.('SIGINT', stopSharedProcess);
  process.once?.('SIGTERM', stopSharedProcess);
}

const handleWakeCommand = passiveMode ? createWakeCommands({ settings: wakeSettings, guildId: conversationConfig.guildId,
  isOperator: isConversationOperator, onChange: () => conversation.command('clear') }) : null;

function memoryCommandsFor(channelId) { const owner = session.generation; return createMemoryCommands({ engine: memoryEngine,
  guildId: conversationConfig.guildId, channelId,
  isCurrent: () => !dynamicVoice || (session.generation === owner && session.channel?.id === channelId),
  isAdmin: (_id, member) => member?.permissions?.has('ManageGuild') === true,
  channel: () => session.channel, cancel: () => conversation.command('clear') }); }
let handleMemoryCommand = memoryEngine && !dynamicVoice ? memoryCommandsFor(conversationConfig.channelId) : null;

function authorizedVoiceChannel(channel, member = null) {
  if (channel?.guild?.id !== conversationConfig.guildId || channel.type !== 2) return false;
  const permissions = channel.permissionsFor?.(client.user);
  return ['ViewChannel', 'Connect', 'Speak'].every(p => permissions?.has(p) === true) &&
    (!member || ['ViewChannel', 'Connect'].every(p => channel.permissionsFor(member)?.has(p) === true));
}

function selectVoiceChannel(action, member, target) {
  if (!ready) return 'Still starting up.';
  if (action === 'move' && !isAdministrator(member?.id, member)) return 'Administrator or configured operator required.';
  if (action === 'join' && session.active) return `Already active in <#${session.channel?.id}>; use /move explicitly.`;
  if (action === 'move' && !session.active) return 'No active session; use /join first.';
  if (!authorizedVoiceChannel(target, member)) return 'Join an authorized ordinary voice channel with View Channel, Connect and Speak permissions for the bot.';
  if (session.active && session.channel?.id === target.id) return `Already active in <#${target.id}>.`;
  if (!session.realMemberCount(target)) return 'An eligible human participant must be present.';
  try {
    const guild = { id: target.guild.id, adapterCreator: target.guild.voiceAdapterCreator };
    const connection = session.join(target, guild);
    session.attach(connection, target, target, guild);
    return `Connecting to <#${target.id}>; transcription waits for connection and visible notice.`;
  } catch { session.leave('Channel transition failed'); return 'Channel transition failed; disconnected.'; }
}

function scheduleCapture(connection, channel, textChannel) {
  clearTimeout(captureRestartTimer); listener.reset();
  const owner = conversation.generation;
  // Receiver removes destroyed subscriptions on close; never resubscribe in the same tick.
  captureRestartTimer = setTimeout(() => {
    captureRestartTimer = null;
    if (session.connection === connection && conversation.generation === owner && !conversation.paused)
      listener.start(connection, channel, textChannel);
  }, 0);
}

// Audio stays gated until the channel-visible notice has actually been sent.
async function notifyListening(connection, channel, textChannel, participant) {
  const owner = conversation.generation, sessionOwner = session.generation;
  const recipients = [...channel.members.values()].filter(m => !m.user.bot && speechAllowed(m.id)).map(m => m.id);
  const wake = wakeSettings.get(channel.guild.id);
  const notice = `被动语音转写：本频道参与者的语音将在本地转写，临时上下文保留最近3分钟/40句；唤醒词“${wake.phrase}”，匹配模式 ${wake.mode}（direct 为句首直接称呼，anywhere 允许句中提及；引号内不唤醒）。/wake show 查看当前设置。匹配后把有限相关上下文发给已启用的DeepSeek，未唤醒时保持静默。/pause 暂停并清空临时上下文，/resume 恢复，/clear-context 清空临时上下文，/status 状态；/opt-out 退出转写并撤回持久化，/opt-in 重新加入临时转写；/stop 断开。不保存原始录音或后台转写日志。\n` + historyNotice(memoryEngine);
  try {
    await channel.send({ content: participant ? `<@${participant}> ${notice}` : notice,
      allowedMentions: { parse: [], users: participant ? [participant] : [] } });
    if (session.connection !== connection || session.generation !== sessionOwner || conversation.generation !== owner || conversation.paused) return;
    if (dynamicVoice && !authorizedVoiceChannel(channel)) { session.leave('Voice permissions changed'); return; }
    for (const id of recipients) if (channel.members.get(id) && speechAllowed(id)) notified.add(id);
    scheduleCapture(connection, channel, textChannel);
  } catch { if (session.connection === connection && conversation.generation === owner) conversation.command('pause'); }
}

async function setParticipantOptOut(id, exclude) {
  if (exclude) optedOut.add(id); else optedOut.delete(id);
  notified.delete(id); conversation.command('clear');
  if (exclude) {
    try { memoryEngine?.withdraw(id); }
    catch { console.warn('[memory] Withdrawal deletion incomplete; storage disabled; operator recovery required.'); return false; }
  }
  if (!exclude && session.connection && !conversation.paused)
    await notifyListening(session.connection, session.channel, session.textChannel, id);
  return true;
}

function conversationStatus() {
  return { ...conversation.status(), guild: session.channel?.guild?.id || null, channel: session.channel?.id || null,
    connectionState: session.connection?.state.status || (session.active ? 'connecting' : 'disconnected'),
    participants: session.realMemberCount(session.channel), subscriptions: session.connection?.receiver.subscriptions.size || 0,
    playback: playback.busy, requestCount: conversationRequests,
    persistentMemory: memoryEngine?.status(),
    memory: process.memoryUsage?.(), cpu: process.cpuUsage?.(), uptimeSeconds: process.uptime?.() };
}
if (diagnosticEnabled) {
  const started = process.hrtime.bigint();
  setInterval(() => {
    const crypto = session.cryptoState();
    diagnostics.emit('resources', { ...conversation.status(), requestCount: conversationRequests,
      memory: process.memoryUsage(), cpu: process.cpuUsage(), elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
      subscriptions: session.connection?.receiver.subscriptions.size || 0, playback: playback.busy,
      dave: [...conversationConfig.users].map(id => ({ user: id, verdict: session.cryptoVerdict(crypto, id)?.text })) });
  }, 5000).unref();
}

// A second chance for the wake word (WAKE_WHISPER_BACKUP) and, optionally, a
// measurement of its misses (WAKE_SHADOW): Whisper also checks what the wake-word model
// rejected (wake-backup.js). Both off by default.
const wakeBackup = createWakeBackup({
  config, console, whisper, nameOf, wakeLog,
  onWake: (...args) => { if (!conversation) return answerer.answerMissedWake(...args); },
});
  if (config.WAKE_SHADOW && !conversationConfig.enabled) setInterval(() => wakeBackup.report(), config.WAKE_SHADOW_REPORT_MS).unref?.();

// From an utterance to Luna's spoken answer (voice-answer.js, whisper.js).
const answerer = createVoiceAnswerer({
  config, console, llm, playback, session, fetchTTS,
  whisper,
  sendCommand: (channel, command, requesterId) => sendSmakbotCommand(channel, command, requesterId),
  leave: userId => leaveOnRequest(userId),
  expectQuestion: (userId, ms, why) => listener.expectQuestion(userId, ms, why),
  nowPlaying, nameOf, wakeLog,
});

// Her intro, join greetings and farewells (announce.js).
const announcer = createAnnouncer({
  config, console, session, playback, fetchTTS, fetchTTSInVoice, checkElevenLabsVoice,
  isIgnored: id => IGNORED_USERS.has(id), wakeLabel: WAKE_LABEL,
});

// !luna is refused until startup finishes. A capture created before the wake
// word models load runs without detection until its stream next restarts.
let ready = false;

client.on(Events.ClientReady, async () => {
  if (musicCatalog) {
    try { console.log(`[music] authorized tracks=${await musicCatalog.load()}`); }
    catch { console.warn('[music] Catalog unavailable or invalid; music library remains empty.'); }
    if (process.env.CONVERSATION_REGISTER_COMMANDS === 'true' || process.env.MUSIC_REGISTER_COMMANDS === 'true') {
      try { await client.guilds.cache.get(musicConfig.guildId).commands.create(musicCommandDefinition); }
      catch { console.warn('[music] Guild command registration failed'); }
    }
  }
  if (fishTextConfig.enabled && fishTextConfig.register) {
    try { await client.guilds.cache.get(fishTextConfig.guildId).commands.create(fishCommandDefinition); }
    catch { console.warn('[text] Command registration failed'); }
  }
  if (!await llm.resolveModel()) process.exit(1);
  await listener.initWakeWord();
  console.log(`[tts] ${describeTTS()}`);
  if (!conversation) announcer.describeCustomGreetings();
  if (conversation && process.env.CONVERSATION_REGISTER_COMMANDS === 'true') {
    const guild = client.guilds.cache.get(conversationConfig.guildId);
    try {
      const commands = [['stop', 'Emergency disconnect'], ['interrupt', 'Cancel response, keep context'],
        ['end-conversation', 'Clear context and return to listening'], ['conversation-status', 'Show conversation state']];
      if (passiveMode) commands.push(['pause', 'Pause transcription and clear context'], ['resume', 'Resume local transcription'],
        ['clear-context', 'Clear temporary transcripts'], ['status', 'Show listener state'], ['opt-out', 'Exclude my speech'], ['opt-in', 'Include my speech again']);
      for (const [name, description] of commands)
        await guild.commands.create({ name, description });
      if (dynamicVoice) {
        await guild.commands.create({ name: 'join', description: 'Join your authorized voice channel' });
        await guild.commands.create({ name: 'move', description: 'Move the voice session (administrator/operator)', options: [
          { type: 7, name: 'channel', description: 'Destination voice channel', required: true, channel_types: [2] }] });
        await guild.commands.create({ name: 'leave', description: 'Disconnect and clear transient voice context' });
      }
      if (passiveMode) {
        await guild.commands.create(memoryCommandDefinition);
        await guild.commands.create(wakeCommandDefinition);
      }
    } catch { console.warn('[conversation] Slash registration failed; text controls remain available'); }
  }
  console.log(`[search] web search: ${llm.describeSearch()}`);
  if (LLM_TOOLS_ON) startLlmTools();
  ready = true;
  checkAutoJoin();
  scheduleAutoJoin();
  console.log(`Ready! Wake phrase: "${passiveMode ? wakeSettings.get(conversationConfig.guildId).phrase : WAKE_LABEL}"  •  text command: ${BOT_COMMAND}`);
});

// ─── Text commands ────────────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (handleWakeCommand && await handleWakeCommand(interaction)) return;
  if (musicCommands && await musicCommands.interaction(interaction)) return;
  if (interaction.isChatInputCommand?.() && handleFishText && await handleFishText(interaction)) return;
  if (!conversation || !interaction.isChatInputCommand?.()) return;
  if (dynamicVoice && ['join', 'move', 'leave', 'memory'].includes(interaction.commandName)) {
    const reply = content => interaction.reply({ content, flags: 64, allowedMentions: { parse: [] } }).catch(() => {});
    if (interaction.guildId !== conversationConfig.guildId) return reply('Voice controls are restricted to the configured server.');
    if (['join', 'move'].includes(interaction.commandName)) {
      const member = interaction.guild?.members?.cache?.get(interaction.user.id) || interaction.member;
      const target = interaction.commandName === 'join' ? member?.voice?.channel : interaction.options?.getChannel('channel');
      return reply(selectVoiceChannel(interaction.commandName, member, target));
    }
    if (interaction.commandName === 'leave') {
      if (!canControlConversation(interaction.user.id, interaction.member)) return reply('Join the active channel or use an operator account.');
      conversation.leave(); return reply('Disconnected; transient context cleared.');
    }
    if (!handleMemoryCommand) return reply('No active voice memory scope; join a channel first.');
  }
  if (handleMemoryCommand && await handleMemoryCommand(interaction)) return;
  if (interaction.guildId !== conversationConfig.guildId || !canControlConversation(interaction.user.id, interaction.member)) {
    diagnostics.emit('controlDenied', { user: interaction.user.id, guild: interaction.guildId,
      reason: interaction.guildId !== conversationConfig.guildId ? 'wrong-guild' : 'not-enrolled' });
    return interaction.reply({ content: 'This control is restricted to the consenting test participants.', flags: 64 }).catch(() => {});
  }
  if (interaction.commandName !== 'stop' && !isAdministrator(interaction.user.id, interaction.member) && interaction.member?.voice?.channelId !== activeChannelId())
    return interaction.reply({ content: 'Join the authorized voice channel to use this control.', flags: 64 }).catch(() => {});
  const action = { stop: 'stop', interrupt: 'interrupt', 'end-conversation': 'end',
    ...(passiveMode ? { pause: 'pause', resume: 'resume', 'clear-context': 'clear' } : {}) }[interaction.commandName];
  if (passiveMode && ['resume', 'clear-context'].includes(interaction.commandName) && !isAdministrator(interaction.user.id, interaction.member))
    return interaction.reply({ content: 'Administrator or configured operator required.', flags: 64 }).catch(() => {});
  if (passiveMode && ['opt-out', 'opt-in'].includes(interaction.commandName)) {
    if (interaction.member?.voice?.channelId !== activeChannelId()) return;
    if (!await setParticipantOptOut(interaction.user.id, interaction.commandName === 'opt-out'))
      return interaction.reply({ content: 'Transcription stopped. Persistent deletion is incomplete; operator storage recovery required.', flags: 64 }).catch(() => {});
  } else if (action) {
    if (passiveMode && action === 'resume') notified.clear();
    conversation.command(action);
    if (passiveMode && action === 'resume' && session.connection) await notifyListening(session.connection, session.channel, session.textChannel);
  } else if (!['conversation-status', ...(passiveMode ? ['status'] : [])].includes(interaction.commandName)) return;
  return interaction.reply({ content: JSON.stringify(conversationStatus()), flags: 64 }).catch(() => {});
});

client.on(Events.MessageCreate, async message => {
  if (dynamicVoice && message.content.trim().toLowerCase() === BOT_COMMAND) {
    if (message.author?.bot || message.guild?.id !== conversationConfig.guildId) return;
    return message.reply(selectVoiceChannel('join', message.member, message.member?.voice?.channel)).catch(() => {});
  }
  if (conversation) {
    if (!message.author?.bot && /^(?:!luna(?:\s|$)|\/stop$)/i.test(message.content.trim()))
      diagnostics.emit('textControlReceived', { user: message.author?.id, guild: message.guild?.id,
        voiceChannel: message.member?.voice?.channelId, enrolled: conversationConfig.users.has(message.author?.id) });
    if (message.author?.bot || message.guild?.id !== conversationConfig.guildId || !canControlConversation(message.author?.id, message.member)) return;
    if (passiveMode && /^!luna opt-(?:in|out)$/i.test(message.content.trim())) {
      if (message.member?.voice?.channelId !== activeChannelId()) return;
      await setParticipantOptOut(message.author.id, /out$/i.test(message.content.trim())); return;
    }
    const action = new Map([['/stop', 'stop'], ['!luna stop', 'stop'], ['!luna interrupt', 'interrupt'], ['!luna end', 'end'],
      ...(passiveMode ? [['!luna pause', 'pause'], ['!luna resume', 'resume'], ['!luna clear-context', 'clear']] : [])]).get(message.content.trim().toLowerCase());
    if (action) {
      if (action !== 'stop' && !isAdministrator(message.author?.id, message.member) && message.member?.voice?.channelId !== activeChannelId()) return;
      if (passiveMode && ['resume', 'clear'].includes(action) && !isAdministrator(message.author?.id, message.member)) return;
      if (passiveMode && action === 'resume') notified.clear();
      conversation.command(action);
      if (passiveMode && action === 'resume' && session.connection) await notifyListening(session.connection, session.channel, session.textChannel);
      return;
    }
    if (passiveMode && message.content.trim().toLowerCase() === '!luna status') return message.reply(JSON.stringify(conversationStatus())).catch(() => {});
  }
  if (llm.provider !== 'deepseek' && textChat.onMessage(message)) return;
  if (message.content.toLowerCase().trim() === `${BOT_COMMAND} voicecheck`) return voiceCheck(message);
  // "!luna wakestats [7d|12h]": how well the wake word works for each person.
  const statsMatch = message.content.trim().match(new RegExp(`^${BOT_COMMAND}\\s+wakestats(?:\\s+(\\d+)\\s*([dh]))?\\s*$`, 'i'));
  if (statsMatch) return wakeStats(message, statsMatch[1] ? Number(statsMatch[1]) : 24, (statsMatch[2] || 'h').toLowerCase());
  // "!luna say <text>": exactly those words, out loud, no LLM.
  const sayMatch = message.content.trim().match(new RegExp(`^${BOT_COMMAND}\\s+say\\s+([\\s\\S]+)$`, 'i'));
  if (conversation && sayMatch) return;
  if (sayMatch && !message.author?.bot) {
    const who = message.member?.displayName || message.author?.username || 'someone';
    if (!sayInVoice(sayMatch[1], message.author?.id || 'text', who)) {
      message.reply("I'm not in a voice channel.").catch(() => {});
    } else {
      message.react('🔊').catch(() => {});
    }
    return;
  }
  if (message.content.toLowerCase().trim() === `${BOT_COMMAND} leave`) {
    message.reply('Bye!').catch(() => {});
    return leaveOnRequest(message.author?.id);
  }
  if (message.content.toLowerCase().trim() !== BOT_COMMAND) return;
  // .catch: a rejected reply (e.g. no send permission) in an async listener is
  // an unhandled rejection, which terminates Node.
  if (!ready) return message.reply('Still starting up — try again in a few seconds.').catch(() => {});

  if (passiveMode && !isAdministrator(message.author?.id, message.member))
    return message.reply('An administrator or configured operator must enable this channel session.').catch(() => {});
  const channel = conversation && isAdministrator(message.author?.id, message.member)
    ? [...(client.guilds.cache.get(conversationConfig.guildId)?.channels.cache.values() || [])].find(c => c.id === activeChannelId())
    : message.member?.voice?.channel;
  if (conversation && (channel?.id !== activeChannelId() || channel?.guild?.id !== conversationConfig.guildId)) return;
  if (!channel) return message.reply('You need to join a voice channel first!').catch(() => {});
  if (conversation && session.realMemberCount(channel) === 0)
    return message.reply('A consenting speaker must enter the configured test voice channel first.').catch(() => {});

  autoJoinPaused = false;   // asked to join: auto-join may follow people again
  const guild = { id: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator };
  // Returns the guild's existing connection if there is one, moving it to
  // `channel` when that differs.
  const connection = session.join(channel, guild);

  if (connection === session.connection) {
    if (session.channel?.id === channel.id) {
      message.reply(`Already listening in **${channel.name}**.`).catch(() => {});
      return;
    }
    // !luna from another channel: session.join() just moved Luna there.
    // Listening carries over (it is per connection, not per channel); only
    // the channel she announces and counts members in changes.
    console.log(`[voice] moved to ${channel.name} by !luna`);
    session.moveTo(channel);
    message.reply(`Moved to **${channel.name}**!`).catch(() => {});
    if (!conversation) announcer.introduce(connection);
    return;
  }

  session.attach(connection, channel, message.channel, guild, () => {
    message.reply(conversation ? (passiveMode ? 'Joined the configured channel. Passive local transcription; say “大肥鱼” explicitly to request one reply. /pause pauses, /stop disconnects.' : 'Joined the configured test channel. Say "Hey Luna" to start; /stop disconnects.') : (
      `Joined **${channel.name}**! Say "${WAKE_LABEL}" to wake me up. ` +
      `Also, you can say "${WAKE_LABEL}, play song ___" to play music, ` +
      `or "${WAKE_LABEL}, skip" and "${WAKE_LABEL}, stop" to control it.`
    )).catch(() => {});
    if (!conversation) announcer.introduce(connection);
  });
});

// `!luna voicecheck`: per-person answer to "can Luna decrypt them?", plus the
// voice privacy code to compare with the one Discord shows in the call's
// encryption details — if they differ, Luna's whole session is out of sync.
function voiceCheck(message) {
  if (!session.connection || !session.channel) return message.reply("I'm not in a voice channel.").catch(() => {});
  const crypto = session.cryptoState();
  if (!crypto) return message.reply('Encryption details are unavailable (unencrypted call, or the voice library changed).').catch(() => {});
  const lines = [`**Voice encryption:** ${crypto.status}, epoch ${crypto.epoch ?? '-'}` +
    (crypto.privacyCode ? ` — privacy code \`${crypto.privacyCode}\` (should match the code Discord shows for this call)` : '')];
  for (const member of session.channel.members.values()) {
    if (member.user.bot) continue;
    const v = session.cryptoVerdict(crypto, member.id);
    lines.push(`${v.problem ? '⚠️' : '✅'} ${member.displayName}: ${v.text}`);
  }
  console.log(`[voice] voicecheck: ${lines.slice(1).join(' | ')}`);
  return message.reply(lines.join('\n')).catch(() => {});
}

// ─── Tools for the LLM (music, leaving) ───────────────────────────────────────
//
// Besides the fixed commands below, the LLM can play, skip and stop music and
// leave the channel itself (llm-tools.js): Luna serves the tools over MCP on
// LUNA_MCP_PORT, LM Studio knows them from its mcp.json as "luna", and every
// request offers them as mcp/luna. When a call succeeds, Luna acts on it (the
// onTool handlers in voice-answer.js and text-chat.js). Offering them, and leaving
// them out while LM Studio can't reach them, is answer-llm.js's job.
const LLM_TOOLS_ON    = !musicEngine && llm.provider !== 'deepseek' && config.LLM_TOOLS;
const LUNA_MCP_PORT   = config.LUNA_MCP_PORT;

function startLlmTools() {
  // say_in_voice tells the model the truth about whether anything was said.
  // list_top_songs asks smakbot.
  const runs = {
    say_in_voice: () => session.connection
      ? `Said in ${session.channel?.name || 'the voice channel'}.`
      : 'You are not in a voice channel, so nothing was said. Tell them that.',
    list_top_songs: async ({ count }) => nowPlaying.listForModel(
      await nowPlaying.topSongs(Math.min(50, Math.max(1, Math.round(Number(count)) || 10)))),
  };
  const tools = LLM_TOOLS.map(t => runs[t.name] ? { ...t, run: runs[t.name] } : t);
  const server = createMcpServer({ tools });
  http.createServer((req, res) => server.handle(req, res).catch(() => { try { res.writeHead(500).end(); } catch (_) {} }))
    .on('error', err => console.error(`[tools] tools server failed on port ${LUNA_MCP_PORT}: ${err.message} — LLM tools off`))
    .listen(LUNA_MCP_PORT, '0.0.0.0', () => console.log(
      `[tools] ${[...LLM_TOOL_NAMES].join(', ')} offered to the LLM as ${TOOLS_PLUGIN_ID} ` +
      `(LM Studio's mcp.json needs "luna": {"url": "http://127.0.0.1:${LUNA_MCP_PORT}/mcp"})`));
}

// ─── Leaving on request ───────────────────────────────────────────────────────

// An explicit leave disables auto-join until someone explicitly types !luna.
let autoJoinPaused = false;

function leaveOnRequest(userId) {
  const who = speakableName(session.channel?.members?.get(userId)?.displayName) || userId;
  autoJoinPaused = true;
  clearTimeout(autoJoinTimer);
  autoJoinTimer = null;
  autoJoiningUntil = 0;
  session.leave(`asked to leave by ${who}`);
}

// Posts a smakbot command (commands.js) in the text channel, summoning smakbot
// first if it isn't in the voice channel, credited to whoever asked
// (requesterId). Used by the fixed commands and by the LLM's music tools, by
// voice and by text.
function sendSmakbotCommand(channel, command, requesterId = null) {
  // Legacy model tools must never become privileged internal music commands.
  if (musicEngine) return Promise.resolve();
  const musicBotPresent = !!session.channel?.members?.some(m => m.user.username.toLowerCase().includes('smakbot'));
  return postSmakbotCommand(channel, command, { musicBotPresent, console, requesterId });
}

client.on(Events.Error, console.warn);

// Tracks Luna being moved, announces joins and leaves, and disconnects when the
// last real user (non-bot, non-ignored) leaves.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (conversation && newState.guild.id !== conversationConfig.guildId) return;
  // Luna herself was dragged to another channel by someone. (A kick or a lost
  // connection is handled by voice-session.js; !luna updates this itself.)
  if (newState.id === client.user.id) {
    if (conversation && ((newState.channelId && newState.channelId !== activeChannelId()) ||
        (!newState.channelId && session.connection))) { conversation.leave(); return; }
    if (dynamicVoice && newState.channelId) session.confirmChannel(newState.guild.id, newState.channelId);
    if (session.connection && newState.channelId && newState.channelId !== session.channel?.id) {
      session.moveTo(newState.channel);
      console.log(`[voice] moved to ${newState.channel.name}`);
      if (session.realMemberCount(session.channel) === 0) session.leave('Moved into an empty channel');
    }
    return;
  }

  if (passiveMode && session.connection && newState.channelId === activeChannelId() && oldState.channelId !== newState.channelId &&
      !newState.member?.user?.bot && !conversation.paused) {
    conversation.command('clear');
    if (speechAllowed(newState.id)) void notifyListening(session.connection, session.channel, session.textChannel, newState.id);
  }
  if (conversation && oldState.channelId === activeChannelId() && newState.channelId !== activeChannelId()) {
    notified.delete(newState.id);
    conversation.memberLeft(newState.id);
  }
  if (!conversation) { announcer.onJoin(oldState, newState); announcer.onLeave(oldState, newState); }

  // Someone joined a voice channel while Luna is in none: maybe one to
  // auto-join (scheduleAutoJoin checks).
  if (!session.connection && newState.channelId && newState.channelId !== oldState.channelId) scheduleAutoJoin();

  if (!session.channel || oldState.channelId !== session.channel.id) return;
  if (session.realMemberCount(session.channel) === 0) {
    session.leave('Last real user left');
    scheduleAutoJoin();   // people may be waiting in another auto-join channel
  }
});

// ─── Text chat ────────────────────────────────────────────────────────────────
//
// Typed questions in TEXT_CHAT_CHANNELS (text-chat.js).
const textChat = createTextChat({
  config, llm, console, command: BOT_COMMAND,
  botId: () => client.user.id,
  isReady: () => ready,
  inChannels: channel => named(channel, config.TEXT_CHAT_CHANNELS),
  sendCommand: sendSmakbotCommand,
  sayInVoice: (text, userId, who) => sayInVoice(text, userId, who),
  voiceChannelName: () => (session.connection ? session.channel?.name || 'the voice channel' : null),
  nowPlaying,
});

// "!luna wakestats": the wake-word log (wake-log.js) summed up per person.
async function wakeStats(message, amount, unit) {
  const hours = Math.min(unit === 'd' ? amount * 24 : amount, 90 * 24) || 24;
  const span = hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} h`;
  const text = await wakeLog.summary(Date.now() - hours * 3600000).catch(err => `Couldn't read the wake-word log: ${err.message}`);
  message.reply(`**Wake word, last ${span}**\n${text}`.slice(0, 1990)).catch(() => {});
}

// Speaks a line in the voice channel on someone's behalf (say_in_voice, or
// "!luna say …"). Queued like their own answer — after whatever is playing,
// superseded if they then ask something by voice — not interrupting anyone.
// Returns false when she isn't in a voice channel.
function sayInVoice(text, userId, who) {
  const connection = session.connection;
  const line = String(text || '').trim().slice(0, SAY_MAX_CHARS);
  if (!connection || !line) return false;
  console.log(`[text] ${who} had Luna say: ${JSON.stringify(line)}`);
  // Their current generation: after whatever of theirs is already queued.
  playback.say(line, { connection, userId, generation: playback.generationOf(userId) ?? playback.nextGeneration(userId),
                       wanted: () => session.connection === connection, cache: false });
  return true;
}

// ─── Auto-join ────────────────────────────────────────────────────────────────
//
// AUTO_JOIN_CHANNELS: voice channels (names or IDs) Luna joins by herself when
// someone is in one and she is in no channel — at startup, or when someone
// joins. With people in several, the busiest. She posts (status messages,
// smakbot commands) in AUTO_JOIN_TEXT_CHANNEL. She still leaves when the last
// person does, and a kick is respected: she comes back only when someone next
// joins. A short delay lets someone who pops in and straight out not summon her.
const AUTO_JOIN_CHANNELS     = conversation ? [] : config.AUTO_JOIN_CHANNELS;
const AUTO_JOIN_TEXT_CHANNEL = config.AUTO_JOIN_TEXT_CHANNEL;
const AUTO_JOIN_DELAY_MS     = 2000;
let autoJoinTimer = null;
let autoJoiningUntil = 0;   // a join in progress (not Ready yet): don't start another

const named = (channel, wanted) => wanted.some(w => w === channel.id || w.toLowerCase() === String(channel.name).toLowerCase());
const guildChannels = guild => [...(guild.channels?.cache?.values() ?? [])];
const textChannelFor = guild => AUTO_JOIN_TEXT_CHANNEL
  ? guildChannels(guild).find(c => !c.isVoiceBased?.() && c.isTextBased?.() && named(c, [AUTO_JOIN_TEXT_CHANNEL])) : null;

// At startup: say which settings match nothing, and what does exist.
function checkAutoJoin() {
  if (!AUTO_JOIN_CHANNELS.length) return;
  const guilds = [...(client.guilds?.cache?.values() ?? [])];
  const all = guilds.flatMap(guildChannels);
  const voices = all.filter(c => c.isVoiceBased?.()), texts = all.filter(c => !c.isVoiceBased?.() && c.isTextBased?.());
  const missing = AUTO_JOIN_CHANNELS.filter(w => !voices.some(c => named(c, [w])));
  if (missing.length) console.warn(`[voice] AUTO_JOIN_CHANNELS: no voice channel ${missing.map(m => `"${m}"`).join(', ')} — ` +
    `voice channels: ${voices.map(c => c.name).join(', ') || 'none'}`);
  if (!guilds.some(textChannelFor)) console.warn(`[voice] AUTO_JOIN_TEXT_CHANNEL ${AUTO_JOIN_TEXT_CHANNEL ? `"${AUTO_JOIN_TEXT_CHANNEL}" not found` : 'not set'} — ` +
    `she will post in the voice channel's own chat. Text channels: ${texts.map(c => c.name).join(', ') || 'none'}`);
  console.log(`[voice] auto-join: ${AUTO_JOIN_CHANNELS.join(', ')}`);
}

function scheduleAutoJoin() {
  if (!AUTO_JOIN_CHANNELS.length || autoJoinPaused) return;
  clearTimeout(autoJoinTimer);
  autoJoinTimer = setTimeout(autoJoin, AUTO_JOIN_DELAY_MS);
}

function autoJoin() {
  if (!ready || session.active || autoJoinPaused || Date.now() < autoJoiningUntil) return;
  const candidates = [...(client.guilds?.cache?.values() ?? [])].flatMap(guild => guildChannels(guild)
    .filter(c => c.isVoiceBased?.() && named(c, AUTO_JOIN_CHANNELS))
    .map(channel => ({ guild, channel, people: session.realMemberCount(channel) })))
    .filter(c => c.people > 0)
    .sort((a, b) => b.people - a.people);
  if (!candidates.length) return;
  const { guild, channel, people } = candidates[0];
  const g = { id: guild.id, adapterCreator: guild.voiceAdapterCreator };
  console.log(`[voice] auto-joining ${channel.name} (${people} ${people === 1 ? 'person' : 'people'} there)`);
  autoJoiningUntil = Date.now() + 15000;
  const connection = session.join(channel, g);
  session.attach(connection, channel, textChannelFor(guild) || channel, g, () => { autoJoiningUntil = 0; announcer.introduce(connection); });
}

void client.login(config.DISCORD_TOKEN || undefined);
