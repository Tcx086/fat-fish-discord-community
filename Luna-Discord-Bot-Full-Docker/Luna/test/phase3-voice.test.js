const test = require('node:test');
const assert = require('node:assert/strict');
const { createTTS } = require('../tts');
const { loadConfig } = require('../config');
const { takeSentences } = require('../sentences');

function setup(env = {}, responder = () => new Response('wav'), fs = null) {
  const calls = [];
  const tts = createTTS({ config: loadConfig({ KOKORO_URL: 'http://kokoro/speech',
    TTS_PROVIDER: 'qwen3', QWEN3_TTS_URL: 'http://qwen/speech', QWEN3_TTS_VOICE: 'Vivian', ...env }),
    console: { log() {}, warn() {}, error() {} }, fs,
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return responder(url, init); } });
  return { ...tts, calls };
}
async function consume(stream) {
  if (!stream) return null;
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test('explicit Qwen preset is unchanged across Chinese, English and mixed text', async () => {
  const t = setup({ QWEN3_TTS_VOICE: 'Serena' });
  for (const text of ['你好。', 'Hello there.', 'Discord 的 latency 高了。']) {
    await consume(await t.fetchTTS(text));
    assert.deepEqual(t.calls.at(-1).body, { input: text, voice: 'Serena', stream: false, expression: 'neutral', language: 'Auto' });
  }
});

test('metadata is separate from spoken text; ordinary strings remain supported', async () => {
  const t = setup();
  await consume(await t.fetchTTS({ text: '[curious] 这是怎么回事？', expression: 'curious' }));
  assert.equal(t.calls[0].body.input, '这是怎么回事？');
  assert.equal(t.calls[0].body.expression, 'curious');
  assert.equal(t.expressivePrompt(), '');
  assert.equal(await t.fetchTTS({ expression: 'playful' }), null);
});

test('manual instructions and config style; expressive off enforces neutral', async () => {
  const t = setup({ QWEN3_TTS_EXPRESSION: 'caring', QWEN3_TTS_LANGUAGE: 'Chinese' });
  await consume(await t.fetchTTS('test', { instruct: 'Relaxed.' }));
  assert.equal(t.calls[0].body.instruct, 'Relaxed.');
  assert.equal(t.calls[0].body.expression, 'caring');
  assert.equal(t.calls[0].body.language, 'Chinese');
  const off = setup({ TTS_EXPRESSIVE: 'false' });
  await consume(await off.fetchTTS('test', { expression: 'amused', instruct: 'Laugh.' }));
  assert.equal(off.calls[0].body.expression, 'neutral');
  assert.equal(off.calls[0].body.instruct, undefined);
});

test('service failure or missing model falls back without sending emotion to Kokoro', async () => {
  for (const status of [429, 503]) {
    const t = setup({}, url => url.includes('qwen') ? new Response('unavailable', { status }) : new Response('kokoro'));
    assert.equal(await consume(await t.fetchTTS({ text: 'Hello.', expression: 'playful' })), 'kokoro');
    assert.deepEqual(t.calls[1].body, { input: 'Hello.', stream: true });
  }
});

test('Kokoro remains default; absent Qwen URL uses existing fallback', async () => {
  for (const env of [{ TTS_PROVIDER: 'kokoro' }, { QWEN3_TTS_URL: '' }]) {
    const t = setup(env);
    await consume(await t.fetchTTS('Hello.'));
    assert.equal(t.calls[0].url, 'http://kokoro/speech');
    assert.equal(t.calls[0].body.expression, undefined);
  }
});

test('aborted synthesis does not fall back or retain returned audio', async () => {
  const controller = new AbortController();
  const t = setup({}, async (_url, init) => {
    controller.abort();
    throw init.signal.reason;
  });
  assert.equal(await t.fetchTTS('hello', { signal: controller.signal }), null);
  assert.equal(t.calls.length, 1);
});

test('Chinese sentence incrementality keeps commas and ellipses within prosody units', () => {
  assert.deepEqual(takeSentences('诶？'), { sentences: [], rest: '诶？' });
  assert.deepEqual(takeSentences('诶？等一下，你刚刚说的是什么意思？下一句'),
    { sentences: ['诶？等一下，你刚刚说的是什么意思？'], rest: '下一句' });
  assert.deepEqual(takeSentences('不是吧，你怎么又弄坏了……我看看。下一句'),
    { sentences: ['不是吧，你怎么又弄坏了……我看看。'], rest: '下一句' });
  assert.deepEqual(takeSentences('第一句。Second sentence. 下一句？'),
    { sentences: ['第一句。', 'Second sentence.', '下一句？'], rest: '' });
});

test('cached Qwen phrases distinguish expression, instruction and language', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'phase3-cache-'));
  t.after(() => {
    for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
    fs.rmdirSync(dir);
  });
  const voice = setup({ TTS_CACHE_DIR: dir }, () => new Response('wav'), fs);
  for (const options of [{}, { expression: 'caring' }, { language: 'English' }, { instruct: 'Softly.' }]) {
    await consume(await voice.fetchTTS('same text', { ...options, cache: true }));
  }
  // Cache writes finish asynchronously after the returned streams end.
  for (let i = 0; i < 100 && fs.readdirSync(dir).filter(n => n.endsWith('.audio')).length < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(fs.readdirSync(dir).filter(n => n.endsWith('.audio')).length, 4);
  await consume(await voice.fetchTTS('same text', { cache: true }));
  assert.equal(voice.calls.length, 4);
});
