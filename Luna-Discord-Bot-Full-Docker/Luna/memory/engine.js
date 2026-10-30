const path = require('node:path');
const fs = require('node:fs');
const { MemoryStore, DAY, integer } = require('./store');
const { createCharacter } = require('./character');
const { buildContext, MEMORY_RULES } = require('./context');

function loadMemoryConfig(env = process.env) {
  const number = (key, fallback, min, max) => integer(Number(env[key] ?? fallback), min, max);
  for (const key of ['MEMORY_STORAGE_ENABLED', 'MEMORY_POLICY_REVIEWED', 'MEMORY_ENCRYPTED_STORAGE_CONFIRMED'])
    if (env[key] !== undefined && !['true', 'false'].includes(env[key])) throw new Error(`Invalid ${key}`);
  const enabled = env.MEMORY_STORAGE_ENABLED === 'true';
  let privacyUrl = '';
  if (enabled) {
    try { const url = new URL(env.MEMORY_PRIVACY_URL); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); privacyUrl = url.href; }
    catch { throw new Error('Persistence requires a public HTTPS MEMORY_PRIVACY_URL'); }
    if (env.MEMORY_POLICY_REVIEWED !== 'true' || env.MEMORY_ENCRYPTED_STORAGE_CONFIRMED !== 'true')
      throw new Error('Persistence requires reviewed policy and verified encrypted storage');
  }
  return { enabled, privacyUrl, filename: env.MEMORY_DB_PATH || path.join(__dirname, '..', 'data', 'memory.sqlite'),
    characterDir: env.MEMORY_CHARACTER_DIR || path.join(__dirname, '..', 'character'),
    retentionMs: number('MEMORY_RETENTION_MS', DAY, 60000, 30 * DAY),
    summaryRetentionMs: number('MEMORY_SUMMARY_RETENTION_MS', DAY, 60000, 30 * DAY),
    utcOffsetMinutes: number('MEMORY_UTC_OFFSET_MINUTES', 0, -720, 840),
    totalTokens: number('MEMORY_TOTAL_TOKENS', 8192, 4096, 16384),
    workingTokens: number('MEMORY_WORKING_TOKENS', 1200, 256, 4000),
    episodeTokens: number('MEMORY_EPISODE_TOKENS', 1000, 256, 4000),
    memoryTokens: number('MEMORY_APPROVED_TOKENS', 500, 128, 2000),
    identityBytes: number('MEMORY_IDENTITY_BYTES', 3000, 1000, 4000) };
}

function createMemoryEngine({ config, guildId, channelId, now = Date.now, timers = globalThis, onFailure = () => {} }) {
  const character = createCharacter(config.characterDir, config.identityBytes);
  let store = null, session = null, failed = false, closed = false;
  const recoveryFile = config.enabled && config.filename !== ':memory:' ? config.filename + '.recovery-required' : null;
  const markRecovery = () => { if (recoveryFile) fs.writeFileSync(recoveryFile, 'Memory recovery required before persistent restart. Reconcile pending deletions and consent.\n', { mode: 0o600 }); };
  function fail(error) {
    failed = true;
    try { markRecovery(); } catch { /* Storage may be unwritable; operator recovery is still required. */ }
    try { store?.close(); } catch {}
    store = null; session = null; onFailure(error);
  }
  const safely = (fn, fallback) => { try { return fn(); } catch (error) { fail(error); return fallback; } };
  if (config.enabled) safely(() => {
    if (recoveryFile && fs.existsSync(recoveryFile)) throw new Error('Memory recovery marker present');
    store = new MemoryStore({ filename: config.filename, guildId, channelId, now, retentionMs: config.retentionMs, summaryRetentionMs: config.summaryRetentionMs });
  });
  let timer = null;
  function scheduleCleanup(delay) {
    timer = timers.setTimeout(() => {
      const removed = safely(() => store?.cleanup(), 0);
      if (!closed && store) scheduleCleanup(removed === 25 ? 250 : 60000);
    }, delay);
    timer?.unref?.();
  }
  if (store) scheduleCleanup(60000);
  const engine = {
    character, config, get store() { return store; },
    instructions: () => character.instructions() + '\n' + MEMORY_RULES,
    status: () => safely(() => ({ backend: failed ? 'unavailable' : store ? 'sqlite' : 'disabled',
      historyEnabled: !!store?.settings().enabled, retentionMs: store?.settings().retention_ms ?? config.retentionMs,
      summarization: 'explicit extractive candidates through text /summary; owner review required', sessionActive: !!session }), { backend: 'unavailable', historyEnabled: false }),
    ticket: (speaker, startedAt) => safely(() => store?.ticket(speaker, startedAt) || null, null),
    canRead: speaker => safely(() => store?.canRead(speaker) || false, false),
    startSession() { character.resetState(); safely(() => { if (session) store?.endSession(session); session = store?.startSession() || null; }); },
    endSession() { character.resetState(); safely(() => store?.endSession(session)); session = null; },
    record(entry) { return safely(() => !!(entry.ticket && store && session && store.append({ ...entry, session })), false); },
    withdraw(speaker) {
      if (!store) { if (config.enabled) throw new Error('Memory unavailable: deletion pending operator recovery'); return; }
      try {
        // A crash or lock during withdrawal must not silently restore old consent on restart.
        markRecovery(); store.withdraw(speaker);
        if (recoveryFile) fs.unlinkSync(recoveryFile);
      } catch (error) { fail(error); throw new Error('Deletion incomplete: memory disabled; operator recovery required'); }
    },
    context(input) {
      const args = { ...config, ...input, now: now(), store };
      try { return buildContext(args); }
      catch (error) { fail(error); return buildContext({ ...args, store: null, audienceEligible: false }); }
    },
    unavailable: fail,
    close() { if (closed) return; closed = true; timers.clearTimeout(timer); engine.endSession(); safely(() => store?.close()); store = null; },
  };
  return engine;
}
module.exports = { createMemoryEngine, loadMemoryConfig };
