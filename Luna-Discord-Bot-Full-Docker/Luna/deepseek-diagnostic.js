// Local, single-call smoke test. No Discord, STT or TTS services are contacted.
const { loadDeepSeekConfig } = require('./deepseek-config');
const { createDeepSeek, safeError } = require('./deepseek');

async function main() {
  if (process.env.NODE_ENV !== 'development' || process.env.DEEPSEEK_DIAGNOSTIC !== 'true' ||
      !process.argv.includes('--live') || !process.argv.includes('--authorized-cost')) {
    console.error('Disabled. Requires local development, DEEPSEEK_DIAGNOSTIC=true, --live --authorized-cost.');
    process.exitCode = 1; return;
  }
  let config;
  try {
    const configured = loadDeepSeekConfig();
    config = { ...configured, maxTokens: Math.min(configured.maxTokens, 64), retries: 0, historyTurns: 0,
      concurrency: 1, sessionTokens: Math.min(configured.sessionTokens, 2048), dailyTokens: Math.min(configured.dailyTokens, 2048) };
  }
  catch { console.error('Invalid DeepSeek configuration; check ../../README.md.'); process.exitCode = 1; return; }
  let requestCount = 0, completed = false;
  const llm = createDeepSeek({ config, fetch: async (...args) => {
    if (requestCount !== 0) throw new Error('Single-request diagnostic limit');
    requestCount++;
    const response = await globalThis.fetch(...args);
    console.log('[live-http]', JSON.stringify({ requestCount, status: response.status,
      eventStream: response.headers?.get('content-type')?.includes('text/event-stream') === true }));
    return response;
  } }), controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  let turn;
  try {
    turn = llm.createTurn({ guildId: 'local', sessionId: 'smoke', userId: 'operator',
      query: 'Reply with exactly: DeepSeek connection OK.', signal: controller.signal });
    for await (const sentence of turn.stream()) console.log(sentence);
    completed = true;
    // Deliberately no history commit: this was displayed locally, not played in Discord.
    console.log('DeepSeek text smoke test complete; live voice remains unverified.');
  } finally {
    turn?.dispose(); controller.abort(); llm.forgetConversations(); process.removeListener('SIGINT', cancel);
    console.log('[live-summary]', JSON.stringify({ requestCount, completed, cancelledAndDisposed: true,
      accountedTokens: llm.usage().dailyTokens }));
  }
}
if (require.main === module) main().catch(error => {
  const safe = safeError(error);
  console.error(`[deepseek] ${safe.code}: ${safe.message}`); process.exitCode = 1;
});
module.exports = { main };
