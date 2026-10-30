# Fat Fish v0.2 architecture

Local implementation and offline verification: 2026-10-29 (America/New_York).

This component shares the integrated voice/memory source. Private checkout, branch
and session records are excluded; see the current publication gate for validation.

## Common conversation path

```text
local-chat.js                         Discord /fish (ephemeral)
       \                            /
        conversation-runtime.js -> conversation-core.handle
                                  | commands / consent / review
                                  | bounded working context
                                  v
Discord passive listener ----> conversation-core.prepare
 (existing STT/invocation/      |             |
  cancellation/queue retained) |             +-- explicit/current request -> Search
                              +-- Memory Engine context -> existing DeepSeek adapter
                                  |
                         delivered text / existing voice playback + Feiyu

WeChat encrypted fixtures / WeCom sync_msg fixtures -> same core.handle
(no listener, real token acquisition or outbound account transport installed)
```

The trusted adapter supplies this envelope; user messages cannot assign permissions:

```js
{
  platform: 'discord-text',
  scope: { kind: 'private', guildId: 'stable-server-id', channelId: 'stable-channel-id' },
  sessionId: 'adapter-session-id', userId: 'authenticated-platform-user-id',
  content: 'message', timestamp: 1793318400000, explicitInvocation: true,
  permissions: { interact: true, readMemory: true, manageMemory: false, search: true },
  signal: abortController.signal, messageId: 'optional-stable-provider-message-id'
}
```

`prepare` owns memory/search routing and budgeted retrieval; `handle` adds private
text commands and turn delivery. `turnFor` uses the existing DeepSeek streaming
adapter. Voice calls the same `prepare` with its current Memory Engine and bounded
working buffer. Its existing response/playback adapter continues to acknowledge
sentences only after delivery. Search evidence uses a static turn, split into
at most 400 UTF-16 units per chunk for the 500-character Feiyu service limit.

Text runtime disables the model adapter's separate history; all recent dialogue
comes from the existing rolling context helper. No platform implements a second
memory database or its own search client. Text and voice share the search attempt
ledger in the Discord process. Model token budgets remain the existing adapter's
process-local implementation (separate text/voice instances).

The controlled validation follow-up adds an opt-in text-only synthesis step after
Search (`SEARCH_SYNTHESIS_ENABLED`, false by default). It buffers one tool-free
model answer, checks exact quotes/source IDs, labels interpretations as inferences
and renders citations from provider metadata. Passive voice remains evidence-only.
See [V0_2_LIVE_VALIDATION.md](V0_2_LIVE_VALIDATION.md) for boundaries and the completed
authorized live run, including grounding and Search quality limitations.

The repair follow-up uses explicit ISO UTC memory dates in text model context and
dedicated structured synthesis instructions. The shared DeepSeek adapter preserves
raw JSON content only for explicitly requested structured turns; default voice
sentence streaming is unchanged. Text Search applies bounded date/language filters
and preserves grouped locale-source provenance. The same attempt/token ledgers and
privacy gates apply; no new model service or autonomous tool loop was introduced.

## Memory, scopes and deletion

| Layer | Behavior |
| --- | --- |
| Working | Existing rolling buffer: 180 seconds, 40 entries, 6,000 serialized characters; at most 32 text scopes. Delivered model answers are working-only. |
| Episodic | Explicit enablement **and** per-user consent, then authorized user text only. Default 24 hours. No command bodies, raw audio, model answers or retrieved pages are recorded. |
| Summary | Explicit `/summary`, extractive latest six eligible statements, maximum 300 characters each, labeled `unknown_or_conflicting`; owner review required. Original event IDs/timestamps retained. No model summarization or background requests. |
| Long term | `/remember` creates a candidate; separate `/approve ... CONFIRM` attests a necessary non-sensitive fact or the owner's own preference. No sensitive profiles or third-party personal data. UUID, author, review/provenance/source time and supersession retained. Never inferred automatically. |
| Character | Existing IDENTITY/SOUL/SPEECH_STYLE files are read-only to conversation; temporary state is reset at session boundaries. No new character content. |

Summary retention is `MEMORY_SUMMARY_RETENTION_MS` (24 hours by default, bounded
to 1 minute–30 days), capped by the earliest source expiration. It never extends
transcript retention. Historical reads exclude expired records immediately;
cleanup physically removes expired events/FTS entries and erases derived summary
content. Cleanup now includes inactive scopes in the same database, 25 events per
batch, with the existing 60-second/250-ms backlog timer. While the application is
stopped, cleanup resumes at the next open. Tombstone metadata is bounded to 30 days.

Schema v2 is an atomic additive migration from v1: account link offers, account
links and processed-message IDs, plus a deletion trigger that also erases topic
text. It preserves existing voice settings and consent; it never opts anyone in.
Back up an authorized database on its protected volume before deploying a migration;
the old v1-only application refuses v2 instead of silently using an unknown schema.
Only temporary synthetic databases were migrated during this task.

Legacy Discord voice memory retains its explicit guild/channel namespace and
shared audience checks. New text scopes use `v2:` + SHA-256(platform, guild) and
SHA-256(private, channel, user), so even equal user IDs on different platforms or
different Discord channels cannot collide. Hashes are namespace keys, not encryption.
Discord text results are private to the invoking user, not posted in guild history.
No private text memory is injected into shared voice playback.
Existing shared voice commands retain their administrator/non-personal-content
restriction; private owner-reviewed preferences use distinct provenance. Both paths
retain the same policy, consent, explicit non-sensitive attestation and review gates.

Explicit account linking uses a random 192-bit, single-use, five-minute challenge,
stored only as a SHA-256 digest, accepted from the other authenticated platform.
Display names are never used. Linking grants no automatic transcript access.
`/linked-recall` explicitly retrieves only currently approved private curated facts,
with source identity/provenance and current consent checks. It reads the source,
does not copy facts, excludes summaries and guild transcripts, and is not cached
in working context. `/unlink`, `/withdraw`, source deletion and supersession take
effect on the next read. There is no transitive linking.

Stable incoming message IDs are reserved before side effects and retained 24 hours
in SQLite. Duplicates return a suppression result, including across restarts. A crash
after reservation may drop a response: this is at-most-once processing, not an
exactly-once outbound guarantee. Without storage the bounded dedup ledger is only
in memory; a future real webhook service must require durable storage/outbox.

Existing policy/privacy URL/encrypted-volume confirmation gates remain mandatory.
SQLite is **not** application-encrypted; deployment must actually protect the
volume, ACLs, backups and WAL. File mode is restricted where the OS supports it.
Storage failures fail closed, create the existing recovery marker, and require
operator reconciliation before persistence can reopen. Deletion does not claim to
erase external backups or previously delivered user messages.

## Local and Discord text usage

From `Luna-Discord-Bot-Full-Docker/Luna`, run `npm run chat:local`. It opens only
stdin/stdout, not a web server, Discord connection or API request. It reads explicit
process environment, not `.env`. Default APIs/storage are disabled. The console
represents the current OS operator; `LOCAL_CHAT_USER` is a local namespace, not
multi-user authentication.

For real persistence, first fulfill the existing policy notice and encrypted-volume
requirements in `memory.env.example`, set an absolute protected `MEMORY_DB_PATH`,
and explicitly enable storage. Do not reuse synthetic test attestations for people.
Ordinary model chat additionally needs authorized `DEEPSEEK_ENABLED=true` and a
privately supplied API key; memory commands work without a paid model.

```text
/enable CONFIRM
/consent CONFIRM
/remember test-game | The synthetic test game is Celeste.
/approve <returned-id> CONFIRM
/recall game
/provenance <returned-id>
/quit
# Restart npm run chat:local with the same database and LOCAL_CHAT_USER:
/recall game
/remember test-game | The synthetic test game is Portal.
/approve <new-id> CONFIRM <old-id>
/forget <new-id>
/quit
# Restart again: /recall game must have no approved result.
```

Other operations: plain text for chat; `/history query`, `/summary`, `/status`,
`/clear` (working context only), `/withdraw` (consent/data deletion in this scope),
`/search query`, `/link-offer CONFIRM`, `/link-accept token CONFIRM`,
`/linked-recall query`, `/unlink`, `/help`. Approval is deliberate, never an LLM tool.

Discord uses `/fish message:<question or command>`. Configure the exact guild,
channel, user allowlist and memory-operator allowlist in `v02.env.example`.
`FAT_FISH_TEXT_ENABLED` and command registration are separate opt-ins. Registration
requires a future authorized Discord connection; none was made here. Responses and
follow-ups are ephemeral with mentions disabled. The adapter does not collect
ordinary channel messages. Existing legacy LM Studio text features are unchanged;
the v0.2 DeepSeek path is `/fish`.

See [SEARCH_TOOLS.md](SEARCH_TOOLS.md), [WECHAT_ADAPTER.md](WECHAT_ADAPTER.md) and
[MEMORY_RESTART_VALIDATION.md](MEMORY_RESTART_VALIDATION.md) for external boundaries
and reproducible evidence.
