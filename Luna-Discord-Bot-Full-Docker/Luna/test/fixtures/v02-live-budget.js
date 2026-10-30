// Test-only preload for the separately approved live run. Never imported by the application.
const fs = require('node:fs');
const path = require('node:path');
const SEARCH_QUERY = 'League of Legends latest official patch notes site:leagueoflegends.com';
const APPROVAL = '7-model-1-search-USD0.03';

function createValidationFetch({ filename, fetch }) {
  return async (url, options) => {
    if (options?.method !== 'POST' || options.redirect !== 'error' || options.signal?.aborted)
      throw new Error('Validation transport refused');
    const body = JSON.parse(options.body);
    let kind;
    if (url === 'https://api.deepseek.com/chat/completions') {
      kind = 'model';
      if (body.model !== 'deepseek-flash' || body.thinking?.type !== 'disabled' || body.tools || body.functions ||
          body.stream !== true || !Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 512 ||
          !Array.isArray(body.messages) || body.messages.length !== 2 || body.messages[0].role !== 'system' || body.messages[1].role !== 'user' ||
          body.messages.some(m => typeof m.content !== 'string') || Buffer.byteLength(body.messages[1].content) > 4096 ||
          body.messages.reduce((n, m) => n + Buffer.byteLength(m.content) + 32, 256) > 8192)
        throw new Error('Validation model budget refused');
    } else if (url === 'https://api.deepseek.com/v1/tools/search') {
      kind = 'search';
      if (body.query !== SEARCH_QUERY || body.count !== 3 || body.need_content !== false ||
          Object.keys(body).sort().join() !== 'count,need_content,query') throw new Error('Validation search refused');
    } else throw new Error('Validation endpoint refused'); // Includes Fetch and all page URLs.

    // Exclusive reservation survives child restarts. An interrupted write/lock fails closed.
    const lock = filename + '.lock', lockFd = fs.openSync(lock, 'wx', 0o600);
    try {
      const ledger = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!['model', 'search'].every(key => Number.isInteger(ledger[key]) && ledger[key] >= 0) ||
          ledger.model > 7 || ledger.search > 1 || ledger[kind] >= (kind === 'model' ? 7 : 1))
        throw new Error('Validation request allowance exhausted');
      ledger[kind]++;
      const fd = fs.openSync(filename, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(ledger)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
    return fetch(url, options); // Failed and ambiguous requests keep their reservation.
  };
}

if (process.env.FAT_FISH_V02_LIVE_APPROVED !== undefined) {
  if (process.env.FAT_FISH_V02_LIVE_APPROVED !== APPROVAL) throw new Error('Live validation approval missing');
  const filename = path.join(process.env.LOCALAPPDATA, 'FatFish', 'test-memory-v02', 'request-ledger.json');
  // Operator creates {"model":0,"search":0} once, after approval. Never reset it on restart.
  globalThis.fetch = createValidationFetch({ filename, fetch: globalThis.fetch });
}
module.exports = { createValidationFetch, SEARCH_QUERY, APPROVAL };
