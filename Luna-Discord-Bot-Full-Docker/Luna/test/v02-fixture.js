const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationCore, staticTurn } = require('../conversation-core');
const { loadMemoryConfig } = require('../memory/engine');

function config(filename) {
  // Synthetic identities only. This does not attest any real deployment's storage or policy.
  return loadMemoryConfig({ MEMORY_STORAGE_ENABLED: 'true', MEMORY_DB_PATH: filename,
    MEMORY_POLICY_REVIEWED: 'true', MEMORY_ENCRYPTED_STORAGE_CONFIRMED: 'true',
    MEMORY_PRIVACY_URL: 'https://example.invalid/synthetic-test-only' });
}
function mockLlm(calls = []) {
  return { createTurn(input) {
    calls.push(input);
    const context = JSON.parse(input.query);
    return staticTurn(context.historicalMemory.filter(m => m.kind !== 'episode').map(m => m.text).join('; ') || 'No authorized remembered evidence.', input.signal);
  } };
}
function envelope(content, overrides = {}) {
  return { platform: 'local', scope: { guildId: 'synthetic-guild', channelId: 'synthetic-channel', kind: 'private' },
    sessionId: 'session-1', userId: 'synthetic-alice', timestamp: Date.now(), explicitInvocation: true,
    permissions: { interact: true, readMemory: true, manageMemory: true, search: true }, content, ...overrides };
}
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fat-fish-v02-'));
  const filename = path.join(directory, 'synthetic.sqlite'), calls = [];
  const memoryConfig = { ...config(filename), ...options.memoryConfig };
  const core = createConversationCore({ memoryConfig, llm: mockLlm(calls), ...options }), disposers = [];
  t.after(() => { for (const dispose of disposers) dispose(); core.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { core, directory, filename, calls, memoryConfig, dispose: fn => disposers.push(fn), run: (content, overrides) => core.handle(envelope(content, overrides)) };
}
async function authorize(run) { await run('/enable CONFIRM'); await run('/consent CONFIRM'); }
async function remember(run, fact = 'Synthetic favorite game is Celeste.', topic = 'game') {
  const candidate = await run(`/remember ${topic} | ${fact}`);
  await run(`/approve ${candidate.data.id} CONFIRM`);
  return candidate.data.id;
}
module.exports = { fixture, config, envelope, mockLlm, authorize, remember };
