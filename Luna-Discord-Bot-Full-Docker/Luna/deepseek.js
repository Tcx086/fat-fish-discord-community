const { takeSentences } = require('./sentences');

const MESSAGES = {
  DISABLED: 'DeepSeek is disabled; explicit local opt-in required',
  CREDENTIALS: 'DeepSeek API key is missing', AUTH: 'DeepSeek authentication failed (401)',
  BALANCE: 'DeepSeek balance is insufficient (402)', RATE_LIMIT: 'DeepSeek rate limit reached (429)',
  HTTP: 'DeepSeek rejected the request', NETWORK: 'DeepSeek network request failed',
  PROTOCOL: 'Invalid DeepSeek stream', INCOMPLETE: 'DeepSeek answer was incomplete',
  CANCELLED: 'DeepSeek request cancelled', TIMEOUT: 'DeepSeek request timed out',
  BUDGET: 'DeepSeek token limit reached', BUSY: 'DeepSeek concurrency limit reached',
  INPUT: 'Invalid or oversized DeepSeek input', DELIVERY: 'Answer playback did not complete',
};
class DeepSeekError extends Error {
  constructor(code, retryable = false) { super(MESSAGES[code]); this.code = code; this.retryable = retryable; }
}
const fault = code => new DeepSeekError(code);
const safeError = e => e instanceof DeepSeekError ? e : fault('NETWORK');
const bytes = text => Buffer.byteLength(text, 'utf8');

// Race even transports that ignore AbortSignal; never propagate raw transport errors.
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof DeepSeekError ? signal.reason : fault('CANCELLED'));
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function delay(ms, signal) {
  let timer;
  return abortable(new Promise(resolve => { timer = setTimeout(resolve, ms); }), signal)
    .finally(() => clearTimeout(timer));
}

async function* readSSE(body, controller, idleMs) {
  if (!body?.getReader) throw fault('PROTOCOL');
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data = [], eventBytes = 0;
  try {
    for (;;) {
      const timer = setTimeout(() => controller.abort(fault('TIMEOUT')), idleMs);
      let chunk;
      try { chunk = await abortable(reader.read(), controller.signal); }
      finally { clearTimeout(timer); }
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let match;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        if (!chunk.done && match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        eventBytes += bytes(line);
        if (eventBytes > 65536) throw fault('PROTOCOL');
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = []; eventBytes = 0;
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        // Comments and unknown SSE fields are deliberately ignored.
      }
      if (bytes(buffer) + eventBytes > 65536) throw fault('PROTOCOL');
      if (chunk.done) {
        if (buffer || data.length) throw fault('INCOMPLETE');
        return;
      }
    }
  } finally {
    // Do not await an uncooperative transport's cancellation.
    Promise.resolve(reader.cancel()).catch(() => {});
    reader.releaseLock();
  }
}

function createDeepSeek({ config, fetch = globalThis.fetch, console = globalThis.console, now = Date.now, onFirstContent = () => {} }) {
  const conversations = new Map(), turns = new Set(), active = new Set();
  // shortcut: budgets are process-local; persist/share the ledger before production or multiple instances.
  let epoch = 0, sessionBudget = { used: 0 }, daily = { day: '', used: 0 };
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const dailyBudget = () => {
    if (daily.day !== day()) daily = { day: day(), used: 0 };
    return daily;
  };
  function reserve(messages) {
    // UTF-8 bytes + framing + maximum output is deliberately above typical token counts.
    const amount = messages.reduce((n, m) => n + bytes(m.content) + 32, 256) + config.maxTokens;
    const session = sessionBudget, today = dailyBudget();
    if (session.used + amount > config.sessionTokens || today.used + amount > config.dailyTokens) throw fault('BUDGET');
    session.used += amount; today.used += amount;
    return usage => {
      const actual = usage?.total_tokens ?? amount;
      session.used += actual - amount; today.used += actual - amount;
      return { tokens: actual, estimated: !usage };
    };
  }
  function createTurn({ guildId, sessionId, userId, query, signal, jsonInstructions }) {
    if (!config.enabled) throw fault('DISABLED');
    if (!config.apiKey.trim()) throw fault('CREDENTIALS');
    if ([guildId, sessionId, userId].some(x => x === undefined || x === null || !String(x).length || String(x).length > 128) ||
        typeof query !== 'string' || !query.trim() || bytes(query) > config.queryBytes) throw fault('INPUT');
    if (signal?.aborted) throw fault('CANCELLED');
    if (jsonInstructions !== undefined && (typeof jsonInstructions !== 'string' || !jsonInstructions.trim() || bytes(jsonInstructions) > 16384)) throw fault('INPUT');
    const jsonOutput = jsonInstructions !== undefined;
    const key = JSON.stringify([String(guildId), String(sessionId), String(userId)]);
    let record = conversations.get(key);
    record?.turn?.dispose();
    if (!record) record = { history: [], turn: null };
    conversations.delete(key);
    conversations.set(key, record);
    while (conversations.size > config.maxConversations) {
      const oldest = conversations.keys().next().value;
      conversations.get(oldest).turn?.dispose(); conversations.delete(oldest);
    }
    const owner = epoch, controller = new AbortController();
    const cancel = () => controller.abort(fault('CANCELLED'));
    signal?.addEventListener('abort', cancel, { once: true });
    const systemPrompt = jsonOutput ? jsonInstructions : config.getSystemPrompt ? config.getSystemPrompt() : config.systemPrompt;
    if (typeof systemPrompt !== 'string' || bytes(systemPrompt) > 16384) throw fault('INPUT');
    const messages = [{ role: 'system', content: systemPrompt }, ...record.history,
      { role: 'user', content: query }];
    let started = false, completed = false, committed = false, disposed = false;
    let emitted = [], acknowledged = 0;
    const current = () => !disposed && !controller.signal.aborted && epoch === owner &&
      conversations.get(key) === record && record.turn === turn;
    const turn = {
      signal: controller.signal,
      async *stream() {
        if (started || !current()) throw fault('CANCELLED');
        started = true;
        if (active.size >= config.concurrency) throw fault('BUSY');
        active.add(turn);
        const release = () => active.delete(turn);
        controller.signal.addEventListener('abort', release, { once: true });
        const deadline = setTimeout(() => controller.abort(fault('TIMEOUT')), config.timeoutMs);
        let sawContent = false;
        try {
          for (let attempt = 0; ; attempt++) {
            if (!current()) throw fault('CANCELLED');
            const settle = reserve(messages);
            let usage = null, done = false, finish = null, rest = '', totalBytes = 0, outcome = 'OK';
            try {
              let response;
              try {
                const pending = Promise.resolve(fetch(config.endpoint, {
                  method: 'POST', redirect: 'error', signal: controller.signal,
                  headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ model: config.model, messages, thinking: { type: 'disabled' },
                    stream: true, stream_options: { include_usage: true }, max_tokens: config.maxTokens,
                    ...(jsonOutput ? { response_format: { type: 'json_object' } } : {}) }),
                })).then(result => {
                  if (controller.signal.aborted) Promise.resolve(result.body?.cancel()).catch(() => {});
                  return result;
                });
                response = await abortable(pending, controller.signal);
              } catch (e) {
                if (controller.signal.aborted) throw controller.signal.reason;
                throw new DeepSeekError('NETWORK', true);
              }
              if (!response.ok) {
                Promise.resolve(response.body?.cancel()).catch(() => {});
                const code = ({ 401: 'AUTH', 402: 'BALANCE', 429: 'RATE_LIMIT' })[response.status] || 'HTTP';
                throw new DeepSeekError(code, [408, 429, 500, 502, 503, 504].includes(response.status));
              }
              if (!response.headers?.get('content-type')?.includes('text/event-stream')) throw fault('PROTOCOL');
              for await (const event of readSSE(response.body, controller, config.idleMs)) {
                if (!current()) throw fault('CANCELLED');
                if (event === '[DONE]') { done = true; break; }
                let value;
                try { value = JSON.parse(event); } catch { throw fault('PROTOCOL'); }
                if (!value || value.error || !Array.isArray(value.choices)) throw fault('PROTOCOL');
                if (value.usage != null) {
                  const u = value.usage;
                  if (!['prompt_tokens', 'completion_tokens', 'total_tokens'].every(k => Number.isSafeInteger(u[k]) && u[k] >= 0) ||
                      u.total_tokens !== u.prompt_tokens + u.completion_tokens) throw fault('PROTOCOL');
                  usage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens };
                }
                if (value.choices.length > 1) throw fault('PROTOCOL');
                const choice = value.choices[0];
                if (!choice) continue; // OpenAI-compatible usage-only event.
                if (choice.index !== undefined && choice.index !== 0) throw fault('PROTOCOL');
                const delta = choice.delta || {};
                if (delta.tool_calls || (delta.content != null && typeof delta.content !== 'string')) throw fault('PROTOCOL');
                if (delta.content) {
                  if (finish) throw fault('PROTOCOL');
                  if (!sawContent) onFirstContent();
                  sawContent = true;
                  totalBytes += bytes(delta.content);
                  if (totalBytes > config.maxTokens * 16 + 4096) throw fault('PROTOCOL');
                  if (jsonOutput) {
                    // Structured evidence must preserve exact quoted whitespace, unlike spoken sentences.
                    emitted.push(delta.content); yield delta.content;
                  } else {
                    rest += delta.content;
                    const split = takeSentences(rest); rest = split.rest;
                    for (const sentence of split.sentences) { emitted.push(sentence); yield sentence; }
                  }
                }
                if (choice.finish_reason != null) finish = choice.finish_reason;
              }
              if (!done || finish !== 'stop' || !sawContent) throw fault('INCOMPLETE');
              if (rest.trim()) { emitted.push(rest.trim()); yield rest.trim(); }
              if (!current()) throw fault('CANCELLED');
              completed = true;
              return;
            } catch (raw) {
              const error = controller.signal.aborted ? safeError(controller.signal.reason) : safeError(raw);
              outcome = error.code;
              if (sawContent || !error.retryable || attempt >= config.retries || !current()) throw error;
            } finally {
              const accounting = settle(usage);
              console.log('[deepseek]', JSON.stringify({ attempt: attempt + 1, outcome, ...accounting,
                ...(usage || {}) }));
            }
            await delay(Math.min(500 * 2 ** attempt, 2000), controller.signal);
          }
        } finally {
          clearTimeout(deadline); release(); controller.signal.removeEventListener('abort', release);
        }
      },
      acknowledge(sentence) {
        if (!current() || emitted[acknowledged] !== sentence) return false;
        acknowledged++; return true;
      },
      commit() {
        if (!current() || !completed || committed || acknowledged !== emitted.length || !emitted.length) return false;
        record.history.push({ role: 'user', content: query }, { role: 'assistant', content: emitted.join(jsonOutput ? '' : ' ') });
        while (record.history.length > config.historyTurns * 2 ||
            record.history.reduce((n, m) => n + bytes(m.content), 0) > config.historyBytes) record.history.splice(0, 2);
        committed = true; return true;
      },
      dispose() {
        disposed = true; cancel(); turns.delete(turn); signal?.removeEventListener('abort', cancel);
        if (record.turn === turn) record.turn = null;
      },
    };
    record.turn = turn; turns.add(turn);
    return turn;
  }
  return {
    provider: 'deepseek', model: config.model, reasoning: 'off', createTurn,
    resolveModel: async () => true, describeSearch: () => 'disabled for DeepSeek Phase 1',
    forgetConversations() {
      epoch++; for (const turn of turns) turn.dispose(); conversations.clear(); sessionBudget = { used: 0 };
    },
    usage: () => ({ sessionTokens: sessionBudget.used, dailyTokens: dailyBudget().used, day: daily.day }),
  };
}
module.exports = { createDeepSeek, DeepSeekError, safeError, abortable };
