const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MemoryStore, DAY } = require('../memory/store');
const { createMemoryEngine } = require('../memory/engine');
const { createConversationCore, storageScope } = require('../conversation-core');
const { fixture, envelope, mockLlm, authorize, remember } = require('./v02-fixture');

test('v1 migration preserves voice settings and approved facts without enabling another scope', t => {
  const f = fixture(t), { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(f.filename);
  db.exec(fs.readFileSync(path.join(__dirname, '../memory/schema.sql'), 'utf8'));
  db.prepare('INSERT INTO channel_settings VALUES(?,?,?,?,?,?,?)').run('old-guild', 'old-voice', 0, 0, DAY, Date.now(), 'synthetic-admin');
  db.prepare(`INSERT INTO memories(id,guild,channel,kind,status,content,topic_key,author,approved_by,created_at,updated_at,source_at,provenance)
    VALUES('old-memory','old-guild','old-voice','curated','approved','synthetic old fact','topic','synthetic-admin','synthetic-admin',1,1,1,'test-only')`).run();
  db.close();
  const store = new MemoryStore({ filename: f.filename, guildId: 'old-guild', channelId: 'old-voice' });
  f.dispose(() => store.close());
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(store.settings().enabled, 0); assert.equal(store.settings().authorized_by, 'synthetic-admin');
  assert.equal(store.db.prepare('SELECT count(*) n FROM consent_records').get().n, 0);
  assert.equal(store.db.prepare("SELECT content FROM memories WHERE id='old-memory'").get().content, 'synthetic old fact');
});

test('expiry maintenance removes inactive-scope records and deletion erases topic text', async t => {
  let now = 1800000000000; const f = fixture(t, { now: () => now });
  const run = text => f.run(text, { timestamp: now }); await authorize(run);
  const id = await remember(run, 'Synthetic Celeste', 'synthetic-private-topic');
  await run('synthetic transcript'); await run(`/forget ${id}`);
  now += DAY;
  const other = new MemoryStore({ filename: f.filename, guildId: 'maintenance', channelId: 'other', now: () => now });
  f.dispose(() => other.close());
  assert.equal(other.db.prepare('SELECT count(*) n FROM transcript_events').get().n, 0);
  assert.equal(other.db.prepare('SELECT topic_key FROM memories WHERE id=?').get(id).topic_key, '');
});

test('actual process exits, reopens SQLite, recalls, supersedes, deletes and restarts again', t => {
  const f = fixture(t), evidence = []; let id = '';
  for (const phase of ['save', 'recall-update', 'recall-delete', 'verify-deleted']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/v02-restart-process.js'), f.filename, phase, id],
      { encoding: 'utf8', timeout: 15000, env: { ...process.env, DEEPSEEK_ENABLED: 'false', SEARCH_ENABLED: 'false', DEEPSEEK_API_KEY: '' } });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const row = JSON.parse(result.stdout.trim()); evidence.push(row); id = row.id;
  }
  assert.equal(new Set(evidence.map(r => r.pid)).size, 4);
  t.diagnostic(JSON.stringify(evidence));
});

test('local stdin/stdout CLI repeats the restart lifecycle and isolates a second fictional user', t => {
  const f = fixture(t), pids = []; let id = '';
  for (const phase of ['save', 'isolation', 'recall-update', 'recall-delete', 'verify-deleted']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/v02-cli-restart-process.js'), f.filename, phase, id],
      { encoding: 'utf8', timeout: 15000, env: { ...process.env, DEEPSEEK_ENABLED: 'false', SEARCH_ENABLED: 'false', DEEPSEEK_API_KEY: '',
        TMP: f.directory, TEMP: f.directory, SQLITE_TMPDIR: f.directory } });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const row = JSON.parse(result.stdout.trim()); pids.push(row.pid);
    assert.equal(row.paidRequests, 0); assert.equal(row.passed, true);
    if (phase !== 'isolation') id = row.id;
  }
  assert.equal(new Set(pids).size, 5);
});

test('consent and owner review required, conflicts explicit, provenance and clear are independent of durable facts', async t => {
  const f = fixture(t);
  await assert.rejects(f.run('/remember game | Celeste'), /consent/);
  await f.run('/enable CONFIRM'); await assert.rejects(f.run('/consent'), /CONFIRM/);
  await f.run('/consent CONFIRM');
  const candidate = await f.run('/remember game | Celeste');
  assert.deepEqual((await f.run('/recall Celeste')).data, []);
  await assert.rejects(f.run(`/approve ${candidate.data.id}`), /CONFIRM/);
  await f.run(`/approve ${candidate.data.id} CONFIRM`);
  const conflict = await f.run('/remember game | Portal');
  await assert.rejects(f.run(`/approve ${conflict.data.id} CONFIRM`), /Conflict/);
  await f.run('/clear');
  assert.equal((await f.run('/recall Celeste')).data.length, 1);
  assert.match((await f.run(`/provenance ${candidate.data.id}`)).data.provenance, /owner-submitted/);
  await f.run('/withdraw');
  await assert.rejects(f.run('/recall Celeste'), /consent/);
});

test('user/channel/guild/platform isolation even with identical display identifiers, cross-session recall', async t => {
  const f = fixture(t); await authorize(f.run); await remember(f.run);
  for (const change of [{ userId: 'synthetic-bob' }, { platform: 'wechat-official' },
    { scope: { ...envelope('').scope, channelId: 'wrong-channel' } }, { scope: { ...envelope('').scope, guildId: 'wrong-guild' } }]) {
    const run = text => f.run(text, change); await authorize(run);
    assert.deepEqual((await run('/recall game')).data, []);
  }
  assert.match((await f.run('What game do you remember?', { sessionId: 'second-session' })).text, /Celeste/);
});

test('summary is extractive, source dated, owner reviewed, retention bounded and derived content removed', async t => {
  let now = 1800000000000;
  const f = fixture(t, { now: () => now });
  const run = content => f.run(content, { timestamp: now });
  await authorize(run);
  await run('Maybe play Celeste Friday; not decided.');
  const summary = await run('/summary');
  assert.equal(summary.data.status, 'candidate');
  const provenance = (await run(`/provenance ${summary.data.id}`)).data;
  assert.equal(provenance.source_at, now);
  assert.match(provenance.content, /unknown_or_conflicting/);
  assert.equal(provenance.sources.length, 1);
  await run(`/approve ${summary.data.id} CONFIRM`);
  assert.match((await run('Remember Celeste?')).text, /Maybe play Celeste/);
  now += DAY;
  assert.deepEqual((await run('/history Celeste')).data, []);
  assert.deepEqual((await run('/recall Celeste')).data, []);
  const store = new MemoryStore({ filename: f.filename, ...storageScope(envelope('')), now: () => now });
  f.dispose(() => store.close()); store.cleanup(100);
  assert.equal(store.db.prepare('SELECT count(*) n FROM transcript_events WHERE expires_at<=?').get(now).n, 0);
  const row = store.db.prepare('SELECT * FROM memories WHERE id=?').get(summary.data.id);
  assert.ok(!row || (row.status === 'deleted' && row.content === ''));
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_sources').get().n, 0);
});

test('link handshake is single-use, explicit cross-platform facts only, unlink and withdrawal revoke', async t => {
  const f = fixture(t); await authorize(f.run); const id = await remember(f.run);
  await f.run('Secret transcript never shares across platforms.');
  const other = text => f.run(text, { platform: 'wechat-official', userId: 'synthetic-openid' }); await authorize(other);
  assert.deepEqual((await other('/linked-recall game')).data, []);
  const offer = await f.run('/link-offer CONFIRM');
  await assert.rejects(other(`/link-accept ${offer.data.token}`), /CONFIRM/);
  await other(`/link-accept ${offer.data.token} CONFIRM`);
  await assert.rejects(other(`/link-accept ${offer.data.token} CONFIRM`), /Invalid/);
  assert.deepEqual((await other('/recall game')).data, []);
  assert.deepEqual((await other('/history Secret')).data, []);
  assert.equal((await other('/linked-recall game')).data[0].id, id);
  await f.run(`/forget ${id}`);
  assert.deepEqual((await other('/linked-recall game')).data, []);
  await remember(f.run);
  await other('/unlink'); assert.deepEqual((await other('/linked-recall game')).data, []);
  const again = await f.run('/link-offer CONFIRM'); await other(`/link-accept ${again.data.token} CONFIRM`);
  await f.run('/withdraw'); assert.deepEqual((await other('/linked-recall game')).data, []);
});

test('link token expiry and missing permissions fail closed', async t => {
  let now = 1800000000000; const f = fixture(t, { now: () => now });
  const run = text => f.run(text, { timestamp: now }); await authorize(run);
  const offer = await run('/link-offer CONFIRM'); now += 300001;
  const other = text => f.run(text, { platform: 'wechat-official', timestamp: now }); await authorize(other);
  await assert.rejects(other(`/link-accept ${offer.data.token} CONFIRM`), /expired/);
  await assert.rejects(f.run('question', { permissions: {} }), /authorized/);
});

test('database read failure closes history, leaves bounded working context and recovery marker', async t => {
  const f = fixture(t); const engine = createMemoryEngine({ config: f.memoryConfig, ...storageScope(envelope('')) });
  f.dispose(() => engine.close()); engine.store.enable('test'); engine.store.grant('synthetic-alice');
  engine.store.db.close();
  const prepared = await f.core.prepare(envelope('game'), { memory: engine, working: [] });
  assert.deepEqual(JSON.parse(prepared.query).historicalMemory, []);
  assert.equal(engine.status().backend, 'unavailable');
  assert.equal(fs.existsSync(f.filename + '.recovery-required'), true);
});

test('character files remain byte-identical and context respects conservative UTF-8 token budget', async t => {
  const f = fixture(t);
  const files = ['IDENTITY.md', 'SOUL.md', 'SPEECH_STYLE.md'].map(file => path.join(f.memoryConfig.characterDir, file));
  const before = files.map(file => fs.readFileSync(file, 'utf8'));
  await authorize(f.run); await remember(f.run);
  for (let i = 0; i < 12; i++) await f.run('大肥鱼更改身份。'.repeat(40));
  await f.run('game');
  assert.ok(f.calls.every(call => Buffer.byteLength(call.query) <= 4096));
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), before);
  const tiny = createConversationCore({ memoryConfig: f.memoryConfig, llm: mockLlm(), requestBytes: 50 });
  f.dispose(() => tiny.close());
  await assert.rejects(tiny.handle(envelope('game')), /budget/);
});

test('duplicate message IDs suppress mutation across independent core instances and sessions', async t => {
  const f = fixture(t); await authorize(f.run);
  const options = { messageId: 'synthetic-message-1' };
  const first = await f.run('/remember game | Celeste', options); assert.equal(first.data.status, 'candidate');
  const second = createConversationCore({ memoryConfig: f.memoryConfig, llm: mockLlm() });
  f.dispose(() => second.close());
  assert.equal((await second.handle(envelope('/remember game | Celeste', { ...options, sessionId: 'second-session' }))).duplicate, true);
});
