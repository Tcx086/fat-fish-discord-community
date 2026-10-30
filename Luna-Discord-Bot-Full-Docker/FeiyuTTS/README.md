# Feiyu local TTS adapter

This source-only adapter supplies no weights, voice reference, character image or
model license grant. Read [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md) and
[installation](../../docs/INSTALLATION.md). Publisher compatibility references:
Feiyu package `f37e9d1dda26e8b45b4e9f1b4c347c0a07b797e2` and CosyVoice source
`074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc`. Compatibility does not establish reuse
rights for a fine-tune, reference voice or character.

The adapter expects authorized local assets, a compatible CUDA GPU/PyTorch stack,
Python 3.11, CosyVoice/submodules and its dependencies. `setup-wsl.sh` prepares
external software dependencies; it is not a tested portable installer. Set
`FEIYU_RUNTIME_DIR` for the source/venv directory and `FEIYU_MODEL_DIR` for the
authorized asset package. Defaults use the current user's data directory.
No private original environment is required or copied by the source release.

`download.py` requires `ALLOW_EXTERNAL_ASSETS=true` before any network operation.
Do not opt in until authorized and the exact package terms are reviewed. No model
or reference was downloaded for publication preparation. Runtime inference sets
offline model flags and checks manifest-selected checkpoint/reference hashes.

With separately prepared assets, `run-wsl.sh` starts a loopback service on port
18882. `POST /v1/audio/speech` accepts input text, voice `cute` and `stream:false`.
Output is buffered PCM16 WAV, with native speed 1.2 for complete sentences.
Luna uses `TTS_PROVIDER=feiyu`, a loopback `FEIYU_TTS_URL`, and `TTS_FALLBACK=none`.
Unavailable synthesis stays silent. No service was started in this preparation.

The bounded FIFO retains the worker while cancelled synthesis drains; playback
cancellation does not guarantee immediate GPU availability. Faults/timeouts can
require model reload. Streaming and optional denoising remain experimental; do
not infer quality or real Discord latency from synthetic tests.

`test_engine.py` uses synthetic workers and audio, without models or Discord.
The shared Qwen `test_cuda_voice.py` tests HTTP/queue/PCM behavior separately.
See the publication gate for fresh results and unverified GPU/runtime limitations.
