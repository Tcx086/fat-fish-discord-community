const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./v02-fixture');
const { createValidationFetch, SEARCH_QUERY } = require('./fixtures/v02-live-budget');
const modelUrl = 'https://api.deepseek.com/chat/completions', searchUrl = 'https://api.deepseek.com/v1/tools/search';
const model = { model: 'deepseek-flash', thinking: { type: 'disabled' }, stream: true, max_tokens: 512,
  messages: [{ role: 'system', content: 'Synthetic.' }, { role: 'user', content: 'Hello.' }] };
const options = body => ({ method: 'POST', redirect: 'error', body: JSON.stringify(body) });

test('live validation reservations survive guard recreation and consume failures without resetting allowance', async t => {
  const f = fixture(t), filename = path.join(f.directory, 'ledger.json');
  fs.writeFileSync(filename, JSON.stringify({ model: 0, search: 0 }));
  let calls = 0;
  const fetch = async () => { calls++; throw new Error('synthetic failure'); };
  for (let i = 0; i < 7; i++) await assert.rejects(createValidationFetch({ filename, fetch })(modelUrl, options(model)), /synthetic failure/);
  const guarded = createValidationFetch({ filename, fetch });
  await assert.rejects(guarded(modelUrl, options(model)), /exhausted/);
  const search = options({ query: SEARCH_QUERY, count: 3, need_content: false });
  await assert.rejects(guarded(searchUrl, search), /synthetic failure/);
  await assert.rejects(guarded(searchUrl, search), /exhausted/);
  assert.equal(calls, 8); assert.deepEqual(JSON.parse(fs.readFileSync(filename)), { model: 7, search: 1 });
});

test('live guard rejects Fetch, altered queries, tools, model/token escalation, missing/corrupt ledgers and concurrent locks', async t => {
  const f = fixture(t), filename = path.join(f.directory, 'ledger.json');
  const guarded = createValidationFetch({ filename, fetch: () => assert.fail('must not send') });
  await assert.rejects(guarded(modelUrl, options(model)));
  fs.writeFileSync(filename, '{broken'); await assert.rejects(guarded(modelUrl, options(model)));
  fs.writeFileSync(filename, JSON.stringify({ model: 0, search: 0 }));
  await assert.rejects(guarded('https://api.deepseek.com/v1/tools/fetch', options({ url: 'https://example.com' })), /endpoint/);
  await assert.rejects(guarded(searchUrl, options({ query: 'another query', count: 3, need_content: false })), /search/);
  for (const extra of [{ tools: [{}] }, { model: 'deepseek-v4-pro' }, { max_tokens: 513 },
    { messages: [{ role: 'system', content: 'a'.repeat(8192) }, model.messages[1]] }])
    await assert.rejects(guarded(modelUrl, options({ ...model, ...extra })), /model budget/);
  fs.writeFileSync(filename + '.lock', ''); await assert.rejects(guarded(modelUrl, options(model)), /EEXIST/);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename)), { model: 0, search: 0 });
});
