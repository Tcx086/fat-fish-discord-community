// Fixed synthetic fixtures only. Usage: node bench/stt-latency.cjs URL FIXTURE_DIR [rounds]
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createWhisper } = require('../Luna-Discord-Bot-Full-Docker/Luna/whisper');
const { invocation } = require('../Luna-Discord-Bot-Full-Docker/Luna/passive-listener');

(async () => {
  const [url, directory, repetitions = '3'] = process.argv.slice(2);
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
  const rounds = Number(repetitions);
  assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 10);
  const whisper = createWhisper({config: { WHISPER_SERVER_URLS: [url], WHISPER_TIMEOUT_MS: 30000 }, fetch, console, initialPrompt: '大肥鱼。'});
  const cases = [['invocation', true], ['bare', true], ['thirdperson', true], ['english', false]];
  const inputs = cases.map(([name, wake]) => {
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(directory, name + '.wav'), '-f', 's16le', '-ar', '48000', '-ac', '1', 'pipe:1']);
    assert.equal(decoded.status, 0, decoded.stderr?.toString());
    return {name, wake, pcm: decoded.stdout};
  });
  await whisper.transcribe(inputs[0].pcm, {language: 'auto'});
  const rows = [];
  for (let round = 0; round < rounds; round++) {
    for (const input of inputs) {
      const started = performance.now();
      const text = await whisper.transcribe(input.pcm, {language: 'auto'});
      assert.ok(text, 'Transcription failed');
      const milliseconds = performance.now() - started;
      const invoked = Boolean(invocation(text));
      rows.push({round, name: input.name, milliseconds, text, invoked, wakeCorrect: invoked === input.wake});
    }
  }
  console.log(JSON.stringify({url, rounds, rows}, null, 2));
})().catch(error => {console.error(error); process.exitCode = 1;});
