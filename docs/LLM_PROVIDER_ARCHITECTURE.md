# LLM provider architecture — v0.5 interface preparation

This change prepares interfaces only. DeepSeek remains the default and the only
implemented unified turn provider. No new model transport is implemented or live
validated. No model, voice reference, dependency or service is installed.

Base: public `main`, commit `aa1eb070eddb649543d3a267014e67ff826f9faf`.
Branch: `feature/pluggable-llm-provider`, in a fresh public-only clone. That base
already contains public PR #1 (configurable wake); this task merges no branch and
imports no private history.

## Current integration and ownership

- `deepseek-config.js` retains every existing DeepSeek environment variable,
  explicit paid-API opt-in, prompt loading and bounded request/cost settings.
- `deepseek.js` is the existing working transport. Its request body, SSE parser,
  retry policy, cancellation, usage accounting, history and request limits are
  unchanged. Existing diagnostics can still import it directly.
- `index.js` retains passive voice's DeepSeek-only gate, the request-counting
  fetch wrapper, passive prompt, single concurrency, zero retries and disabled
  provider history. Construction now goes through `llm-providers.js`.
- `conversation-runtime.js` selects configuration through the provider boundary
  and constructs through the factory. Non-DeepSeek selection now fails explicitly
  instead of silently continuing to use DeepSeek for the text runtime.
- `conversation-core.js` still owns identity, permissions, explicit invocation,
  isolated scopes, working context, memory retrieval, state and invalidation.
  Memory formats and character prompts are unchanged.
- `deepseek-response.js` still owns the existing playback delivery protocol and
  error handling. `voice-answer.js` still selects its stable DeepSeek path.
  These provider-specific compatibility paths are deliberately retained; enabling
  runtime switching requires a separately authorized change and verification.
- `answer-llm.js` remains the separate legacy Luna LM Studio implementation,
  with its existing response-ID memory, native `/api/v1/chat` stream and MCP tools.
  Its lifecycle is not equivalent to the unified delivery-commit contract.

## Unified provider contract

`createProvider({ id = 'deepseek', config, fetch, console, now, onFirstContent })`
returns a frozen object with:

| Member | Meaning |
| --- | --- |
| `id` | Stable provider identity. |
| `capabilities` | Immutable adapter support, not a model's advertised features. |
| `createTurn(input)` | Synchronous validation and turn creation; no request until streaming starts. |
| `cancel()` | Dispose all outstanding turns without clearing history or resetting budgets. Reusable afterward. |
| `forgetConversations()` | Cancel turns and apply the backend's existing forget semantics. |
| `close()` | Idempotent terminal cancellation; future turn creation throws `CLOSED`. Does not reset budgets. |

Compatibility members (`provider`, `model`, `reasoning`, `resolveModel`,
`describeSearch`, `usage`) remain available for current DeepSeek callers.
The wrapper adds lifecycle management and leaves transport errors as
`DeepSeekError` with their existing codes. Registry/lifecycle/capability errors are
sanitized `ProviderError` values with `providerId` and `code`:
`NOT_IMPLEMENTED`, `NOT_CONFIGURED`, `CLOSED`, `UNSUPPORTED_CAPABILITY`. Unknown selection is a
configuration error. There is no provider fallback.

Turn input preserves the actual existing shape:
`{ guildId, sessionId, userId, query, signal?, jsonInstructions? }`.
`jsonInstructions` requests structured JSON mode. Tool and reasoning options are
explicitly rejected by the current wrapper. New operation fields must acquire
defined validation and translation before being added to this contract.

Each turn exposes the original `signal`, `stream()`, `acknowledge(chunk)`,
`commit()` and `dispose()` operations. The wrapper delegates these operations;
it does not reinterpret or buffer output. Callers must dispose turns in `finally`.

## Factory and provider status

The small factory is the registry; a plugin loader or dynamic module registry is
unnecessary here. IDs are validated against a fixed list before construction.

| Identity | Unified turn implementation | Application behavior |
| --- | --- | --- |
| `deepseek` | Implemented compatibility wrapper around the existing adapter. | Default; existing opt-in and limits apply. |
| `openai-compatible` | Experimental configuration/interface scaffold only. | Factory throws `NOT_IMPLEMENTED`, no request. |
| `ollama` | Experimental configuration/interface scaffold only. | Factory throws `NOT_IMPLEMENTED`, no request. |
| `lmstudio` | New unified adapter unimplemented. | Unified factory/text runtime refuse; Discord's legacy Luna mode remains explicitly selectable. |

`LLM_PROVIDER=lmstudio` in `index.js` continues to mean the **old** adapter and
`LM_STUDIO_URL`. New `LMSTUDIO_*` settings never silently replace that path.
There is no new selector for the future LM Studio adapter yet. Passive/shared
voice still requires DeepSeek, including when legacy LM Studio is selected.

## Configuration examples

Existing DeepSeek setups require no changes:

```dotenv
LLM_PROVIDER=deepseek
DEEPSEEK_ENABLED=false
# Existing secure credential entry and all DEEPSEEK_* limits remain unchanged.
```

Commented examples for all future providers are in
`Luna-Discord-Bot-Full-Docker/Luna/providers.env.example`. They are disabled by
default. Selecting a future provider does not enable it or a paid fallback.

`loadCompatibleConfig(env, id)` parses future configuration without I/O. Prefixes
are `OPENAI_COMPATIBLE`, `OLLAMA`, and `LMSTUDIO`; each accepts:

| Suffix | Meaning/default |
| --- | --- |
| `_BASE_URL` | Required explicit API base URL, for example `http://127.0.0.1:1234/v1`. |
| `_MODEL` | Required bounded explicit model/loaded-model identifier. No discovery or download. |
| `_API_KEY` | Optional; empty means no authentication. No credential migration. |
| `_TIMEOUT_MS` | 30000; range 100–120000. |
| `_MAX_TOKENS` | 256; range 1–4096. |
| `_STREAM` | `true` or `false`; default `true`, an operator declaration only. |
| `_FEATURES` | Optional comma-separated `structuredJson,toolCalling,tokenUsage,reasoning`. Default empty. |
| `_CONTEXT_TOKENS` | 0/unknown by default; declared context limit, maximum 10000000. |
| `_ALLOWED_ORIGINS` | Exact HTTPS origins explicitly approved by the operator for remote access. Empty by default. |

These values are parsed but not consumed by any new HTTP transport. Secrets must
be supplied through the existing operator environment, never Discord input.
Configuration objects contain credentials and must never be logged or serialized.
Errors include setting names only, never values, URLs or keys.

## Capabilities and search separation

The DeepSeek wrapper reports `streamingText`, `structuredJson`, and `tokenUsage`
as true; `toolCalling`, `reasoning`, and `search` as false. This reflects this
adapter: thinking is disabled and tool deltas are rejected. It does not describe
everything the remote model might support. `contextLimits` contains
`contextTokens: null` (unknown), configured `outputTokens`, and `queryBytes`.
No token/byte conversion or invented context-window size is assumed.

`requireCapabilities(provider, ...names)` requires explicit boolean true; false,
missing or unknown capabilities fail. The text runtime checks streaming, and
structured JSON when synthesis is enabled. Declared future features must be
intersected with adapter implementation before becoming effective capabilities;
they currently confer no functionality or permission.

Search is separate: `search-tools.js` retains its independent DeepSeek Search &
Fetch endpoints, authorization, opt-in, budgets and source filtering. Provider
`search: false` does not disable those explicitly authorized application searches.
It means callers must not route search through the model adapter. Future provider
selection must not automatically enable or reuse DeepSeek Search credentials.
Legacy Luna's MCP search/tools remain confined to its existing legacy path.

## Streaming, cancellation and history commits

DeepSeek streams completed spoken sentences; JSON mode streams exact content
fragments. These are not guaranteed to be individual tokens. A single stream
must finish successfully before commit. Every emitted chunk must be acknowledged
in order after successful delivery; reading the stream alone cannot commit.
Duplicate commit, stale turn, cancellation or incomplete delivery returns false.

External `AbortSignal`, replacing a turn in the same guild/session/user scope,
disposal and backend eviction retain their existing cancellation behavior.
Provider `cancel()`/`close()` dispose outstanding turns and prevent stale commits.
Closing the text runtime also closes its provider. Voice playback behavior and
per-turn timeouts remain in the stable playback/transport code.

`forgetConversations()` intentionally preserves the existing DeepSeek behavior:
it clears history and resets the process session ledger, while retaining the
daily ledger. `cancel()` and `close()` do neither ledger reset. There is no hot
provider switch or budget reset introduced here. Existing process-local budget
limitations are unchanged; persistent/shared accounting is future work.

## Security boundaries and future HTTP translation

Future endpoint configuration defaults to numeric loopback (`127.0.0.1`, `::1`).
Hostnames, LAN, metadata and other remote destinations require HTTPS and an exact
operator-approved origin, including any non-default port. `localhost` is not
implicitly trusted through DNS. Embedded credentials, query strings, fragments,
control characters, backslashes, other URL schemes and wildcard policies fail.
An approved origin is an explicit trust decision, including any internal service
behind that origin; it must not come from a message or model response.

There is no new outbound request code. Before implementing it, enforce the policy
at connection time, validate/pin resolved addresses to prevent DNS rebinding,
disable redirects, preserve deadlines/abort propagation and bounded responses,
and attach optional credentials only to the configured approved destination.
Do not log credentials, request bodies or raw provider errors. The parser alone
is not a complete network security boundary or permission to add a transport.
The existing DeepSeek endpoint validation is unchanged, not newly hardened here.

Future adapters must construct their own chat-completions bodies. A base URL is
not a complete request URL; a future adapter must append `/chat/completions`
without discarding a configured base path. Include only implemented and negotiated
fields; do not copy DeepSeek `thinking`, `stream_options`, JSON or token-limit
fields into arbitrary compatible requests. No shared transport is extracted from
the stable DeepSeek adapter. Authentication translation remains unimplemented.

Providers never grant interaction, memory, voice or search permission. Existing
authorization, privacy controls, user invocation rules and cost limits must be
preserved before enabling any future runtime path. Future local inference also
needs input/output/concurrency limits; locality does not waive these controls.

## Validation and remaining work

Validation is limited to JavaScript syntax checks, static import consistency,
the targeted offline v0.2/v0.3 suites, a deterministic provider contract file with
synthetic in-memory responses, and Git diff checks. Synthetic checks cover compatibility with the original request and
history lifecycle, capability refusal, opt-in gates, cancellation, accounting
preservation and configuration policy. They are not live provider validation.

Local result: `npm run test:v02` passed 45/45, `npm run test:v03` passed 30/30,
and `node --test test/llm-provider-contract.test.js` passed 10/10. The text-status
fixture explicitly selects DeepSeek rather than inheriting the legacy LM Studio
harness default, and verifies that status makes no model request. The existing
dynamic-voice fixture injects the new factory and is covered by the v0.3 run.
The offline runs reuse an existing dependency directory through temporary
`NODE_PATH`; its lockfile SHA-256 matches this checkout. No dependencies were
installed or updated. Initial static checks passed `node --check` for all 8
then-changed/new JavaScript files; provider/config/runtime imports and exports
resolved, and `git diff --check` passed.

Exact changed files (paths relative to repository root):

| File | Change |
| --- | --- |
| `Luna-Discord-Bot-Full-Docker/Luna/llm-provider-config.js` | New selection and future configuration boundary. |
| `Luna-Discord-Bot-Full-Docker/Luna/llm-providers.js` | New factory, capabilities and compatibility lifecycle wrapper. |
| `Luna-Discord-Bot-Full-Docker/Luna/config.js` | Known IDs and fail-closed provider selection. |
| `Luna-Discord-Bot-Full-Docker/Luna/conversation-runtime.js` | Factory integration, capability checks, provider close. |
| `Luna-Discord-Bot-Full-Docker/Luna/index.js` | Construct DeepSeek through factory; retain legacy path. |
| `Luna-Discord-Bot-Full-Docker/Luna/providers.env.example` | Disabled future configuration examples. |
| `Luna-Discord-Bot-Full-Docker/Luna/test/llm-provider-contract.test.js` | Deterministic contract checks. |
| `Luna-Discord-Bot-Full-Docker/Luna/test/harness.js` | Register factory in existing mock module map. |
| `Luna-Discord-Bot-Full-Docker/Luna/test/v02-adapters.test.js` | Select DeepSeek explicitly in text-status fixture and assert zero model requests. |
| `Luna-Discord-Bot-Full-Docker/Luna/test/v03-dynamic-voice.test.js` | Preserve existing delayed-transport fixture injection. |
| `docs/LLM_PROVIDER_ARCHITECTURE.md` | Architecture, boundaries, evidence, risks and future work. |
| `README.md` | Provider status and architecture link. |

Integration risks: live voice and Discord behavior are not revalidated here; current
provider-specific voice gates/errors remain intentional compatibility constraints.
An invalid provider ID now fails startup rather than recovering to the paid default.
Text runtime LM Studio selection now refuses instead of ignoring the selection and
using DeepSeek. These fail-closed changes are intentional. Legacy Luna and future
LM Studio configuration are separate; operators must not expect the new settings
to configure the old path. No new transport is ready to enable.

The existing known test limitations remain disclosed in `PUBLICATION_GATE.md`:
five inherited `integration-v0.test.js` fixture failures, one old autojoin resume
expectation and one old Luna wording expectation. This task does not rerun the
full suite, repair those failures or claim a new full-suite pass count.

Future separately authorized steps:

1. Implement bounded provider-specific HTTP/authentication and response translation
   for each experimental adapter, including non-streaming behavior where needed.
2. Add deterministic malformed-stream, cancellation, budget, capability and endpoint
   security tests before enabling any runtime selection.
3. Generalize retained voice compatibility gates/error handling only after proving
   identical acknowledgement, playback and permission behavior. Preserve legacy
   Luna separately or introduce an explicit migration choice.
4. Perform opt-in live validation independently for OpenAI-compatible servers,
   Ollama and LM Studio, with explicitly chosen models, endpoints and cost caps.
   DeepSeek regression/live validation also remains outside this task's evidence.

No live API calls, inference, GPU benchmarks, Discord sessions, full repository
suite, launcher edits, deployment, running-service changes or Actions changes are
part of this preparation. Branch publication and PR creation were separately
authorized after the initial local implementation.
