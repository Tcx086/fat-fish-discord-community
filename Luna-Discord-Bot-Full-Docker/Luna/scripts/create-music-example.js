// Synthetic test tones only, dedicated to the public domain (CC0-1.0).
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
function wav(seconds = 1, frequency = 440) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10 || !Number.isFinite(frequency) || frequency < 20 || frequency > 20000)
    throw new Error('Invalid synthetic fixture parameters');
  const count = Math.round(48000 * seconds), buffer = Buffer.alloc(44 + count * 4);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(48000, 24); buffer.writeUInt32LE(192000, 28); buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(count * 4, 40);
  for (let i = 0; i < count; i++) { const sample = Math.round(Math.sin(i * 2 * Math.PI * frequency / 48000) * 1500);
    buffer.writeInt16LE(sample, 44 + i * 4); buffer.writeInt16LE(sample, 46 + i * 4); }
  return buffer;
}
async function createExample(directory) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'tone-440.wav'), wav(2, 440), { flag: 'wx' });
  await fs.writeFile(path.join(directory, 'tone-660.wav'), wav(3, 660), { flag: 'wx' });
  const catalog = await fs.readFile(path.join(__dirname, '../examples/music-catalog.json'));
  await fs.writeFile(path.join(directory, 'catalog.json'), catalog, { flag: 'wx' });
}
if (require.main === module) {
  const directory = path.resolve(process.argv[2] || path.join(os.homedir(), 'Music', 'FatFish'));
  createExample(directory).then(() => console.log(`Synthetic test library created: ${directory}`))
    .catch(() => { console.error('Cannot create example library; use a writable empty directory. Existing files are never overwritten.'); process.exitCode = 1; });
}
module.exports = { wav, createExample };
