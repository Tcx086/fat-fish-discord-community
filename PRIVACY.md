# Privacy and operator responsibilities

Fat Fish is self-hosted, independent and unofficial. This document describes the
code; it is not a published operator privacy policy or a promise about Discord or
DeepSeek. A deployment must identify its operator, contact method, audience,
retention and deletion process before collecting speech or text.

## Data flow

1. Discord transports voice, account IDs, names and messages. Authorized voice is
   decoded locally to PCM and sent as an in-memory WAV to configured Whisper
   endpoints. Use loopback endpoints only for the documented local STT setup.
   Redirects are rejected. A configurable remote STT endpoint would transmit audio
   outside the machine; “local” depends on the actual configuration.
2. Passive mode transcribes eligible speech before deciding whether it addresses
   Fat Fish. It is not a guarantee that only the wake phrase is transcribed.
   Recent attributed text is temporarily retained for conversational context.
3. With `DEEPSEEK_ENABLED=true`, requests send text, the character/system prompt,
   bounded recent dialogue and eligible retrieved memory to DeepSeek. Context can
   include speaker IDs, display names and timestamps (`memory/context.js`). The
   integration sends text rather than raw microphone audio to DeepSeek. A response
   may be spoken to everyone in the voice channel. Do not submit secrets or
   sensitive third-party information.
4. Search sends the query to DeepSeek's search tool. Optional Fetch sends a permitted
   URL; optional synthesis sends query and selected search excerpts in another
   model request. These are separate external transfers and may incur charges.
5. Feiyu receives answer text at the configured local service and returns audio.
   Legacy alternative cloud TTS/search providers have separate data flows and
   terms. Discord receives text replies, exports and generated voice output.

External provider retention and deletion are governed by those providers and the
operator's account agreements; this repository cannot verify or erase their copies.
Ephemeral Discord replies reduce channel visibility but are still sent to Discord.

## Participation and consent

Use the manual inert profile with `CONVERSATION_ALL_PARTICIPANTS=false` and explicit
participant/operator allowlists for a controlled deployment. The Windows launcher
currently forces all-participant passive mode: presence plus notice/opt-out is not
affirmative per-session consent. Do not use that launcher where an explicit
allowlist or affirmative transcription consent is required.

`/opt-out` stops that participant's local transcription in the current runtime and
withdraws memory consent; runtime opt-out does not survive a process restart.
`/stop` or `/leave` disconnects the voice session. Explain these controls before
joining. Merely declining persistent memory does **not** disable temporary STT.
Obtain appropriate participant agreement for transcription and external text
processing separately from persistence.

Persistent storage defaults off. Enabling it requires an operator privacy URL,
policy review and encrypted-storage attestations; those booleans do not encrypt
SQLite or establish consent by themselves. Channel history enablement posts a
notice and resets participant consent. `/memory action:consent confirm:true`
authorizes future eligible attributed transcripts for that scope. Read access is
scoped; voice recall also checks the current audience. User-linked private scopes
can intentionally bridge identities only through explicit linking controls.

## Retention and deletion

| Data | Behavior |
| --- | --- |
| Live audio | Integration buffers in memory; no participant recording feature is enabled by the recommended profile. Service stderr, OS crash dumps, swaps and operator instrumentation are separate risks. |
| Working text | Default bounded window: up to 180 seconds, 40 entries and 6,000 characters. Session lifecycle/opt-out clears applicable state; there is no secure-memory erasure guarantee. |
| SQLite transcripts/summaries | Default 24 hours; configurable bounded retention up to 30 days. Expired entries are excluded from retrieval immediately; physical cleanup is batched while the process runs, so an offline database may retain expired bytes. |
| Curated memory | Can have no expiry. Approval does not mean verified truth. Explicit forget/withdrawal is needed for relevant records. Clearing history does not remove every curated entry. |
| Consent/session/link/dedup metadata | Stored separately; controls and cleanup differ. Withdrawal removes the speaker's consent row, transcripts and authored/derived memory content in the current scope. It is not a global account purge across all scopes, links and providers. |
| Deletion audit/tombstones | Limited metadata can remain up to 30 days under cleanup rules; not a transcript archive. |
| Logs, caches, exports and backups | Operator-managed. Legacy wake logs can contain names/IDs; set `WAKE_LOG_FILE=`. Legacy paths log text and can cache generated greetings. Disable unused legacy paths. Exports sent to Discord and backups require independent deletion. |

Use `/memory action:export` for paginated own records, `action:withdraw` for own
scope consent/content removal, `action:forget id:<id>` for an owned/authorized
curated entry, and operator `action:clear-history` or `action:disable-history` for
channel history. Text CLI/`/fish` controls are described in
[the component guide](docs/V0_2_ARCHITECTURE.md). Contact the deployment operator
for inactive channels, linked identities, backups or a complete deletion request.

SQLite uses secure-delete and FTS cleanup, but this does not promise forensic
erasure from WAL/SHM sidecars, backups, SSDs or exports. An operator performing a
full offline purge must stop their own instance, remove the selected database and
its sidecars/exports/backups, and verify removal without exposing content. Use an
encrypted volume and restrictive OS permissions; Unix mode bits do not establish
Windows ACL protection. This release audit did not perform a production deletion.
