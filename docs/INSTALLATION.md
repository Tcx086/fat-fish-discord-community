# Installation and configuration

This is a source-only v0.4.0-alpha, not a turnkey bot or licensed voice bundle.
No original private checkout, private credentials or private model assets are
required for the Node install and offline tests below. Full GPU/OS/container setup
and live Discord operation have not been validated by this preparation.

## Prerequisites

- Node >=22.12.0 and npm. Use a currently patched supported Node release; the test
  host's Node 24.13.0/npm 11.6.2 is recorded evidence, not a security recommendation.
  The exact minimum and other platforms are not certified.
- FFmpeg/FFprobe on PATH for synthetic audio checks. Their license depends on the
  installed build; no binaries are included in this source distribution.
- Native Opus: a platform-compatible prebuilt binary or Python/C++ build tools.
  On Windows, install a supported Visual Studio Build Tools C++ workload and Python
  if a prebuilt is unavailable. This host built Opus locally after a prebuilt 404.
- Python 3.11 for optional synthetic service tests. GPU inference needs a separate
  environment and authorized assets; it is not needed for those tests.

## Credential-free Node install and tests

Extract an approved archive or use an approved checkout. Leave `.env` absent and
remove application credentials/enable flags from the test process environment.
From the source root:

```sh
cd Luna-Discord-Bot-Full-Docker/Luna
npm ci --ignore-scripts --no-audit --no-fund
npm rebuild @discordjs/opus --no-audit --no-fund
node --test test/publication-dependencies.test.js test/phase0-native.test.js
npm run test:v02
npm run test:v03
npm run test:music
npm run test:integration
npm test
```

The first command deliberately skips lifecycle scripts. The second enables only
Opus installation, which may download public native software or compile it; it
does not obtain models or voices. ONNX native setup/inference is optional and is
not demonstrated by this path. The last two suites include inherited failures;
see [exact results](PUBLICATION_GATE.md). No Discord login or paid API is needed.
Use the reviewed lockfile/overrides; do not run `npm audit fix --force`.

The local preparation used empty npm user/global configuration, public registry
requests and a new dependency tree/cache. Existing compilers, Node, Python and
FFmpeg were on the host: this is not a clean-OS certification.

## Synthetic Python tests

Use an isolated Python 3.11 venv. The reviewed synthetic test environment used
FastAPI 0.115.6, HTTPX 0.28.1, NumPy 1.26.4, SoundFile 0.12.1 and Uvicorn 0.34.0.
Those historical test pins are not a deployment security recommendation or a
complete GPU stack. No weights or running model service are needed.

```sh
python -m unittest discover -s tests -p test_asset_policy.py -v
python -m unittest discover -s Luna-Discord-Bot-Full-Docker/FeiyuTTS -p test_engine.py -v
python -m unittest discover -s Luna-Discord-Bot-Full-Docker/Qwen3TTS -p test_cuda_voice.py -v
```

The first test uses only the standard library; the others need the small HTTP/audio
test dependencies above and FFmpeg. `FeiyuTTS/requirements-lock.wsl.txt` is a
historical GPU environment inventory, not a portable or hash-locked installer.
Do not install all GPU requirements merely to run offline source checks.

## External assets — intentionally absent

| Component | External prerequisite and boundary |
| --- | --- |
| STT | Independently obtained whisper.cpp server and a licensed compatible multilingual GGML model for Mandarin. `run-whisper-cuda.ps1` accepts explicit binary/model paths and validates its expected model hash. Its supported asset revision/hash are in that script. The passive Compose profile expects an existing image and explicit model mount. |
| Feiyu | Python 3.11/CUDA PyTorch, CosyVoice source at `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc`, submodules, and separately authorized fine-tune/reference package. Package revision `f37e9d1dda26e8b45b4e9f1b4c347c0a07b797e2` identifies compatibility, not redistribution permission. See the component README and THIRD_PARTY_NOTICES. |
| Wake inference | Separate ONNX feature/classifier models and their exact terms; keep `OWW_ENABLED=false` without them. Code's Apache license does not license weights. |
| Alternate TTS/music/art | Independently cleared models, voices, local music and artwork. None supplied, and optional experimental integrations are not production validated. |

Feiyu runs only from separately prepared local assets. Its WSL helpers use
`FEIYU_RUNTIME_DIR`, defaulting to `XDG_DATA_HOME/feiyu-cute` or the current user's
`.local/share/feiyu-cute`; `FEIYU_MODEL_DIR` selects the authorized local package.
The Windows helper assumes WSL distribution Ubuntu. These are adaptable helpers,
not validated cross-platform installers.

Acquisition-capable legacy TTS/Metal scripts and `FeiyuTTS/download.py` fail closed
unless `ALLOW_EXTERNAL_ASSETS=true` is explicitly set. Legacy Whisper/Kokoro Docker
builds require `--build-arg ALLOW_EXTERNAL_ASSETS=true`. Alternate Python model
loaders also require the flag. Setting it acknowledges a deliberate operation; it
does not grant licenses, permission to clone a voice, or approval for any download.
Do not run these until rights, source integrity and resource use are reviewed.
No models were acquired during this preparation.

## Deliberate runtime configuration

Copy `fat-fish.env.example` to ignored `.env` only when preparing your own deployment.
Supply your own Discord application/token and guild/participant/operator IDs.
Start with all enable flags off, `CONVERSATION_ALL_PARTICIPANTS=false`,
`OWW_ENABLED=false`, `LLM_TOOLS=false`, `WAKE_LOG_FILE=` and no autojoin.
Credentials in the process environment override `.env`; review both.

Obtain participant agreement and publish the operator's privacy/deletion details
before enabling transcription. Memory consent is separate. Configure DeepSeek only
with explicit external-transmission/cost approval; process limits reset at restart.
Persistent memory also needs encrypted storage, real operator policy and consent.
Music needs an authorized local catalog. Do not concatenate conflicting examples.

`npm start`, diagnostics and `Start-FatFish.cmd` are operational entry points that
can connect Discord or start local services. They were not run here. The Windows
launcher forces all-participant mode: use the manual profile for explicit allowlists.
Keep services on loopback. Read [PRIVACY](../PRIVACY.md), [SECURITY](../SECURITY.md)
and [deployment boundaries](DEPLOYMENT.md) before any separately authorized launch.
