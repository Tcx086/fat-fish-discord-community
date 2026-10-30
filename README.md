# Fat Fish Discord — v0.4.0-alpha

An independent Discord voice/text assistant derived from
[smakus/Luna](https://github.com/smakus/luna-discord-ai-voice-chatbot).
It combines local speech recognition, optional DeepSeek text inference, optional
local speech synthesis, scoped memory and an authorized local music catalog.
It is unofficial and is not endorsed by Discord, DeepSeek or upstream authors.

**Source-only alpha candidate, prepared locally. Public release is not authorized.**
This is experimental software, with no turnkey model bundle or production-readiness
claim. See [the publication gate](docs/PUBLICATION_GATE.md) for exact validation
and owner actions.

## Features and limits

| Feature | Scope |
| --- | --- |
| Voice lifecycle | Join/move/leave, pause/resume/stop, cancellation and session isolation; one guild/voice session per process. Real Opus/DAVE loading is tested offline. |
| Mandarin invocation | Local Whisper transcribes eligible speech before name matching. A mention or quotation containing 大肥鱼 can trigger a reply. |
| DeepSeek | Bounded streaming text responses and cancellation; disabled in the inert example. Enabled requests transmit text/context externally and may incur charges. |
| Memory/text | Optional SQLite consent, review, recall, export/deletion; local CLI and allowlisted ephemeral `/fish` text. Persistence defaults off. |
| Search | Optional bounded Search/Fetch and synthesis. Sources and model claims can be wrong; no freshness guarantee. |
| Music | Local file catalog, queue and speech/music coordination. No songs, downloader or streaming service integration supplied. |
| TTS | Feiyu HTTP adapter and synthetic service tests. GPU runtime, models and reference voices must be obtained separately with appropriate permission. |
| Legacy/experimental | ONNX wake inference, alternate TTS, WeChat/WeCom and Windows launch helpers have separate limitations. They are not a supported turnkey stack. |

## Install and verify independently

Obtain an approved source archive/checkout. You do not need the private repository,
its environments, credentials or models to install Node dependencies and run offline
checks. Requirements: Node >=22.12.0 (use a currently patched supported release),
npm, and FFmpeg/FFprobe on PATH. Native Opus may require Python and a C++ toolchain.

```sh
cd Luna-Discord-Bot-Full-Docker/Luna
npm ci --ignore-scripts --no-audit --no-fund
npm rebuild @discordjs/opus --no-audit --no-fund
node --test test/publication-dependencies.test.js test/phase0-native.test.js
npm run test:v02
npm run test:v03
npm run test:music
```

The install above uses public package sources and deliberately skips the ONNX
installer. Native packages/binaries are software dependencies, not model weights.
No credentials or model assets are required for these checks. Use
[INSTALLATION.md](docs/INSTALLATION.md) for platform prerequisites, synthetic Python
checks, external assets and deliberate configuration. Do not use `npm start` or
launchers as installation tests: they can connect to Discord and start services.

The [dependency review](docs/DEPENDENCY_SECURITY_REVIEW.md) covers each of the
11 previously affected npm packages and 40 advisories. The fresh fixed-lock audit
has zero findings; this does not certify native binaries, Python, OS or Node itself.
The full Node suite still has seven inherited failures, recorded separately in
the gate. Models, GPU inference and live Discord/music were not tested here.

## Privacy and configuration

Start with `fat-fish.env.example`; enable flags and persistence remain off.
Keep `LLM_PROVIDER=deepseek`; inference remains off until explicitly enabled.
Supply your own credentials only in the environment or ignored `.env`, then review
the effective configuration. Use explicit participant/operator allowlists and
`CONVERSATION_ALL_PARTICIPANTS=false`. Keep `OWW_ENABLED=false`, `LLM_TOOLS=false`
and `WAKE_LOG_FILE=` until separately reviewed.

Give participants notice and obtain appropriate agreement before transcription or
external text processing. Memory consent is separate from temporary transcription.
`/opt-out` is runtime-only and does not survive restart. SQLite encryption,
retention, backups and provider-side deletion are operator responsibilities.
The Windows launcher uses all-participant mode; use the manual profile when an
explicit transcription allowlist is required. See [PRIVACY.md](PRIVACY.md).

## Assets, attribution and contributions

No model weights, reference voices, recordings, music, artwork or character likeness
are included. The generic text identity grants no third-party asset rights.
Feiyu fine-tunes/references and wake models have separate terms. Legacy acquisition
entry points require explicit asset opt-in; that opt-in does not grant permission.

Luna's **Copyright (c) 2026 smakus** and [MIT license](LICENSE) are preserved.
The adapted openWakeWord implementation also retains **Copyright 2022 David Scripka**,
Apache-2.0 and a modification notice. Read [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Contributions should use synthetic fixtures, preserve attribution, identify borrowed
source/licenses and report focused test results. See [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md), [architecture](docs/ARCHITECTURE.md) and
[draft release notes](docs/RELEASE_NOTES_v0.4.0-alpha.md).
GitHub Private Vulnerability Reporting is preferred but **OWNER_ACTION_REQUIRED**;
it is not claimed to be enabled, and no security email is supplied.
