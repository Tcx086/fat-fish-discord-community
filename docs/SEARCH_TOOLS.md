# Read-only Search/Fetch integration

**LIVE_TRANSPORT_VALIDATED_QUALITY_LIMITED**. One authorized live Search completed;
official URLs/titles matched, but dates differed from page dates and latest coverage
was not established. One synthesis attempt safely fell back to excerpts. Fetch was
not called. See [live validation](V0_2_LIVE_VALIDATION.md) for the completed run.

The subsequent code repairs pass offline regression tests; post-fix paid validation
has not been run. Prior live findings above are not a claim about repaired-model
quality. The original allowance is exhausted.

The [official DeepSeek Search/Fetch guide](https://api-docs.deepseek.com/guides/search/)
was read on 2026-10-29. The adapter implements its JSON endpoints:

- `POST https://api.deepseek.com/v1/tools/search`: `{query,count,need_content:false}`.
- `POST https://api.deepseek.com/v1/tools/fetch`: `{url}`.
- Bearer authentication reuses `DEEPSEEK_API_KEY`. Search consumes `results` with
  title, URL, summary/snippet and optional RFC3339 `date`; Fetch consumes title/content.

## Routing and output

The common conversation core selects search for `/search`, explicit search language,
or clear current-information requests such as `今天 LOL 更新了什么？`. Ordinary
memory questions (`我们昨天说的那个游戏是什么？`) use authorized local history.
Memory-language detection takes priority over date words unless search was explicit.
No model autonomously decides to loop, fetch, write, or execute external commands.
The query includes only the current user request, never the retrieved private context.

Default orchestration performs one search and returns bounded, attributed excerpts.
It labels them as retrieved, not independently verified, retains conflicting evidence
side-by-side, and states that this turn has **no model interpretation**. Empty or
unavailable results produce uncertainty, not fabricated citations. This intentionally
uses the smallest safe sourced response: it does not promise a synthesized news article.
Source titles/URLs and known publication times are attached by code, not invented
by an LLM. The renderer removes embedded links/mention markup from excerpt text;
only the validated source URL is presented as a citation.

With synthesis disabled (the default), search content never enters a model prompt or a command parser. Thus instructions
inside pages cannot request more tools, change identity, obtain credentials, or
write/delete memories. The user query can remain authorized episodic context; the
retrieved page and rendered evidence are not persisted or promoted to user facts.
The next ordinary turn retains the user's working conversation.

### Optional text-only synthesis

`SEARCH_SYNTHESIS_ENABLED=true` opts the text runtime into one additional paid
model request after a successful non-empty search; it requires `DEEPSEEK_RETRIES=0`.
It is disabled by default and does not change passive voice. The model sees only
the request and bounded excerpts, with no private history, source URLs or tools.
It uses dedicated system instructions and provider JSON output mode. Raw structured
content bypasses spoken sentence splitting so exact quote whitespace is preserved.
Output is buffered and checked for known source IDs, exact quote substrings and
bounded plain interpretations. Code renders citations and labels interpretations
as inferences. Invalid output falls back to excerpts without repair or Fetch.
Exact matching establishes provenance, not semantic accuracy or source truth.
Neither excerpts nor synthesis enter user memory. See
[controlled validation](V0_2_LIVE_VALIDATION.md) for fixture results, limitations,
the restart-safe test allowance and the completed, quality-limited live run.

### Text search freshness and metadata

For current/latest text requests, the same single Search call adds a 30-day `after:`
and an English or Chinese/English `lang:` filter when each fits within 128 characters.
User-supplied date/language filters are preserved. No second search occurs when the
provider returns stale, redundant or missing results. Passive voice does not use
this text query transformation.

Same-origin locale-path variants are grouped but all their excerpts/URLs are kept,
including conflicts. They are not counted as independent corroboration; individual
source IDs still point to the exact quoted page. Dates require valid RFC3339 calendar
timestamps and are labeled unverified index metadata, not verified publication dates.
Old results are marked historical. Recent index dates alone never establish that
the result is the latest information. Fetch remains disabled by default.

## Cost and transport controls

| Setting | Default / accepted limits |
| --- | --- |
| `SEARCH_ENABLED` | false; explicit operator opt-in |
| `SEARCH_RESULT_LIMIT` | 3 / 1–5 |
| `SEARCH_TURN_BUDGET` | 1 / 1–3 attempts, including retries/fetch |
| `SEARCH_PROCESS_BUDGET` | 10 / 1–100 attempts, shared by text/voice in the bot |
| `SEARCH_TIMEOUT_MS` | 8,000 / 100–30,000; includes body reading |
| `SEARCH_RETRIES` | 0 / 0–1; only documented transient HTTP failures, 250-ms delay |
| Response bytes | 65,536 before parsing, with bounded excerpts |
| Query | 1–128 Unicode characters; oversized queries are refused |
| `SEARCH_FETCH_ORIGINS` | empty; exact operator-reviewed HTTPS origins only |

Reservations occur before I/O; errors and ambiguous timeouts consume budget. There
is no unbounded retry or browse loop. The default budget of one cannot retry even
if retries are enabled. The existing model token/concurrency/deadline controls remain
independent. Budgets are process-local: a restart is not a durable billing ceiling.

The documentation lists $0.75 per 1,000 successful Search or Fetch requests. Thus
the default 10-attempt cap represents at most $0.0075 at that documented rate,
excluding model inference and other processes. Verify current account pricing before
live approval; no free allowance is assumed. The guide lists separate account-level
limits of 100 Search QPS and 25 Fetch QPS. Local limits are much smaller.

## Security boundary and optional Fetch

The HTTP client posts only to hard-coded DeepSeek tool endpoints, never a URL from
a page. Provider redirects are rejected. Credentials are not included in fetch URLs,
page parameters, result payloads or raw errors. Cancellation races uncooperative
transports; streaming reads enforce size/deadline limits and release bodies.

Source URLs require HTTPS, no credentials/nondefault port, and a public-looking
DNS hostname; IP literals and local/reserved suffixes are rejected. Optional Fetch
also requires an exact configured origin and a public-address DNS preflight; mixed
public/private DNS answers are refused. No local service is contacted to fetch a page.

Fetch is implemented and mock-tested but **not automatically called by orchestration**.
Leave `SEARCH_FETCH_ORIGINS` empty for the delivered configuration. The provider's
Fetch response does not expose its redirect chain/final URL; the application cannot
independently prove downstream redirect/DNS-rebinding protection inside that service.
Review the provider's current security policy and the specific allowed origins before
enabling optional Fetch. The local SSRF boundary is strong; an end-to-end provider
security guarantee is not claimed. Adding a local URL-fetching fallback is prohibited.

## Live-check procedure (one authorized run completed)

The run in [V0_2_LIVE_VALIDATION.md](V0_2_LIVE_VALIDATION.md) consumed its one-search
allowance. The following procedure is not authorization to repeat it.

After separate cost authorization, supply a key privately, enable Search, set
`SEARCH_PROCESS_BUDGET=1`, `SEARCH_TURN_BUDGET=1`, `SEARCH_RETRIES=0`, and keep Fetch
origins empty. Use local `/search LOL 最新官方补丁 site:leagueoflegends.com`.
Check returned URLs/titles/date against the official page. Then ask a memory question
and confirm no further tool attempt. Save only counts/timings, no credentials or
private conversation content. Do not restart to evade an approved budget.

Tests in `test/v02-search.test.js` use synthetic HTTP responses and DNS answers,
covering routing, auth destination, schemas, missing/conflicting sources, injection,
SSRF addresses, size/time limits, cancellation, retry/turn/process caps and disabled
mode. They do not establish live provider availability or relevance.
