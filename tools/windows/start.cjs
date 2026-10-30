const fs = require('node:fs');
const path = require('node:path');
const app = path.resolve(__dirname, '../../Luna-Discord-Bot-Full-Docker/Luna');
const { createRequire } = require('node:module');
const appRequire = createRequire(path.join(app, 'index.js'));

function buildEnvironment(settings, base = {}, secrets = {}) {
  if (!/^\d{17,20}$/.test(settings.guildId || '')) throw new Error('Valid server ID required');
  if (settings.botId && !/^\d{17,20}$/.test(settings.botId)) throw new Error('Invalid Bot ID');
  const operators = (settings.operatorIds || '').split(',').map(s => s.trim()).filter(Boolean);
  if (operators.length > 16 || operators.some(id => !/^\d{17,20}$/.test(id))) throw new Error('Invalid operator IDs');
  if (typeof settings.enableDeepSeek !== 'boolean') throw new Error('Explicit DeepSeek setting required');
  // Keep local voice calibration, but override every provider/persistence activation gate.
  const env = { ...base, DISCORD_TOKEN: secrets.discord || '', DEEPSEEK_API_KEY: settings.enableDeepSeek ? secrets.deepseek || '' : '',
    CONVERSATION_ENABLED: 'true', CONVERSATION_MODE: 'passive', CONVERSATION_GUILD_ID: settings.guildId,
    CONVERSATION_CHANNEL_ID: '', CONVERSATION_ALL_PARTICIPANTS: 'true', CONVERSATION_USER_IDS: '',
    CONVERSATION_OPERATOR_IDS: operators.join(','), CONVERSATION_REGISTER_COMMANDS: 'true', CONVERSATION_DIAGNOSTIC: 'true',
    LLM_PROVIDER: 'deepseek', DEEPSEEK_ENABLED: String(settings.enableDeepSeek), DEEPSEEK_MODEL: 'deepseek-flash',
    DEEPSEEK_API_URL: 'https://api.deepseek.com/chat/completions', DEEPSEEK_RETRIES: '0', DEEPSEEK_CONCURRENCY: '1',
    DEEPSEEK_MAX_TOKENS: '128', DEEPSEEK_SESSION_TOKENS: '16000', DEEPSEEK_DAILY_TOKENS: '16000', CONVERSATION_REQUEST_LIMIT: '6',
    SEARCH_ENABLED: 'false', SEARCH_FETCH_ORIGINS: '', WEB_SEARCH: 'off', LLM_TOOLS: 'false',
    MEMORY_STORAGE_ENABLED: 'false', FAT_FISH_TEXT_ENABLED: 'false', FAT_FISH_TEXT_REGISTER_COMMANDS: 'false',
    AUTO_JOIN_CHANNELS: '', AUTO_JOIN_TEXT_CHANNEL: '', TEXT_CHAT_CHANNELS: '', WAKE_LOG_FILE: '',
    OWW_ENABLED: 'false', WAKE_SHADOW: 'false', WAKE_WHISPER_BACKUP: 'false', ANNOUNCE_SELF: 'false', GREET_ON_JOIN: 'off',
    WHISPER_SERVER_URLS: 'http://127.0.0.1:18082/inference', TTS_PROVIDER: 'feiyu', TTS_FALLBACK: 'none',
    FEIYU_TTS_URL: 'http://127.0.0.1:18882/v1/audio/speech', ELEVENLABS_API_KEY: '', TAVILY_API_KEY: '' };
  appRequire('./config').loadConfig(env, { warn: () => {} });
  appRequire('./conversation-config').loadConversationConfig(env);
  appRequire('./deepseek-config').loadDeepSeekConfig(env);
  appRequire('./memory/engine').loadMemoryConfig(env);
  return env;
}

async function main() {
  const filename = process.argv[2];
  if (!filename) throw new Error('Settings file required');
  const settings = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  const profilePath = path.join(app, '.env');
  const profile = fs.existsSync(profilePath) ? appRequire('dotenv').parse(fs.readFileSync(profilePath)) : {};
  const env = buildEnvironment(settings, profile, { discord: process.env.DISCORD_TOKEN, deepseek: process.env.DEEPSEEK_API_KEY });
  if (process.argv.includes('--check')) {
    appRequire('@discordjs/opus'); appRequire('@discordjs/voice'); appRequire('discord.js');
    console.log('PASS: configuration, Node dependencies and Opus load; no Discord or paid calls.'); return;
  }
  if (!env.DISCORD_TOKEN.trim()) throw new Error('Save a Discord Bot Token in Configure first');
  if (settings.enableDeepSeek && !env.DEEPSEEK_API_KEY.trim()) throw new Error('Save a DeepSeek key or disable DeepSeek');
  const { SETTINGS } = appRequire('./config');
  const families = new Set([...SETTINGS.map(s => s.name.split('_')[0]), 'DEEPSEEK', 'CONVERSATION', 'MEMORY', 'SEARCH', 'FAT']);
  for (const key of Object.keys(process.env)) if (families.has(key.split('_')[0])) delete process.env[key];
  Object.assign(process.env, env);
  if (settings.botId) {
    const { REST, Routes } = appRequire('discord.js');
    const bot = await new REST({ version: '10' }).setToken(env.DISCORD_TOKEN).get(Routes.user('@me'));
    if (bot.id !== settings.botId || bot.bot !== true) throw new Error('Bot ID and Bot Token do not match');
  }
  process.chdir(app);
  console.log(`Fat Fish: guild ${settings.guildId}; DeepSeek ${settings.enableDeepSeek ? 'ON (6 requests per process, 128 output tokens each)' : 'OFF'}; memory/search OFF.`);
  console.log('Use /join, /move, /status, /pause, /resume, /stop. Ctrl+C stops the bot.');
  // Do not expose SDK request headers or server error bodies in startup failures.
  process.on('unhandledRejection', () => { console.error('Discord operation failed. Check token, guild membership and permissions.'); process.emit('SIGTERM'); process.exitCode = 1; });
  appRequire('./index');
}
module.exports = { buildEnvironment };
if (require.main === module) main().catch(() => { console.error('Startup failed. Check configuration, Bot Token and server access. No secret details were logged.'); process.exitCode = 1; });
