const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMusicCommands, commandDefinition } = require('../music-commands');
const { createPassiveListener, invocation } = require('../passive-listener');
const { createNowPlaying } = require('../now-playing');
const { fixture, tick, deferred } = require('./music-fixture');

test('all required voice phrases are deterministic and ordinary background mentions never become controls', () => {
  for (const [phrase, action] of [['放首歌', 'play'], ['播放晴天', 'play'], ['下一首', 'skip'], ['暂停音乐', 'pause'],
    ['继续播放', 'resume'], ['停止音乐', 'stop'], ['现在放的是什么歌？', 'now-playing'], ['这是什么歌？', 'now-playing']]) {
    assert.equal(invocation(`大肥鱼，${phrase}`).music.action, action); assert.equal(invocation(phrase), null);
    assert.equal(invocation(`他说大肥鱼，${phrase}`), null);
    assert.equal(invocation(`他说大肥鱼，${phrase}`, { phrase: '大肥鱼', mode: 'anywhere' }).music, undefined);
  }
  assert.equal(invocation('大肥鱼，暂停').action, 'pause'); assert.equal(invocation('大肥鱼，别说了').action, 'interrupt');
  assert.equal(invocation('大肥鱼，退出频道').action, 'leave'); assert.equal(invocation('大肥鱼，停止音乐').action, null);
});

test('guild, membership, bot, permissions and operator eligibility are checked before commands or autocomplete', async t => {
  const f = fixture(); t.after(() => f.coordinator.reset());
  const user = { user: { bot: false }, voice: { channelId: 'A' } };
  const session = { connection: f.connection, channel: { id: 'A', guild: { id: 'g' }, members: new Map([['u', user]]) } };
  let allowed = true; const commands = createMusicCommands({ engine: f.engine, catalog: f.catalog, guildId: 'g', session, isAllowed: () => allowed });
  async function command(action, { guildId = 'g', member = user, track = 'a', level = 40, auto = false } = {}) {
    let result; await commands.interaction({ commandName: 'music', guildId, member, user: { id: 'u' },
      isAutocomplete: () => auto, isChatInputCommand: () => true,
      options: { getSubcommand: () => action, getString: () => track, getInteger: () => level, getFocused: () => '' },
      reply: async data => { result = data.content; assert.deepEqual(data.allowedMentions, { parse: [] }); }, respond: async data => { result = data; } }); return result;
  }
  assert.match(await command('play', { guildId: 'other' }), /授权/);
  assert.match(await command('play', { member: { ...user, voice: { channelId: 'B' }, permissions: { has: () => true } } }), /授权/);
  assert.match(await command('play', { member: { ...user, user: { bot: true } } }), /授权/);
  allowed = false; assert.deepEqual(await command('', { auto: true }), []); assert.match(await command('play'), /授权/); allowed = true;
  assert.equal(f.engine.snapshot().current, null); assert.equal((await command('', { auto: true })).length, 3);
  assert.match(await command('play'), /加入队列/); await tick(); assert.match(await command('now-playing'), /Song a/);
  assert.match(await command('queue'), /待播/); await command('pause'); assert.equal(f.engine.snapshot().state, 'PAUSED');
  await command('resume'); assert.equal(f.engine.snapshot().state, 'PLAYING'); await command('volume'); assert.equal(f.engine.snapshot().volume, 40);
  assert.match(await command('play', { track: 'unknown' }), /授权曲库/); await command('stop'); assert.equal(session.connection, f.connection);
  assert.equal(commandDefinition.options.length, 8); assert.equal(commandDefinition.options[0].options[0].autocomplete, true);
});

test('passive music controls bypass a running answer and never call prepare/DeepSeek; stop speaking stays independent', async t => {
  const f = fixture(); t.after(() => f.coordinator.reset()); let prepared = 0, responded = 0, cancels = 0;
  const response = deferred(), actions = [];
  const listener = createPassiveListener({ guildId: 'g', channelId: 'A', isAuthorized: () => true,
    transcribe: async pcm => pcm.toString(), prepareInteraction: async () => { prepared++; return { query: 'question' }; },
    respond: () => { responded++; return response.promise; }, cancelPlayback: () => { cancels++; }, clearHistory() {}, disconnect() {},
    beginSpeech: f.coordinator.beginSpeech, musicCommand: command => { actions.push(command.action); f.engine[command.action]?.(); } });
  t.after(() => listener.reset()); listener.attach('g', 'A'); f.engine.play('a', 'u'); await tick();
  listener.submit(Buffer.from('今天天气很好'), 'u'); await tick(); assert.equal(prepared, 0);
  listener.submit(Buffer.from('大肥鱼，今天怎样'), 'u'); await tick(); assert.equal(responded, 1);
  assert.equal(f.engine.snapshot().state, 'INTERRUPTED_FOR_SPEECH');
  listener.submit(Buffer.from('大肥鱼，停止音乐'), 'u'); await tick(); assert.deepEqual(actions, ['stop']); assert.equal(prepared, 1);
  response.resolve(); await tick(); assert.equal(f.engine.snapshot().state, 'IDLE');
  f.engine.play('a', 'u'); await tick(); listener.submit(Buffer.from('大肥鱼，别说了'), 'u'); await tick();
  assert.ok(cancels > 1); assert.equal(f.engine.snapshot().state, 'PLAYING');
});

test('internal now-playing never fetches Smakbot or invents metadata', async t => {
  const f = fixture(); t.after(() => f.coordinator.reset());
  const np = createNowPlaying({ config: { MUSIC_STATUS_URL: 'https://not-used' }, music: f.engine, musicGuildId: 'g',
    fetch: () => assert.fail('External music API'), console });
  assert.equal((await np.get('g')).playing, false); f.engine.play('a', '123'); await tick();
  assert.equal((await np.get('g')).title, 'Song a'); assert.equal((await np.get('g')).requested_by, '123');
  assert.equal((await np.get('other')).playing, false); assert.deepEqual(await np.topSongs(5), []);
});

test('duplicate, stale, canceled and unauthorized transcripts cannot enqueue music', async t => {
  let now = 1000, eligible = true, text = '大肥鱼，放首歌', slow = null, calls = 0;
  const listener = createPassiveListener({ guildId: 'g', channelId: 'A', isAuthorized: () => eligible, now: () => now,
    transcribe: () => slow?.promise || Promise.resolve(text), respond: () => assert.fail('DeepSeek not expected'),
    musicCommand: () => { calls++; }, cancelPlayback() {}, clearHistory() {}, disconnect() {} });
  t.after(() => listener.reset()); listener.attach('g', 'A');
  listener.submit(Buffer.from('first'), 'u'); await tick(); listener.submit(Buffer.from('duplicate'), 'u'); await tick();
  assert.equal(calls, 1);
  slow = deferred(); listener.submit(Buffer.from('stale'), 'u'); now += 16000; slow.resolve(text); await tick();
  assert.equal(calls, 1);
  slow = deferred(); listener.submit(Buffer.from('revoked'), 'u'); eligible = false; slow.resolve(text); await tick();
  assert.equal(calls, 1); eligible = true;
  slow = deferred(); listener.submit(Buffer.from('canceled'), 'u'); listener.reset(); slow.resolve(text); await tick(); assert.equal(calls, 1);
});
