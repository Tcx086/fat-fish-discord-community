const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_WAKE = Object.freeze({ phrase: '大肥鱼', mode: 'direct' });
const MAX_TRANSCRIPT = 1024;
const normalize = text => text.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '')
  .replace(/\s+/gu, ' ').replace(/(\p{Script=Han}) +(?=\p{Script=Han})/gu, '$1').trim();

function validatePhrase(text) {
  if (typeof text !== 'string' || text.length > 64 || /[\p{C}]/u.test(text)) throw new Error('Phrase must be 3–32 Chinese/English characters, without control characters.');
  const phrase = normalize(text);
  const han = (phrase.match(/\p{Script=Han}/gu) || []).length;
  const latin = (phrase.match(/[a-z]/gi) || []).length;
  if (phrase.length > 32 || !/^[\p{Script=Han}a-z]+(?: [\p{Script=Han}a-z]+)*$/iu.test(phrase) ||
      han + latin < 3 || han * 2 + latin < 6)
    throw new Error('Use a distinctive phrase: at least 3 Chinese characters, 6 English letters, or an equivalent mix; letters and spaces only.');
  return phrase;
}

function validateSetting(value) {
  if (!value || !['direct', 'anywhere'].includes(value.mode)) throw new Error('Mode must be direct or anywhere.');
  return { phrase: validatePhrase(value.phrase), mode: value.mode };
}

function createWakeSettings({ file = path.join(__dirname, 'data', 'wake-settings.json'), io = fs } = {}) {
  let guilds = new Map();
  try {
    if (io.statSync(file).size > 65536) throw new Error('Oversized wake settings');
    const data = JSON.parse(io.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !data.guilds || Array.isArray(data.guilds) || typeof data.guilds !== 'object' || Object.keys(data.guilds).length > 128)
      throw new Error('Invalid wake settings');
    guilds = new Map(Object.entries(data.guilds).map(([id, value]) => [id, validateSetting(value)]));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Wake settings unavailable or invalid; restore the settings file before starting.');
  }
  const get = id => ({ ...(guilds.get(id) || DEFAULT_WAKE) });
  function set(id, value) {
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) throw new Error('Invalid guild scope.');
    const next = new Map(guilds);
    next.set(id, validateSetting(value));
    const data = JSON.stringify({ version: 1, guilds: Object.fromEntries(next) }, null, 2) + '\n';
    if (next.size > 128 || Buffer.byteLength(data) > 65536) throw new Error('Wake settings capacity reached.');
    io.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp';
    // Commit memory only after the same-directory atomic replacement succeeds.
    try { io.writeFileSync(temporary, data, { mode: 0o600 }); io.renameSync(temporary, file); }
    catch { try { io.unlinkSync(temporary); } catch {} throw new Error('Wake settings could not be saved; previous settings remain active.'); }
    guilds = next;
    return get(id);
  }
  return { get, set, reset: id => set(id, DEFAULT_WAKE) };
}

function quotedPositions(text) {
  const positions = new Set(), closers = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』', '《': '》', '`': '`' };
  let close = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === "'" || ch === '’') && /[a-z]/i.test(text[i - 1] || '') && /[a-z]/i.test(text[i + 1] || '')) continue;
    if (close) { positions.add(i); if (ch === close) close = null; }
    else if (closers[ch]) { close = closers[ch]; positions.add(i); }
  }
  return positions;
}

function matchWake(text, setting = DEFAULT_WAKE, isCommand = () => false) {
  if (typeof text !== 'string' || text.length > MAX_TRANSCRIPT) return null;
  const normalized = normalize(text);
  if (normalized.length > MAX_TRANSCRIPT) return null;
  const phrase = validatePhrase(setting.phrase);
  if (!['direct', 'anywhere'].includes(setting.mode)) return null;
  // Only the default retains the public release's full-name/traditional variants.
  const source = phrase === DEFAULT_WAKE.phrase ? '(?:吃白[饭飯]的)?大肥[鱼魚]' : phrase.replace(/ /g, ' +');
  const pattern = new RegExp(source, 'giu'), quotes = quotedPositions(normalized);
  for (const match of normalized.matchAll(pattern)) {
    const start = match.index, end = start + match[0].length;
    if (quotes.has(start) || (/[a-z]/i.test(match[0][0]) && /[a-z0-9_]/i.test(normalized[start - 1] || '')) ||
        (/[a-z]/i.test(match[0].at(-1)) && /[a-z0-9_]/i.test(normalized[end] || ''))) continue;
    const before = normalized.slice(0, start);
    const rest = normalized.slice(end);
    const tail = rest.replace(/^[\s,、:。.!?！？]+|[\s。.!?！？]+$/gu, '').trim();
    const prefix = /^(?:(?:嘿|喂|嗨|hey|hi|hello)[\s,、:。.!?！？]*)?$/iu.test(before);
    const reference = /^(?:的|是|叫|名字|这个|這個|介绍[了的]|介紹[了的]|['’]s\b|is\b|was\b|said\b|says\b)/iu.test(tail);
    // shortcut: unpunctuated Chinese direct address accepts common request onsets; use punctuation for other requests.
    const separated = !rest || /^[\s,、:。.!?！？]/u.test(rest) || /^(?:你|您|请|請|帮|幫|介绍一下|介紹一下|回答)/u.test(rest) || isCommand(tail);
    const direct = prefix && !reference && separated;
    if (setting.mode === 'direct' && !direct) continue;
    return { normalized, direct, question: direct && tail ? tail : normalized };
  }
  return null;
}

module.exports = { DEFAULT_WAKE, createWakeSettings, validatePhrase, matchWake };
