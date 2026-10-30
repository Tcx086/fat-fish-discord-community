# Dependency security review

Reviewed 2026-10-30. Fresh npm results: **11 affected package entries before; 0 after**.
Those entries inherit **40 distinct advisories** across four root libraries.
See [complete advisory IDs, CVEs, severities, ranges and upstream patched versions](DEPENDENCY_SECURITY_AUDIT.json).
Reachability is a source-based assessment; no exploit was executed.

| Package | Version before → after | Original severity | Dependency path and fix |
| --- | --- | --- | --- |
| `@discordjs/node-pre-gyp` | 0.4.5 → 0.4.5 | high | @discordjs/opus > @discordjs/node-pre-gyp > tar; fix `tar@7.5.21` |
| `@discordjs/opus` | 0.10.0 → 0.10.0 | high | @discordjs/opus > @discordjs/node-pre-gyp > tar; fix `tar@7.5.21` |
| `@discordjs/rest` | 2.6.1 → 2.6.1 | moderate | discord.js > @discordjs/rest > undici; fix `undici@6.29.1` |
| `@discordjs/voice` | 0.19.2 → 0.19.2 | high | @discordjs/voice > prism-media > @discordjs/opus (optional peer) > @discordjs/node-pre-gyp > tar; fix `tar@7.5.21` |
| `adm-zip` | 0.5.18 → 0.6.1 | high | onnxruntime-node > adm-zip; fix `adm-zip@0.6.1` |
| `brace-expansion` | 1.1.15 → 1.1.21 | high | @discordjs/opus > @discordjs/node-pre-gyp > rimraf > glob > minimatch > brace-expansion; fix `brace-expansion@1.1.21` |
| `discord.js` | 14.26.4 → 14.26.4 | moderate | discord.js > undici; discord.js > @discordjs/rest > undici; fix `undici@6.29.1` |
| `onnxruntime-node` | 1.27.0 → 1.27.0 | high | onnxruntime-node > adm-zip; fix `adm-zip@0.6.1` |
| `prism-media` | 1.3.5 → 1.3.5 | high | prism-media > @discordjs/opus (optional peer) > @discordjs/node-pre-gyp > tar; fix `tar@7.5.21` |
| `tar` | 6.2.1 → 7.5.21 | critical | @discordjs/opus > @discordjs/node-pre-gyp > tar; fix `tar@7.5.21` |
| `undici` | 6.24.1 → 6.29.1 | high | discord.js > undici; discord.js > @discordjs/rest > undici; fix `undici@6.29.1` |

## tar

Reachable during Opus native installation/packaging, not speech/message handling. Exploitation requires a malicious archive (compromised or redirected binary source, local tarball or installation environment). Archive traversal/link handling, metadata and resource exhaustion advisories remain applicable to that boundary; do not dismiss them as dev-only.

Cross-major override of parent ^6.1.11. Node >=18 required (within app minimum). Same streamed extract({cwd,strip,onentry}) and create API exercised with a synthetic archive; actual Opus source build and codec checks pass. Archive validation/metadata behavior changed; Linux/macOS prebuilt installation remains unverified.

| Advisory | Severity | Affected range | First patched releases from upstream |
| --- | --- | --- | --- |
| [GHSA-34x7-hfp2-rc4v](https://github.com/advisories/GHSA-34x7-hfp2-rc4v) | high | `<7.5.7` | 7.5.7 |
| [GHSA-8qq5-rm4j-mr97](https://github.com/advisories/GHSA-8qq5-rm4j-mr97) | high | `<=7.5.2` | 7.5.3 |
| [GHSA-83g3-92jg-28cx](https://github.com/advisories/GHSA-83g3-92jg-28cx) | high | `<7.5.8` | 7.5.8 |
| [GHSA-qffp-2rhf-9h96](https://github.com/advisories/GHSA-qffp-2rhf-9h96) | high | `<=7.5.9` | 7.5.10 |
| [GHSA-9ppj-qmqm-q256](https://github.com/advisories/GHSA-9ppj-qmqm-q256) | high | `<=7.5.10` | 7.5.11 |
| [GHSA-r6q2-hw4h-h46w](https://github.com/advisories/GHSA-r6q2-hw4h-h46w) | high | `<=7.5.3` | 7.5.4 |
| [GHSA-vmf3-w455-68vh](https://github.com/advisories/GHSA-vmf3-w455-68vh) | moderate | `<=7.5.15` | 7.5.16 |
| [GHSA-w8wr-v893-vjvp](https://github.com/advisories/GHSA-w8wr-v893-vjvp) | moderate | `<=7.5.17` | 7.5.18 |
| [GHSA-23hp-3jrh-7fpw](https://github.com/advisories/GHSA-23hp-3jrh-7fpw) | critical | `<=7.5.18` | 7.5.19 |
| [GHSA-8x88-c5mf-7j5w](https://github.com/advisories/GHSA-8x88-c5mf-7j5w) | high | `<=7.5.17` | 7.5.18 |
| [GHSA-gvwx-54wh-qm9j](https://github.com/advisories/GHSA-gvwx-54wh-qm9j) | moderate | `<=7.5.16` | 7.5.17 |
| [GHSA-r292-9mhp-454m](https://github.com/advisories/GHSA-r292-9mhp-454m) | high | `<=7.5.20` | 7.5.21 |

## adm-zip

Reachable in ONNX native dependency installation through NuGet ZIP entry lookup/extraction. No application handler accepts user ZIPs. Exploitation requires hostile installation ZIP content or a hostile destination filesystem. Memory allocation/decompression and extraction defects apply at installation; asynchronous/whole-archive-only variants are not used by the inspected call path.

Cross-minor 0.x override of ONNX ^0.5.16. Tested constructor/getEntry/extractEntryTo against a synthetic NuGet-shaped ZIP. Stricter archive guards can reject malformed packages. No real GPU NuGet download or ONNX model inference performed.

| Advisory | Severity | Affected range | First patched releases from upstream |
| --- | --- | --- | --- |
| [GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85) | high | `<0.6.0` | 0.6.0 |
| [GHSA-vwc7-r8mq-g2x9](https://github.com/advisories/GHSA-vwc7-r8mq-g2x9) | moderate | `>=0.5.9 <=0.6.0` | none recorded |
| [GHSA-7q85-xj36-vmfc](https://github.com/advisories/GHSA-7q85-xj36-vmfc) | high | `<0.6.1` | 0.6.1 |
| [GHSA-rcw4-f5rp-g42v](https://github.com/advisories/GHSA-rcw4-f5rp-g42v) | high | `<=0.6.0` | 0.6.1 |
| [GHSA-j5f4-cc29-5x44](https://github.com/advisories/GHSA-j5f4-cc29-5x44) | high | `<=0.6.0` | 0.6.1 |
| [GHSA-p634-w6r4-rjp2](https://github.com/advisories/GHSA-p634-w6r4-rjp2) | moderate | `<=0.6.0` | 0.6.1 |
| [GHSA-c6fg-446q-cg94](https://github.com/advisories/GHSA-c6fg-446q-cg94) | moderate | `<=0.6.0` | 0.6.1 |
| [GHSA-8238-w5pm-2374](https://github.com/advisories/GHSA-8238-w5pm-2374) | high | `<=0.6.0` | 0.6.1 |

## brace-expansion

Reached through glob/minimatch in native installation cleanup. Untrusted brace patterns can exhaust CPU, stack or memory. No observed path maps Discord speech/messages into installer glob patterns; a malicious install configuration/input is required in this application.

Patch update within 1.x; ordinary expansion regression passes. Resource limits can reject patterns previously accepted. No major glob/minimatch replacement.

| Advisory | Severity | Affected range | First patched releases from upstream |
| --- | --- | --- | --- |
| [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) | high | `<1.1.16` | 1.1.16, 2.1.2, 5.0.7 |
| [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) | high | `<1.1.17` | 1.1.17, 2.1.3, 3.0.3, 5.0.8 |
| [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) | high | `<1.1.18` | 1.1.18, 2.1.4, 3.0.6, 5.0.9 |
| [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) | moderate | `<1.1.21` | 1.1.21, 2.1.7, 3.0.9, 5.0.12 |
| [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) | high | `<1.1.20` | 1.1.20, 2.1.6, 3.0.8, 5.0.11 |
| [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) | high | `<1.1.19` | 1.1.19, 2.1.5, 3.0.7, 5.0.10 |

## undici

Runtime HTTP dependency used by Discord REST and remote attachment fetch. Hostile/compromised responses can reach decompression and TLS error handling. WebSocket/EventSource/cookie-forwarding/cache-interceptor-specific advisories require those features and are not evidenced in the inspected Discord REST path. Do not assume fixed Discord API origins remove all HTTP/TLS exposure. Application global fetch also depends on the separately installed Node runtime, not this npm override.

6.x override of exact 6.24.1 pins. Real Discord REST adapter and undici fetch pass with a synthetic loopback server. No live Discord, proxy, remote TLS or cross-platform compatibility certification.

| Advisory | Severity | Affected range | First patched releases from upstream |
| --- | --- | --- | --- |
| [GHSA-p88m-4jfj-68fv](https://github.com/advisories/GHSA-p88m-4jfj-68fv) | moderate | `<6.27.0` | 6.27.0, 7.28.0, 8.5.0 |
| [GHSA-vxpw-j846-p89q](https://github.com/advisories/GHSA-vxpw-j846-p89q) | high | `<6.27.0` | 6.27.0, 7.28.0, 8.5.0 |
| [GHSA-g8m3-5g58-fq7m](https://github.com/advisories/GHSA-g8m3-5g58-fq7m) | low | `<6.27.0` | 6.27.0, 7.28.0, 8.5.0 |
| [GHSA-8xcm-r25x-g524](https://github.com/advisories/GHSA-8xcm-r25x-g524) | moderate | `<6.28.0` | 6.28.0, 7.29.0, 8.9.0 |
| [GHSA-m8rv-5g2x-5cg5](https://github.com/advisories/GHSA-m8rv-5g2x-5cg5) | moderate | `<6.28.0` | 6.28.0, 7.29.0, 8.9.0 |
| [GHSA-v3r7-h72x-cjcm](https://github.com/advisories/GHSA-v3r7-h72x-cjcm) | moderate | `<6.28.0` | 6.28.0, 7.29.0, 8.9.0 |
| [GHSA-35p6-xmwp-9g52](https://github.com/advisories/GHSA-35p6-xmwp-9g52) | low | `<6.27.0` | 6.27.0, 7.28.0, 8.5.0 |
| [GHSA-r53p-7pc4-xj5r](https://github.com/advisories/GHSA-r53p-7pc4-xj5r) | low | `<6.28.1` | 6.28.1, 7.29.1, 8.10.2 |
| [GHSA-rfgv-xxqx-mfg5](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5) | high | `>=6.7.0 <6.28.1` | 6.28.1, 7.29.1, 8.10.2 |
| [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685) | moderate | `>=6.5.0 <6.29.1` | 6.29.1, 7.30.1, 8.12.2 |
| [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) | high | `>=6.23.0 <6.29.1` | 6.29.1, 7.30.1, 8.12.2 |
| [GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx) | high | `>=4.0.0 <6.29.1` | 6.29.1, 7.30.1, 8.12.2 |
| [GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm) | high | `>=4.2.1 <6.29.1` | 6.29.1, 7.30.1, 8.12.2 |
| [GHSA-9fm3-97px-rjf6](https://github.com/advisories/GHSA-9fm3-97px-rjf6) | moderate | `>=5.15.0 <6.29.1` | 6.29.1, 7.30.1, 8.12.2 |

## Scope and remaining risk

No direct package major was upgraded. Overrides are explicit and locked. The initial lock resolution exposed an optional ONNX WASM inconsistency; a targeted `@emnapi/wasi-threads` update repaired it before the successful fresh install.

Deprecation warnings remain for the old native installer chain. Zero npm findings does not certify the separately installed Node runtime, libopus, DAVE, ONNX binaries, Python, OS or CUDA stack. Use a currently patched supported Node release and independently review deployment dependencies.

Focused ZIP/tar/brace/HTTP and native codec tests passed; complete suite results and remaining legacy failures are in [the publication gate](PUBLICATION_GATE.md). Cross-platform and GPU paths remain unverified.
