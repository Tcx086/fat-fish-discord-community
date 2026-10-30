# Integrated voice and memory architecture

The current source combines local PCM capture/Whisper STT, explicit name matching,
bounded working context, optional consented memory and DeepSeek text responses,
Feiyu WAV synthesis, native Opus and Discord voice playback. Controls support
dynamic channel movement, interruption and session isolation.

See [ARCHITECTURE](ARCHITECTURE.md), [DYNAMIC_VOICE_CHANNELS](DYNAMIC_VOICE_CHANNELS.md),
[privacy](../PRIVACY.md) and [installation](INSTALLATION.md). Historical private
session/branch records are excluded. This architecture description grants no
permission for live tests, paid requests, downloads, service starts or deployment.
Fresh offline results and inherited failures are in [the gate](PUBLICATION_GATE.md).
