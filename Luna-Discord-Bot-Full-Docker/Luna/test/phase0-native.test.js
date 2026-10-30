// Offline only: real pinned native codec, DAVE binding and voice resource pipeline.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { OpusEncoder } = require('@discordjs/opus');
const voice = require('@discordjs/voice');
const davey = require('@snazzah/davey');
const { testTone } = require('../voice-diagnostic');
const { createPacketDecoder } = require('../voice-input');

test('real Opus encodes and decodes the fixed stereo tone without disk audio', () => {
  const encoder = new OpusEncoder(48000, 2), decoder = new OpusEncoder(48000, 2);
  const monoDecoder = new OpusEncoder(48000, 1);
  const pcm = testTone();
  let frames = 0, decodedBytes = 0;
  const decode = createPacketDecoder(decoder, {
    onPcm: frame => { frames++; decodedBytes += frame.length; },
    onUndecodable: () => assert.fail('native codec rejected valid Opus'),
  });
  for (let i = 0; i < pcm.length; i += 3840) {
    const packet = encoder.encode(pcm.subarray(i, i + 3840));
    decode(packet);
    assert.equal(monoDecoder.decode(packet).length, 1920);
  }
  assert.equal(frames, 25); assert.equal(decodedBytes, 96000);
});

test('real voice resource converts the tone to playable Opus packets', async () => {
  const resource = voice.createAudioResource(Readable.from([testTone()]), { inputType: voice.StreamType.Raw });
  let packets = 0;
  const decoder = new OpusEncoder(48000, 2);
  for await (const packet of resource.playStream) {
    assert.equal(decoder.decode(packet).length, 3840); packets++;
  }
  assert.equal(packets, 25);
  resource.playStream.destroy();
});

test('real DAVE native binding loads (does NOT establish Discord compatibility)', () => {
  assert.equal(typeof davey.DAVESession, 'function');
  assert.ok(davey.DAVE_PROTOCOL_VERSION >= 1);
  const session = new davey.DAVESession(davey.DAVE_PROTOCOL_VERSION, '100000000000000001', '100000000000000002');
  assert.equal(session.ready, false);
  assert.equal(typeof session.getDecryptionStats, 'function');
});
