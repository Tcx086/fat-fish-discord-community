const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createMusicCatalog, loadMusicConfig } = require('../music-catalog');
const { decodeAudio } = require('../music-engine');
const { wav } = require('./music-fixture');
const { createExample } = require('../scripts/create-music-example');
async function library(t, probe = async () => 1) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fat-fish-music-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = { ...loadMusicConfig({}), directory, catalogFile: path.join(directory, 'catalog.json') };
  await fs.writeFile(path.join(directory, 'tone.wav'), wav());
  const entry = { id: 'tone', title: 'Test Tone', artist: 'Synthetic fixture', file: 'tone.wav', authorized: true };
  const write = data => fs.writeFile(config.catalogFile, JSON.stringify(data)); await write([entry]);
  return { config, entry, write, catalog: createMusicCatalog(config, probe ? { probe } : {}) };
}
test('catalog validates metadata and uses registered names only; config is bounded and external by default', async t => {
  const f = await library(t); assert.equal(await f.catalog.load(), 1);
  assert.equal(f.catalog.resolve('test tone').id, 'tone'); assert.equal(f.catalog.resolve('tone.wav'), null);
  assert.equal(f.catalog.resolve('../tone'), null); assert.equal(f.catalog.list()[0].file, undefined);
  for (const env of [{ MUSIC_ENABLED: 'yes' }, { MUSIC_ENABLED: 'true' }, { MUSIC_MAX_QUEUE: '1000' }, { MUSIC_VOLUME: '-1' }])
    assert.throws(() => loadMusicConfig(env));
  assert.equal(loadMusicConfig({}).directory, path.join(os.homedir(), 'Music', 'FatFish'));
});
test('catalog rejects traversal, absolute/alternate paths, extensions, duplicates and missing authorization', async t => {
  const f = await library(t);
  for (const patch of [{ file: '../tone.wav' }, { file: '/tone.wav' }, { file: 'C:/tone.wav' }, { file: 'sub\\tone.wav' },
    { file: 'tone.wav:private' }, { file: 'tone.m3u' }, { authorized: false }, { title: '' }, { artist: '\nprivate' }, { id: 'a/b' }]) {
    await f.write([{ ...f.entry, ...patch }]); await assert.rejects(f.catalog.load());
  }
  await f.write([f.entry, f.entry]); await assert.rejects(f.catalog.load());
  await f.write([f.entry, { ...f.entry, id: 'second', title: 'tone' }]); await assert.rejects(f.catalog.load(), /Ambiguous/);
});
test('symlink directory escape, missing files, oversized files and duration limit fail closed', async t => {
  const f = await library(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fat-fish-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true })); await fs.writeFile(path.join(outside, 'tone.wav'), wav());
  await fs.symlink(outside, path.join(f.config.directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.write([{ ...f.entry, file: 'escape/tone.wav' }]); await assert.rejects(f.catalog.load(), /outside/);
  await f.write([{ ...f.entry, file: 'missing.wav' }]); await assert.rejects(f.catalog.load());
  await f.write([f.entry]); f.config.maxBytes = 5; await assert.rejects(f.catalog.load(), /size/);
  f.config.maxBytes = 1000000; f.config.maxDuration = 0.5; await assert.rejects(f.catalog.load(), /duration/);
});
test('real FFprobe and FFmpeg decode synthetic audio; Opus stack consumes PCM without Discord or APIs', async t => {
  const f = await library(t, null); await f.catalog.load(); const track = f.catalog.resolve('tone');
  assert.equal(track.duration, 1);
  const checked = await f.catalog.open(track); const decoder = decodeAudio(checked, f.config); t.after(() => decoder.close());
  const voice = require('@discordjs/voice');
  const resource = voice.createAudioResource(decoder.stream, { inputType: voice.StreamType.Raw, inlineVolume: true });
  resource.volume.setVolume(0.3); let packets = 0;
  for await (const packet of resource.playStream) { assert.ok(packet.length > 0); packets++; }
  assert.equal(await decoder.completion, true); assert.equal(packets, 50);
  decoder.close();
  await fs.writeFile(path.join(f.config.directory, 'tone.wav'), Buffer.from('not audio'));
  await assert.rejects(f.catalog.open(track));
});
test('real decoder missing executable and early cancellation close without unhandled child errors', async t => {
  const f = await library(t); await f.catalog.load();
  const bad = decodeAudio(await f.catalog.open(f.catalog.resolve('tone')), { ...f.config, ffmpeg: 'fat-fish-nonexistent-ffmpeg' });
  assert.equal(await bad.completion, false); bad.close();
  const decoder = decodeAudio(await f.catalog.open(f.catalog.resolve('tone')), f.config); decoder.close();
  assert.equal(await decoder.completion, false);
});

test('example creator writes the registered synthetic library and never overwrites operator files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fat-fish-example-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await createExample(directory);
  const catalog = createMusicCatalog({ ...loadMusicConfig({}), directory, catalogFile: path.join(directory, 'catalog.json') });
  assert.equal(await catalog.load(), 2); assert.equal(catalog.resolve('tone-440').duration, 2);
  assert.equal(catalog.resolve('tone-660').duration, 3);
  await assert.rejects(createExample(directory), { code: 'EEXIST' });
  assert.throws(() => wav(100));
});
