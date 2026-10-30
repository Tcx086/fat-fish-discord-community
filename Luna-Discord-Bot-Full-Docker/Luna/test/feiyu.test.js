const test = require('node:test');
const assert = require('node:assert/strict');
const { createTTS } = require('../tts');
const { loadConfig } = require('../config');

async function consume(stream) {
  if (!stream) return null;
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test('Feiyu sends cute voice, buffered audio and strips unsupported emotion tags', async () => {
  const calls = [];
  const tts = createTTS({ config: loadConfig({ TTS_PROVIDER: 'feiyu', FEIYU_TTS_URL: 'http://feiyu/speech' }),
    console, fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return new Response('audio'); } });
  assert.equal(await consume(await tts.fetchTTS({ text: '[happy] 你好 Discord。', expression: 'playful' })), 'audio');
  assert.deepEqual(calls, [{ input: '你好 Discord。', voice: 'cute', stream: false }]);
  assert.equal(tts.expressivePrompt(), '');
  assert.equal(tts.describeTTS(), 'Feiyu cute');
});

test('Feiyu overload falls back to Kokoro; cancellation never does', async () => {
  for (const aborted of [false, true]) {
    const calls = [];
    const controller = new AbortController();
    const tts = createTTS({ config: loadConfig({ TTS_PROVIDER: 'feiyu', FEIYU_TTS_URL: 'http://feiyu/speech',
      KOKORO_URL: 'http://kokoro/speech' }), console: { log() {}, warn() {}, error() {} },
      fetch: async (url, init) => {
        calls.push(url);
        if (url.includes('feiyu')) {
          if (aborted) { controller.abort(); throw init.signal.reason; }
          return new Response('busy', { status: 429 });
        }
        return new Response('backup');
      } });
    assert.equal(await consume(await tts.fetchTTS('hello', { signal: controller.signal })), aborted ? null : 'backup');
    assert.equal(calls.length, aborted ? 1 : 2);
  }
});
