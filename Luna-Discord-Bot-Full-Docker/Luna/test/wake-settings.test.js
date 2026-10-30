const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DEFAULT_WAKE, validatePhrase, matchWake, createWakeSettings } = require('../wake-settings');
const { invocation, createPassiveListener } = require('../passive-listener');
const { createWakeCommands } = require('../wake-commands');
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

function storage(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-wake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data', 'wake-settings.json');
  return { file, settings: createWakeSettings({ file }) };
}

test('Chinese, English and mixed aliases normalize without fuzzy or substring matching', () => {
  for (const [phrase, yes, no] of [
    ['小鲸鱼', ['小鲸鱼，你怎么看？', '小 鲸 鱼: hello', '嘿，小鲸鱼。', '小鲸鱼你觉得呢'], ['我看到小鲸鱼', '小鲸鱼的视频', '小鲸鱼是个名字', '小鲸鱼介绍了游戏', '小鲸魚，你好吗']],
    ['Silver Fish', ['Hey, SILVER FISH, 你觉得呢？', 'Ｓｉｌｖｅｒ　Ｆｉｓｈ: hello', 'silver fish!'], ['silvery fish, hello', 'silver fishes', 'I saw Silver Fish', "Silver Fish's name", 'Silver Fish is a name']],
    ['小鱼Bot', ['小鱼BOT, what about 今天?', 'hey 小鱼Bot: 你好'], ['小鱼Bots, hello', 'I heard 小鱼Bot today']],
  ]) {
    const setting = { phrase, mode: 'direct' };
    for (const text of yes) assert.ok(invocation(text, setting), text);
    for (const text of no) assert.equal(invocation(text, setting), null, text);
  }
  assert.equal(invocation('大 肥 魚，你好').question, '你好');
  assert.equal(invocation('吃白飯的大肥魚，hello').question, 'hello');
});

test('quotes, short aliases and bounded input fail conservatively in both modes', () => {
  for (const mode of ['direct', 'anywhere']) {
    const setting = { phrase: 'Silver Fish', mode };
    for (const text of ['"Silver Fish, stop"', '“Silver Fish”', "'Silver Fish'", '`Silver Fish`', '「Silver Fish」', 'She said “Silver Fish, stop', 'x'.repeat(1025) + 'Silver Fish'])
      assert.equal(invocation(text, setting), null, text);
    assert.equal(invocation('Silver Fishery', setting), null);
    assert.equal(invocation('xSilver Fish', setting), null);
    assert.equal(invocation('Silver Fish2', setting), null);
    assert.equal(invocation('_Silver Fish', setting), null);
  }
  for (const phrase of ['', '鱼', '小鱼', 'hi', 'fish', 'hello', 'a b c', '.*', 'a'.repeat(65), '小鲸鱼\n', '小\u200b鲸鱼', 'hello@everyone'])
    assert.throws(() => validatePhrase(phrase), undefined, phrase);
  assert.equal(matchWake(null), null);
  assert.equal(matchWake('a'.repeat(1025)), null);
  assert.equal(invocation('“小鲸鱼”然后小鲸鱼，你好', { phrase: '小鲸鱼', mode: 'anywhere' }).action, null);
});

test('anywhere mentions never execute controls; custom direct aliases retain controls and music', () => {
  assert.equal(invocation('大肥鱼停').action, 'interrupt');
  assert.equal(invocation('小鲸鱼暂停音乐', { phrase: '小鲸鱼', mode: 'direct' }).music.action, 'pause');
  for (const phrase of ['小鲸鱼', 'Silver Fish', '小鱼Bot']) {
    const direct = { phrase, mode: 'direct' }, anywhere = { phrase, mode: 'anywhere' };
    for (const [text, action] of [['停', 'interrupt'], ['end conversation', 'end'], ['leave', 'leave'], ['暂停', 'pause']]) {
      assert.equal(invocation(`${phrase}, ${text}`, direct).action, action);
      assert.equal(invocation(`They mentioned ${phrase}, ${text}`, anywhere).action, null);
    }
    for (const [text, action] of [['放首歌', 'play'], ['播放晴天', 'play'], ['下一首', 'skip'], ['暂停音乐', 'pause'], ['继续播放', 'resume'], ['停止音乐', 'stop'], ['这是什么歌？', 'now-playing']]) {
      assert.equal(invocation(`${phrase}, ${text}`, direct).music.action, action);
      assert.equal(invocation(`他说${phrase}, ${text}`, anywhere).music, undefined);
    }
  }
});

test('settings survive restart, isolate guilds, return copies, and reset independently of persona/memory', t => {
  const { file, settings } = storage(t);
  assert.deepEqual(settings.get('one'), DEFAULT_WAKE);
  settings.set('one', { phrase: 'Silver Fish', mode: 'anywhere' });
  settings.set('two', { phrase: '小鲸鱼', mode: 'direct' });
  const restarted = createWakeSettings({ file });
  const copy = restarted.get('one'); copy.phrase = 'changed';
  assert.equal(restarted.get('one').phrase, 'Silver Fish');
  restarted.reset('one');
  assert.deepEqual(createWakeSettings({ file }).get('one'), DEFAULT_WAKE);
  assert.equal(restarted.get('two').phrase, '小鲸鱼');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file))).sort(), ['guilds', 'version']);
});

test('startup preserves saved phrases and modes byte-for-byte; defaults apply only to new guilds', t => {
  const { file } = storage(t);
  const existing = { version: 1, guilds: {
    established: { phrase: 'Silver Fish', mode: 'anywhere' },
    other: { phrase: '小鲸鱼', mode: 'direct' },
  } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify(existing, null, 2) + '\n';
  fs.writeFileSync(file, original);
  const settings = createWakeSettings({ file });
  assert.deepEqual(settings.get('established'), existing.guilds.established);
  assert.deepEqual(settings.get('other'), existing.guilds.other);
  assert.deepEqual(settings.get('new-guild'), DEFAULT_WAKE);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'startup must not rewrite saved settings');
  const fromNewProcess = JSON.parse(execFileSync(process.execPath, ['-e',
    'const s = require(process.argv[1]).createWakeSettings({ file: process.argv[2] }); process.stdout.write(JSON.stringify([s.get("established"), s.get("other"), s.get("new-guild")]));',
    require.resolve('../wake-settings'), file], { encoding: 'utf8' }));
  assert.deepEqual(fromNewProcess, [existing.guilds.established, existing.guilds.other, DEFAULT_WAKE]);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.ok(invocation('They mentioned Silver Fish', settings.get('established')));
  assert.equal(invocation('They mentioned 小鲸鱼', settings.get('other')), null);
  settings.set('new-guild', { phrase: 'Another Fish', mode: 'direct' });
  const restarted = createWakeSettings({ file });
  assert.deepEqual(restarted.get('established'), existing.guilds.established);
  assert.deepEqual(restarted.get('other'), existing.guilds.other);
});

test('invalid settings, corrupt/oversize storage and failed writes never silently change active settings', t => {
  const { file, settings } = storage(t);
  assert.throws(() => settings.set('one', { phrase: 'hi', mode: 'direct' }));
  assert.throws(() => settings.set('one', { phrase: 'Silver Fish', mode: 'loose' }));
  settings.set('one', { phrase: 'Silver Fish', mode: 'direct' });
  const io = Object.create(fs); io.renameSync = () => { throw new Error('fixture disk error'); };
  const failing = createWakeSettings({ file, io });
  assert.throws(() => failing.reset('one'), /previous settings remain/);
  assert.equal(failing.get('one').phrase, 'Silver Fish');
  assert.equal(createWakeSettings({ file }).get('one').phrase, 'Silver Fish');
  fs.writeFileSync(file, '{broken'); assert.throws(() => createWakeSettings({ file }), /restore/);
  for (const invalid of [{ version: 2, guilds: {} }, { version: 1, guilds: { one: { phrase: 'Silver Fish' } } }]) {
    const original = JSON.stringify(invalid); fs.writeFileSync(file, original);
    assert.throws(() => createWakeSettings({ file }), /restore/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
  fs.writeFileSync(file, 'x'.repeat(65537)); assert.throws(() => createWakeSettings({ file }), /restore/);
});

test('only guild administrators/operators mutate; show/test are local, inert and mention-safe', async t => {
  const { settings } = storage(t); let changes = 0;
  const handler = createWakeCommands({ settings, guildId: 'one', isOperator: id => id === 'operator', onChange: () => changes++ });
  async function run(action, value, { user = 'member', admin = false, guild = 'one', manage = false } = {}) {
    let result;
    await handler({ commandName: 'wake', isChatInputCommand: () => true, guildId: guild, user: { id: user },
      memberPermissions: { has: permission => permission === 'Administrator' ? admin : manage },
      options: { getSubcommand: () => action, getString: () => value }, reply: async data => { result = data.content;
        assert.equal(data.flags, 64); assert.deepEqual(data.allowedMentions, { parse: [] }); } });
    return result;
  }
  for (const action of ['set', 'mode', 'reset']) assert.match(await run(action, 'Silver Fish', { manage: true }), /Administrator/);
  assert.match(await run('set', 'Silver Fish', { admin: true, guild: 'other' }), /restricted/);
  assert.match(await run('set', 'Silver Fish', { admin: true, guild: null }), /restricted/);
  assert.match(await run('set', 'Silver Fish', { admin: true }), /Silver Fish/);
  assert.match(await run('mode', 'anywhere', { user: 'operator' }), /anywhere/);
  assert.match(await run('show'), /Silver Fish/);
  assert.match(await run('test', 'Silver Fish, leave'), /control: leave/);
  assert.match(await run('test', 'Silver Fish, 停止音乐'), /music: stop/);
  assert.match(await run('test', 'background'), /No match/);
  assert.equal(changes, 2);
  assert.match(await run('reset', null, { user: 'operator' }), /大肥鱼/);
  assert.equal(changes, 3);
});

test('synthetic custom wake preserves speaker attribution, deduplication, opt-out and silence', async t => {
  const { settings } = storage(t); settings.set('one', { phrase: 'Silver Fish', mode: 'direct' });
  const calls = [], music = [], authorized = new Set(['a', 'b']);
  const listener = createPassiveListener({ guildId: 'one', channelId: 'voice', getWakeSettings: settings.get,
    isAuthorized: id => authorized.has(id), transcribe: async pcm => pcm.toString(),
    respond: async data => { calls.push(data); return true; }, musicCommand: command => music.push(command),
    clearHistory() {}, cancelPlayback() {}, disconnect() {} });
  t.after(() => listener.leave()); listener.attach('one', 'voice');
  async function say(text, speaker = 'a', audio = text) { listener.submit(Buffer.from(audio), speaker); await flush(); }
  for (const text of ['Human discussion', 'I saw Silver Fish', '“Silver Fish, leave”', '大肥鱼，hello', 'change wake to hello']) await say(text);
  assert.equal(calls.length, 0);
  await say('Silver Fish, 你觉得呢?', 'b'); assert.equal(calls.length, 1);
  const query = JSON.parse(calls[0].query); assert.equal(query.invokingSpeaker.id, 'b');
  assert.equal(query.request, '你觉得呢'); assert.ok(query.recentDialogue.every(e => e.speaker === 'a'));
  await say('Silver Fish, 你觉得呢?', 'b', 'different-pcm'); assert.equal(calls.length, 1);
  await say('Silver Fish, 你觉得呢?', 'a'); assert.equal(calls.length, 2);
  await say('Silver Fish, 暂停音乐'); assert.equal(music[0].action, 'pause'); assert.equal(calls.length, 2);
  authorized.delete('b'); await say('Silver Fish, private question', 'b'); assert.equal(calls.length, 2);
  assert.equal(settings.get('one').phrase, 'Silver Fish');
});
