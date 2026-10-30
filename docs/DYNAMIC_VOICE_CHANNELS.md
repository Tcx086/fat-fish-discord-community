# Dynamic voice channels — v0.3

Status: **DYNAMIC_VOICE_IMPLEMENTED_LIVE_PENDING**


## Configuration and commands

User-requested follow-up: eligible speech containing 大肥鱼 anywhere now invokes a reply, including mention/quotation and name-only speech. Punctuation is not required; traditional 魚 and inter-character whitespace remain accepted. Name-only speech no longer grants later nameless speech a response window. Existing authorization, notice, opt-out, deduplication and request caps still apply. Spoken pause/leave/interrupt controls require a direct, exact command. The channel notice describes the broader trigger; see `DYNAMIC_VOICE_LIVE.md` for current validation evidence.

Enable the existing passive mode with `CONVERSATION_ENABLED=true`, `CONVERSATION_MODE=passive` and a valid `CONVERSATION_GUILD_ID`. `CONVERSATION_CHANNEL_ID` is no longer required or used to restrict passive sessions. The disabled `passive.env.example` documents this configuration; existing local credentials were not changed or read. Active diagnostic mode retains its previous fixed-channel behavior.

One `createVoiceSession` instance owns the single process-wide connection. There is no new transport or parallel guild-session manager. Passive mode ignores `AUTO_JOIN_CHANNELS` and never joins at startup or follows participants.

Commands are registered only in the configured guild, and only when the existing `CONVERSATION_REGISTER_COMMANDS=true` flag is explicitly enabled. Registration uses individual guild command creation, preserving `/fish` and other unrelated commands. New slash controls reply privately with mentions disabled.

| Command | Permission and behavior |
| --- | --- |
| `/join` | A member selects their own current authorized ordinary voice channel. Already active/pending/reconnecting: report the current location; never implicitly move. |
| `/move channel:<voice-channel>` | Existing session required. Configured operator (`CONVERSATION_OPERATOR_IDS`) or guild member with `ManageGuild` required, preserving the existing administration policy. Administrator permissions satisfy Discord's permission check. Same destination is a no-op. |
| `/leave` | Active-channel participant or operator/administrator. Cancel everything and disconnect. |
| `/stop` | Same control permission; emergency cancellation, including a pending connection/reconnect. |
| `/status` | Active-channel participant or operator/administrator. Guild/channel, lifecycle state, connection state, eligible human count, subscriptions, STT/response queues, playback, memory backend, API count and process resource usage. |
| `/pause` | Participant or operator/administrator; stop capture, cancel work and clear temporary dialogue. |
| `/resume` | Operator/administrator; renew the visible notice before capture. |
| `/clear-context` | Operator/administrator; cancel work and clear temporary dialogue without deleting authorized durable history. |
| `/opt-out`, `/opt-in` | A participant controls their own transcription. Opt-out also withdraws and deletes their persisted contribution in the active channel. Opt-in requires a fresh visible notice. |
| `/memory action:...` | Existing consent, review, export and deletion policy, bound to the active voice channel. Privileged persistence operations still require `ManageGuild`; being a configured voice operator alone does not authorize them. |

All voice controls reject other guilds. Targets must be ordinary guild voice channels (type 2, not Stage channels), with bot View Channel, Connect and Speak permissions. The requesting member must have View Channel and Connect on the destination, which must contain an eligible human. Channel authorization comes from the configured guild and Discord permissions; use bot channel permission overrides to exclude channels. A failed channel notice prevents transcription even when voice permissions exist.

`!luna` remains a legacy alias for joining the requesting member's current channel. Existing `!luna leave/stop/pause/resume/clear-context/status/opt-in/opt-out/interrupt/end` controls remain available under their permissions. `!luna` no longer implicitly moves a passive session or selects a configured fixed channel for an absent operator. `/interrupt`, `/end-conversation`, `/conversation-status` and the legacy typed `/stop` remain compatible. `/fish` keeps its independent private scope and allowlists.

## Lifecycle and atomic transitions

Join proceeds through connecting, target confirmation, visible notice, then passive listening. The voice library may return an existing connection still marked Ready in the previous channel. Therefore dynamic sessions require **both Ready and the bot's Discord voice-state confirmation for the expected guild/channel** before binding memory or notifying/listening in the destination. Missing confirmation remains subject to the 30-second readiness deadline.

Moving first validates the destination without disturbing the source. An accepted move synchronously advances the session generation, clears readiness/disconnect/recovery timers, stops capture, aborts STT/model/TTS, resets playback, destroys subscriptions, clears working dialogue/API history and ends/closes the old memory session. It then uses the existing `joinVoiceChannel` movement path, reusing the connection when the library does. Once the destination is confirmed and Ready, it opens the destination Memory Engine scope, rebinds the passive listener and memory commands, and publishes the notice before any transcription.

Session, passive-listener and capture generations reject old callbacks even when the connection object is reused. A deferred memory command cannot act after its scope has changed. Old audio, notices, model responses, playback jobs, readiness callbacks and reconnect timers cannot restore source-channel processing.

A rejected target leaves the source session intact. Transport/setup failure after transition begins disconnects; there is no automatic rollback into the old channel. A destination notice failure leaves the connection paused with zero capture subscriptions. Readiness timeout, unrecovered disconnection, stop, leave, or the last eligible human leaving release the session. Unexpected server-side dragging disconnects instead of adopting a new channel without authorization.

Existing DAVE recovery remains a bounded reconnect to the same channel (1.5-second retry delay and existing recovery throttling). It rechecks permissions, membership, readiness, target confirmation and notice. An explicit move supersedes the old recovery timer. Pause survives same-channel recovery; a deliberate transition to a different channel starts a fresh temporary session. A brief networking recovery within the same existing session retains the existing transport behavior.

## Participant policy and isolation

Default all-participant mode needs no manual speaker-ID list. Eligible human members receive the channel-visible local-transcription notice before capture. Bots, ignored users and opted-out participants are excluded. New arrivals clear prior working context and interrupt an answer before their notice; failed/late notices cannot enroll them in another session. A notice covers the eligible people present when that send began. Opt-out persists in process memory across channel moves; explicit opt-in is required to reverse it during that process.

The existing distinction between temporary transcription and persistent consent remains:

- Temporary local Whisper transcription uses the existing visible-notice/opt-out policy, bounded to three minutes/40 entries by default. `CONVERSATION_ALL_PARTICIPANTS=false` continues to require the configured consenting user allowlist.
- Persistence is disabled by default. Enabling it still requires the reviewed privacy policy and verified encrypted-storage configuration gates, per-channel administrator confirmation and each participant's explicit consent. No participant is automatically enrolled in persistent history by joining or receiving a notice.
- Historical evidence is included in a voice response only if the current audience can read it. A newly arrived unconsented participant cancels historical playback and prevents retrieval for the changed audience.
- Each reopened Memory Engine uses the destination guild/channel keys. Source history and consent remain in the source scope; destination history is separately enabled and consented. Moves never copy working dialogue or persistent records. Rejoining A can retrieve authorized A history while B cannot.
- Ordinary speech creates zero DeepSeek requests. Explicit address to “大肥鱼” produces one bounded response, with the existing short next-segment question allowance after a bare invocation. No autonomous conversation or new search behavior is introduced.

Per-speaker Opus/DAVE capture, bounded audio/STT queues, local Whisper requirement, streaming answer cancellation, Feiyu worker requests and selected voice are reused. No permanent raw recordings or transcript diagnostics were enabled.

## Files changed

Paths below are relative to `Luna-Discord-Bot-Full-Docker/Luna/`, except the documentation:

- `conversation-config.js`, `passive.env.example`: passive guild configuration without fixed channel binding.
- `index.js`: dynamic commands, permission gates, current-channel controls, target confirmation routing, notice gating and Memory Engine rebinding.
- `voice-session.js`: atomic movement using existing transport, confirmation/readiness gate, generation-safe lifecycle and recovery.
- `voice-listen.js`: reject stale speaking callbacks when reusing a connection.
- `passive-listener.js`: disconnected-only scope rebinding, with paused recovery preservation.
- `memory/commands.js`: invalidate deferred operations after scope changes.
- `test/harness.js`: deterministic channel permissions, registration capture, voice-state acknowledgement and move failures; no real services.
- `test/v03-dynamic-voice.test.js`, `test/v03-voice-session.test.js`: dynamic integration and lifecycle cases.
- `package.json`: `npm run test:v03`.
- `docs/DYNAMIC_VOICE_CHANNELS.md`: this report (repository root).

No dependency, selected TTS voice, resident worker, production storage gate or external infrastructure changes.

## Focused local validation

Final selected run: **169 passed, 0 failed**: 26 v0.3 tests, all 45 v0.2 regressions, and 98 existing tests covering the touched session/listener/memory/answer/TTS boundaries. The TTS file also runs its existing assertion-based checks. The full repository suite was not run.

From `Luna-Discord-Bot-Full-Docker/Luna`:

```powershell
node --test test/v03-*.test.js test/v02-*.test.js test/phase0.test.js test/phase1-integration.test.js test/phase2-integration.test.js test/passive-listener.test.js test/passive-integration.test.js test/unified-voice.test.js test/memory-integration.test.js test/feiyu.test.js test/tts.test.js
```

Coverage includes join/already joined, operator/admin movement, inaccessible/Stage/wrong-guild targets, permission revocation, multi-human capture, arrival notice, explicit allowlist consent, bot exclusion, opt-out/in, ordinary speech silence, explicit invocation, A/B working and persistent isolation, deferred memory invalidation, STT/LLM/TTS/playback cancellation, stale speaking/Ready/error/deadline/recovery callbacks, failed moves/notices, pending-join cancellation, stop/leave during playback, empty channels, repeated cycles, paused recovery and target acknowledgement while transport still reports Ready.

Persistent isolation tests use fictional data and the existing test-only policy fixture. The disposable SQLite database and companions are cleaned up through that fixture. This is not an attestation that this Windows machine or production storage is encrypted. Mock HTTP/Discord/TTS responses are not live service validation.

## Live validation instructions — not executed

Obtain explicit authorization for Discord connection and guild command registration before any launch. Obtain a separate paid-call budget before enabling DeepSeek/Search. The old v0.2 paid allowance is not reused.

1. Review the target guild's bot permissions and visible voice-channel text notices. Keep persistence and paid services disabled unless separately authorized/configured. Prepare two ordinary voice channels A/B, an operator, two consenting human testers, and an inaccessible/Stage target.
2. Register only guild commands using the existing opt-in flag during the authorized launch, then return that flag to false. Do not enable automatic joining.
3. From A, run `/join`, verify the notice precedes capture, then `/status`. Repeat `/join` from B and verify it reports A. Have a non-operator attempt `/move channel:B` and confirm rejection.
4. Test ordinary speech, newcomer notification, `/opt-out`, `/opt-in`, `/pause`, authorized `/resume` and `/clear-context`. Only with a separately approved model budget, make one explicit “大肥鱼” request and check the selected Feiyu voice.
5. As operator, move A to B during STT, model generation, TTS and playback. Confirm source audio stops, target confirmation/notice precedes target capture, and B receives neither source working context nor historical evidence. Inspect `/status` for released queues/subscriptions.
6. With separately authorized protected persistence, enable/consent independently in A/B and use synthetic history to verify A-only retrieval after a round trip. Do not treat the synthetic fixture policy as production authorization.
7. Test permission/notice failure, transport interruption, `/stop` during recovery, `/leave` during playback, last-human departure and repeated cycles. Confirm no automatic join/follow. End with `/stop`.

## Remaining limitations

Real Discord gateway ordering, permissions, application-command registration, DAVE audio, Whisper accuracy, live DeepSeek answers and hardware voice latency remain unverified for v0.3. The additional acknowledgement gate is tested against deterministic events and inspection of the installed voice library; a missing or unexpected Discord acknowledgement deliberately leaves processing closed or disconnects.

One configured guild and one voice session per process are supported. Current `/memory` commands address the active voice scope; accessing an inactive channel's history requires an authorized join back to it. Runtime opt-out is not durable across a full bot process restart; persistent withdrawal/consent remains database-backed under existing policy. Temporary transcription still follows notice/opt-out rather than an affirmative per-session consent click in default all-participant mode; deployments requiring stricter consent must use the existing explicit allowlist and review policy before enabling it.

Storage encryption is not newly verified by this change, and the existing configuration attestation does not itself encrypt SQLite/WAL/backups. Cancellation rejects late local output but cannot retract text already sent to an authorized remote provider or sound already played. Existing retention and deletion limitations in the memory documentation continue to apply.
