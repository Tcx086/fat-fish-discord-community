const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildEnvironment } = require('../../../tools/windows/start.cjs');
const { loadConversationConfig } = require('../conversation-config');
const { loadDeepSeekConfig } = require('../deepseek-config');
const { createDeepSeek } = require('../deepseek');
const settings = { guildId: '100000000000000104', botId: '', operatorIds: '100000000000000105', enableDeepSeek: false };

test('Windows profile clears fixed channel, enrolls humans and keeps privacy/provider gates despite old env', () => {
  const env = buildEnvironment(settings, { CONVERSATION_CHANNEL_ID: '100000000000000103', MEMORY_STORAGE_ENABLED: 'true',
    SEARCH_ENABLED: 'true', DEEPSEEK_ENABLED: 'true', AUTO_JOIN_CHANNELS: 'busy', FAT_FISH_TEXT_ENABLED: 'true', TTS_PROVIDER: 'elevenlabs',
    MAX_SPEECH_MS: '11000' }, { discord: 'synthetic-token', deepseek: 'synthetic-key' });
  assert.equal(loadConversationConfig(env).dynamicChannels, true); assert.equal(loadConversationConfig(env).allParticipants, true);
  assert.equal(env.CONVERSATION_CHANNEL_ID, ''); assert.equal(env.MEMORY_STORAGE_ENABLED, 'false'); assert.equal(env.SEARCH_ENABLED, 'false');
  assert.equal(env.FAT_FISH_TEXT_ENABLED, 'false'); assert.equal(env.AUTO_JOIN_CHANNELS, ''); assert.equal(env.WAKE_LOG_FILE, '');
  assert.equal(env.DEEPSEEK_API_KEY, ''); assert.equal(env.TTS_PROVIDER, 'feiyu'); assert.equal(env.TTS_FALLBACK, 'none');
  assert.equal(env.MAX_SPEECH_MS, '11000'); assert.equal(env.CONVERSATION_REGISTER_COMMANDS, 'true');
});

test('DeepSeek is explicit opt-in and remains bounded without Search or persistence', () => {
  const env = buildEnvironment({ ...settings, enableDeepSeek: true }, {}, { deepseek: 'synthetic-key' });
  const c = loadDeepSeekConfig(env);
  assert.equal(c.enabled, true); assert.equal(c.apiKey, 'synthetic-key'); assert.equal(c.retries, 0); assert.equal(c.maxTokens, 128);
  assert.equal(env.CONVERSATION_REQUEST_LIMIT, '6'); assert.equal(env.SEARCH_ENABLED, 'false'); assert.equal(env.MEMORY_STORAGE_ENABLED, 'false');
});

test('invalid guild/operator/Bot IDs and missing explicit opt-in fail before startup', () => {
  for (const delta of [{ guildId: '' }, { botId: 'wrong' }, { operatorIds: 'wrong' }, { enableDeepSeek: 'true' }])
    assert.throws(() => buildEnvironment({ ...settings, ...delta }));
});

test('offline entrypoint checks native Opus and configuration without credentials or connecting', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fatfish-launcher-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json'); fs.writeFileSync(file, JSON.stringify(settings));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../../tools/windows/start.cjs'), file, '--check'],
    { timeout: 10000, encoding: 'utf8', env: { ...process.env, DISCORD_TOKEN: '', DEEPSEEK_API_KEY: '' } });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /PASS: configuration/);
});
