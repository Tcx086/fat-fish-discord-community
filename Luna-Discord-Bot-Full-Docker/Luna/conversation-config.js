function loadConversationConfig(env = process.env) {
  const enabled = env.CONVERSATION_ENABLED === 'true';
  const mode = env.CONVERSATION_MODE || 'passive';
  if (!['passive', 'active'].includes(mode)) throw new Error('Invalid CONVERSATION_MODE');
  const allParticipants = mode === 'passive' && env.CONVERSATION_ALL_PARTICIPANTS !== 'false';
  if (env.CONVERSATION_ALL_PARTICIPANTS && !['true', 'false'].includes(env.CONVERSATION_ALL_PARTICIPANTS)) throw new Error('Invalid CONVERSATION_ALL_PARTICIPANTS');
  if (env.CONVERSATION_ENABLED && !['true', 'false'].includes(env.CONVERSATION_ENABLED)) throw new Error('Invalid CONVERSATION_ENABLED');
  const ids = (env.CONVERSATION_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  const operatorIds = (env.CONVERSATION_OPERATOR_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  const guildId = env.CONVERSATION_GUILD_ID || '100000000000000104';
  const dynamicChannels = enabled && mode === 'passive';
  const channelId = env.CONVERSATION_CHANNEL_ID || (dynamicChannels ? null : '100000000000000103');
  if (enabled && ((!allParticipants && !ids.length) || ids.length > 16 || operatorIds.length > 16 ||
      (mode === 'passive' && !env.CONVERSATION_GUILD_ID) ||
      ![guildId, ...(channelId ? [channelId] : []), ...ids, ...operatorIds].every(x => /^\d{17,20}$/.test(x))))
    throw new Error('Conversation requires valid target and consenting user IDs');
  const inactivityMs = Number(env.CONVERSATION_IDLE_MS || 45000);
  const maxTurns = Number(env.CONVERSATION_MAX_TURNS || 12);
  const requestLimit = Number(env.CONVERSATION_REQUEST_LIMIT || 12);
  if (!Number.isSafeInteger(inactivityMs) || inactivityMs < 1000 || inactivityMs > 300000 ||
      !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 32 ||
      !Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 64) throw new Error('Invalid conversation limits');
  const integer = (key, fallback, min, max) => {
    const raw = env[key] ?? String(fallback), value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  return { enabled, mode, dynamicChannels, allParticipants, guildId, channelId, users: new Set(ids), operators: new Set(operatorIds), inactivityMs, maxTurns, requestLimit,
    ageMs: integer('CONVERSATION_CONTEXT_MS', 180000, 1000, 180000),
    maxEntries: integer('CONVERSATION_CONTEXT_ENTRIES', 40, 1, 40),
    maxChars: integer('CONVERSATION_CONTEXT_CHARS', 6000, 256, 12000),
    // Legacy setting remains parseable; name-only speech now answers without a follow-up window.
    waitingMs: integer('CONVERSATION_QUESTION_MS', 8000, 1000, 8000),
    maxPending: integer('CONVERSATION_PENDING', 6, 3, 6),
    sttTimeoutMs: integer('CONVERSATION_STT_TIMEOUT_MS', 15000, 1000, 30000),
    staleMs: integer('CONVERSATION_STALE_MS', 15000, 1000, 30000) };
}
module.exports = { loadConversationConfig };
