# Feiyu FIFO dispatch

Concurrent bounded-prefetch requests can reach Feiyu's single buffered worker out of sentence order. Playback correctly preserves sentence order, but must wait if the next required sentence is still synthesizing. The earlier research replay contained a 1,208.113 ms application gap: 1,159.554 ms waiting for response headers, 0.118 ms for handoff and 48.441 ms for media preparation. TTS completed in order 0→2→1; playback remained 0→1→2. That one REAL_LOCAL observation is separate from the distributions below. Exact server admission/lock timestamps were not available, so the precise location of the original admission reversal remains unverified.

## Production scope

Only `Luna-Discord-Bot-Full-Docker/Luna/tts.js` changes production behavior. The existing cancellation-aware FIFO limiter grants one Feiyu request at a time and releases at HTTP headers. This adapter returns a complete WAV after synthesis, so those headers mean its model job has finished. The next synthesis can still overlap earlier playback. The existing bounded prefetch window, voice `cute`, `stream: false`, request payload, cache key, normalization and fallback rules are preserved.

Queued cancellation removes work before dispatch. Active transport cancellation or failure releases the client slot. Existing generation checks still reject stale audio; the service still drains active cancelled inference while keeping its GPU slot. A cancelled request may therefore leave server work draining after the client slot is released. No worker/process, model weight, voice asset, Whisper/VAD, DeepSeek/Provider v0.5, memory, music coordinator or channel-switching code is changed.

The limiter is per TTS instance, not a reservation across applications. Other clients can still insert work. Waiting moves to a cancellable client queue with the existing Feiyu timeout; it does not make synthesis faster. Sending the next job after headers adds client/HTTP overhead between server jobs. The guarantee depends on Feiyu continuing to return buffered complete WAVs; a future streaming adapter would need a different release boundary.

No research profiler, runtime timing hooks or new logging are included. Existing diagnostics remain disabled by default. The offline fixture alone records at most 128 anonymous numeric timing events and caps its virtual timer loop at 100 steps. It prints no participant transcript, raw audio, credential or private Discord identifier.

## Identical deterministic fixture

`test/helpers/feiyu-replay.js` runs the actual TTS adapter, response delivery, bounded prefetch and playback queue with injected fake HTTP/model/player implementations. The three public Mandarin sentences are identical between baseline and patch. It validates the exact cute/buffered JSON request. There is no DeepSeek transport, Discord login, model inference or real audio decoding.

All times in this section are **SYNTHETIC supplied virtual time**, not local-model or Discord measurements. The single worker synthesizes sentence indices 0/1/2 for 1,400/2,000/1,300 ms. Sentence 1's network admission is delayed 10 ms. Player preparation is 40 ms and each spoken sentence lasts 2,000 ms.

| Code | Worker admission | Playback order | First inter-sentence gap |
| --- | --- | --- | ---: |
| Public main `c65ff823f11caef4fdf787750d894605918a1fa8` | 0→2→1 | 0→1→2 | 1,300 ms |
| Patched provider | 0→1→2 | 0→1→2 | 40 ms |
| Strict FIFO fixture control | 0→1→2 | 0→1→2 | 40 ms |

The patch still completes sentence 1 synthesis at 3,410 ms during sentence 0 playback (1,440–3,440 ms). A cancellation fixture at 1,600 ms lets the simulated worker drain its active job, destroys every returned late stream, never dispatches the queued third sentence, and never commits an interrupted answer.

**The deterministic 1,300 ms to 40 ms improvement does not establish better real-world median or client-audible latency.** Repeating a constructed timeline is a correctness/repeatability check, not a latency sample distribution.

## Previous local replay measurements: median and tail

These are **REAL_LOCAL archived results from the prior research task**, not rerun for this PR. The same three fixed sentences, existing warm Feiyu worker, real FFmpeg/Opus and a local AudioPlayer were used. A subscription stub and local no-subscriber playback clock replaced Discord transport; the LLM was a fixed answer. Ten responses per configuration yield 20 paired gaps, not 20 independent conversations. Small-sample p90 is exploratory (nearest rank); sigma is population standard deviation. No WAVs or participant recordings are included here.

| Configuration | Gap median | Gap p90 | Gap min–max | Gap sigma | Reordered completions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before: original bounded | 51.0 ms | 80.9 ms | 47.2–93.8 ms | 13.9 ms | 0/10 |
| Before: strict ordered control | 55.3 ms | 98.1 ms | 47.0–105.8 ms | 18.7 ms | 0/10 |
| After: FIFO provider, bounded prefetch | 52.2 ms | 100.5 ms | 48.0–101.8 ms | 22.2 ms | 0/10 |
| After: FIFO provider plus ordered control | 52.1 ms | 90.9 ms | 47.5–93.6 ms | 16.9 ms | 0/10 |

The fresh before sample did not naturally repeat the earlier rare inversion. Median gaps did not improve (51.0→52.2 ms), and tail estimates did not improve either. Do not splice the separate 1,208 ms observation into this before distribution. The repair prevents the demonstrated admission-order condition; these small local samples do not prove fewer live stalls, faster normal conversation or better audible onset. Exact live server queue spans, client jitter buffers and perceived voice quality were not tested. Audio-generation settings remain unchanged; this is not a claim of measured perceptual equivalence.

## Offline reproduction and focused validation

From repository root, with Node 22.12+:

```sh
node Luna-Discord-Bot-Full-Docker/Luna/test/helpers/feiyu-replay.js
git worktree add --detach ../fat-fish-fifo-baseline c65ff823f11caef4fdf787750d894605918a1fa8
node Luna-Discord-Bot-Full-Docker/Luna/test/helpers/feiyu-replay.js ../fat-fish-fifo-baseline/Luna-Discord-Bot-Full-Docker/Luna/tts.js
```

Both commands use the same helper and fixtures. The second selects the exact unchanged public-main adapter rather than a handcrafted baseline. The helper needs only Node standard-library and repository modules; it cannot contact a real service through its injected fetch. Existing project dependencies are needed for some integration tests:

```sh
cd Luna-Discord-Bot-Full-Docker/Luna
node --test test/feiyu-scheduling.test.js test/feiyu.test.js test/tts.test.js test/phase1-integration.test.js test/music-integration.test.js test/v03-voice-session.test.js test/v03-dynamic-voice.test.js test/conversation-diagnostics.test.js test/llm-provider-contract.test.js
```

The focused checks cover queued/active cancellation, failure slot release, stale audio, sentence ordering, prefetch overlap, delivery commit, exact voice request, music/speech subscription ownership, channel invalidation, diagnostics default-off/privacy and the existing provider interface. The unchanged Python fake-worker tests verify worker reuse after cancellation and retention of the queue slot while a fake job drains. They create only test workers, never load or restart GPU models. No broad test suite or real API, Discord, model-service or deployment action is needed to validate this PR.
