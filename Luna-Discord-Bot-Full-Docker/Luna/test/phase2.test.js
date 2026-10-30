const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createConversation, controlCommand } = require('../voice-conversation');
const { loadConversationConfig } = require('../conversation-config');
const { createDeepSeek } = require('../deepseek');
const { loadDeepSeekConfig } = require('../deepseek-config');
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function clock() {
  let at = 0, sequence = 0; const tasks = new Map();
  return { now: () => at, tasks,
    setTimeout(fn, ms) { const id = ++sequence; tasks.set(id, { fn, due: at + ms }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    tick(ms) { const target = at + ms;
      for (;;) { const due = [...tasks].filter(([,t]) => t.due <= target).sort((a,b) => a[1].due-b[1].due)[0];
        if (!due) break; tasks.delete(due[0]); at = due[1].due; due[1].fn(); }
      at = target;
    },
  };
}
function setup(options = {}) {
  const timers = clock(), calls = [], spoken = [], events = [], humans = new Set(['a', 'b']);
  let clears = 0, leaves = 0, cancels = 0;
  const c = createConversation({ guildId: 'guild', channelId: 'voice', timers, now: timers.now,
    isAuthorized: id => humans.has(id), hasParticipants: () => humans.size > 0,
    transcribe: async pcm => pcm.toString(),
    respond: async item => { calls.push(item); spoken.push(item.query); return true; },
    clearHistory: () => clears++, disconnect: () => leaves++, cancelPlayback: () => cancels++,
    onEvent: e => events.push(e), ...options });
  c.attach('guild', 'voice');
  const say = async (text, id = 'a', meta) => { const accepted = c.submit(Buffer.from(text), id, meta); await flush(); return accepted; };
  return { c, say, timers, calls, spoken, events, humans, get clears() { return clears; }, get leaves() { return leaves; }, get cancels() { return cancels; } };
}

test('standby ignores unrelated speech; valid wake and bare wake activate locally', async () => {
  const f = setup(); await f.say('talking to someone else'); assert.equal(f.c.state, 'STANDBY'); assert.equal(f.calls.length, 0);
  await f.say('Hey Luna'); assert.equal(f.c.state, 'ACTIVE'); assert.equal(f.calls.length, 0);
  await f.say('what is two plus two?', 'b'); assert.equal(f.calls.length, 1); assert.match(f.calls[0].query, /^Speaker b:/);
});
test('speaker attribution, wake stripping and followups share the exact channel scope', async () => {
  const f = setup(); await f.say('Hey Luna, remember four'); await f.say('double it', 'b');
  assert.deepEqual(f.spoken, ['Speaker a: remember four', 'Speaker b: double it']);
  assert.equal(f.calls[0].scopeId, f.calls[1].scopeId); assert.equal(f.c.state, 'ACTIVE');
});
test('concurrent STT completing in reverse still yields FIFO responses', async () => {
  const a = deferred(), b = deferred(); let n = 0;
  const f = setup({ transcribe: () => (++n === 1 ? a.promise : b.promise) });
  f.c.submit(Buffer.from('one'), 'a'); f.c.submit(Buffer.from('two'), 'b');
  b.resolve('followup'); await flush(); assert.equal(f.calls.length, 0);
  a.resolve('Hey Luna, first'); await flush(); assert.deepEqual(f.spoken, ['Speaker a: first', 'Speaker b: followup']);
});
test('one response worker serializes simultaneous people and history writes', async () => {
  const wait = deferred(), calls = []; let active = 0, maximum = 0;
  const f = setup({ respond: async item => { calls.push(item); active++; maximum = Math.max(maximum, active);
    if (calls.length === 1) await wait.promise; active--; return true; } });
  await f.say('Hey Luna first'); await f.say('second', 'b'); assert.equal(calls.length, 1);
  wait.resolve(); await flush(); assert.equal(calls.length, 2); assert.equal(maximum, 1);
});
test('noise, empty STT, hallucinations and forced continuous segments never make requests', async () => {
  const f = setup(); await f.say('Hey Luna');
  for (const s of ['[BLANK_AUDIO]', 'um', 'thanks for watching', 'please subscribe']) await f.say(s);
  assert.equal(await f.say('continuous voice', 'a', { forced: true }), false);
  assert.equal(f.calls.length, 0); f.timers.tick(45000); assert.equal(f.c.state, 'STANDBY');
});
test('PCM duplicates and repeated transcripts suppressed without refreshing inactivity', async () => {
  const f = setup(); await f.say('Hey Luna, hello'); assert.equal(await f.say('Hey Luna, hello'), false);
  f.timers.tick(1000); await f.say('HEY LUNA HELLO!'); assert.equal(f.calls.length, 1);
  f.timers.tick(44000); assert.equal(f.c.state, 'STANDBY');
});
test('45 second timeout clears context and stays connected', async () => {
  const f = setup(); await f.say('Hey Luna first'); f.timers.tick(44999); assert.equal(f.c.state, 'ACTIVE');
  const cleared = f.clears; f.timers.tick(1); assert.equal(f.c.state, 'STANDBY'); assert.equal(f.leaves, 0); assert.equal(f.clears, cleared + 1);
  await f.say('not a wake'); assert.equal(f.calls.length, 1);
});
test('inactivity never expires mid generation, then restarts after delivered output', async () => {
  const wait = deferred(); const f = setup({ respond: () => wait.promise });
  await f.say('Hey Luna first'); f.timers.tick(90000); assert.equal(f.c.state, 'RESPONDING');
  wait.resolve(true); await flush(); f.timers.tick(44999); assert.equal(f.c.state, 'ACTIVE');
  f.timers.tick(1); assert.equal(f.c.state, 'STANDBY');
});
test('inactivity waits for STT; invalid text does not grant a fresh 45 seconds', async () => {
  const wait = deferred(); let second = false;
  const f = setup({ transcribe: pcm => second ? wait.promise : Promise.resolve(pcm.toString()) });
  await f.say('Hey Luna'); f.timers.tick(44000); second = true; f.c.submit(Buffer.from('noise'), 'b');
  f.timers.tick(3000); assert.equal(f.c.state, 'ACTIVE'); wait.resolve('um'); await flush();
  f.timers.tick(0); assert.equal(f.c.state, 'STANDBY');
});

test('continuous invalid STT cannot admit unlimited work beyond idle deadline', async () => {
  const wait = deferred(); let delayed = false;
  const f = setup({ transcribe: pcm => delayed ? wait.promise : Promise.resolve(pcm.toString()) });
  await f.say('Hey Luna'); f.timers.tick(44000); delayed = true; f.c.submit(Buffer.from('pending noise'), 'b');
  f.timers.tick(2000); assert.equal(f.c.submit(Buffer.from('more noise'), 'a'), false);
  wait.resolve('um'); await flush(); f.timers.tick(0); assert.equal(f.c.state, 'STANDBY');
});
test('interrupt cancels streaming and queued turns, preserves context, remains ACTIVE', async () => {
  const wait = deferred(), calls = [];
  const f = setup({ respond: item => { calls.push(item); return wait.promise; } });
  await f.say('Hey Luna first'); await f.say('queued', 'b'); const clears = f.clears, scope = calls[0].scopeId;
  f.c.interrupt(); await flush(); assert.ok(calls[0].signal.aborted); assert.equal(f.c.state, 'ACTIVE'); assert.equal(f.clears, clears);
  assert.equal(f.c.status().pending, 0); wait.resolve(false); await f.say('new turn', 'b');
  assert.equal(calls.at(-1).scopeId, scope);
});
test('voice controls preempt a generating response without consulting the LLM', async () => {
  const wait = deferred(); const f = setup({ respond: () => wait.promise });
  await f.say('Hey Luna first'); await f.say('DeepSeek, stop', 'b');
  assert.equal(f.c.state, 'ACTIVE'); assert.ok(f.events.some(e => e.event === 'voice-control' && typeof e.recognitionMs === 'number'));
  wait.resolve(false); await flush(); await f.say('DeepSeek, end conversation', 'b'); assert.equal(f.c.state, 'STANDBY');
  await f.say('DeepSeek, leave'); assert.equal(f.c.state, 'DISCONNECTED'); assert.equal(f.leaves, 1);
});
test('end cancels current work and clears scope, without disconnecting', async () => {
  const f = setup(); await f.say('Hey Luna first'); const scope = f.calls[0].scopeId;
  f.c.end(); assert.equal(f.c.state, 'STANDBY'); assert.equal(f.leaves, 0);
  await f.say('Hey Luna second'); assert.notEqual(f.calls[1].scopeId, scope);
});
test('emergency stop disconnects immediately and refuses late generation and new speech', async () => {
  const wait = deferred(); const f = setup({ respond: () => wait.promise }); await f.say('Hey Luna first');
  f.c.command('stop'); assert.equal(f.c.state, 'DISCONNECTED'); assert.equal(f.leaves, 1);
  wait.resolve(true); await flush(); assert.equal(f.c.state, 'DISCONNECTED'); assert.equal(await f.say('Hey Luna late'), false);
});
test('cancel during STT aborts and rejects the stale transcript across reattach', async () => {
  const wait = deferred(); let signal;
  const f = setup({ transcribe: (_, o) => { signal = o.signal; return wait.promise; } });
  f.c.submit(Buffer.from('one'), 'a'); f.c.leave(); assert.ok(signal.aborted);
  f.c.attach('guild', 'voice'); wait.resolve('Hey Luna late'); await flush(); assert.equal(f.c.state, 'STANDBY'); assert.equal(f.calls.length, 0);
});
test('bounded queues, audio bytes, text size and turn count', async () => {
  const wait = deferred(); const f = setup({ transcribe: () => wait.promise, maxPending: 2, maxAudioBytes: 5 });
  assert.equal(f.c.submit(Buffer.alloc(6), 'a'), false);
  assert.ok(f.c.submit(Buffer.from('1'), 'a')); assert.ok(f.c.submit(Buffer.from('2'), 'b'));
  assert.equal(f.c.submit(Buffer.from('3'), 'a'), false); assert.equal(f.c.status().stt, 2); f.c.leave(); wait.resolve('late'); await flush();
  const g = setup({ maxTurns: 1 }); await g.say('Hey Luna first'); await g.say('second', 'b');
  assert.equal(g.calls.length, 1); assert.equal(g.c.state, 'STANDBY');
  const h = setup({ maxTextBytes: 8 }); await h.say('Hey Luna way too long'); assert.equal(h.calls.length, 0);
});
test('absent speaker, bots (authorization filter), and cross-channel attach are refused', async () => {
  const f = setup(); assert.equal(await f.say('Hey Luna', 'bot'), false);
  assert.throws(() => f.c.attach('other', 'voice')); assert.throws(() => f.c.attach('guild', 'other'));
  assert.equal(f.calls.length, 0);
});
test('departing participant cannot contribute a late transcript; empty membership disconnects', async () => {
  const wait = deferred(); const f = setup({ transcribe: () => wait.promise }); f.c.submit(Buffer.from('one'), 'b');
  f.humans.delete('b'); f.c.memberLeft('b'); wait.resolve('Hey Luna late'); await flush(); assert.equal(f.calls.length, 0);
  f.humans.clear(); f.c.memberLeft('a'); assert.equal(f.c.state, 'DISCONNECTED'); assert.equal(f.leaves, 1);
});
test('stale idle callback cannot end a new active session', async () => {
  const f = setup(); await f.say('Hey Luna first'); const old = [...f.timers.tasks.values()][0].fn;
  f.c.end(); await f.say('Hey Luna second'); old(); assert.equal(f.c.state, 'ACTIVE');
});
test('STT deadline releases resources and cannot refresh a session', async () => {
  const f = setup({ transcribe: () => new Promise(() => {}), sttTimeoutMs: 100 });
  f.c.submit(Buffer.from('one'), 'a'); f.timers.tick(100); await flush();
  assert.equal(f.c.status().stt, 0); assert.equal(f.c.status().pending, 0); assert.equal(f.calls.length, 0);
});
test('controls require exact addressed phrases', () => {
  assert.equal(controlCommand('DeepSeek, stop!'), 'interrupt');
  for (const text of ['stop', 'DeepSeek please stop', 'do not say DeepSeek leave', 'DeepSeek leave and delete']) assert.equal(controlCommand(text), null);
});
test('strict opt-in config and consenting IDs', () => {
  assert.equal(loadConversationConfig({}).enabled, false);
  assert.throws(() => loadConversationConfig({ CONVERSATION_ENABLED: 'true' }));
  assert.throws(() => loadConversationConfig({ CONVERSATION_IDLE_MS: 'NaN' }));
  assert.equal(loadConversationConfig({}).operators.size, 0);
  assert.throws(() => loadConversationConfig({ CONVERSATION_ENABLED: 'true',
    CONVERSATION_USER_IDS: '100000000000000106', CONVERSATION_OPERATOR_IDS: 'bad-id' }));
  assert.equal(loadConversationConfig({ CONVERSATION_ENABLED: 'true', CONVERSATION_MODE: 'active', CONVERSATION_USER_IDS: '100000000000000106,100000000000000107' }).inactivityMs, 45000);
});

test('actual adapter shared history contains both speakers, excludes interrupted output, and resets on end', async () => {
  const requests = [];
  const llm = createDeepSeek({ config: loadDeepSeekConfig({ DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'fake' }), console: { log() {} },
    fetch: async (_, init) => { requests.push(JSON.parse(init.body)); return new Response(
      'data: {"choices":[{"delta":{"content":"Answer."}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }); } });
  let hear = true;
  const f = setup({ clearHistory: () => llm.forgetConversations(), respond: async item => {
    const turn = llm.createTurn({ guildId: 'guild', sessionId: item.scopeId, userId: 'shared', query: item.query, signal: item.signal });
    try { for await (const sentence of turn.stream()) if (hear) turn.acknowledge(sentence); return turn.commit(); }
    finally { turn.dispose(); }
  } });
  await f.say('Hey Luna first'); await f.say('followup', 'b');
  assert.deepEqual(requests[1].messages.filter(m => m.role === 'user').map(m => m.content), ['Speaker a: first', 'Speaker b: followup']);
  hear = false; await f.say('unheard'); hear = true; await f.say('next', 'b');
  assert.ok(!requests.at(-1).messages.some(m => m.content === 'Speaker a: unheard'));
  f.c.end(); await f.say('Hey Luna fresh'); assert.equal(requests.at(-1).messages.length, 2);
});
