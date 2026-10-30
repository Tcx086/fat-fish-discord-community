// Synthetic, local-only workload. No Discord, STT, model or network imports.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { MemoryStore, DAY } = require('./store');
const { buildContext } = require('./context');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memory-bench-'));
const filename = path.join(directory, 'synthetic.sqlite');
let now = Date.UTC(2026, 9, 29, 12), store;
const rssBefore = process.memoryUsage().rss;
function timed(fn) { const start = performance.now(); fn(); return performance.now() - start; }
function distribution(values) { values.sort((a, b) => a - b); return { p50: values[Math.floor(values.length * .5)], p95: values[Math.floor(values.length * .95)], max: values.at(-1) }; }
try {
  store = new MemoryStore({ filename, guildId: 'synthetic-guild', channelId: 'synthetic-channel', now: () => now });
  store.enable('synthetic-admin'); for (let i = 0; i < 4; i++) store.grant(`speaker-${i}`);
  const session = store.startSession(), writes = [], searches = [], shortSearches = [], contexts = [];
  for (let i = 0; i < 2000; i++) {
    now += 100; const speaker = `speaker-${i % 4}`;
    writes.push(timed(() => assert.equal(store.append({ session, sequence: i + 1, speaker, timestamp: now, startedAt: now,
      ticket: store.ticket(speaker, now), text: `合成记录${i}：我们暂定周五玩原神游戏，具体计划尚未确认。 Synthetic discussion ${i}.` }), true)));
  }
  for (let i = 0; i < 200; i++) {
    searches.push(timed(() => assert.ok(store.episodes({ viewer: 'speaker-0', terms: ['原神游'] }).length)));
    shortSearches.push(timed(() => assert.ok(store.episodes({ viewer: 'speaker-0', terms: ['游戏'] }).length)));
    contexts.push(timed(() => {
      const context = buildContext({ question: '原神游戏计划是什么？', speaker: 'speaker-0', name: 'Synthetic', timestamp: now, sequence: 2001,
        working: [], store, audienceEligible: true, now, totalTokens: 8192, systemBytes: 2500 });
      assert.ok(Buffer.byteLength(context) <= 4096);
    }));
  }
  store.db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
  const size = fs.statSync(filename).size;
  const copy = path.join(directory, 'without-index.sqlite'); fs.copyFileSync(filename, copy);
  const without = new DatabaseSync(copy);
  without.exec('DROP TRIGGER event_insert; DROP TRIGGER event_delete; DROP TABLE transcript_search; VACUUM;'); without.close();
  const indexOverhead = size - fs.statSync(copy).size;
  now += DAY;
  const batches = []; let removed = 0;
  const cleanup = timed(() => { while (removed < 2000) batches.push(timed(() => { removed += store.cleanup(); })); });
  assert.equal(removed, 2000);
  console.log(JSON.stringify({ node: process.version, sqlite: store.db.prepare('select sqlite_version() version').get().version,
    events: 2000, speakers: 4, dbBytes: size, indexOverheadBytes: indexOverhead, writeMs: distribution(writes), searchTrigramMs: distribution(searches),
    searchShortMs: distribution(shortSearches), contextMs: distribution(contexts), cleanupMs: cleanup, cleanupBatchMs: distribution(batches),
    rssBeforeBytes: rssBefore, rssAfterBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
    note: 'Serial interleaved speaker writes; excludes audio/STT/LLM and does not measure sustainable live speakers.' }, null, 2));
} finally { store?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
