const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPassiveListener, createRollingContext, invocation } = require('../passive-listener');
const { loadConversationConfig } = require('../conversation-config');
const { createWhisper } = require('../whisper');
const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function clock() {
  let at = 1000000, next = 0; const tasks = new Map();
  return { now: () => at, tasks,
    setTimeout(fn, ms) { const id = ++next; tasks.set(id, { fn, due: at + ms }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    tick(ms) { const target = at + ms;
      for (;;) { const due = [...tasks].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break; tasks.delete(due[0]); at = due[1].due; due[1].fn(); } at = target;
    },
  };
}
function setup(options = {}) {
  const timers = clock(), calls = [], events = [], humans = new Set(['a', 'b']); let clears = 0, cancels = 0, leaves = 0;
  const c = createPassiveListener({ guildId: 'g', channelId: 'v', timers, now: timers.now,
    isAuthorized: id => humans.has(id), hasParticipants: () => humans.size > 0, nameOf: id => 'Name ' + id,
    transcribe: async pcm => pcm.toString(), respond: async data => { calls.push(data); return true; },
    clearHistory: () => clears++, cancelPlayback: () => cancels++, disconnect: () => leaves++, onEvent: e => events.push(e), ...options });
  c.attach('g', 'v');
  const say = async (text, speaker = 'a', metadata) => { const accepted = c.submit(Buffer.from(text), speaker, metadata); await flush(); return accepted; };
  return { c, say, calls, events, timers, humans, get clears() { return clears; }, get cancels() { return cancels; }, get leaves() { return leaves; } };
}

test('direct-address matching accepts specified name forms, spacing, punctuation and code switching', () => {
  for (const s of ['大肥鱼，你觉得呢？', '大肥鱼，你怎么看？', '大肥鱼，帮我们想一下。', '大肥鱼，回答一下这个。',
    '嘿，大肥鱼。', '大 肥 鱼 ： 你怎么看 ？', '大肥魚，你觉得呢？', '吃白饭的大肥鱼, what do you think?', '大肥鱼你觉得呢',
    '大肥鱼介绍一下。自己。', '大肥魚介紹一下自己'])
    assert.ok(invocation(s), s);
  assert.equal(invocation('嘿，大肥鱼。').question, '嘿,大肥鱼。');
});
test('direct default rejects references; explicit anywhere accepts unquoted mentions only', () => {
  const anywhere = { phrase: '大肥鱼', mode: 'anywhere' };
  for (const s of ['我刚才看到一个大肥鱼的视频。', '这个机器人的名字是大肥鱼。', '你知道大肥鱼是什么吗？',
    '大肥鱼的视频很有趣', '大肥鱼是一个名字', '大肥鱼介绍的视频很好看', '大肥魚介紹了這個遊戲',
    '请大肥鱼介绍一下自己']) {
    assert.equal(invocation(s), null, s);
    assert.ok(invocation(s, anywhere), s);
  }
  assert.equal(invocation('请大肥鱼介绍一下自己', anywhere).question, '请大肥鱼介绍一下自己');
  for (const s of ['大飞鱼，你怎么看？', 'a'.repeat(2000) + '大肥鱼', '介绍一下自己', '“大肥鱼，你觉得呢？”']) {
    assert.equal(invocation(s), null, s);
    assert.equal(invocation(s, anywhere), null, s);
  }
});
test('addressed controls are exact and deterministic', () => {
  assert.equal(invocation('大肥鱼，停。').action, 'interrupt');
  assert.equal(invocation('大肥鱼，退出频道。').action, 'leave');
  assert.equal(invocation('大肥鱼，结束对话。').action, 'end');
  assert.equal(invocation('大肥鱼，暂停。').action, 'pause');
  assert.equal(invocation('大肥鱼，停止了吗？').action, null);
  for (const s of ['请不要让大肥鱼停下来', '他说大肥鱼，退出频道', '“大肥鱼，暂停”'])
    assert.equal(invocation(s), null);
});
test('ordinary bilingual human conversation only populates local context, never responds or emits text diagnostics', async () => {
  const f = setup(); await f.say('I think we should play League tonight.'); await f.say('但是我们只有三个人', 'b');
  assert.equal(f.calls.length, 0); assert.equal(f.c.status().contextEntries, 2); assert.equal(f.c.state, 'PASSIVE_LISTENING');
  assert.doesNotMatch(JSON.stringify(f.events), /League|三个人|Name a/); f.c.leave();
});
test('STT completion exposes speech-end and processing timing without text', async () => {
  const f = setup(), endedAt = f.timers.now() - 200;
  await f.say('private timing fixture', 'a', { speechEndedAt: endedAt });
  const event = f.events.find(e => e.event === 'sttCompleted');
  assert.equal(event.speechEndedAt, endedAt);
  assert.equal(event.at - event.speechEndedAt, 200);
  assert.equal(event.at - event.sttStartedAt, event.durationMs);
  assert.doesNotMatch(JSON.stringify(event), /private|Name a/);
  f.c.leave();
});
test('explicit contextual invocation uses chronological labeled recent speech and returns immediately to passive', async () => {
  const f = setup(); await f.say('We should play League.'); f.timers.tick(100); await f.say('Only three of us.', 'b');
  await f.say('大肥鱼，你觉得呢？', 'b');
  assert.equal(f.calls.length, 1); const p = JSON.parse(f.calls[0].query);
  assert.equal(p.invokingSpeaker.id, 'b'); assert.equal(p.invokingSpeaker.name, 'Name b'); assert.equal(p.request, '你觉得呢');
  assert.deepEqual(p.recentDialogue.map(e => e.text), ['We should play League.', 'Only three of us.']);
  assert.deepEqual(p.recentDialogue.map(e => e.speaker), ['a', 'b']); assert.equal(f.c.state, 'PASSIVE_LISTENING');
  await f.say('Yeah, hold on.'); await f.say('No, I just to tell you', 'b'); assert.equal(f.calls.length, 1); f.c.leave();
});
test('missing context is represented as empty data and second explicit invocation produces one more response', async () => {
  const f = setup(); await f.say('大肥鱼，你怎么看？'); assert.deepEqual(JSON.parse(f.calls[0].query).recentDialogue, []);
  await f.say('大肥鱼，what about tomorrow?', 'b'); assert.equal(f.calls.length, 2); f.c.leave();
});

test('local Whisper introduction without name punctuation reaches one response without logging speech', async () => {
  const f = setup();
  try {
    await f.say('大肥鱼介绍一下。自己。');
    assert.equal(f.c.status().invocations, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.parse(f.calls[0].query).request, '介绍一下。自己');
    assert.equal(f.c.state, 'PASSIVE_LISTENING');
    assert.doesNotMatch(JSON.stringify(f.events), /大肥鱼|介绍|自己/);
  } finally { f.c.leave(); }
});
test('bare name answers once without granting later nameless speech permission to invoke', async () => {
  const f = setup(); await f.say('大肥鱼'); assert.equal(f.calls.length, 1); assert.equal(f.c.state, 'PASSIVE_LISTENING');
  assert.equal(JSON.parse(f.calls[0].query).request, '大肥鱼');
  await f.say('Human background question?', 'b'); assert.equal(f.calls.length, 1);
  await f.say('What should we play?'); assert.equal(f.calls.length, 1); assert.equal(f.c.state, 'PASSIVE_LISTENING');
  await f.say('Another question?'); assert.equal(f.calls.length, 1); f.c.leave();
});
test('name-only answer does not open a delayed follow-up window', async () => {
  const f = setup(); await f.say('嘿，大肥鱼。'); f.timers.tick(8000);
  assert.equal(f.c.state, 'PASSIVE_LISTENING'); await f.say('Late question?'); assert.equal(f.calls.length, 1); f.c.leave();
});
test('slow nameless speech after a name-only answer does not invoke again', async () => {
  const wait = deferred(); let slow = false;
  const f = setup({ transcribe: pcm => slow ? wait.promise : Promise.resolve(pcm.toString()) });
  await f.say('大肥鱼'); f.timers.tick(7000); slow = true; f.c.submit(Buffer.from('question'), 'a');
  f.timers.tick(2000); wait.resolve('What should we play?'); await flush(); assert.equal(f.calls.length, 1); f.c.leave();
});
test('nameless speech segmented before name STT completes does not become a second invocation', async () => {
  const wait = deferred(); let n = 0;
  const f = setup({ transcribe: () => ++n === 1 ? wait.promise : Promise.resolve('What should we play?') });
  f.c.submit(Buffer.from('name'), 'a'); f.c.submit(Buffer.from('question'), 'a'); await flush();
  wait.resolve('大肥鱼'); await flush(); assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.calls[0].query).request, '大肥鱼');
  await f.say('Another ordinary question?'); assert.equal(f.calls.length, 1); f.c.leave();
});
test('reverse STT completion still keeps context in speech order before invocation', async () => {
  const a = deferred(), b = deferred(); let n = 0;
  const f = setup({ transcribe: () => ++n === 1 ? a.promise : b.promise });
  f.c.submit(Buffer.from('one'), 'a'); f.timers.tick(10); f.c.submit(Buffer.from('two'), 'b');
  b.resolve('大肥鱼，你觉得呢？'); await flush(); assert.equal(f.calls.length, 0);
  a.resolve('Only three of us tonight.'); await flush();
  assert.equal(JSON.parse(f.calls[0].query).recentDialogue[0].text, 'Only three of us tonight.'); f.c.leave();
});
test('rolling context expires automatically and enforces count and serialized character bounds', () => {
  const timers = clock(), b = createRollingContext({ timers, now: timers.now, maxEntries: 2, maxChars: 400, ageMs: 1000 });
  b.add({ sequence: 1, timestamp: timers.now(), text: 'one' }); timers.tick(10);
  b.add({ sequence: 2, timestamp: timers.now(), text: 'two' }); b.add({ sequence: 3, timestamp: timers.now(), text: 'three' });
  assert.deepEqual(b.snapshot().map(e => e.text), ['two', 'three']); timers.tick(1000);
  assert.equal(timers.tasks.size, 0); assert.deepEqual(b.snapshot(), []);
  b.add({ sequence: 4, timestamp: timers.now(), text: 'x'.repeat(500) }); assert.deepEqual(b.snapshot(), []);
});
test('rolling snapshot cannot mutate memory and older timestamps are sorted', () => {
  const timers = clock(), b = createRollingContext({ timers, now: timers.now });
  b.add({ sequence: 2, timestamp: timers.now(), text: 'later' }); b.add({ sequence: 1, timestamp: timers.now() - 1, text: 'earlier' });
  const copy = b.snapshot(); copy[0].text = 'changed'; assert.equal(b.snapshot()[0].text, 'earlier'); b.clear(); assert.equal(timers.tasks.size, 0);
});
test('request JSON obeys UTF-8 byte bound including names, question and dialogue framing', async () => {
  const f = setup({ requestBytes: 500 }); for (let i = 0; i < 20; i++) { f.timers.tick(10); await f.say('第' + i + '句很长的中文讨论。'.repeat(10)); }
  await f.say('大肥鱼，你觉得呢？'); assert.ok(Buffer.byteLength(f.calls[0].query) <= 500); f.c.leave();
});
test('queued invocation rebuilds context at send time so expired transcripts never bypass TTL', async () => {
  const wait = deferred(), calls = [];
  const f = setup({ ageMs: 1000, respond: async data => { calls.push(data); if (calls.length === 1) await wait.promise; return true; } });
  await f.say('Short-lived context'); await f.say('大肥鱼，你觉得呢？'); await f.say('大肥鱼，帮我们想一下', 'b');
  f.timers.tick(1500); wait.resolve(); await flush(); assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].query).recentDialogue, []); f.c.leave();
});
test('sustained local fixture speech keeps retention bounded and makes zero conversational calls', async () => {
  const f = setup(); for (let i = 0; i < 1000; i++) { f.timers.tick(10); await f.say('Human conversation number ' + i, i % 2 ? 'a' : 'b'); }
  assert.equal(f.calls.length, 0); assert.ok(f.c.status().contextEntries <= 40); assert.ok(f.c.status().contextChars <= 6000);
  assert.equal(f.c.status().pending, 0); f.c.leave(); assert.equal(f.timers.tasks.size, 0);
});
test('pause cancels STT, clears context, refuses audio, and resume starts empty', async () => {
  const wait = deferred(); let slow = false;
  const f = setup({ transcribe: pcm => slow ? wait.promise : Promise.resolve(pcm.toString()) });
  await f.say('private context'); slow = true; f.c.submit(Buffer.from('late'), 'b'); f.c.command('pause');
  assert.equal(f.c.paused, true); assert.equal(f.c.status().contextEntries, 0); assert.equal(await f.say('大肥鱼，你怎么看？'), false);
  wait.resolve('大肥鱼，你觉得呢？'); await flush(); assert.equal(f.calls.length, 0);
  f.c.command('resume'); assert.equal(f.c.paused, false); assert.equal(f.c.status().contextEntries, 0); f.c.leave();
});
test('pause remains in force across a connection recovery', async () => {
  const f = setup(); f.c.command('pause'); f.c.reset(); f.c.attach('g', 'v');
  assert.equal(f.c.paused, true); assert.equal(await f.say('hello'), false); f.c.leave();
});
for (const action of ['interrupt', 'end', 'pause', 'leave', 'stop']) test(action + ' aborts generation and queued explicit replies; late output cannot reactivate', async () => {
  const wait = deferred(), calls = [];
  const f = setup({ respond: data => { calls.push(data); return wait.promise; } });
  await f.say('We should play League.'); await f.say('大肥鱼，你觉得呢？'); await f.say('大肥鱼，帮我们想一下', 'b');
  f.c.command(action); await flush(); assert.ok(calls[0].signal.aborted); assert.equal(f.c.status().queuedInvocations, 0);
  wait.resolve(true); await flush(); assert.notEqual(f.c.state, 'RESPONDING'); assert.equal(calls.length, 1);
  if (action === 'interrupt') assert.ok(f.c.status().contextEntries > 0); else assert.equal(f.c.status().contextEntries, 0); f.c.leave();
});
test('spoken stop bypasses an earlier pending STT without an LLM request', async () => {
  const wait = deferred(); let n = 0;
  const f = setup({ transcribe: () => ++n === 1 ? wait.promise : Promise.resolve('大肥鱼，停。') });
  f.c.submit(Buffer.from('slow'), 'a'); f.c.submit(Buffer.from('stop'), 'b'); await flush();
  assert.equal(f.calls.length, 0); assert.equal(f.c.status().pending, 0); wait.resolve('大肥鱼，回答一下'); await flush(); assert.equal(f.calls.length, 0); f.c.leave();
});
test('generation worker serializes explicitly invoked replies while ordinary speech stays passive', async () => {
  const wait = deferred(), calls = []; let active = 0, peak = 0;
  const f = setup({ respond: async data => { calls.push(data); active++; peak = Math.max(peak, active); if (calls.length === 1) await wait.promise; active--; return true; } });
  await f.say('大肥鱼，你怎么看？'); await f.say('ordinary speech', 'b'); await f.say('大肥鱼，帮我们想一下', 'b');
  assert.equal(calls.length, 1); wait.resolve(); await flush(); assert.equal(calls.length, 2); assert.equal(peak, 1); f.c.leave();
});
test('queue overload drops older unstarted context and never exceeds two local STT operations', async () => {
  const waits = []; let active = 0, peak = 0;
  const f = setup({ transcribe: () => { active++; peak = Math.max(peak, active); const d = deferred(); waits.push(d); return d.promise.finally(() => active--); } });
  for (let i = 0; i < 30; i++) f.c.submit(Buffer.from('sound' + i), i % 2 ? 'a' : 'b');
  assert.ok(f.c.status().pending <= 6); assert.ok(f.c.status().dropped >= 24); assert.equal(peak, 2);
  f.c.command('pause'); for (const d of waits) d.resolve('late'); await flush(); assert.equal(f.calls.length, 0); f.c.leave();
});
test('STT timeout, stale audio, oversize audio, noise and duplicates cannot invoke DeepSeek', async () => {
  const wait = deferred(); const f = setup({ transcribe: () => wait.promise });
  f.c.submit(Buffer.from('hung'), 'a'); f.timers.tick(15000); await flush(); assert.equal(f.c.status().pending, 0);
  assert.equal(f.c.submit(Buffer.from('old'), 'a', { speechEndedAt: f.timers.now() - 20000 }), false);
  assert.equal(f.c.submit(Buffer.alloc(960001), 'a'), false); assert.equal(f.c.submit(Buffer.from('forced'), 'a', { forced: true }), false);
  wait.resolve('大肥鱼，你怎么看？'); await flush(); assert.equal(f.calls.length, 0); f.c.leave();
  const g = setup(); for (const text of ['[BLANK_AUDIO]', 'um', 'please subscribe']) await g.say(text);
  await g.say('大肥鱼，你怎么看？'); await g.say('大肥鱼，你怎么看？'); assert.equal(g.calls.length, 1); g.c.leave();
});
test('waiting stale audio is dropped before consuming additional STT capacity', async () => {
  const waits = []; const f = setup({ sttTimeoutMs: 30000, staleMs: 1000, transcribe: () => { const d = deferred(); waits.push(d); return d.promise; } });
  f.c.submit(Buffer.from('one'), 'a'); f.c.submit(Buffer.from('two'), 'b'); f.c.submit(Buffer.from('old queued audio'), 'a');
  f.timers.tick(1500); waits[0].resolve('old context'); waits[1].resolve('other context'); await flush();
  assert.equal(waits.length, 2); assert.equal(f.c.status().pending, 0); assert.equal(f.calls.length, 0); assert.ok(f.c.status().dropped >= 1); f.c.leave();
});
test('cross-channel attach, departed/opted-out speaker, reset and empty channel reject stale context', async () => {
  const wait = deferred(); const f = setup({ transcribe: () => wait.promise });
  assert.throws(() => f.c.attach('other', 'v')); assert.equal(f.c.submit(Buffer.from('x'), 'outsider'), false);
  f.c.submit(Buffer.from('old'), 'a'); f.humans.delete('a'); f.c.memberLeft('a'); wait.resolve('大肥鱼，你怎么看？'); await flush();
  assert.equal(f.calls.length, 0); f.humans.clear(); f.c.memberLeft('b'); assert.equal(f.c.state, 'DISCONNECTED'); assert.equal(f.c.status().contextEntries, 0);
});
test('channel opt-in, default everyone consent, explicit legacy compatibility and bounded config fail closed', () => {
  const base = { CONVERSATION_ENABLED: 'true', CONVERSATION_GUILD_ID: '100000000000000104', CONVERSATION_CHANNEL_ID: '100000000000000103' };
  assert.equal(loadConversationConfig({}).enabled, false); const c = loadConversationConfig(base);
  assert.equal(c.mode, 'passive'); assert.equal(c.allParticipants, true); assert.equal(c.users.size, 0);
  assert.throws(() => loadConversationConfig({ CONVERSATION_ENABLED: 'true' }));
  assert.throws(() => loadConversationConfig({ ...base, CONVERSATION_ALL_PARTICIPANTS: 'false' }));
  assert.throws(() => loadConversationConfig({ ...base, CONVERSATION_CONTEXT_ENTRIES: '10000' }));
  assert.throws(() => loadConversationConfig({ ...base, CONVERSATION_STT_TIMEOUT_MS: 'NaN' }));
  assert.equal(loadConversationConfig({ ...base, CONVERSATION_MODE: 'active', CONVERSATION_USER_IDS: '100000000000000106' }).allParticipants, false);
});
test('production Whisper form explicitly requests auto language, transcription, cancellation and no error transcript logging', async () => {
  let init; const logs = [];
  const w = createWhisper({ config: { WHISPER_SERVER_URLS: ['http://127.0.0.1/inference'], WHISPER_TIMEOUT_MS: 1000 },
    fetch: async (_, options) => { init = options; return { ok: true, json: async () => ({ text: '大肥鱼，你怎么看？' }) }; }, console: { error: (...v) => logs.push(v) } });
  const signal = new AbortController().signal;
  assert.equal(await w.transcribe(Buffer.alloc(100), { language: 'auto', translate: false, signal }), '大肥鱼，你怎么看？');
  assert.equal(init.body.get('language'), 'auto'); assert.equal(init.body.get('translate'), 'false'); assert.ok(init.signal);
  const e = createWhisper({ config: { WHISPER_SERVER_URLS: ['local'], WHISPER_TIMEOUT_MS: 1000 },
    fetch: async () => ({ ok: false, status: 500, text: async () => { throw new Error('must not read private response body'); } }), console: { error: (...v) => logs.push(v) } });
  assert.equal(await e.transcribe(Buffer.alloc(100)), null); assert.doesNotMatch(JSON.stringify(logs), /private/);
});
