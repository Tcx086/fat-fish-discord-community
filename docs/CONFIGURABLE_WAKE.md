# Configurable wake phrases

Reviewed against public `main` commit `3c0cf811920dd1efd797cce6d3912192c7d89443`, on branch `feature/configurable-wake`. The latest upstream Feiyu credits/notices are retained. No private development commits were imported. Review assumes one bot process per settings file, the existing supported operating model.

## Interface

This applies to the multilingual **passive Whisper conversation** pipeline (`CONVERSATION_ENABLED=true`, `CONVERSATION_MODE=passive`). It uses the existing local transcription call with `language=auto`, `translate=false`. No training, extra transcription request, intent classifier, or additional DeepSeek call is introduced.

| Command | Effect |
| --- | --- |
| `/wake set phrase:小鲸鱼` | Set this guild's phrase; retain its mode |
| `/wake set phrase:Fat Fish` | English phrases are supported |
| `/wake mode mode:direct` | Require direct address; the default |
| `/wake mode mode:anywhere` | Also accept unquoted mentions within speech |
| `/wake show` | Show the current phrase and mode |
| `/wake reset` | Restore `大肥鱼` and `direct` |
| `/wake test phrase:Fat Fish, 停止音乐` | Test synthetic text against current settings; report reply/control/music/no match; execute nothing |

Discord requires a named option on the `mode` subcommand, hence `mode:direct`. Mutations require Discord **Administrator** permission or membership in the existing `CONVERSATION_OPERATOR_IDS` list. Manage Server permission alone is insufficient. Show/test are available to guild members; all replies are ephemeral with mentions disabled. DMs and other guilds are rejected. The current application still serves one configured guild per process; the store keys settings by guild, never by speaker or voice channel.

The `/wake` definition is registered alongside the other passive guild commands only when the existing `CONVERSATION_REGISTER_COMMANDS=true` switch is deliberately enabled. This implementation did not connect to Discord or register commands. Settings can be managed while disconnected from voice; changing them does not join a channel or enable transcription/paid inference.

## Matching rules and limits

Default phrase: **大肥鱼**. Default mode: **direct**. Changing the alias does not rename the assistant: persona files and the system identity remain `吃白饭的大肥鱼`.

| Synthetic transcript | Direct | Anywhere |
| --- | --- | --- |
| `小鲸鱼，你觉得呢？` | Reply | Reply |
| `Hey, Fat Fish, what do you think?` (English alias) | Reply | Reply |
| `小鲸鱼, what about 这个游戏?` | Reply | Reply |
| `我刚才看到小鲸鱼的视频` | Silent | Reply |
| `小鲸鱼的视频很有趣` | Silent | Reply |
| `“小鲸鱼，退出频道”` | Silent | Silent |
| `他说小鲸鱼，退出频道` | Silent | Reply; never a leave command |
| `小鲸鱼，停止音乐` | Local music control | Local music control |
| Ordinary speech without the configured alias | Silent | Silent |

Examples assume the matching Chinese or English alias has been selected. A bare matching phrase produces one reply and never opens a nameless follow-up window.

Matching is literal after Unicode NFKC normalization, case-insensitive English matching, whitespace collapse, zero-width mark removal, and spacing normalization between Han characters. The default retains its previous `大肥魚` and `吃白饭/飯的大肥鱼/魚` forms. Custom phrases do not acquire translations, homophones, spelling variants, or fuzzy matches. English portions have word boundaries, so `Fat Fishery` cannot invoke `Fat Fish`.

Direct mode accepts a phrase at the start, optionally after `嘿`, `喂`, `嗨`, `hey`, `hi`, or `hello`. Use punctuation/spacing before the request. Joined Chinese requests with common onsets such as `你`, `请`, `帮`, `介绍一下`, and `回答` also work, as do exact existing control/music commands (`大肥鱼停`, `小鲸鱼暂停音乐`). Leading possessives and common descriptive continuations (`的`, `是`, `is`, `was`, `said`, etc.) are treated as references. This is a conservative syntax rule, not semantic intent detection: punctuation can make a description resemble an address, and unusual punctuation-free requests can be missed. Use `/wake test` and a distinctive phrase to assess examples.

Quoted occurrences in straight quotes, Chinese quotes, book-title brackets, and backticks are excluded in both modes. An unmatched opening quote excludes subsequent text; ordinary English contractions are preserved. Anywhere mode intentionally allows third-person references outside quotes and therefore has more false positives. Only direct addresses enter the existing exact control/music parsers; mentions retain their full question context.

Bounds are enforced before normalization: transcripts at most 1,024 UTF-16 code units (and the listener's existing 4,096-byte bound); submitted phrases at most 64 units and normalized phrases at most 32. Phrases contain only Han characters, English A–Z letters and internal spaces. At least three letters/characters and a distinctiveness score of six are required (two per Han character, one per English letter), giving a minimum of three Chinese characters or six English letters. Mixed aliases use the same score. Empty, short, punctuation/regex/control-containing phrases are rejected. User text is never evaluated as code or accepted as a regex pattern; only validated letters/spaces form literal matching terms. Work is bounded by these small input limits.

## Persistence and privacy

Settings reside at `Luna-Discord-Bot-Full-Docker/Luna/data/wake-settings.json`, resolved relative to the application, not its working directory. It is a separate versioned JSON configuration file, outside persona files, SQLite memory, conversation history and transcript logs. Its only data is guild-to-phrase/mode settings. The existing `data/` Git ignore excludes it. Both supplied Compose profiles mount `/app/data` for persistence across container replacement; local runs retain the file across process restarts. Protect/back up that directory as operator configuration, and retain its mount if adapting deployment profiles.

Each update validates, writes a temporary file in the same directory, and atomically replaces the destination before changing the in-memory setting. A save failure retains the prior setting and reports failure. Missing storage starts with defaults; corrupt, unsupported, inaccessible or oversized storage prevents passive startup instead of silently changing the phrase. Storage is bounded to 128 guild records/64 KiB. Use one bot process per file; concurrent writers are unsupported. Manual file edits require a stopped process and restart. Atomic replacement protects against partial writes; it does not guarantee power-loss durability on every filesystem.

Existing version-1 saved settings are read without rewriting the file or replacing their modes. A saved `anywhere` record remains `anywhere`; a saved `direct` record remains `direct`; changing another guild does not change either. Defaults apply only to guilds without a saved record. The regression includes loading both modes in a fresh Node process and checking the original file bytes. An unsupported schema or a saved record with a missing mode causes a visible startup failure, never an implicit reset. Public main had no configurable wake-settings store before this feature; upgrades from its hardcoded mention behavior need an explicit `/wake mode mode:anywhere` choice if that behavior is desired. The new direct default and quote exclusion are intentional, documented changes.

A successful mutation cancels in-flight STT/replies/playback and clears temporary context, so speech admitted under the previous setting cannot later invoke under a new one. It does not reset paid request budgets, change persistent memory/consent, resume a paused listener, or alter opt-outs. The next Whisper request receives the current alias as its bounded hint. This hint can bias recognition; real microphone accuracy remains unmeasured.

Transcripts and LLM output cannot write this file or invoke slash commands. No wake configuration tool is exposed to the LLM. `/wake test` invokes neither Whisper nor DeepSeek and cannot stop music, leave voice, change settings or retain its input. Existing transcription consent, participant attribution, byte limits, cancellation, stale-job rejection, duplicate suppression and logging restrictions remain in place. The channel notice describes the effective phrase/mode and points to `/wake show`.

## Compatibility and local regression

The default phrase, default-name variants, exact addressed music/voice controls and character identity remain. **Behavior change:** passive third-person/quoted names no longer invoke by default. Select `anywhere` to restore unquoted mention invocation; quoted wake names stay excluded. Legacy `CONVERSATION_MODE=active`, the acoustic openWakeWord path, text summon commands and their existing follow-up behavior are unchanged; `/wake` is available only for the passive Whisper path.

Run from the Luna directory with the existing locked dependencies:

```powershell
node --test test/wake-*.test.js test/passive-*.test.js test/music-*.test.js test/whisper-privacy.test.js
node --test test/wake-*.test.js test/music-*.test.js test/passive-*.test.js test/whisper-privacy.test.js test/memory*.test.js test/phase2*.test.js test/unified-voice.test.js test/conversation-diagnostics.test.js test/v02-memory.test.js test/v03-*.test.js
node --test test/*.test.js
```

The new tests cover Chinese/English/mixed aliases, direct address, references, quotes, short phrases, normalization bounds, duplicate transcription, restart persistence, storage failure, guild/speaker isolation, permissions, inert tests, prompt/output configuration injection, cancellation, music commands, unchanged persona and the existing DeepSeek request cap. Existing music, memory, privacy and cancellation suites remain relevant.

Local verification on Node 24.13.0:

| Check | Result |
| --- | --- |
| Expanded focused wake/music/privacy/memory/conversation/dynamic-voice command above, including all 12 new wake tests | **200 passed, 0 failed**, no skips/cancellations |
| Full existing JavaScript suite plus wake tests | **502 passed, 8 failed** out of 510; no skips/cancellations |
| Untouched latest public main, complete JavaScript suite with the same dependencies/runtime | **490 passed, the identical 8 failed** out of 498; no skips/cancellations |
| Repository Python asset-policy test (`python -m unittest discover -s tests -v`) | **1 passed**; download fails before network/write without explicit asset opt-in |
| `git diff --check` | Passed |

All eight full-suite failures reproduce on untouched latest public main under the same runtime/dependencies: `config.test.js` expects an existing missing `LLM_PROVIDER` README table entry; `autojoin.test.js` expects a legacy autojoin log; `luna.test.js` expects a legacy moved-channel reply; five `integration-v0.test.js` cases fail joining their fixture before a connection exists (`setStatus` of undefined). Failure names and errors were compared, not assumed inherited from an old count. The older publication report lists seven; this runtime/main combination has the same seven plus the README/config assertion. They were not repaired, skipped or weakened as part of this feature. No additional feature-branch failure was found.

Dependencies are reused from an existing installation through process-local `NODE_PATH`; no lockfile or dependency changes are needed. The baseline was extracted with `git archive origin/main`, without private Git history. Tests use synthetic transcripts and fake Discord/DeepSeek/TTS transports. Loopback HTTP tests are local fixtures. No live Discord, paid inference, microphone evaluation, real model inference or service launch is part of this check.

## Public file review

All **16 changed/new files are appropriate for source publication** after removing the private local recording's fingerprint from the asset review. Paths beginning with `Luna/` below are relative to `Luna-Discord-Bot-Full-Docker/`; other paths are relative to the repository root.

| File | Public content / reason |
| --- | --- |
| `Luna/index.js` | Settings/command integration, notice, existing privacy/cancellation gates |
| `Luna/passive-listener.js` | Local activation matching; unchanged identity and exact control/music dispatch |
| `Luna/whisper.js` | Current phrase hint in the existing transcription call |
| `Luna/wake-settings.js` | Bounded validation/matching and separate atomic per-guild store |
| `Luna/wake-commands.js` | Slash definitions, Administrator/operator enforcement, inert local test |
| `Luna/test/harness.js` | Synthetic in-memory store for fake Discord integration |
| `Luna/test/music-commands.test.js` | Direct default and explicit-anywhere control regression |
| `Luna/test/passive-integration.test.js` | Explicit-anywhere integration regression |
| `Luna/test/passive-listener.test.js` | Direct/quoted/reference regression expectations |
| `Luna/test/wake-settings.test.js` | Synthetic phrases/guilds/users; real temporary-file/process persistence tests |
| `Luna/test/wake-integration.test.js` | Fake transports, authorization, cancellation, unchanged identity and request budget |
| `Luna-Discord-Bot-Full-Docker/docker-compose.yml` | Persistent local data-directory mount only |
| `Luna-Discord-Bot-Full-Docker/docker-compose.metal.yml` | Same local data-directory mount |
| `README.md` | Wake interface/default and links; latest upstream credits retained |
| `docs/CONFIGURABLE_WAKE.md` | Interface, compatibility, evidence, review and unexecuted manual protocol |
| `docs/VOICE_ASSET_RELEASE_REVIEW.md` | Sanitized public-package provenance/hashes and unresolved rights; no private recording fingerprint |

Existing release license notices, persona files, privileged command authorization, dependency manifests/locks, download opt-in and asset paths are unchanged. The diff contains no real Discord identifiers, credentials, private personal data, audio/model assets, runtime files or participant transcripts. Existing synthetic fixture identifiers come from public main. The only parent history is public community main; push scope is the feature branch only. Public main and this branch contain no Actions workflows; no Actions setting is changed. Source-branch publication/PR creation was authorized separately; no merge, deployment, Discord connection or paid inference is part of this review.

## Exact live microphone validation protocol (not executed)

These are future operator steps, not evidence of a live test. Run only in separately approved test guilds/channels with consenting participants, authorized external local Whisper/TTS assets and an authorized local music fixture. Do not use or publish the unresolved Feiyu references/weights as demo assets. Keep any private environment/IDs and validation notes outside Git.

1. Stop any bot process using this settings file. Privately record the prior `/wake show` result (if available) and back up `Luna/data/wake-settings.json` if it exists. Use the same checkout/data mount throughout. Configure `LLM_PROVIDER=deepseek`, `CONVERSATION_ENABLED=true`, `CONVERSATION_MODE=passive`, the approved test guild and operator IDs, `OWW_ENABLED=false`, the existing local multilingual `WHISPER_SERVER_URLS`, `DEEPSEEK_ENABLED=false`, `SEARCH_ENABLED=false`, `MEMORY_STORAGE_ENABLED=false`, and `CONVERSATION_DIAGNOSTIC=false`. Leave raw recording/transcript logging disabled. Keep paid keys absent. Set participant allowlists/consent policy as required by the installation.
2. After separate authorization to connect the test bot, start the existing local Whisper service using its installed configuration. Run `npm start` from `Luna-Discord-Bot-Full-Docker/Luna`. To register guild commands if needed, use the existing `CONVERSATION_REGISTER_COMMANDS=true` switch deliberately for that startup; return it to false for subsequent restarts. Do not enable Actions or deploy anything.
3. In Discord, use `/wake show`. With no saved record it must show `大肥鱼`/`direct`; with a saved record it must show that exact phrase/mode. Use `/join` in the approved voice channel and wait for the visible transcription notice and ready connection. Use `/status`; record only numeric `invocations`/`requestCount`, state and pass/fail, never participant IDs or transcript content in public notes. `requestCount` must remain **0** throughout this no-paid protocol. No generated conversational audio is expected with DeepSeek disabled.
4. Select `/wake set phrase:小鲸鱼` and `/wake mode mode:direct`. Before speaking, verify `/wake test` reports a match for `小鲸鱼，你觉得呢？` and no match for `我看到小鲸鱼的视频` and `“小鲸鱼，你觉得呢？”`. The test command itself must leave voice/music/state and the invocation/request counters unchanged.
5. Have participant A speak once per row below; wait until `/status` reports no pending/active STT before checking counters. Allow at least four seconds between repeated phrases to avoid the existing three-second duplicate window. A genuine addressed utterance increments `invocations` once; the other rows must not increment it. Repeat in a quiet channel and then with ordinary background conversation. Quote marks are text, not audible: for the quoted case say `他说“小鲸鱼，你觉得呢？”` and use `/wake test` for exact quote syntax; Whisper may omit quotes, which must be recorded as a recognition limitation rather than a claim of reliable quote detection from audio.

   | Speak | Direct-mode expected change in `invocations` |
   | --- | ---: |
   | `小鲸鱼，你觉得呢？` | +1 |
   | `小鲸鱼` (bare alias), then ordinary nameless speech | +1, then 0 |
   | `小鲸鱼, what about 这个游戏?` | +1 |
   | `我刚才看到小鲸鱼的视频` | 0 |
   | `小鲸鱼的视频很有趣` | 0 |
   | Ordinary speech without the alias | 0 |
   | The previous alias `大肥鱼，你觉得呢？` | 0 |

6. Change to `/wake set phrase:Silver Fish`, retain direct mode, and repeat with `Hey, Silver Fish, what do you think?` and `Silver Fish，你觉得呢？` (+1 each); `I saw Silver Fish` and `Silver Fishery` must remain silent. Have participant B give a different addressed question. Both participants should invoke; neither should cause another participant's speech to be attributed to them. The offline regression verifies exact speaker attribution without exposing live transcript data. Do not infer text accuracy from counters alone.
7. Set `/wake mode mode:anywhere`. Say `I was talking about Silver Fish` (+1); normal speech without the phrase remains 0. `/wake test phrase:They said Silver Fish, leave` must report a reply rather than a leave control. Unquoted mentions are deliberately allowed; quoted occurrences in synthetic text must still fail. Set a distinctive phrase before testing short forms; attempts to set `鱼`, `hi`, or `fish` must be rejected and `/wake show` must remain unchanged.
8. As an ordinary guild member who is neither Administrator nor configured operator, try `/wake set`, `/wake mode` and `/wake reset`: all must be denied with settings unchanged. Show/test remain ephemeral and inert. Verify an Administrator and then a configured operator can mutate. A stale `/wake` command in another guild must be denied. A speaker saying `/wake set phrase:...` must not change configuration.
9. Set `/wake mode mode:direct` with the current alias, use an authorized local music track and say `Silver Fish，暂停音乐`, `Silver Fish，继续播放`, `Silver Fish，下一首`, and `Silver Fish，停止音乐`. Verify only the existing music actions occur and `requestCount` stays 0. `Silver Fish，停` must use the existing speech interrupt control. `Silver Fish，暂停` must pause transcription; `/status` must show paused/zero subscriptions after capture closes. A wake-setting change must not resume it; only the existing authorized `/resume` flow may do so. Test `/opt-out` for participant B: their addressed speech must not be transcribed/invoke; `/opt-in` must re-notify before capture. `Silver Fish，退出频道` must leave without a paid request.
10. Save a custom phrase with `anywhere`, stop the bot process, and restart with the **same data directory**. `/wake show` must retain both, and an unquoted mention must still increment `invocations`. Repeat after saving `direct`: third-person speech must then remain silent across restart. Inspect the saved file privately; startup must not rewrite it. Do not delete/reset production settings to simulate a new installation.
11. For a live guild-isolation check, stop the process and switch only its private configured guild/operator values to a second approved test guild, retaining the same settings file. Its unsaved record must show `大肥鱼`/`direct`; save a distinct alias/mode there. Stop and switch back to the first guild: its original custom alias/mode must remain unchanged. Only one process may use this file. The offline store tests already verify this isolation without connecting to two guilds.
12. Restore the prior phrase/mode and private configuration deliberately (or restore the backup while stopped), then stop the test bot and any test-only local service. Keep all model/reference assets external. Record only pass/fail, numeric counters and observed recognition limitations. Do not upload audio or personal transcripts. Conversational response quality, audible identity and real reply-interruption quality remain outside this no-paid protocol; their deterministic routing/cancellation/identity checks are covered by synthetic tests.
