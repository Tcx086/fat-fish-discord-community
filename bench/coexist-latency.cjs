// Both services must already be warm. Synthetic speech only; no paid calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFile } = require('node:child_process');
const { createWhisper } = require('../Luna-Discord-Bot-Full-Docker/Luna/whisper');
const { invocation } = require('../Luna-Discord-Bot-Full-Docker/Luna/passive-listener');

(async () => {
  const [directory, output] = process.argv.slice(2);
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(directory, 'invocation.wav'), '-f', 's16le', '-ar', '48000', '-ac', '1', 'pipe:1']);
  assert.equal(decoded.status, 0);
  const stt = createWhisper({config: {WHISPER_SERVER_URLS: ['http://127.0.0.1:18082/inference'], WHISPER_TIMEOUT_MS: 30000}, fetch, console, initialPrompt: '大肥鱼。'});
  async function transcribe() {
    const start = performance.now();
    const text = await stt.transcribe(decoded.stdout, {language: 'auto'});
    assert.ok(invocation(text), 'Wake phrase missed');
    return performance.now() - start;
  }
  async function synthesize() {
    const start = performance.now();
    const res = await fetch('http://127.0.0.1:18882/v1/audio/speech', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({input: '第一项安排是去公园。', voice: 'cute', stream: false}),
      signal: AbortSignal.timeout(110000), redirect: 'error',
    });
    assert.equal(res.status, 200);
    const audio = Buffer.from(await res.arrayBuffer());
    assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
    return performance.now() - start;
  }
  await transcribe(); await synthesize();
  const rows = [];
  const memorySamples = [];
  let sampling = false;
  const sampler = setInterval(() => {
    if (sampling) return;
    sampling = true;
    execFile('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], (error, stdout) => {
      if (!error && Number.isFinite(Number(stdout.trim()))) memorySamples.push(Number(stdout.trim()));
      sampling = false;
    });
  }, 500);
  sampler.unref();
  for (let round = 0; round < 3; round++) {
    const sttOnlyMs = await transcribe();
    const ttsOnlyMs = await synthesize();
    const concurrentSttMs = [];
    let finished = false;
    let ttsError;
    const tts = synthesize().then(value => {finished = true; return value;}, error => {finished = true; ttsError = error;});
    // Multiple STT requests during one TTS job expose GPU contention, not just startup overlap.
    while (!finished) {
      concurrentSttMs.push(await transcribe());
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const concurrentTtsMs = await tts;
    if (ttsError) throw ttsError;
    rows.push({round, sttOnlyMs, ttsOnlyMs, concurrentSttMs, concurrentTtsMs});
  }
  clearInterval(sampler);
  const result = {scenario: 'game running; Feiyu and CUDA Whisper resident', sampledPeakVramMiB: memorySamples.length ? Math.max(...memorySamples) : null, rows};
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch(error => {console.error(error); process.exitCode = 1;});
