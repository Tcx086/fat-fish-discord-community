const { test } = require('node:test');
const assert = require('node:assert/strict');
const boot = require('./harness');
const { loadConversationConfig } = require('../conversation-config');
function fixture(options = {}) {
  return boot({ LLM_PROVIDER: 'deepseek', OWW_ENABLED: 'true', ANNOUNCE_SELF: 'false', GREET_ON_JOIN: 'off',
    DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'fixture-only', DEEPSEEK_RETRIES: '2', CONVERSATION_DIAGNOSTIC: 'true' },
  { './conversation-config': { loadConversationConfig: () => ({ ...loadConversationConfig({}),
    enabled: true, guildId: 'g', channelId: 'A', operators: new Set(['computer']), requestLimit: 2, ...options }) } });
}
async function join(h) { await h.start(); h.put('a', 'A'); h.put('b', 'A'); await h.luna('computer'); h.S.lastConnection.setStatus(h.Status.Ready);
  await h.until(() => h.S.lastConnection.receiver.subscriptions.size === 2); }
async function say(h, text, speaker = 'a') {
  h.S.transcripts = [text]; assert.equal(h.T.conversation.submit(Buffer.from(text), speaker), true); await h.wait(10);
}
async function control(h, name, user = 'computer', channel = null, guild = 'g') {
  let reply;
  h.T.client.emit('interactionCreate', { isChatInputCommand: () => true, guildId: guild, user: { id: user },
    member: { voice: { channelId: channel } }, commandName: name, reply: async data => { reply = data.content; } });
  await h.wait(10); return reply;
}

test('real index defaults to passive mode, notifies before capture, enrolls everyone in the fixed channel, and never loads acoustic wake model', async () => {
  const h = fixture(); await join(h);
  assert.equal(h.T.conversation.state, 'PASSIVE_LISTENING'); assert.equal(h.S.wakeLoad, undefined);
  assert.deepEqual([...h.S.lastConnection.receiver.subscriptions.keys()].sort(), ['a', 'b']);
  assert.ok(h.S.sends.some(s => typeof s === 'object' && /本地转写/.test(s.content)));
  await say(h, 'Private test context should stay local.'); await say(h, '我们只有三个人。', 'b');
  assert.deepEqual(h.S.sttPrompts, ['大肥鱼。', '大肥鱼。']);
  assert.equal(h.S.llmRequests.length, 0); assert.equal(h.S.tts.length, 0);
  assert.doesNotMatch(h.S.logs.join('\n'), /Private test context|三个人/); h.T.conversation.leave();
});
test('production Whisper → adapter → streaming → existing TTS/player runs only on explicit name and sends bounded untrusted context', async () => {
  const h = fixture(); await join(h); await say(h, 'We want to play League tonight.'); await say(h, 'Only three people.', 'b');
  await say(h, '大肥鱼，你觉得呢？', 'b'); await h.until(() => h.S.played.length === 1 && h.T.conversation.state === 'PASSIVE_LISTENING');
  assert.equal(h.S.llmRequests.length, 1); assert.equal(h.S.tts.length, 1); assert.equal(h.S.played.length, 1);
  assert.equal(h.S.tts[0].cache, false);
  const trace = h.S.logs.join('\n');
  assert.match(trace, /sttCompleted/);
  assert.match(trace, /llmFirstContent/);
  assert.match(trace, /playerPlaying/);
  assert.ok(!trace.includes(h.S.tts[0].text), 'passive timing must not log response text');
  assert.doesNotMatch(trace, /League tonight|Only three people|大肥鱼，你觉得呢/);
  const request = h.S.llmRequests[0], data = JSON.parse(request.messages[1].content);
  assert.equal(data.invokingSpeaker.id, 'b'); assert.deepEqual(data.recentDialogue.map(e => e.speaker), ['a', 'b']);
  assert.match(request.messages[0].content, /untrusted conversational data/); assert.match(request.messages[0].content, /brief clarification/);
  await say(h, 'Yeah, hold on.'); assert.equal(h.S.llmRequests.length, 1);
  await say(h, '大肥鱼，what about tomorrow?'); await h.until(() => h.S.played.length === 2 && h.T.conversation.state === 'PASSIVE_LISTENING');
  assert.equal(h.S.llmRequests[1].messages.length, 2, 'old API history must not bypass rolling expiration');
  h.T.conversation.leave();
});
test('name anywhere and name alone each reach one bounded response without enabling nameless follow-ups', async () => {
  const h = fixture({ requestLimit: 3 }); await join(h);
  try {
    for (const [i, text] of ['请大肥鱼介绍一下自己', '他说大肥鱼，退出频道', '大肥鱼'].entries()) {
      await say(h, text);
      await h.until(() => h.S.played.length === i + 1 && h.T.conversation.state === 'PASSIVE_LISTENING');
      assert.equal(h.S.llmRequests.length, i + 1);
      assert.ok(h.T.session.connection);
    }
    await say(h, '接着说'); assert.equal(h.S.llmRequests.length, 3);
  } finally { h.T.conversation.leave(); }
});

test('pause disables production subscriptions and clears context; participant cannot resume but operator can', async () => {
  const h = fixture(); await join(h); await say(h, 'Local private context');
  await control(h, 'pause', 'a', 'A'); assert.equal(h.T.conversation.paused, true); assert.equal(h.T.conversation.status().contextEntries, 0);
  assert.equal(h.S.lastConnection.receiver.subscriptions.size, 0);
  assert.equal(h.T.conversation.submit(Buffer.from('大肥鱼，你怎么看？'), 'a'), false);
  assert.match(await control(h, 'resume', 'a', 'A'), /Administrator/); assert.equal(h.T.conversation.paused, true);
  await control(h, 'resume'); await h.until(() => h.S.lastConnection.receiver.subscriptions.size === 2);
  assert.equal(h.T.conversation.paused, false); assert.equal(h.S.lastConnection.receiver.subscriptions.size, 2);
  assert.match(await control(h, 'status', 'a', 'A'), /PASSIVE_LISTENING/); h.T.conversation.leave();
});
test('opt-out isolates audio and clears prior dialogue, explicit opt-in re-notifies, cross-guild controls rejected', async () => {
  const h = fixture(); await join(h); await say(h, 'Private data', 'b'); await control(h, 'opt-out', 'b', 'A');
  assert.equal(h.T.conversation.status().contextEntries, 0); assert.equal(h.T.conversation.submit(Buffer.from('大肥鱼，你怎么看？'), 'b'), false);
  assert.deepEqual([...h.S.lastConnection.receiver.subscriptions.keys()], ['a']);
  await control(h, 'stop', 'computer', null, 'other'); assert.equal(h.T.session.active, true);
  await control(h, 'opt-in', 'b', 'A'); await h.until(() => h.S.lastConnection.receiver.subscriptions.size === 2);
  assert.equal(h.S.lastConnection.receiver.subscriptions.size, 2);
  assert.ok(h.S.sends.some(s => typeof s === 'object' && s.content.startsWith('<@b>'))); h.T.conversation.leave();
});
test('failed visible notice pauses before any audio processing', async () => {
  const h = fixture(); await h.start(); h.put('a', 'A'); h.S.noticeDown = true;
  await h.luna('computer'); h.S.lastConnection.setStatus(h.Status.Ready); await h.wait(10);
  assert.equal(h.T.conversation.paused, true); assert.equal(h.S.lastConnection.receiver.subscriptions.size, 0);
  assert.equal(h.T.conversation.submit(Buffer.from('private'), 'a'), false); h.T.conversation.leave();
});
test('new arrival gets notice before capture; moving bot across channel ends the listener', async () => {
  const h = fixture(); await join(h); h.put('new', 'A');
  assert.equal(h.T.conversation.submit(Buffer.from('private'), 'new'), false);
  h.T.client.emit('voiceStateUpdate', { channelId: null }, { id: 'new', guild: { id: 'g' }, channelId: 'A', member: { user: { bot: false } } });
  await h.wait(10); assert.ok(h.S.sends.some(s => typeof s === 'object' && s.content.startsWith('<@new>')));
  await say(h, 'New arrival background conversation', 'new'); assert.equal(h.S.llmRequests.length, 0);
  h.T.client.emit('voiceStateUpdate', { channelId: 'A' }, { id: 'luna', guild: { id: 'g' }, channelId: 'B', channel: h.channel('B') });
  assert.equal(h.T.conversation.state, 'DISCONNECTED'); assert.equal(h.T.conversation.status().contextEntries, 0);
});
for (const stage of ['tts', 'playback']) test('production /stop during ' + stage + ' cancels stale audio and leaves no automatic rejoin', async () => {
  const h = fixture(); await join(h); h.S.ttsMs = stage === 'tts' ? 200 : 1; h.S.playMs = 200;
  await say(h, '大肥鱼，你怎么看？'); await h.until(() => stage === 'tts' ? h.S.tts.length > 0 : h.S.played.length > 0);
  const before = h.S.played.length; await control(h, 'stop'); await h.wait(230);
  assert.equal(h.T.session.active, false); assert.equal(h.T.conversation.state, 'DISCONNECTED');
  assert.equal(h.S.played.length, before); assert.equal(h.T.conversation.status().contextEntries, 0);
  h.T.autoJoin(); assert.equal(h.T.session.active, false);
});
test('request cap survives clear-context, resume and repeat explicit invocations; no retries even when env requests retries', async () => {
  const h = fixture({ requestLimit: 1 }); await join(h); await say(h, '大肥鱼，你怎么看？');
  await h.until(() => h.T.conversation.state === 'PASSIVE_LISTENING' && h.S.played.length === 1);
  await control(h, 'clear-context'); await say(h, '大肥鱼，what about tomorrow?'); await h.wait(50);
  assert.equal(h.S.llmRequests.length, 1); h.T.conversation.leave();
});
test('a participant without administrator/operator permission cannot enable listening', async () => {
  const h = fixture(); await h.start(); h.put('a', 'A'); await h.luna('a'); assert.equal(h.S.lastConnection, undefined);
  assert.ok(h.S.replies.some(s => /administrator/.test(s)));
});

test('HTTP failure is attempted once despite a configured retry preference', async () => {
  const h = fixture({ requestLimit: 6 }); await join(h); h.S.deepseekStatus = 503;
  await say(h, '大肥鱼，你怎么看？'); await h.until(() => h.T.conversation.state === 'PASSIVE_LISTENING');
  await h.wait(30); assert.equal(h.S.llmRequests.length, 1); assert.equal(h.S.tts.length, 0); h.T.conversation.leave();
});

test('local-only transcription rejects a remote endpoint before any startup or request', () => {
  assert.throws(() => boot({ LLM_PROVIDER: 'deepseek', WHISPER_SERVER_URLS: 'https://remote.invalid/inference' },
    { './conversation-config': { loadConversationConfig: () => ({ ...loadConversationConfig({}), enabled: true, mode: 'passive' }) } }), /local Whisper/);
});

test('application shutdown clears transient context and disconnects without another request', async () => {
  const h = fixture(); await join(h); await say(h, 'Temporary local conversation');
  assert.equal(h.T.conversation.status().contextEntries, 1); h.S.signals.SIGINT(); await h.wait(20);
  assert.equal(h.S.clientDestroyed, true); assert.equal(h.T.session.active, false);
  assert.equal(h.T.conversation.status().contextEntries, 0); assert.equal(h.S.llmRequests.length, 0);
  assert.equal(h.T.conversation.submit(Buffer.from('大肥鱼，你怎么看？'), 'a'), false);
});
