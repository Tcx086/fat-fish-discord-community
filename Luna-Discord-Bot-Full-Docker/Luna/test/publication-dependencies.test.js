const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { pipeline } = require('node:stream/promises');
const { createRequire } = require('node:module');

test('patched tar retains the native installer streaming extract API', async () => {
  const installerRequire = createRequire(require.resolve('@discordjs/node-pre-gyp/package.json'));
  const tar = installerRequire('tar');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-tar-'));
  try {
    fs.mkdirSync(path.join(dir, 'package'));
    fs.mkdirSync(path.join(dir, 'out'));
    fs.writeFileSync(path.join(dir, 'package', 'synthetic.txt'), 'synthetic');
    const archive = path.join(dir, 'synthetic.tar.gz');
    tar.create({ gzip: true, sync: true, cwd: dir, file: archive }, ['package/synthetic.txt']);
    let entries = 0;
    await pipeline(fs.createReadStream(archive), tar.extract({ cwd: path.join(dir, 'out'), strip: 1, onentry: () => entries++ }));
    assert.equal(entries, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'out', 'synthetic.txt'), 'utf8'), 'synthetic');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('patched ZIP supports the exact ONNX installer entry extraction calls', () => {
  const onnxRequire = createRequire(require.resolve('onnxruntime-node/package.json'));
  const AdmZip = onnxRequire('adm-zip');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-zip-'));
  try {
    const zip = new AdmZip();
    zip.addFile('runtimes/synthetic.txt', Buffer.from('synthetic'));
    const file = path.join(dir, 'synthetic.zip');
    zip.writeZip(file);
    const installed = new AdmZip(file);
    const entry = installed.getEntry('runtimes/synthetic.txt');
    assert.ok(entry);
    installed.extractEntryTo(entry, dir, false, true);
    assert.equal(fs.readFileSync(path.join(dir, 'synthetic.txt'), 'utf8'), 'synthetic');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('patched brace expansion retains ordinary glob expansion', () => {
  assert.deepEqual(require('brace-expansion')('file-{a,b}-{1..2}'), ['file-a-1', 'file-a-2', 'file-b-1', 'file-b-2']);
});

test('Discord REST works through patched undici against synthetic loopback HTTP', async () => {
  const { REST } = require('@discordjs/rest');
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/v10/candidate-check');
    assert.equal(request.headers.authorization, undefined);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ synthetic: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const rest = new REST({ api: `http://127.0.0.1:${server.address().port}`, retries: 0 });
  try {
    assert.deepEqual(await rest.get('/candidate-check', { auth: false }), { synthetic: true });
    const direct = await require('undici').fetch(`http://127.0.0.1:${server.address().port}/v10/candidate-check`);
    assert.deepEqual(await direct.json(), { synthetic: true });
  } finally {
    rest.clearHashSweeper(); rest.clearHandlerSweeper();
    await new Promise(resolve => server.close(resolve));
  }
});
