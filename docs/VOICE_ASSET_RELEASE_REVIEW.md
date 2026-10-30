# Feiyu voice asset release review

Review date: 2026-10-30. Decision: **redistribution rights are unresolved; retain the existing external-asset setup.** No weights, references, recording excerpts or model archive were copied into this public checkout. No Hugging Face packaging proposal or release Model Card is prepared because the rights condition is not met. An existing public download is not itself permission to republish it.

## Evidence and exact provenance

This is a local documentary/integrity audit, not a grant of rights. The inspected installed package identifies itself as FeiyuVoice-CosyVoice3 **v1.0.1 lossless**, published under [Esmerubphire/FeiyuVoice-CosyVoice3](https://huggingface.co/Esmerubphire/FeiyuVoice-CosyVoice3). Its saved download metadata records revision `f37e9d1dda26e8b45b4e9f1b4c347c0a07b797e2`. That revision identifies the recorded download; it is not a claim about today's remote main or a cryptographic attestation of authorship.

Locally inspected: `manifest.json`, `provenance.json`, `download-snapshot.json`, `files_sha256.json`, `README.md`, `COPYRIGHT.md`, `NOTICE.md`, the supplied upstream Apache license and base-model README; the F6/N01 and C3/N10 files; and the separate local reference override manifest and launcher selections. Only sanitized findings appear here. Private absolute paths, service logs, recording content and runtime files are excluded.

| Item | Finding and evidence limit |
| --- | --- |
| Upstream model creator/publisher | FunAudioLLM, `Fun-CosyVoice3-0.5B-2512`; pinned revision `29e01c4e8d000f4bcd70751be16fa94bf3d85a18` in the manifest/provenance |
| Upstream code | CosyVoice commit `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc`; the canonical GitHub URL currently redirects to QwenAudio/CosyVoice |
| Fine-tuned weights | Cute **F6**, cumulative 40 updates, `models/feiyu_cute_F6_0040.pt`; package credits distribution to Esmerubphire. The individual trainer/complete training-data chain is not independently established by these files |
| Serialization provenance | Manifest states v1.0.1 restores shared storage for equal tied Parameters, without tensor/inference changes; prior v1.0.0 F6 hash `d85c651b8e209a3a9fdc051461055ed4fc91607bbd30a9ac57e71609bf1cc393`. No tensor-loading or historical audio-regression claims were revalidated here |
| Packaged N01 reference | `references/cute_N01.wav`; manifest says synthetic CosyVoice3 output followed by exported **Feiyu RVC A60**, not a new human recording. This describes processing, not rights clearance |
| Gentle alternative | C3 uses the original upstream `llm.pt`, paired with synthetic RVC-derived N10. An unmodified base LLM does not clear reference/identity rights |
| Original audio source | Package `COPYRIGHT.md` and `provenance.json` credit Bilibili creator [星落落_oi](https://space.bilibili.com/30584746/), and record publisher confirmation of authorization for this project's voice-model **training**, dated 2026-10-25 |
| Missing source evidence | No independently reviewed permission instrument, exact source recording inventory, original source-file hashes, RVC A60 checkpoint hash/revision/license or complete derivative chain was found in the inspected package |

The [pinned base-model card](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/blob/29e01c4e8d000f4bcd70751be16fa94bf3d85a18/README.md) declares Apache-2.0. The [pinned upstream code license](https://github.com/QwenAudio/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/LICENSE) is Apache-2.0, matching the local retained notice. Publisher NOTICE/COPYRIGHT URLs could not be independently retrieved through the web reader in this review; conclusions about those texts come from the exact installed files, not a claimed fresh remote confirmation.

## Installed reference differs from packaged N01

A separate private reference-override configuration was also inspected read-only. It references the same F6 checkpoint but substitutes a local recording for N01, expressly for local matching rather than redistribution. The publisher's synthetic N01 provenance does not describe this substitute. No permission to publish the substitute or its derivatives was established.

No running service was contacted, so this is configuration evidence, not verification of a live process. The substitute's private paths, recording dialogue, size, checksum and other runtime details are excluded from this public review and all packaging/demo plans. Possession of a recording or local-use approval does not itself establish publication rights.

## Measured sizes and integrity

The following are fresh local SHA-256 measurements, without deserializing checkpoints or running inference. All four packaged hashes agree with the installed manifest and saved publisher metadata. The separately stored N01/manifest copies agree with the installed package as well. Hash agreement establishes file identity, not licensing or safe execution.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| Cute F6 `feiyu_cute_F6_0040.pt` | 2,024,692,677 | `31a87a0f83ae9987285e115dd0d2048a0f52db44fa40d48e8da1cfefea12affc` |
| Packaged `cute_N01.wav` | 219,244 | `cefa06b7f45479130169d154f84a32bc89d90585b7de50f96e36533c5ebe819e` |
| Base/C3 `llm.pt` | 2,024,669,519 | `69f43bd545131c30e98947fb360ea8b4dc9916d8e83dded7757c7ea4f5a24970` |
| Packaged `gentle_N10.wav` | 801,644 | `d6f6365b66bc14f26def0f281beb2bd1db6392b76150b990603d04e34e364356` |

The private local reference override's checksum and size are deliberately omitted from this public review. It is not part of the publisher's package or any release inventory.

The installed publisher `models/` plus `references/` payload totals **7,452,754,699 bytes across 18 files** (including model configs/tokenizers/base README). Only the checkpoints/references above were freshly hashed; the aggregate is a size inventory, not a claim that every shared upstream component was independently hash-verified.

For reproducible evidence identification, the installed package manifest is 2,805 bytes, SHA-256 `9f39074aba4d6a422a98b7a5e0bfc0a7463666669da226be55c85b67ccbc0edd`; its `COPYRIGHT.md` hash is `662c301210ecb93bf89f37889b8b8b0525d4ec03c1a8373c876fb1e78185e87a`, `NOTICE.md` hash `c044aee0be10e801f9dde4a4d891e05c97197409bd886926fb5dc5af34d6628f`, and `provenance.json` hash `e4b1a2b4b1d966ae435d00370102448d258b0f78332e8191035f5ccf88d21f7f`. These documents remain external to the public repository.

## Rights assessment

| Rights layer | Confirmed documentary fact | Unresolved scope / release consequence |
| --- | --- | --- |
| Base model and upstream code | Pinned sources declare Apache-2.0; installed upstream license is retained | Apply that license to those components and satisfy its conditions; it does not clear unrelated recordings, identity or new contributions |
| F6 fine-tuning contributions | Local publisher NOTICE states no repository-wide reuse license was selected for local contributions, references or character assets | No explicit third-party redistribution grant for the complete F6 package established; do not label the whole model Apache/MIT or rehost it |
| Training audio | Publisher records source-creator consent for project training | Training permission is narrower than permission to publish source recordings, trained weights, synthetic outputs, sublicenses or commercial distribution; the underlying permission and rights chain need review |
| RVC A60 and N01/N10 | Synthetic processing chain is declared | Exact RVC checkpoint/license, source material rights, permitted derivative outputs and permission to redistribute references remain unverified; an RVC implementation's code license would not settle trained-voice rights |
| Character and voice identity | Feiyu character/voice is named | No explicit voice/personality/character reuse, endorsement or identity permission established; artwork/adjacent project licenses cannot be presumed to cover this voice |
| Local recording override | Manifest expressly limits it to local matching | No publication permission established; exclude recordings, reference crops and generated demos derived from it |
| Attribution | Package names FunAudioLLM/CosyVoice, Esmerubphire and 星落落_oi | Preserve applicable upstream license/copyright/NOTICE and change notices. Carry source/training attribution if a later approved distribution uses these assets; confirm any additional creator-specified conditions. Attribution alone is not authorization |

The installed package supports the narrower factual claim that **the publisher reports training consent**. It does not establish a blanket model-use grant, and model-use permission, where separately obtained, must still be distinguished from redistribution permission. Synthetic speech can retain upstream, source-content and identity constraints; the synthetic label does not clear them.

Keep downloads/operator opt-in and asset-path configuration as they are. This change does not expand those terms or certify an existing local deployment. Existing public code license notices are unchanged.

## What would be required before a separate release proposal

Obtain inspectable, explicit written permission from the relevant rights holders covering the exact F6 checkpoint, packaged reference audio, RVC-derived material and intended identity use. Establish source inventories and the exact RVC A60 model provenance/license. Confirm rights to reproduce/distribute derivatives, allowed users/purposes, commercial scope, sublicensing, attribution and any withdrawal conditions; distinguish reference clips from training data and generated demonstrations. Do not contact creators or upload assets as part of this task.

Only after that review clears the intended distribution should a separate Hugging Face packaging proposal and Model Card be prepared under the approved license(s). At that point they must accurately separate upstream and fine-tuning terms, identify immutable revisions/hashes, document training/reference consent, intended uses/restrictions, limitations and evaluation evidence, and exclude private runtime data. No such package, license selection, repository creation or publication is authorized or performed here.

## Optional original-audio demo plan

Use a newly written neutral script and a new recording by an adult contributor using their own ordinary voice, with documented permission to publish that specific recording and the script under an explicit chosen license (for example CC0 or CC BY 4.0). Record in a quiet space without music, borrowed character dialogue or other speakers. Keep a short consent/release record identifying author, performer, scope, date and required attribution.

A dry-recorded human demo may illustrate the script, but must be labeled as a human example rather than Feiyu model output. To demonstrate TTS, separately select an engine, weights, reference and voice identity with documented rights for both inference and publication of outputs; use the contributor's own consenting voice if cloning. Do not use F6, N01/N10, the local recording override, participant transcripts or imitation of the Feiyu identity until their rights are resolved. Label synthetic results, document model/reference revisions and publishing permissions, and hash the final approved clips. No audio was generated or published during this audit.
