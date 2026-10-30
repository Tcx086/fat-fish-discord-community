const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { loadDeepSeekConfig } = require('../deepseek-config');
const { createDeepSeek } = require('../deepseek');

const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const part = content => event({ choices: [{ index: 0, delta: { content } }] });
const usage = { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 };
const end = (u = usage) => event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: u }) + 'data: [DONE]\r\n\r\n';
const encode = value => new TextEncoder().encode(value);
function response(text = part('Hello. ') + end(), bytewise = false) {
  const data = encode(text);
  return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: new ReadableStream({ start(c) {
      if (bytewise) for (const b of data) c.enqueue(Uint8Array.of(b)); else c.enqueue(data);
      c.close();
    } }) };
}
function fixture(overrides = {}, fetchImpl = async () => response()) {
  const calls = [], logs = [];
  const config = { ...loadDeepSeekConfig({ DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'private-test-key' }), ...overrides };
  const llm = createDeepSeek({ config, fetch: async (...args) => { calls.push(args); return fetchImpl(...args); },
    console: { log: (...a) => logs.push(a.join(' ')) } });
  const turn = opts => llm.createTurn({ guildId: 'g', sessionId: 1, userId: 'u', query: 'Hi', ...opts });
  return { config, llm, calls, logs, turn };
}
async function collect(turn, heard = false) {
  const output = [];
  for await (const sentence of turn.stream()) { output.push(sentence); if (heard) assert.ok(turn.acknowledge(sentence)); }
  return output;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('request construction: endpoint, current model, thinking disabled, bounded streaming and prompt', async () => {
  const f = fixture({ model: 'deepseek-v4-pro', endpoint: 'https://example.invalid/chat/completions' });
  const t = f.turn(); assert.deepEqual(await collect(t, true), ['Hello.']); assert.ok(t.commit()); t.dispose();
  const [url, init] = f.calls[0], body = JSON.parse(init.body);
  assert.equal(url, f.config.endpoint); assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer private-test-key');
  assert.equal(body.model, 'deepseek-v4-pro'); assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.stream, true); assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_tokens, 256); assert.deepEqual(body.messages.map(m => m.role), ['system', 'user']);
  assert.equal(body.response_format, undefined);
  assert.equal(body.messages[0].content, f.config.systemPrompt); assert.equal(body.tools, undefined);
  assert.equal(f.llm.usage().sessionTokens, 24); assert.match(f.logs[0], /"estimated":false/);
});

test('trusted JSON turns preserve bytes and share the existing token ledger and validation', async () => {
  const json = '{"quote":"One.  Two! 三。"}';
  const f = fixture({ historyTurns: 0, historyBytes: 0, systemPrompt: 'Plain.', sessionTokens: 700, maxTokens: 32 },
    async () => response([...json].map(part).join('') + end(), true));
  const turn = f.turn({ jsonInstructions: 'Return only JSON.' });
  assert.equal((await collect(turn, true)).join(''), json); assert.ok(turn.commit()); turn.dispose();
  assert.equal(f.llm.usage().sessionTokens, 24);
  const body = JSON.parse(f.calls[0][1].body);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].content, 'Return only JSON.'); assert.equal(body.tools, undefined);
  assert.throws(() => f.turn({ jsonInstructions: {} }), { code: 'INPUT' });
  const expensive = f.turn({ jsonInstructions: 'j'.repeat(1000) });
  await assert.rejects(collect(expensive), { code: 'BUDGET' }); expensive.dispose();
  assert.equal(f.calls.length, 1);
});

test('SSE byte boundaries: Chinese/emoji, CRLF, comments, multiple events, reasoning excluded', async () => {
  const stream = ': keep alive\r\n\r\n' + event({ choices: [{ delta: { reasoning_content: 'SECRET THINKING' } }] }) +
    part('你好😊。接着') + part('说！') + end();
  const f = fixture({}, async () => response(stream, true)), t = f.turn();
  assert.deepEqual(await collect(t, true), ['你好😊。', '接着说！']); assert.ok(t.commit()); t.dispose();
  assert.ok(!f.logs.join('').includes('SECRET'));
});

test('SSE multiline data, bare CR, LF and usage-only terminal event', async () => {
  const s = 'data: {"choices":\rdata: [{"delta":{"content":"One. "}}]}\r\r' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    event({ choices: [], usage }) + 'data: [DONE]\n\n';
  const f = fixture({}, async () => response(s, true)), t = f.turn();
  assert.deepEqual(await collect(t), ['One.']); assert.equal(t.commit(), false); t.dispose();
  assert.equal(f.llm.usage().dailyTokens, 24);
});

test('first completed sentence is yielded before remaining network data and DONE', async () => {
  let network;
  const f = fixture({}, async () => ({ ...response(), body: new ReadableStream({ start(c) { network = c; c.enqueue(encode(part('First. '))); } }) }));
  const t = f.turn(), iterator = t.stream();
  assert.deepEqual(await iterator.next(), { value: 'First.', done: false });
  network.enqueue(encode(part('Second.') + end())); network.close();
  assert.equal((await iterator.next()).value, 'Second.'); assert.equal((await iterator.next()).done, true); t.dispose();
});

test('missing DONE, truncation, malformed JSON and length finish reject without committing or retry', async () => {
  for (const s of [part('Partial. '), part('Partial. ') + 'data: {bad}\n\n',
    part('Partial. ') + event({ choices: [{ delta: {}, finish_reason: 'length' }] }) + 'data: [DONE]\n\n']) {
    const f = fixture({}, async () => response(s)), t = f.turn();
    await assert.rejects(collect(t, true)); assert.equal(t.commit(), false); assert.equal(f.calls.length, 1); t.dispose();
  }
});

test('oversized SSE event and invalid UTF8 fail safely', async () => {
  for (const payload of [encode('data: ' + 'x'.repeat(65537)), Uint8Array.of(0xff)]) {
    const f = fixture({}, async () => ({ ...response(), body: new ReadableStream({ start(c) { c.enqueue(payload); c.close(); } }) }));
    const t = f.turn(); await assert.rejects(collect(t)); assert.equal(t.commit(), false); t.dispose();
  }
});

test('cancel before request, during fetch, and during stream; no retry', async () => {
  const already = new AbortController(); already.abort(); const f0 = fixture();
  assert.throws(() => f0.turn({ signal: already.signal }), { code: 'CANCELLED' }); assert.equal(f0.calls.length, 0);
  for (const duringStream of [false, true]) {
    let cancelled = false;
    const f = fixture({}, async () => duringStream ? { ...response(), body: new ReadableStream({ cancel() { cancelled = true; } }) } : new Promise(() => {}));
    const controller = new AbortController(), t = f.turn({ signal: controller.signal });
    const result = collect(t); await tick(); controller.abort();
    await assert.rejects(result, { code: 'CANCELLED' }); assert.equal(f.calls.length, 1);
    if (duringStream) assert.ok(cancelled); assert.equal(t.commit(), false); t.dispose();
  }
});

test('absolute and idle timeouts bound unresponsive transports', async () => {
  for (const stream of [false, true]) {
    const f = fixture({ timeoutMs: 50, idleMs: 15 }, async () => stream
      ? { ...response(), body: new ReadableStream() } : new Promise(() => {}));
    const t = f.turn(); await assert.rejects(collect(t), { code: 'TIMEOUT' }); assert.equal(f.calls.length, 1); t.dispose();
  }
});

test('a fetch that resolves after cancellation has its late body closed', async () => {
  let resolveFetch, cancelled = false;
  const f = fixture({}, () => new Promise(resolve => { resolveFetch = resolve; }));
  const t = f.turn(), pending = collect(t); await tick(); t.dispose();
  await assert.rejects(pending, { code: 'CANCELLED' });
  resolveFetch({ ...response(), body: new ReadableStream({ cancel() { cancelled = true; } }) });
  await tick(); assert.ok(cancelled);
});

test('bounded transient retries succeed; each attempt reserves tokens', async () => {
  let count = 0;
  const f = fixture({}, async () => ++count === 1 ? { ok: false, status: 503 } : response());
  const t = f.turn(); assert.deepEqual(await collect(t), ['Hello.']); t.dispose();
  assert.equal(count, 2); assert.equal(f.logs.length, 2); assert.ok(f.llm.usage().dailyTokens > 24);
  const bad = fixture({ retries: 1 }, async () => { throw new Error('private-test-key raw network URL'); });
  const b = bad.turn(); await assert.rejects(collect(b), { code: 'NETWORK' }); b.dispose(); assert.equal(bad.calls.length, 2);
  assert.ok(!bad.logs.join('').includes('private-test-key'));
});

test('cancel during retry backoff never restarts request', async () => {
  const f = fixture({}, async () => ({ ok: false, status: 429 })), c = new AbortController();
  const t = f.turn({ signal: c.signal }), result = collect(t); await tick(); c.abort();
  await assert.rejects(result, { code: 'CANCELLED' }); assert.equal(f.calls.length, 1); t.dispose();
});

test('401/402 are clear, sanitized, non-retryable; server body is never logged', async () => {
  for (const [status, code] of [[401, 'AUTH'], [402, 'BALANCE'], [400, 'HTTP']]) {
    const f = fixture({}, async () => ({ ok: false, status, text: () => { throw new Error('must not read private body'); } }));
    const t = f.turn(); await assert.rejects(collect(t), { code }); assert.equal(f.calls.length, 1); t.dispose();
    assert.ok(!f.logs.join('').includes('private'));
  }
});

test('history requires full acknowledged delivery, truncates complete pairs and isolates scopes', async () => {
  const f = fixture({ historyTurns: 1 });
  const unheard = f.turn({ query: 'unheard' }); await collect(unheard); assert.equal(unheard.commit(), false); unheard.dispose();
  for (const q of ['first', 'second', 'third']) { const t = f.turn({ query: q }); await collect(t, true); assert.ok(t.commit()); t.dispose(); }
  const messages = JSON.parse(f.calls[3][1].body).messages;
  assert.deepEqual(messages.map(m => m.content), [f.config.systemPrompt, 'second', 'Hello.', 'third']);
  for (const scope of [{ guildId: 'other' }, { sessionId: 2 }, { userId: 'other' }]) {
    const t = f.turn(scope); await collect(t); t.dispose(); assert.equal(JSON.parse(f.calls.at(-1)[1].body).messages.length, 2);
  }
  const tiny = fixture({ historyBytes: 1 }), a = tiny.turn(); await collect(a, true); a.commit(); a.dispose();
  const b = tiny.turn(); await collect(b); b.dispose(); assert.equal(JSON.parse(tiny.calls[1][1].body).messages.length, 2);
});

test('superseded turns and session termination reject late commits; daily ledger survives reset', async () => {
  const f = fixture(); const old = f.turn(); await collect(old, true);
  const next = f.turn(); assert.equal(old.commit(), false); next.dispose();
  const t = f.turn(); await collect(t, true); const daily = f.llm.usage().dailyTokens;
  f.llm.forgetConversations(); assert.equal(t.commit(), false); assert.equal(f.llm.usage().sessionTokens, 0);
  assert.equal(f.llm.usage().dailyTokens, daily);
});

test('disabled, missing credentials, input size and session/daily limits prevent fetch', async () => {
  for (const [overrides, code] of [[{ enabled: false }, 'DISABLED'], [{ apiKey: '' }, 'CREDENTIALS'], [{ queryBytes: 1 }, 'INPUT']]) {
    const f = fixture(overrides); assert.throws(() => f.turn(), { code }); assert.equal(f.calls.length, 0);
  }
  for (const overrides of [{ sessionTokens: 1 }, { dailyTokens: 1 }]) {
    const f = fixture(overrides), t = f.turn(); await assert.rejects(collect(t), { code: 'BUDGET' }); t.dispose(); assert.equal(f.calls.length, 0);
  }
});

test('unknown usage retains conservative reservation and concurrency fails before fetch', async () => {
  const f = fixture({}, async () => response(part('Hello.') + end(null)));
  const t = f.turn(); await collect(t); t.dispose(); assert.ok(f.llm.usage().dailyTokens > 256); assert.match(f.logs[0], /"estimated":true/);
  const busy = fixture({}, async () => new Promise(() => {})), a = busy.turn(), b = busy.turn({ userId: 'v' });
  const pending = collect(a); await tick(); await assert.rejects(collect(b), { code: 'BUSY' });
  a.dispose(); b.dispose(); await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(busy.calls.length, 1);
});

test('bounded conversation count evicts and rejects pending old commits', async () => {
  const f = fixture({ maxConversations: 1 }), a = f.turn(); await collect(a, true);
  const b = f.turn({ userId: 'b' }); assert.equal(a.commit(), false); b.dispose();
});

test('strict configuration, separate prompt and diagnostic opt-in (no network)', () => {
  assert.equal(loadDeepSeekConfig({}).enabled, false); assert.equal(loadDeepSeekConfig({}).model, 'deepseek-flash');
  for (const env of [{ DEEPSEEK_MAX_TOKENS: 'NaN-secret' }, { DEEPSEEK_MODEL: 'deepseek-chat' },
    { DEEPSEEK_ENABLED: 'yes' }, { DEEPSEEK_API_URL: 'https://secret:private@host/' },
    { DEEPSEEK_PROMPT_FILE: 'nonexistent-private-path' }]) {
    assert.throws(() => loadDeepSeekConfig(env), error => !/secret|private/.test(error.message));
  }
  const result = spawnSync(process.execPath, [path.join(__dirname, '../deepseek-diagnostic.js')],
    { env: { ...process.env, NODE_ENV: 'test', DEEPSEEK_API_KEY: 'private-test-key' }, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Disabled/); assert.ok(!result.stderr.includes('private-test-key'));
});

test('live diagnostic respects a lower configured budget, with network forcibly mocked', () => {
  const script = `globalThis.fetch = async () => { throw new Error('NETWORK MUST NOT RUN'); };
    process.argv.push('--live', '--authorized-cost');
    require('./deepseek-diagnostic').main().catch(e => { console.error(e.code); process.exitCode = 1; });`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'development', DEEPSEEK_DIAGNOSTIC: 'true', DEEPSEEK_ENABLED: 'true',
      DEEPSEEK_API_KEY: 'fake-key', DEEPSEEK_SESSION_TOKENS: '1', DEEPSEEK_PROMPT_FILE: '' } });
  assert.equal(result.status, 1); assert.match(result.stderr, /BUDGET/); assert.ok(!result.stderr.includes('NETWORK'));
});

for (const status of [200, 503]) test(`single-call diagnostic records HTTP ${status}, request count and cleanup using mocked fetch`, () => {
  const text = part('DeepSeek connection OK.') + end();
  const script = `let calls = 0; globalThis.fetch = async () => {
    if (++calls > 1) throw new Error('duplicate');
    return new Response(${JSON.stringify(text)}, { status: ${status}, headers: { 'content-type': 'text/event-stream' } });
  }; process.argv.push('--live', '--authorized-cost');
  require('./deepseek-diagnostic').main().catch(e => { console.error(e.code); process.exitCode = 1; });`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'development', DEEPSEEK_DIAGNOSTIC: 'true', DEEPSEEK_ENABLED: 'true',
      DEEPSEEK_API_KEY: 'private-test-key', DEEPSEEK_RETRIES: '2', DEEPSEEK_SESSION_TOKENS: '2048',
      DEEPSEEK_DAILY_TOKENS: '2048', DEEPSEEK_PROMPT_FILE: '' } });
  assert.equal(result.status, status === 200 ? 0 : 1);
  assert.match(result.stdout, new RegExp(`"status":${status}`));
  assert.match(result.stdout, /"requestCount":1,"completed":(?:true|false),"cancelledAndDisposed":true/);
  assert.equal((result.stdout.match(/\[live-http\]/g) || []).length, 1);
  assert.ok(!result.stdout.includes('private-test-key')); assert.ok(!result.stderr.includes('private-test-key'));
});
