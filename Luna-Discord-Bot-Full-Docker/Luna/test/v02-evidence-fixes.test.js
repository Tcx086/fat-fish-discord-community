const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createConversationRuntime } = require('../conversation-runtime');
const { createTextSearch, createSearchTools, loadSearchConfig, renderEvidence } = require('../search-tools');
const { fixture, envelope, authorize, remember } = require('./v02-fixture');
const now = Date.parse('2026-10-30T03:30:24.985Z');

test('text memory dates are ISO UTC before byte budgeting; retrieval retains the original evidence', async t => {
  const f = fixture(t), bodies = [];
  const core = createConversationRuntime({ now: () => now, env: { MEMORY_STORAGE_ENABLED: 'true', MEMORY_DB_PATH: f.filename,
    MEMORY_POLICY_REVIEWED: 'true', MEMORY_ENCRYPTED_STORAGE_CONFIRMED: 'true', MEMORY_PRIVACY_URL: 'https://example.invalid/synthetic-test-only',
    DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'synthetic-key', DEEPSEEK_RETRIES: '0' }, console: { log() {} },
    fetch: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response('data: {"choices":[{"delta":{"content":"Celeste."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    } });
  f.dispose(() => core.close());
  const run = content => core.handle(envelope(content, { timestamp: now }));
  await authorize(run); await remember(run); await run('What game do you remember?');
  const context = JSON.parse(bodies[0].messages[1].content);
  assert.equal(context.historicalMemory[0].timestamp, '2026-10-30T03:30:24.985Z');
  assert.match(bodies[0].messages[0].content, /ISO 8601 UTC/);
  assert.match(bodies[0].messages[0].content, /Do not infer/);
  await run('What game do you remember?');
  const second = JSON.parse(bodies[1].messages[1].content);
  assert.ok(second.recentDialogue.every(row => typeof row.timestamp === 'string' && row.timestamp.endsWith('Z')));
  assert.ok(bodies.every(body => Buffer.byteLength(body.messages[1].content) <= 4096));
});

test('text latest search adds one bounded date filter, groups translations and labels stale unverified dates', async () => {
  const queries = [];
  const source = locale => ({ url: `https://www.leagueoflegends.com/${locale}/news/game-updates/league-of-legends-patch-26-18-notes/`,
    title: 'Patch 26.18', excerpt: 'Synthetic patch changes.', publishedAt: '2026-09-08T16:00:00.000Z' });
  const raw = { usage: () => ({ attempts: queries.length }), search: async query => { queries.push(query); return [source('pt-br'), source('es-es'), source('vi-vn')]; } };
  const search = createTextSearch(raw, () => now);
  const sources = await search.search('/search League of Legends latest official patch notes site:leagueoflegends.com');
  assert.equal(queries.length, 1); assert.match(queries[0], /after:2026-09-30\b/); assert.match(queries[0], /lang:en$/);
  assert.ok([...queries[0].replace(/^\/search\s+/, '')].length <= 128);
  assert.equal(sources.length, 1); assert.equal(sources[0].variants.length, 2);
  assert.equal(sources[0].freshness, 'stale'); assert.equal(sources[0].dateUnverified, true);
  const rendered = renderEvidence(sources);
  assert.match(rendered, /不能确认最新/); assert.match(rendered, /索引日期.*未核验/);
  assert.match(rendered, /pt-br/); assert.match(rendered, /es-es/); assert.match(rendered, /vi-vn/);
  await search.search('/search latest patch after:2026-01-01');
  assert.equal((queries[1].match(/after:/g) || []).length, 1);
  await search.search('/search patch history'); assert.equal(queries[2], '/search patch history');
  await search.search('/search latest ' + 'x'.repeat(110)); assert.equal(queries.length, 4);
  assert.ok([...queries[3].replace(/^\/search\s+/, '')].length <= 128);
  await search.search('/search 最新补丁 lang:pt'); assert.match(queries[4], /lang:pt/);
  assert.equal((queries[4].match(/lang:/g) || []).length, 1);
  await search.search('/search 最新补丁'); assert.match(queries[5], /lang:zh,en$/);
});

test('invalid provider dates become unknown and distinct articles remain distinct', async () => {
  const tools = createSearchTools({ config: loadSearchConfig({ SEARCH_ENABLED: 'true', DEEPSEEK_API_KEY: 'synthetic' }),
    fetch: async () => new Response(JSON.stringify({ results: [
      { url: 'https://example.com/en-us/a', title: 'A', summary: 'Synthetic A.', date: '2026-02-30T00:00:00Z' },
      { url: 'https://example.com/es-es/b', title: 'B', summary: 'Synthetic B.', date: '09/08/2026' },
      { url: 'https://example.com/vi-vn/c', title: 'C', summary: 'Synthetic C.', date: '2026-10-29T20:00:00-04:00' },
    ] }), { headers: { 'content-type': 'application/json' } }) });
  const sources = await createTextSearch(tools, () => now).search('/search latest news');
  assert.equal(sources.length, 3);
  assert.equal(sources[0].publishedAt, null); assert.equal(sources[1].publishedAt, null);
  assert.equal(sources[2].publishedAt, '2026-10-30T00:00:00.000Z');
  assert.equal(sources[2].freshness, 'recent-unverified');
});
