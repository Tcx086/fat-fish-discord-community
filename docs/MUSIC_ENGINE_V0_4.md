# Fat Fish Discord v0.4 — Music Playback Engine

Status: **MUSIC_PLAYER_IMPLEMENTED_LIVE_PENDING**. No real Discord playback is claimed.

## Repository and scope


Only authorized local file playback is implemented. No music generation, AI singing, cloning, lyric synthesis, model installation, downloader, streaming-service extraction, DRM bypass or audio history was added.

## Architecture and audio ownership

`music-catalog.js` validates an operator-managed JSON registry and opens approved files. `music-engine.js` owns one process-wide FIFO queue, current decoder, resource, player and state machine. `audio-coordinator.js` owns the subscription to the **existing** Discord voice connection. `music-commands.js` handles authenticated slash controls and deterministic wake-stripped voice intent. There is no second bot or voice connection.

The existing `voice-session.js` remains the authority for joining, moving, generation changes and disconnecting. `voice-playback.js` retains ownership of speech generation, sentence queues, cancellation and speech resources. It acquires the coordinator's speech output instead of directly subscribing when music is enabled. `passive-listener.js` acquires a speech hold before preparing an accepted conversational request, and releases it in `finally`, including failed or canceled requests. This covers generation, Feiyu synthesis and every spoken sentence, avoiding music between sentences.

The coordinator pauses the music player and removes its subscription before speech subscribes. Once all speech holds are released, it re-subscribes and resumes the **same** music resource and FFmpeg process. Manual music pause remains in effect. A new speech player cannot steal another speech player's output. This is exclusive output ownership, not mixing; see the [Discord AudioPlayer API](https://discord.js.org/docs/packages/voice/0.19.0/AudioPlayer:Class) for pause/resume and resource destruction semantics.

Speech interruption cancels the existing speech generation through the existing playback mechanism. The hold releases safely, resuming music unless the user paused or stopped it. Overlapping holds are reference-counted. Session reset invalidates all old holds before stopping speech; their late cleanup cannot subscribe in the new channel. A command issued during speech can stop music immediately, or enqueue music that waits until speech finishes.

Music is separate from the speech `busy` flag, receiver subscriptions, local Whisper, privacy notices and wake-name detection. No changes were needed in `tts.js` or `conversation-core.js`. Existing memory retrieval and the low-latency Feiyu pipeline remain intact.

Legacy `commands.js`/Smakbot parsers remain for compatibility when the new engine is disabled. They are not used to control the new engine. When enabled, outgoing Smakbot commands and the legacy model-tool server are disabled, and `now-playing.js` reads the internal engine without calling Smakbot's status API. Legacy top-song history returns an empty list; no play-history database is created. The supported v0.4 voice-command path is the v0.3 passive listener, not the legacy English Luna command path.

## Sources, catalog, metadata and security

Default library directory: `<home>/Music/FatFish`, outside the checkout. Default catalog: `catalog.json` in that directory. Operators can set `MUSIC_DIRECTORY` and `MUSIC_CATALOG`; Discord callers cannot provide paths or URLs.

Example entry:

```json
{
  "id": "tone-440",
  "title": "测试音 440 Hz",
  "artist": "Fat Fish synthetic fixture",
  "file": "tone-440.wav",
  "authorized": true
}
```

`authorized: true` is an operator assertion that playback rights cover the intended Discord channel; it does not confer a license. Register only files you may use there. Do not commit commercial tracks. Audio extensions remain ignored by Git. The included example generator creates short synthetic test tones, dedicated to the public domain under CC0-1.0, and refuses to overwrite existing files.

Validation:

- Catalog: at most 256 KiB and 500 entries; atomic load with no partial library on failure, 60-second total validation deadline. IDs are unique ASCII identifiers; titles are unique after Unicode normalization. ID/title ambiguity is rejected.
- Title and artist: required, bounded to 100 characters, no control or angle-bracket characters. Artist/title come from validated registration, never guessed from filenames or synthesized by a model.
- Files: MP3, FLAC, WAV or OGG only. Relative paths, no `..`, absolute paths, drive/alternate-stream syntax, backslashes or empty path segments. Canonical paths must remain inside the canonical library, including junction/symlink checks. Regular nonempty files only; default maximum 100 MiB, configurable up to 500 MiB.
- FFprobe checks actual audio streams and positive finite duration, capped by default at 900 seconds (maximum configurable 3600). Each probe has a 10-second timeout and 64 KiB output bound. Files are revalidated before each playback. Missing/replaced/unreadable files become recoverable track errors.
- The engine passes an already opened file stream into FFmpeg's stdin with an explicit audio demuxer and pipe-only protocol whitelist. FFprobe permits only file/pipe protocols with that same explicit demuxer. No shell is involved, no URLs or playlists are accepted. Decoder output also has a duration cap.
- Keep the library and configured executable locations writable only by the operator. Canonical paths, an open handle and identity/size/mtime checks protect Discord's boundary; this is not a sandbox against a local administrator concurrently rewriting the media or replacing the approved root.

Current metadata exposes title, artist, measured duration, consumed-audio elapsed time, status, requesting user ID and upcoming tracks. Elapsed time is approximate to Opus frames, remains fixed while paused, and is not a seek guarantee. Queue/requester metadata exists only in RAM and is cleared on stop/reset. Logs contain state and generic errors, not participant identities or filenames.

## Commands and authorization

Guild-only registration occurs at startup only when `MUSIC_ENABLED=true` and either `MUSIC_REGISTER_COMMANDS=true` or existing `CONVERSATION_REGISTER_COMMANDS=true`. No global commands are registered. The server defaults to `CONVERSATION_GUILD_ID`, with an explicit `MUSIC_GUILD_ID` override available.

| Command | Behavior |
| --- | --- |
| `/music play track:<name>` | Append a registered exact title or ID; autocomplete offers up to 25 entries. |
| `/music pause` | Pause only music, retaining position. |
| `/music resume` | Clear manual pause; wait if speech still owns output. |
| `/music skip` | Cancel current loading/decoding/playback and advance in FIFO order. |
| `/music stop` | Stop music and clear its queue; keep voice and assistant active. |
| `/music queue` | Current status and first 10 upcoming titles, with total count. |
| `/music now-playing` | Internal title, artist, elapsed/duration, state and volume. |
| `/music volume level:0–100` | Set inline music volume, including mute at zero. |

Commands and autocomplete require the configured guild, a ready authorized session, actual membership in its current voice channel, existing participant/operator eligibility, and relevant channel permissions. Even an operator in an unrelated channel cannot remotely control this queue. Ignored users and bots cannot control it. Slash replies are private and disable mentions. `/stop` and `/leave` retain their emergency/session behavior.

Supported directly addressed phrases include:

| Phrase | Effect |
| --- | --- |
| 大肥鱼，放首歌 | Queue the first catalog entry, deterministically. |
| 大肥鱼，播放晴天 | Resolve only that registered title; otherwise explain it is not in the authorized library. |
| 大肥鱼，下一首 | Skip. |
| 大肥鱼，暂停音乐 | Pause music. |
| 大肥鱼，继续播放 | Resume music. |
| 大肥鱼，停止音乐 | Stop music and clear queue. |
| 大肥鱼，现在放的是什么歌？ / 大肥鱼，这是什么歌？ | Read current metadata. |
| 大肥鱼，音乐队列 | Inspect queue. |

Music intent requires a direct name invocation at the beginning (with existing greeting/name variants). Background speech and indirect mentions cannot trigger privileged music actions. Existing indirect-name conversational behavior is preserved. Music intent is handled before conversation preparation or DeepSeek. Duplicate transcripts, stale STT, revoked participants and old generations cannot enqueue tracks. Music commands bypass a running response and an older pending STT job. No LLM executes music actions.

Control acknowledgments are posted in the active session's text channel; now-playing also uses the existing optional speech renderer. Failure/unavailability of TTS does not prevent playback or text controls. `/pause` or “大肥鱼，暂停” controls transcription; “大肥鱼，别说了” controls speech; “停止音乐” controls music; “退出频道” disconnects. These remain separate.

## Queue, states and lifecycle

States are `IDLE`, `LOADING`, `PLAYING`, `PAUSED`, `INTERRUPTED_FOR_SPEECH`, `STOPPING`, `ERROR`. Changes emit `events` → `state` with previous/new state. Natural completion emits `completed`; validation, decoder, player and watchdog failures emit `trackError` and briefly transition through `ERROR` before advancing or returning idle. `snapshot()` exposes state, volume, current metadata, elapsed time, upcoming queue and last generic error.

The default queue limit is 20 entries **including the current track** (configurable 1–100). Requests reserve their FIFO position synchronously before asynchronous validation. Manual pause is preserved across skip; resume or stop clears it. A stopped queue is not restored by an old speech hold. Stop during loading aborts FFprobe; late file handles are closed. Stop during decoding closes streams, stops the player, cancels its watchdog and kills FFmpeg. A nonpaused stream with no progress for 15 seconds fails safely. Playback exceeding validated duration plus two seconds also fails.

Joining leaves music idle. Moving, leaving, unauthorized dragging, connection recovery/signalling, disconnect, destruction and process shutdown clear the queue and all pending music. Reconnecting binds an empty engine; it never automatically replays old-channel audio. Late decoder/player callbacks are checked against the owning item, and old speech releases against a coordinator epoch. State cleanup does not depend on DeepSeek finishing.

## Resource usage

No new npm dependencies or models. At steady state there is one FFmpeg decoder and one music AudioPlayer/resource; FFprobe runs during catalog validation or track opening. The decoder remains alive during pause and is backpressured by bounded Node/Opus stream buffers rather than collecting an entire track. PCM is 48 kHz, stereo, 16-bit: 192,000 bytes per audio second flowing through the pipeline. Catalog/queue limits bound metadata. One unreferenced one-second watchdog exists for the current item. Old children may briefly be reaping while the next starts; they are killed on cancellation, and process errors/stream errors are handled.

Exact CPU/RSS and acoustic wake-name reliability in a real music-filled Discord channel have not been measured. No echo cancellation, simultaneous mixing, seeking, persisted queues, repeat/shuffle, or authorized network streaming provider is included.

## Exact local setup

From the checkout's `Luna-Discord-Bot-Full-Docker/Luna` directory, with the project's existing dependencies, Node >=22.12, native Opus, FFmpeg and FFprobe available:

```powershell
node --version
ffmpeg -version
ffprobe -version
npm run music:example
npm run test:music
```

`music:example` writes `tone-440.wav` (2 seconds), `tone-660.wav` (3 seconds) and `catalog.json` into `$HOME/Music/FatFish`. It makes no network connections. For another empty directory, use `node scripts/create-music-example.js 'E:/authorized-music'`, then configure that path. The tests use temporary synthetic files and clean them up; they never load the operator's private `.env` or real library and never log into Discord.

Append settings from `music.env.example` to the existing private `.env`, preserving all v0.3 voice, privacy, memory and Feiyu configuration:

```dotenv
MUSIC_ENABLED=true
# Existing CONVERSATION_GUILD_ID selects the server; otherwise set MUSIC_GUILD_ID.
# MUSIC_DIRECTORY=E:/authorized-music
# MUSIC_CATALOG=E:/authorized-music/catalog.json
MUSIC_FFMPEG=ffmpeg
MUSIC_FFPROBE=ffprobe
MUSIC_MAX_QUEUE=20
MUSIC_MAX_FILE_MB=100
MUSIC_MAX_DURATION_SECONDS=900
MUSIC_VOLUME=30
MUSIC_REGISTER_COMMANDS=false
```

The directory/catalog overrides are unnecessary for the default example. Use absolute executable paths if FFmpeg/FFprobe are not on PATH. Restart to reload a changed catalog. An invalid catalog leaves an empty library and logs an operator-facing diagnostic; it does not terminate the assistant.

For playback without DeepSeek access, retain `LLM_PROVIDER=deepseek` and set `DEEPSEEK_ENABLED=false`; no API key is required for music. Slash music needs no STT or TTS. Spoken commands use the already configured local Whisper and passive mode. Only actual conversational replies require an enabled DeepSeek pipeline.

Do **not** run `npm start` as part of offline setup/verification: it logs into Discord. Only after separate authorization, set `MUSIC_REGISTER_COMMANDS=true` for a controlled startup with the existing Discord credentials, run `npm start`, and use existing `/join`. Disable the registration flag after registration if desired.

## Files changed

Paths below are relative to `Luna-Discord-Bot-Full-Docker/Luna` unless otherwise stated.

- Added runtime modules: `music-catalog.js`, `music-engine.js`, `audio-coordinator.js`, `music-commands.js`.
- Modified integration: `index.js`, `voice-session.js`, `voice-playback.js`, `passive-listener.js`, `now-playing.js`.
- Added examples/config: `examples/music-catalog.json`, `scripts/create-music-example.js`, `music.env.example`; added `test:music` and `music:example` scripts to `package.json`.
- Added tests: `test/music-catalog.test.js`, `test/music-engine.test.js`, `test/music-commands.test.js`, `test/music-integration.test.js`, `test/music-fixture.js`; extended `test/harness.js` with explicit local module injections and music state exposure.
- Added this repository-root document: `docs/MUSIC_ENGINE_V0_4.md`.

No package-lock/dependency changes, binary audio assets, changes to memory logic or speech provider configuration.

## Offline verification results

Validation date: 2026-10-30, Windows, Node v24.13.0. Results are offline, not evidence of live Discord audio.

- `npm run test:music`: **30 passed, 0 failed**. Covers catalog validation/traversal/junction escapes/metadata/limits, FIFO/bounds/concurrency, pause/resume/volume, invalid tracks, permissions/autocomplete, completion, FFmpeg errors and cancellation, stalled decoding, speech ownership/resumption, cancellation/failure, explicit stop, channel moves/disconnect/drag, stale audio/transcripts, deterministic voice commands and zero unintended DeepSeek/status-service calls.
- Native test runs actual FFprobe, FFmpeg and installed Opus encoding: a one-second synthetic WAV produces 50 Opus packets. Example creation and non-overwrite behavior are checked. This does not send packets to Discord.
- Application replay runs the real passive listener and Feiyu adapter with mocked network/audio responses. It confirms music position and decoder identity survive a response and incoming subscriptions remain active. DeepSeek-disabled replay confirms music requires neither conversational API calls nor synthesis.
- Full suite before the final added edge-case tests: **484 passed, 7 failed, 491 total**. The same 7 failures reproduce in a separate clean worktree at the unchanged baseline `eecf1f7`: `autojoin.test.js` (legacy auto-resume expectation), `luna.test.js` (legacy “Moved” vs “Joined” response), and all 5 `integration-v0.test.js` cases (old operator join fixture has no connection). These were not changed as part of music work.
- Final regression run excluding only those three baseline-failing files: **487 passed, 0 failed**, including all 30 music tests, v0.3 channel/session tests, passive listener, Feiyu/native voice, Memory Engine and v0.2 tests. `git diff --check` also passed.

Reproduce the final regression selection in PowerShell:

```powershell
$musicRegressionFiles = @(rg --files test -g '*.test.js' | Where-Object { $_ -notmatch '(autojoin|luna|integration-v0)\.test\.js$' })
node --test @musicRegressionFiles
```

The baseline comparison worktree is `<local-workspace>`; test logs are ignored local artifacts, not committed data. Relevant logs: `music-full-tests.log`, `music-regressions.log`, and baseline `baseline-music-tests.log` in their respective Luna directories.

## Controlled Discord live validation plan — separate authorization required

1. Obtain authorization for the existing bot, one test guild/channel and consenting participants. Use only synthetic tones or operator-licensed files. Start with DeepSeek disabled and low music volume; keep the existing privacy notice and operator controls.
2. Enable guild-only command registration for the controlled startup. Verify the eight subcommands/autocomplete. Join through the existing authorized `/join`; confirm it stays silent until `/music play`.
3. Queue two authorized tracks. Verify audible order, one output connection, metadata/elapsed, volume 0/30/100, pause/resume position, skip, completion and music-only stop. Test unavailable titles and wrong-guild/off-channel callers, including an off-channel operator.
4. Exercise the listed directly addressed voice phrases. Ordinary conversation and unnamed background speech must not control music. Test now-playing when idle and while paused. Check that transcription pause, speech interruption and music stop remain independent.
5. Only with separately authorized conversational API usage, enable the existing DeepSeek/Feiyu pipeline. Play a longer licensed track, call 大肥鱼, confirm music pauses before speech and resumes at its prior position without overlapping audio or restarting FFmpeg. Repeat with a second invocation, `/interrupt`, synthesis failure and generation failure.
6. During generation and speech, issue `/music stop`, `/stop`, `/leave`, `/move`; also test a disconnect and unauthorized drag. Confirm no old queue or late speech reaches the destination and no automatic resume occurs. A new explicit play after a recovered session should work.
7. Repeat play/skip/stop and join/move/leave cycles. Observe FFmpeg processes, open handles, receiver subscriptions, state-only logs and memory behavior; ensure resources return to baseline. Verify wake detection at realistic music volume and speaker/headphone conditions. Record audible behavior and measured CPU/RSS separately.
8. Stop and disconnect after validation. Keep `LIVE_PENDING` until that authorized test has actually run; do not infer live success from offline packet encoding or mocks.
