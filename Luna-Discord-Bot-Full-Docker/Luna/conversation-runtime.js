const { createProvider, requireCapabilities } = require('./llm-providers');
const { loadTurnProviderConfig } = require('./llm-provider-config');
const { loadMemoryConfig } = require('./memory/engine');
const { createConversationCore } = require('./conversation-core');
const { createSearchTools, createTextSearch, loadSearchConfig } = require('./search-tools');
const { synthesizeEvidence, SYNTHESIS_RULES } = require('./search-synthesis');

function createConversationRuntime({ env = process.env, fetch = globalThis.fetch, console = globalThis.console, now = Date.now, search } = {}) {
  const modelConfig = loadTurnProviderConfig(env), memoryConfig = loadMemoryConfig(env);
  if (env.SEARCH_SYNTHESIS_ENABLED !== undefined && !['true', 'false'].includes(env.SEARCH_SYNTHESIS_ENABLED))
    throw new Error('Invalid search synthesis opt-in');
  const synthesisEnabled = env.SEARCH_SYNTHESIS_ENABLED === 'true';
  if (synthesisEnabled && modelConfig.retries !== 0) throw new Error('Search synthesis requires DEEPSEEK_RETRIES=0');
  search ||= createSearchTools({ config: loadSearchConfig(env), fetch });
  search = createTextSearch(search, now);
  let core;
  const textInstructions = () => core.instructions() + '\nMemory timestamps are ISO 8601 UTC source times. ' +
    'Do not infer, guess or invent calendar dates. Copy supplied dates exactly only when relevant to the request. ' +
    'retrievedAt is retrieval time, not the event time. Do not add an unsolicited date to a remembered fact.';
  const llm = createProvider({ config: { ...modelConfig, historyTurns: 0, historyBytes: 0,
    getSystemPrompt: textInstructions }, fetch, console, now });
  requireCapabilities(llm, 'streamingText');
  if (synthesisEnabled) requireCapabilities(llm, 'structuredJson');
  core = createConversationCore({ memoryConfig, llm, search, dateStrings: true,
    synthesize: synthesisEnabled ? (input, sources) => synthesizeEvidence({ request: input.content, sources, signal: input.signal,
      createTurn: query => core.turnFor(input, { query, jsonInstructions: SYNTHESIS_RULES }) }) : undefined,
    requestBytes: modelConfig.queryBytes,
    systemBytes: () => Buffer.byteLength(textInstructions()), now });
  return { ...core, close() { core.close(); llm.close(); } };
}
module.exports = { createConversationRuntime };
