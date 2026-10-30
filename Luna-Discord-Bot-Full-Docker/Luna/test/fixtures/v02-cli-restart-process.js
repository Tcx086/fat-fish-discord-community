// Synthetic-only fixture: no credential loading, network or production policy attestation.
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const { createConversationCore } = require('../../conversation-core');
const { runLocalChat } = require('../../local-chat');
const { config, mockLlm, authorize, remember } = require('../v02-fixture');
const [filename, phase, oldId] = process.argv.slice(2);
assert.ok(filename && ['save', 'isolation', 'recall-update', 'recall-delete', 'verify-deleted'].includes(phase));
const calls = [], core = createConversationCore({ memoryConfig: config(filename), llm: mockLlm(calls) });
const input = new PassThrough();
let pending, banner = true;
const output = new Writable({ write(chunk, encoding, done) {
  const text = chunk.toString().trim();
  if (banner) banner = false;
  else { let data; try { data = JSON.parse(text); } catch {} pending({ text, data }); }
  done();
} });
const running = runLocalChat({ core, input, output, userId: phase === 'isolation' ? 'synthetic-cli-bob' : 'synthetic-cli-alice' });
const run = content => new Promise(resolve => { pending = resolve; input.write(content + '\n'); });
(async () => {
  let id = oldId;
  try {
    if (phase === 'save') {
      await run('Hello. This conversation is fictional and temporary.');
      await authorize(run);
      id = await remember(run);
      assert.equal((await run('/recall game')).data[0].id, id);
    } else if (phase === 'isolation') {
      await authorize(run);
      assert.deepEqual((await run('/recall game')).data, []);
      assert.equal((await run('What game do you remember?')).text, 'No authorized remembered evidence.');
    } else if (phase === 'recall-update') {
      assert.match((await run('What game do you remember?')).text, /Celeste/);
      const next = await run('/remember game | Synthetic favorite game is Portal.');
      assert.equal(next.data.status, 'candidate');
      id = next.data.id;
      assert.equal((await run(`/approve ${id} CONFIRM ${oldId}`)).data.status, 'approved');
      const recalled = (await run('/recall game')).data;
      assert.equal(recalled.length, 1); assert.match(recalled[0].content, /Portal/);
    } else if (phase === 'recall-delete') {
      assert.match((await run('What game do you remember?')).text, /Portal/);
      assert.equal((await run(`/forget ${id}`)).text, 'Memory deleted.');
      assert.deepEqual((await run('/recall game')).data, []);
    } else {
      assert.deepEqual((await run('/recall game')).data, []);
      assert.equal((await run('What game do you remember?')).text, 'No authorized remembered evidence.');
    }
    assert.equal(calls.length, 1);
    console.log(JSON.stringify({ phase, pid: process.pid, id, mockModelCalls: calls.length, paidRequests: 0, passed: true }));
  } finally { input.end('/quit\n'); await running; }
})().catch(() => { process.exitCode = 1; });
