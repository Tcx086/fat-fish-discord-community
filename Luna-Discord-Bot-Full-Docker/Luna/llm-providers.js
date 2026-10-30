const { createDeepSeek } = require('./deepseek');
const { selectProvider } = require('./llm-provider-config');

class ProviderError extends Error {
  constructor(providerId, code) {
    super(`${providerId}: ${code}; no provider fallback`);
    this.providerId = providerId;
    this.code = code;
  }
}

function requireCapabilities(provider, ...names) {
  for (const name of names) {
    if (provider.capabilities[name] !== true) throw new ProviderError(provider.id, 'UNSUPPORTED_CAPABILITY');
  }
}

// Keep the tested transport, errors, limits, accounting and delivery semantics intact.
function createProvider({ id = 'deepseek', config, ...dependencies } = {}) {
  id = selectProvider(id);
  if (id !== 'deepseek') throw new ProviderError(id, 'NOT_IMPLEMENTED');
  if (!config) throw new ProviderError(id, 'NOT_CONFIGURED');
  const backend = createDeepSeek({ config, ...dependencies });
  const turns = new Set();
  let closed = false;
  const provider = {
    ...backend, id,
    capabilities: Object.freeze({ streamingText: true, structuredJson: true, toolCalling: false,
      tokenUsage: true, reasoning: false, search: false,
      contextLimits: Object.freeze({ contextTokens: null, outputTokens: config.maxTokens, queryBytes: config.queryBytes }) }),
    createTurn(input) {
      if (closed) throw new ProviderError(id, 'CLOSED');
      if (input.jsonInstructions !== undefined) requireCapabilities(provider, 'structuredJson');
      // The current adapter cannot translate these operations; never silently discard them.
      if (input.tools !== undefined || input.reasoning !== undefined) throw new ProviderError(id, 'UNSUPPORTED_CAPABILITY');
      const turn = backend.createTurn(input);
      const wrapped = { ...turn, dispose() { turn.dispose(); turns.delete(wrapped); } };
      // The backend replaces a turn in the same scope and aborts its signal synchronously.
      for (const previous of turns) if (previous.signal.aborted) previous.dispose();
      turns.add(wrapped);
      return wrapped;
    },
    cancel() { for (const turn of turns) turn.dispose(); },
    forgetConversations() { provider.cancel(); backend.forgetConversations(); },
    close() { closed = true; provider.cancel(); },
  };
  return Object.freeze(provider);
}

module.exports = { createProvider, requireCapabilities, ProviderError };
