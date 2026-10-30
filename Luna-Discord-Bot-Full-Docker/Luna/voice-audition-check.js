// Offline WAV -> existing FFmpeg/Discord resource -> native Opus decode. No login.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { OpusEncoder } = require('@discordjs/opus');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const { createTTS } = require('./tts');
const { loadConfig } = require('./config');

async function check(file) {
  assert.ok(file, 'Usage: node voice-audition-check.js <generated.wav|--service|--fallback>');
  const started = performance.now();
  let firstBodyMs = null;
  const requestUrls = [];
  const feiyu = file === '--feiyu-service' || file === '--feiyu-fallback';
  const fallback = file === '--fallback' || file === '--feiyu-fallback';
  const source = file === '--service' || feiyu || fallback ? await createTTS({
    config: loadConfig({ TTS_PROVIDER: feiyu ? 'feiyu' : 'qwen3', TTS_FALLBACK: fallback ? 'kokoro' : 'none',
      FEIYU_TTS_URL: `http://127.0.0.1:${fallback ? 18883 : 18882}/v1/audio/speech`,
      QWEN3_TTS_URL: 'http://127.0.0.1:18881/v1/audio/speech', QWEN3_TTS_VOICE: 'Serena',
      KOKORO_URL: 'http://127.0.0.1:18880/v1/audio/speech', KOKORO_VOICE: 'af_heart' }),
    fetch: (url, init) => { requestUrls.push(url); return fetch(url, init); },
    console, onBodyChunk: () => { firstBodyMs ??= performance.now() - started; },
  }).fetchTTS({ text: fallback ? 'Wait, let me check.' : '先别急，我看看。', expression: 'caring' }) : fs.createReadStream(file);
  assert.ok(source, 'Local synthesis failed');
  const resource = createAudioResource(source, { inputType: StreamType.Arbitrary });
  const decoder = new OpusEncoder(48000, 2);
  let packets = 0;
  try {
    for await (const packet of resource.playStream) {
      assert.equal(decoder.decode(packet).length, 3840);
      packets++;
    }
    assert.ok(packets > 0, 'No playable Opus packets');
    assert.ok(source.readableEnded, 'WAV source was truncated');
    if (fallback) assert.deepEqual(requestUrls, [
      `http://127.0.0.1:${feiyu ? 18883 : 18881}/v1/audio/speech`, 'http://127.0.0.1:18880/v1/audio/speech']);
    console.log(JSON.stringify({ file, packets, opusSeconds: packets * 0.02,
      sampleRate: 48000, channels: 2, requestUrls, firstBodyMs, totalMs: performance.now() - started }));
  } finally {
    source.destroy();
    resource.playStream.destroy();
  }
}

check(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
