const assert = require('node:assert/strict');
const { createConversationCore } = require('../../conversation-core');
const { config, envelope, mockLlm, authorize, remember } = require('../v02-fixture');
const [filename, phase, oldId] = process.argv.slice(2);
const calls = [], core = createConversationCore({ memoryConfig: config(filename), llm: mockLlm(calls) });
const run = content => core.handle(envelope(content, { sessionId: `process-${phase}` }));
(async () => {
  let id = oldId;
  try {
    if (phase === 'save') {
      await authorize(run);
      await run('We are discussing a synthetic game.');
      id = await remember(run);
    } else if (phase === 'recall-update') {
      assert.match((await run('What game do you remember?')).text, /Celeste/);
      const next = await run('/remember game | Synthetic favorite game is Portal.');
      await run(`/approve ${next.data.id} CONFIRM ${oldId}`); id = next.data.id;
      assert.match((await run('/recall game')).text, /Portal/);
    } else if (phase === 'recall-delete') {
      assert.match((await run('What game do you remember?')).text, /Portal/);
      await run(`/forget ${oldId}`);
      assert.deepEqual((await run('/recall game')).data, []);
    } else if (phase === 'verify-deleted') {
      assert.equal((await run('What game do you remember?')).text, 'No authorized remembered evidence.');
      assert.deepEqual((await run('/recall game')).data, []);
    } else throw new Error('Unknown phase');
    console.log(JSON.stringify({ phase, pid: process.pid, id, modelCalls: calls.length, passed: true }));
  } finally { core.close(); }
})().catch(() => { process.exitCode = 1; });
