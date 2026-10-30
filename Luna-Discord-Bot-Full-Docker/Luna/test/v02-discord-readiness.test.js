const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./v02-fixture');
const { staticTurn } = require('../conversation-core');
const { createDiscordTextAdapter, loadTextConfig } = require('../discord-text-adapter');

function adapter(core) {
  const handle = createDiscordTextAdapter({ core, config: loadTextConfig({ FAT_FISH_TEXT_ENABLED: 'true',
    FAT_FISH_TEXT_GUILD_ID: 'synthetic-g', FAT_FISH_TEXT_CHANNEL_ID: 'synthetic-c',
    FAT_FISH_TEXT_USERS: 'alice,bob', FAT_FISH_TEXT_OPERATORS: 'alice' }) });
  let sequence = 0;
  function interaction(content, extra = {}) {
    const sent = [];
    return { commandName: 'fish', id: String(++sequence), guildId: 'synthetic-g', channelId: 'synthetic-c', user: { id: 'alice' },
      options: { getString: () => content }, sent,
      reply: async p => sent.push({ method: 'reply', ...p }), deferReply: async p => sent.push({ method: 'defer', ...p }),
      editReply: async p => sent.push({ method: 'edit', ...p }), followUp: async p => sent.push({ method: 'followUp', ...p }), ...extra };
  }
  async function run(content, extra) { const value = interaction(content, extra); await handle(value); return value.sent; }
  return { handle, interaction, run };
}

test('Discord exact allowlists and memory ownership hold through approval, update and deletion', async t => {
  const f = fixture(t), { run } = adapter(f.core);
  for (const extra of [{ guildId: 'wrong' }, { channelId: 'wrong' }, { user: { id: 'alice', bot: true } }, { user: { id: 'outsider' } }]) {
    const sent = await run('/enable CONFIRM', extra);
    assert.equal(sent.length, 1); assert.equal(sent[0].flags, 64); assert.match(sent[0].content, /not authorized/);
  }
  assert.match((await run('/enable CONFIRM', { user: { id: 'bob' } })).at(-1).content, /refused/);
  await run('/enable CONFIRM'); await run('/consent CONFIRM');
  const candidate = JSON.parse((await run('/remember game | Synthetic Celeste.')).at(-1).content);
  assert.equal(candidate.status, 'candidate');
  assert.deepEqual(JSON.parse((await run('/recall game')).at(-1).content), []);
  assert.match((await run(`/approve ${candidate.id} CONFIRM`, { user: { id: 'bob' } })).at(-1).content, /refused/);
  await run(`/approve ${candidate.id} CONFIRM`);
  assert.match((await run('/recall Celeste')).at(-1).content, /Celeste/);
  assert.match((await run(`/provenance ${candidate.id}`)).at(-1).content, /owner-submitted/);
  assert.match((await run(`/forget ${candidate.id}`, { user: { id: 'bob' } })).at(-1).content, /refused/);
  const next = JSON.parse((await run('/remember game | Synthetic Portal.')).at(-1).content);
  await run(`/approve ${next.id} CONFIRM ${candidate.id}`);
  const recalled = JSON.parse((await run('/recall Portal')).at(-1).content);
  assert.equal(recalled.length, 1); assert.equal(recalled[0].id, next.id);
  await run(`/forget ${next.id}`);
  assert.deepEqual(JSON.parse((await run('/recall game')).at(-1).content), []);
  assert.equal(f.calls.length, 0);
});

test('Discord long replies remain ephemeral with mentions disabled; duplicate model requests are suppressed', async t => {
  let modelCalls = 0;
  const f = fixture(t, { llm: { createTurn: input => { modelCalls++; return staticTurn('Synthetic answer. '.repeat(240), input.signal); } } });
  const { interaction, handle } = adapter(f.core), value = interaction('hello');
  await handle(value);
  assert.equal(value.sent[0].flags, 64);
  assert.ok(value.sent.some(p => p.method === 'followUp'));
  for (const p of value.sent.filter(p => p.content)) {
    assert.ok(p.content.length <= 1900); assert.deepEqual(p.allowedMentions, { parse: [] });
    if (p.method === 'followUp') assert.equal(p.flags, 64);
  }
  await handle(value); assert.equal(modelCalls, 1); assert.match(value.sent.at(-1).content, /Duplicate/);
});

test('Discord /clear cancels an in-flight model response before private delivery', async t => {
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const f = fixture(t, { llm: { createTurn: input => ({
    async *stream() {
      began();
      await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
      yield 'Late content must not escape.';
    }, acknowledge: () => true, commit: () => true, dispose() {},
  }) } });
  const { interaction, handle, run } = adapter(f.core), value = interaction('hello');
  const pending = handle(value); await started; await run('/clear'); await pending;
  assert.match(value.sent.at(-1).content, /refused/);
  assert.ok(value.sent.every(p => !p.content?.includes('Late content')));
});
