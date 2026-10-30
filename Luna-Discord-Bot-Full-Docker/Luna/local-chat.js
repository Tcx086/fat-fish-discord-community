const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const { createConversationRuntime } = require('./conversation-runtime');

async function runLocalChat({ core, input = process.stdin, output = process.stdout, userId = 'local-owner', now = Date.now } = {}) {
  const sessionId = randomUUID();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  output.write('Fat Fish local text. /help for commands, /quit to exit. Persistence and paid APIs require separate opt-in.\n');
  let sequence = 0;
  try {
    for await (const content of lines) {
      if (content.trim() === '/quit') break;
      if (!content.trim()) continue;
      try {
        const response = await core.handle({ platform: 'local', scope: { guildId: 'local', channelId: 'console', kind: 'private' },
          sessionId, userId, content, timestamp: now(), explicitInvocation: true,
          permissions: { interact: true, manageMemory: true, readMemory: true, search: true }, messageId: `${sessionId}:${++sequence}` });
        output.write(response.text + '\n');
      } catch { output.write('Operation unavailable or refused. Check /help, consent, storage and API configuration; no success claimed.\n'); }
    }
  } finally { lines.close(); core.close(); }
}
if (require.main === module) {
  // No dotenv or credentials prompt: explicit process environment is the existing secure credential path.
  const core = createConversationRuntime();
  const stop = () => { core.close(); process.exitCode = 0; process.stdin.destroy(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  runLocalChat({ core, userId: process.env.LOCAL_CHAT_USER || 'local-owner' }).catch(() => { core.close(); process.exitCode = 1; });
}
module.exports = { runLocalChat };
