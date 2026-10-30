# Third-party notices

This is a source-only distribution. The root [MIT license](LICENSE) preserves
`Copyright (c) 2026 smakus`. It is not a license for every dependency, model,
voice, character, song or generated output. No new copyright owner is asserted here.
Fat Fish is an independent, unofficial project; attribution does not imply endorsement.

## Derived and adapted source

| Component and affected files | Origin and terms | Treatment |
| --- | --- | --- |
| Original bot, voice transport, TTS adapters, tools, tests and Docker scaffolding under `Luna-Discord-Bot-Full-Docker/`; `docs/UPSTREAM_GUIDE.md` | [smakus/Luna](https://github.com/smakus/luna-discord-ai-voice-chatbot), [MIT](https://github.com/smakus/luna-discord-ai-voice-chatbot/blob/main/LICENSE), copyright 2026 smakus | Retain root LICENSE in copies/substantial portions. Existing source has local modifications. The file inventory distinguishes unchanged, modified and added files. |
| `Luna-Discord-Bot-Full-Docker/Luna/wakeword.js` | JavaScript port/reimplementation of `openwakeword.utils.AudioFeatures._streaming_features`, [openWakeWord](https://github.com/dscripka/openWakeWord), Apache-2.0. Upstream `utils.py`: Copyright 2022 David Scripka. All rights reserved. | This is adapted implementation, not inspiration only. Retain upstream copyright, [Apache-2.0 text](licenses/Apache-2.0.txt), this attribution and modification notice. Luna's MIT notice remains applicable to its contributions; it does not erase Apache obligations. |
| Fat Fish additions: DeepSeek integration, passive conversation, memory, text/search, music, Windows launcher and Feiyu service | Added relative to the inspected Luna snapshot; project contribution provenance is documented in [PROVENANCE.md](docs/PROVENANCE.md) and [SOURCE_PROVENANCE.json](docs/SOURCE_PROVENANCE.json) | An addition to Git is evidence of lineage, not proof of authorship or third-party permission. Maintainers must identify any unrecorded copied material before release. |

openWakeWord modifications include Python-to-JavaScript translation, ONNX Runtime
integration, 48-to-16 kHz resampling, automatic gain control and per-speaker buffers.
The original port's exact upstream revision is not recorded. For this audit,
[utils.py at 368c037](https://github.com/dscripka/openWakeWord/blob/368c03716d1e92591906a84949bc477f3a834455/openwakeword/utils.py)
and that revision's complete tree were inspected: LICENSE exists, no separate
NOTICE file was found. This is a verification reference, not a claim that the port
was made from that revision. Preserve any additional notices if the actual source
revision is recovered. The bundled Apache text matches upstream LICENSE blob
`261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64`.

## Package-managed and external runtime dependencies

No installed packages or binaries are redistributed in this source tree. Package
license metadata is a starting point; binary/container distributors must retain
the actual packages' notices and meet their license/source obligations.

| Dependency | Usage | License evidence |
| --- | --- | --- |
| [discord.js](https://github.com/discordjs/discord.js), `@discordjs/voice`, `@discordjs/opus`, `discord-api-types` | Discord gateway, voice/DAVE, native Opus and API types | Direct packages declare Apache-2.0 or MIT as recorded per version in [npm inventory](docs/npm-licenses.json). Native transitive components retain separate terms. |
| [dotenv](https://github.com/motdotla/dotenv), [libsodium-wrappers](https://github.com/jedisct1/libsodium.js), [prism-media](https://github.com/amishshah/prism-media) | Configuration, voice crypto and audio pipelines | BSD-2-Clause, ISC and Apache-2.0 respectively, per locked metadata. |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | Optional acoustic wake inference | MIT package; does not license ONNX models. |
| [Node.js](https://github.com/nodejs/node) | JavaScript runtime and built-in SQLite memory store | Runtime has its own license and bundled third-party notices; not shipped here. |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [Whisper](https://github.com/openai/whisper) | Operator-hosted STT; legacy build also downloads a model | MIT upstream code; verify the exact converted model artifact and notices separately. No model is bundled. |
| [CosyVoice](https://github.com/QwenAudio/CosyVoice/tree/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc), its Matcha-TTS submodule | Feiyu service imports externally installed inference code | CosyVoice [Apache-2.0](https://github.com/QwenAudio/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/LICENSE). Submodules/dependencies retain their own terms; the external source tree is not vendored. |
| FastAPI, HTTPX, NumPy, SoundFile, PyTorch, Transformers and remaining Python packages | HTTP service, audio processing and optional GPU inference | See [Python inventory](docs/python-licenses.json), `FeiyuTTS/requirements.txt` and `requirements-lock.wsl.txt`. The inventory is dated historical metadata, not a fresh universal resolver lock. LGPL declarations (including soxr/frozendict), native libraries and proprietary NVIDIA terms require separate distribution review. |
| [FFmpeg](https://ffmpeg.org/legal.html) / FFprobe | Decode, validate and convert audio; optional denoising | LGPL/GPL and other obligations depend on build options. The tested external build enables GPL and version 3; never label that binary MIT or bundle it under this repository license. |
| Kokoro, MLX Audio, Chatterbox/Qwen TTS integrations | Legacy optional service wrappers | Source wrappers may be Luna-derived; their Python packages, model revisions and voice assets are separately licensed. Not part of the demonstrated Feiyu installation. |

The locked npm inventory has 121 non-root entries: 74 MIT, 25 ISC, 12 Apache-2.0,
4 BlueOak-1.0.0, 2 BSD-3-Clause, 2 BSD-2-Clause, 1 0BSD and 1 `(MIT OR CC0-1.0)`
declaration. Targeted tar security updates introduced the Blue Oak licensed
transitive components. They remain package-managed external software; no installed
dependency binaries/source are bundled in the source archive or npm package.
Unpinned legacy Python requirements are not reproducible resolved distributions.
Missing historical metadata for `cuda-toolkit`, `nvidia-cudnn-cu12`,
`nvidia-nccl-cu12`, `nvidia-nvshmem-cu12`, `pyworld`, `setuptools` and `wetext`
is unresolved; it is not evidence of permission or absence of a license.

## Model, voice, character and media assets

| Asset | Status and release treatment |
| --- | --- |
| [FeiyuVoice-CosyVoice3](https://huggingface.co/Esmerubphire/FeiyuVoice-CosyVoice3/tree/f37e9d1dda26e8b45b4e9f1b4c347c0a07b797e2), Cute F6 and N01 synthetic reference | Excluded. Publisher NOTICE inspected in the existing local package says no repository-wide reuse license was selected for local contributions, references or character assets. Training authorization does not establish redistribution permission. Keep publisher COPYRIGHT/NOTICE and upstream notices with any separately authorized copy. Public fetch of that NOTICE was unavailable during this audit. |
| Fun-CosyVoice3-0.5B-2512 base, revision `29e01c4e8d000f4bcd70751be16fa94bf3d85a18` | External Feiyu prerequisite. Base-model terms do not grant rights to a fine-tune or voice reference. |
| openWakeWord classifiers and feature models; custom `luna.onnx`/`hey_luna.onnx` | Excluded. Upstream distinguishes Apache code from included pretrained models under CC BY-NC-SA 4.0. Google speech-embedding ancestry is described separately upstream. Check each exact file, conversion and training dataset; do not infer universal Apache or MIT permissions. |
| Qwen/Kokoro/Chatterbox/MLX weights and reference voices | Excluded; optional/experimental and not licensed by this repository. Verify each exact model card and voice permission before use. |
| Character artwork, logo, voice likeness, chimes, music and generated audio | None shipped. The public persona uses a generic fictional AI identity; fan-character visual descriptions have been removed. No trademark/likeness permission is asserted. Use an independently cleared identity/artwork for public promotion. Music must come from an operator's authorized local catalog. Generated media is not automatically MIT. |

## Acknowledgements — design inspiration only

Historical private persona text mentioned unofficial fan imagery without a
verified creator or asset license. The public candidate replaces that description
with a generic fictional AI identity and includes no character asset. No creator,
ownership or permission is invented. Luna and openWakeWord are implementation
provenance, not merely acknowledgements. Legacy Smakbot/MusicBot references describe
optional interoperability, not proof that their implementation was copied.
