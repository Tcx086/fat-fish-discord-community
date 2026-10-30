const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createWhisper } = require('../whisper');

test('Chinese wake hint crosses real HTTP as UTF-8, while unconfigured callers omit it', async t => {
  const prompts = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = await new Response(Buffer.concat(chunks), {headers: {'Content-Type': req.headers['content-type']}}).formData();
    prompts.push(form.get('prompt'));
    res.end(JSON.stringify({text: '大肥鱼'}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {server.closeAllConnections(); server.close();});
  for (const initialPrompt of ['', '大肥鱼。']) {
    const whisper = createWhisper({config: {WHISPER_SERVER_URLS: [`http://127.0.0.1:${server.address().port}/inference`], WHISPER_TIMEOUT_MS: 2000}, fetch, console, initialPrompt});
    assert.equal(await whisper.transcribe(Buffer.alloc(1920), {language: 'auto'}), '大肥鱼');
  }
  assert.deepEqual(prompts, [null, '大肥鱼。']);
});

test('local STT never forwards participant audio across an HTTP redirect', async t => {
  let forwarded = 0;
  const destination = http.createServer((req, res) => {
    forwarded++; req.resume(); res.end(JSON.stringify({ text: 'leaked audio' }));
  });
  const origin = http.createServer((req, res) => {
    req.resume(); res.writeHead(307, { Location: `http://127.0.0.1:${destination.address().port}/outside` }); res.end();
  });
  for (const server of [destination, origin]) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
  }
  const whisper = createWhisper({ config: { WHISPER_SERVER_URLS: [`http://127.0.0.1:${origin.address().port}/inference`],
    WHISPER_TIMEOUT_MS: 1000 }, fetch, console: { error() {} } });
  const result = await whisper.transcribe(Buffer.alloc(1920), { language: 'auto', translate: false });
  assert.equal(forwarded, 0, 'redirect escaped the configured local STT endpoint');
  assert.equal(result, null);
});
