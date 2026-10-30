const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../config');
const { loadDeepSeekConfig } = require('../deepseek-config');
const { loadCompatibleConfig, loadTurnProviderConfig, selectProvider } = require('../llm-provider-config');
const { createProvider, requireCapabilities, ProviderError } = require('../llm-providers');
const { createDeepSeek } = require('../deepseek');

// Synthetic transport only; importing or constructing a provider performs no I/O.
function fixture(factory = createProvider, extra = {}) {
  const requests = [], logs = [];
  const config = { ...loadDeepSeekConfig({ DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'synthetic-secret' }), retries: 0 };
  const provider = factory({ config, console: { log: (...args) => logs.push(args.join(' ')) },
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return new Response('data: {"choices":[{"delta":{"content":"Hello."},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n' +
        'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }, ...extra });
  return { provider, requests, logs };
}
const input = extra => ({ guildId: 'g', sessionId: 's', userId: 'u', query: 'Hi', ...extra });
async function drain(turn) { const chunks = []; for await (const chunk of turn.stream()) chunks.push(chunk); return chunks; }

test('selection defaults to DeepSeek and unknown IDs fail instead of falling back', () => {
  assert.equal(selectProvider(), 'deepseek');
  assert.equal(loadConfig({}, { warn() {} }).LLM_PROVIDER, 'deepseek');
  assert.equal(loadConfig({ LLM_PROVIDER: ' LMStudio ' }).LLM_PROVIDER, 'lmstudio');
  for (const id of ['typo', 'constructor', 'toString', '__proto__']) {
    assert.throws(() => selectProvider(id), /fallback/);
    assert.throws(() => loadConfig({ LLM_PROVIDER: id }), /fallback/);
    assert.throws(() => loadCompatibleConfig({}, id), /fallback/);
  }
  assert.throws(() => createProvider(), e => e.code === 'NOT_CONFIGURED');
  for (const id of ['openai-compatible', 'ollama', 'lmstudio']) {
    assert.equal(loadConfig({ LLM_PROVIDER: id }).LLM_PROVIDER, id);
    assert.throws(() => createProvider({ id, fetch: () => assert.fail('No transport allowed') }),
      e => e instanceof ProviderError && e.code === 'NOT_IMPLEMENTED');
    assert.throws(() => loadTurnProviderConfig({ LLM_PROVIDER: id }), /not implemented/);
  }
});

test('wrapper preserves DeepSeek requests, output, acknowledgement, history and accounting', async () => {
  const wrapped = fixture(), original = fixture(createDeepSeek);
  assert.equal(wrapped.requests.length, 0);
  for (const f of [wrapped, original]) {
    const turn = f.provider.createTurn(input());
    assert.equal(turn.commit(), false);
    const chunks = await drain(turn);
    assert.deepEqual(chunks, ['Hello.']);
    assert.equal(turn.commit(), false);
    assert.equal(turn.acknowledge('wrong'), false);
    assert.equal(turn.acknowledge(chunks[0]), true);
    assert.equal(turn.commit(), true);
    assert.equal(turn.commit(), false);
    turn.dispose();
    const next = f.provider.createTurn(input({ query: 'Next' }));
    await drain(next); next.dispose();
  }
  assert.deepEqual(wrapped.requests, original.requests);
  assert.equal(wrapped.requests[1].body.messages[1].content, 'Hi');
  assert.deepEqual(wrapped.provider.usage(), original.provider.usage());
  assert.deepEqual(wrapped.logs, original.logs);
  assert.ok(!wrapped.logs.join('').includes('synthetic-secret'));
  wrapped.provider.close();
});

test('capabilities describe adapter support and unsupported operations fail before transport', () => {
  const f = fixture(), p = f.provider;
  assert.equal(p.id, 'deepseek'); assert.equal(p.provider, 'deepseek');
  assert.ok(Object.isFrozen(p.capabilities.contextLimits));
  assert.equal(p.capabilities.contextLimits.contextTokens, null);
  requireCapabilities(p, 'streamingText', 'structuredJson', 'tokenUsage');
  for (const name of ['toolCalling', 'reasoning', 'search', 'unknown', 'contextLimits'])
    assert.throws(() => requireCapabilities(p, name), e => e.code === 'UNSUPPORTED_CAPABILITY');
  for (const extra of [{ tools: [] }, { reasoning: true }])
    assert.throws(() => p.createTurn(input(extra)), e => e.code === 'UNSUPPORTED_CAPABILITY');
  assert.equal(f.requests.length, 0); p.close();
});

test('JSON instructions still select the original DeepSeek request format', async () => {
  const f = fixture();
  const turn = f.provider.createTurn(input({ jsonInstructions: 'Return JSON.' }));
  await drain(turn); turn.dispose();
  assert.deepEqual(f.requests[0].body.response_format, { type: 'json_object' });
  assert.equal(f.requests[0].body.messages[0].content, 'Return JSON.');
  f.provider.close();
});

test('external abort, replacement, cancel and close invalidate turns without resetting cost limits', async () => {
  const f = fixture(), p = f.provider, external = new AbortController();
  const first = p.createTurn(input({ signal: external.signal }));
  external.abort(); assert.ok(first.signal.aborted); assert.equal(first.commit(), false); first.dispose();
  const old = p.createTurn(input()), replacement = p.createTurn(input());
  assert.ok(old.signal.aborted); assert.equal(old.commit(), false);
  await drain(replacement);
  const usage = p.usage(); p.cancel(); p.cancel();
  assert.ok(replacement.signal.aborted); assert.equal(replacement.commit(), false);
  assert.deepEqual(p.usage(), usage);
  const pending = p.createTurn(input()); p.close(); p.close();
  assert.ok(pending.signal.aborted); assert.deepEqual(p.usage(), usage);
  assert.throws(() => p.createTurn(input()), e => e.code === 'CLOSED');
});

test('forget keeps the existing DeepSeek session reset and daily ledger semantics', async () => {
  const f = fixture(), p = f.provider, turn = p.createTurn(input());
  await drain(turn); const daily = p.usage().dailyTokens;
  p.forgetConversations();
  assert.ok(turn.signal.aborted); assert.equal(turn.commit(), false);
  assert.equal(p.usage().sessionTokens, 0); assert.equal(p.usage().dailyTokens, daily); p.close();
});

test('close aborts an in-flight transport that ignores AbortSignal and cannot commit late output', async () => {
  let signal, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const f = fixture(createProvider, { fetch: (_url, init) => {
    signal = init.signal; markStarted(); return new Promise(() => {});
  } });
  const turn = f.provider.createTurn(input()), pending = drain(turn);
  await started; f.provider.close();
  assert.ok(signal.aborted);
  await assert.rejects(pending, e => e.code === 'CANCELLED');
  assert.equal(turn.acknowledge('late output'), false); assert.equal(turn.commit(), false);
});

test('the existing disabled and credential gates survive the wrapper', () => {
  for (const env of [{}, { DEEPSEEK_ENABLED: 'true' }]) {
    const p = createProvider({ config: loadDeepSeekConfig(env), fetch: () => assert.fail('No network') });
    assert.throws(() => p.createTurn(input()), e => e.code === (env.DEEPSEEK_ENABLED ? 'CREDENTIALS' : 'DISABLED'));
    p.close();
  }
});

const localConfig = extra => ({ OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:1234/v1',
  OPENAI_COMPATIBLE_MODEL: 'operator-chosen-model', ...extra });

test('compatible boundary parses explicit settings without migrating keys or claiming capabilities', () => {
  const config = loadCompatibleConfig(localConfig({ DEEPSEEK_API_KEY: 'must-not-migrate', OPENAI_COMPATIBLE_STREAM: 'false',
    OPENAI_COMPATIBLE_FEATURES: 'structuredJson,tokenUsage', OPENAI_COMPATIBLE_CONTEXT_TOKENS: '8192' }));
  assert.equal(config.apiKey, ''); assert.equal(config.streamingText, false);
  assert.deepEqual(config.declaredFeatures, ['structuredJson', 'tokenUsage']);
  assert.equal(config.contextTokens, 8192); assert.equal(config.maxTokens, 256);
  for (const [id, prefix, port] of [['ollama', 'OLLAMA', '11434'], ['lmstudio', 'LMSTUDIO', '1234']]) {
    const local = loadCompatibleConfig({ [`${prefix}_BASE_URL`]: `http://[::1]:${port}/v1`, [`${prefix}_MODEL`]: 'local-model' }, id);
    assert.equal(local.apiKey, ''); assert.equal(local.contextTokens, null);
  }
});

test('endpoint policy rejects unknown remote origins, embedded secrets and unsafe configuration', () => {
  for (const url of ['http://example.com/v1', 'https://example.com/v1', 'http://localhost:1234/v1',
    'http://10.0.0.1/v1', 'http://169.254.169.254/', 'file:///etc/passwd', 'http://user:secret@127.0.0.1/v1',
    'http://127.0.0.1/v1?key=secret', 'http://127.0.0.1/v1#secret', 'http://127.0.0.1/\npath']) {
    assert.throws(() => loadCompatibleConfig(localConfig({ OPENAI_COMPATIBLE_BASE_URL: url })),
      error => !error.message.includes('secret'));
  }
  const remote = localConfig({ OPENAI_COMPATIBLE_BASE_URL: 'https://approved.example/v1',
    OPENAI_COMPATIBLE_ALLOWED_ORIGINS: 'https://approved.example', OPENAI_COMPATIBLE_API_KEY: 'synthetic-key' });
  assert.equal(loadCompatibleConfig(remote).apiKey, 'synthetic-key');
  assert.throws(() => loadCompatibleConfig({ ...remote, OPENAI_COMPATIBLE_BASE_URL: 'https://approved.example.evil/v1' }));
  for (const [name, value] of [['MODEL', ''], ['MAX_TOKENS', '0'], ['TIMEOUT_MS', 'NaN'], ['STREAM', 'yes'],
    ['FEATURES', 'deepseekSearch'], ['API_KEY', 'secret\r\ninjection'], ['ALLOWED_ORIGINS', '*']])
    assert.throws(() => loadCompatibleConfig(localConfig({ [`OPENAI_COMPATIBLE_${name}`]: value })));
});
