const { loadDeepSeekConfig } = require('./deepseek-config');

const PROVIDER_IDS = Object.freeze(['deepseek', 'openai-compatible', 'ollama', 'lmstudio']);
const FEATURES = Object.freeze(['structuredJson', 'toolCalling', 'tokenUsage', 'reasoning']);

function selectProvider(value) {
  const id = String(value ?? '').trim().toLowerCase() || 'deepseek';
  if (!PROVIDER_IDS.includes(id)) throw new Error('Unknown LLM_PROVIDER; refusing provider fallback');
  return id;
}

// This parses a future transport boundary only. It never resolves DNS or makes requests.
function loadCompatibleConfig(env = process.env, id = 'openai-compatible') {
  id = selectProvider(id);
  const prefix = { 'openai-compatible': 'OPENAI_COMPATIBLE', ollama: 'OLLAMA', lmstudio: 'LMSTUDIO' }[id];
  if (!prefix) throw new Error('Unsupported compatible provider configuration');
  const fail = name => { throw new Error(`Invalid or missing ${prefix}_${name}`); };
  const value = (name, fallback = '') => env[`${prefix}_${name}`] ?? fallback;
  const integer = (name, fallback, min, max) => {
    const raw = String(value(name, fallback)), number = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number) || number < min || number > max) fail(name);
    return number;
  };
  const boolean = (name, fallback) => {
    const raw = value(name, fallback);
    if (!['true', 'false'].includes(raw)) fail(name);
    return raw === 'true';
  };
  const parseUrl = (raw, name) => {
    let url;
    try { url = new URL(raw); } catch { fail(name); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        /[\s\u0000-\u001f\u007f\\]/u.test(raw)) fail(name);
    return url;
  };
  const base = parseUrl(value('BASE_URL'), 'BASE_URL');
  const allowedOrigins = String(value('ALLOWED_ORIGINS')).split(',').map(s => s.trim()).filter(Boolean).map(raw => {
    const url = parseUrl(raw, 'ALLOWED_ORIGINS');
    if (url.pathname !== '/' || url.protocol !== 'https:') fail('ALLOWED_ORIGINS');
    return url.origin;
  });
  const loopback = ['127.0.0.1', '[::1]'].includes(base.hostname);
  if (!loopback && (base.protocol !== 'https:' || !allowedOrigins.includes(base.origin))) fail('ALLOWED_ORIGINS');
  const model = value('MODEL');
  if (typeof model !== 'string' || !model.trim() || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) fail('MODEL');
  const apiKey = value('API_KEY');
  if (typeof apiKey !== 'string' || /[^\x21-\x7e]/u.test(apiKey)) fail('API_KEY');
  const features = String(value('FEATURES')).split(',').map(s => s.trim()).filter(Boolean);
  if (features.some(feature => !FEATURES.includes(feature))) fail('FEATURES');
  return Object.freeze({ baseUrl: base.href.replace(/\/$/, ''), model, apiKey,
    timeoutMs: integer('TIMEOUT_MS', 30000, 100, 120000),
    maxTokens: integer('MAX_TOKENS', 256, 1, 4096), streamingText: boolean('STREAM', 'true'),
    contextTokens: integer('CONTEXT_TOKENS', 0, 0, 10000000) || null,
    declaredFeatures: Object.freeze(features), allowedOrigins: Object.freeze(allowedOrigins) });
}

// Stable orchestration is deliberately limited to the existing turn adapter.
function loadTurnProviderConfig(env = process.env) {
  const id = selectProvider(env.LLM_PROVIDER);
  if (id !== 'deepseek') throw new Error(`${id}: experimental turn adapter is not implemented; no fallback`);
  return loadDeepSeekConfig(env);
}

module.exports = { PROVIDER_IDS, FEATURES, selectProvider, loadCompatibleConfig, loadTurnProviderConfig };
