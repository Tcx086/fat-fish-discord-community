const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const FORMATS = new Set(['.mp3', '.flac', '.wav', '.ogg']);
const key = value => String(value).normalize('NFKC').trim().toLowerCase();
function metadata(value, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\p{C}<>]/u.test(value))
    throw new Error('Invalid catalog metadata');
  return value.trim();
}
function loadMusicConfig(env = process.env) {
  const bounded = (name, fallback, min, max) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
    return n;
  };
  if (env.MUSIC_ENABLED !== undefined && !['true', 'false'].includes(env.MUSIC_ENABLED)) throw new Error('Invalid MUSIC_ENABLED');
  const directory = path.resolve(env.MUSIC_DIRECTORY || path.join(os.homedir(), 'Music', 'FatFish'));
  const enabled = env.MUSIC_ENABLED === 'true';
  const guildId = env.MUSIC_GUILD_ID || env.CONVERSATION_GUILD_ID;
  if (enabled && !guildId) throw new Error('Music requires MUSIC_GUILD_ID or CONVERSATION_GUILD_ID');
  return { enabled, guildId, directory, catalogFile: env.MUSIC_CATALOG || path.join(directory, 'catalog.json'),
    ffmpeg: env.MUSIC_FFMPEG || 'ffmpeg', ffprobe: env.MUSIC_FFPROBE || 'ffprobe',
    maxBytes: bounded('MUSIC_MAX_FILE_MB', 100, 1, 500) * 1024 * 1024,
    maxDuration: bounded('MUSIC_MAX_DURATION_SECONDS', 900, 1, 3600),
    maxQueue: bounded('MUSIC_MAX_QUEUE', 20, 1, 100), volume: bounded('MUSIC_VOLUME', 30, 0, 100) };
}
function probeFile(file, { ffprobe, signal, format }) {
  return new Promise((resolve, reject) => execFile(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-f', format, '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file],
  { signal, timeout: 10000, maxBuffer: 65536, windowsHide: true }, (error, stdout) => {
    if (error) return reject(new Error('Audio validation failed'));
    try {
      const data = JSON.parse(stdout), duration = Number(data.format?.duration);
      if (!data.streams?.some(s => s.codec_type === 'audio') || !Number.isFinite(duration) || duration <= 0) throw new Error();
      resolve(duration);
    } catch { reject(new Error('Invalid audio duration or stream')); }
  }));
}
function createMusicCatalog(config, { probe = probeFile } = {}) {
  let root, tracks = [];
  function inside(file) {
    const relative = path.relative(root, file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  }
  async function open(track, signal) {
    signal?.throwIfAborted();
    const file = await fs.realpath(path.resolve(root, track.file));
    if (!inside(file)) throw new Error('Track is outside the music directory');
    const handle = await fs.open(file, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size < 1 || before.size > config.maxBytes) throw new Error('Invalid audio file size');
      const duration = await probe(file, { ffprobe: config.ffprobe, signal, format: path.extname(track.file).slice(1).toLowerCase() });
      const after = await fs.stat(file);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
        throw new Error('Audio changed during validation');
      if (!Number.isFinite(duration) || duration <= 0 || duration > config.maxDuration) throw new Error('Track exceeds duration limit');
      signal?.throwIfAborted();
      return { handle, duration, format: path.extname(track.file).slice(1).toLowerCase() };
    } catch (error) { await handle.close(); throw error; }
  }
  return {
    async load() {
      const signal = AbortSignal.timeout(60000);
      root = await fs.realpath(config.directory);
      const stat = await fs.stat(config.catalogFile);
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Catalog too large');
      const data = JSON.parse(await fs.readFile(config.catalogFile, 'utf8'));
      if (!Array.isArray(data) || data.length > 500) throw new Error('Invalid catalog');
      const result = [], ids = new Set(), titles = new Set();
      for (const entry of data) {
        const id = metadata(entry.id, 64), title = metadata(entry.title), artist = metadata(entry.artist);
        if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(key(id)) || titles.has(key(title))) throw new Error('Duplicate or invalid catalog identity');
        const file = metadata(entry.file, 240);
        if (path.isAbsolute(file) || /[:\\]/.test(file) || file.split('/').some(p => !p || p === '.' || p === '..') ||
          !FORMATS.has(path.extname(file).toLowerCase()) || entry.authorized !== true) throw new Error('Unauthorized catalog file');
        const track = { id, title, artist, file };
        const checked = await open(track, signal);
        await checked.handle.close();
        result.push(Object.freeze({ ...track, duration: checked.duration })); ids.add(key(id)); titles.add(key(title));
      }
      // Avoid an ID resolving to another track's title.
      if (result.some(t => result.some(other => other !== t && key(t.id) === key(other.title)))) throw new Error('Ambiguous catalog identity');
      tracks = result;
      return tracks.length;
    },
    resolve(name) { return tracks.find(t => key(t.id) === key(name) || key(t.title) === key(name)) || null; },
    list(query = '') { return tracks.filter(t => key(`${t.title} ${t.artist} ${t.id}`).includes(key(query))).map(({ file, ...t }) => t); },
    open,
  };
}
module.exports = { createMusicCatalog, loadMusicConfig, probeFile };
