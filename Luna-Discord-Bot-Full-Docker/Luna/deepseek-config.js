const fs = require('node:fs');
const path = require('node:path');

// Fail closed: malformed cost settings must never silently remove a limit.
function loadDeepSeekConfig(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const raw = env[name] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Invalid ${name}`);
    return value;
  };
  if (env.DEEPSEEK_ENABLED !== undefined && !['true', 'false'].includes(env.DEEPSEEK_ENABLED))
    throw new Error('Invalid DEEPSEEK_ENABLED');
  const endpoint = env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Invalid DEEPSEEK_API_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid DEEPSEEK_API_URL');
  const model = env.DEEPSEEK_MODEL || 'deepseek-flash';
  if (!['deepseek-flash', 'deepseek-v4-pro'].includes(model)) throw new Error('Invalid DEEPSEEK_MODEL');
  let systemPrompt;
  try {
    const file = env.DEEPSEEK_PROMPT_FILE || path.join(__dirname, 'deepseek-system-prompt.txt');
    if (fs.statSync(file).size > 16384) throw new Error();
    systemPrompt = fs.readFileSync(file, 'utf8').trim();
    if (!systemPrompt) throw new Error();
  } catch { throw new Error('Cannot load bounded DEEPSEEK_PROMPT_FILE'); }
  return Object.freeze({
    enabled: env.DEEPSEEK_ENABLED === 'true', apiKey: env.DEEPSEEK_API_KEY || '', endpoint, model, systemPrompt,
    maxTokens: integer('DEEPSEEK_MAX_TOKENS', 256, 1, 4096),
    historyTurns: integer('DEEPSEEK_HISTORY_TURNS', 6, 0, 32),
    historyBytes: integer('DEEPSEEK_HISTORY_BYTES', 8000, 0, 64000),
    queryBytes: integer('DEEPSEEK_QUERY_BYTES', 4096, 1, 16384),
    maxConversations: integer('DEEPSEEK_MAX_CONVERSATIONS', 32, 1, 128),
    concurrency: integer('DEEPSEEK_CONCURRENCY', 1, 1, 4),
    timeoutMs: integer('DEEPSEEK_TIMEOUT_MS', 30000, 100, 120000),
    idleMs: integer('DEEPSEEK_IDLE_MS', 10000, 100, 60000),
    retries: integer('DEEPSEEK_RETRIES', 1, 0, 2),
    sessionTokens: integer('DEEPSEEK_SESSION_TOKENS', 20000, 1, 1000000),
    dailyTokens: integer('DEEPSEEK_DAILY_TOKENS', 50000, 1, 10000000),
  });
}
module.exports = { loadDeepSeekConfig };
