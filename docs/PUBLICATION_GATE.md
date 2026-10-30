# Local publication gate — v0.4.0-alpha

**LOCAL_CANDIDATE_READY_FOR_OWNER_REVIEW. PUBLIC_RELEASE_NOT_AUTHORIZED.**

This is a source-only follow-up to the completed, reviewed public release audit.
It is not a new audit of old private branches or a production deployment approval.
The exact commit, Git tree, complete file/mode/hash inventory, source archive and
generated-package hashes are in the final local release manifest delivered beside
the candidate. That external manifest avoids a self-referential snapshot hash.

## Source-publication gate

| Item | Disposition |
| --- | --- |
| Scope | Source-only v0.4.0-alpha; models, references, recordings, art, music, credentials and runtime data excluded. Generic fictional persona only. |
| History | A new independent root commit is prepared in a separate directory; no original Git directory, commits, refs, tags or PR metadata imported. All its objects and exported contents are checked. No remote is configured. |
| Private preservation | Existing private repositories/branches/history/environments are not edited. Before/after tracked/untracked source and full Git metadata fingerprints are compared in the private local evidence, outside this snapshot. |
| Npm security | All 11 originally affected packages and 40 advisories reviewed individually. Four targeted library fixes, no forced broad upgrade. Fixed-lock audit: zero npm findings. See the complete dependency review. |
| Attribution | Luna MIT copyright/license unchanged. Adapted openWakeWord copyright, Apache text and modification notice retained, including in the inspected npm package. |
| Prior key | **OWNER_CONFIRMED_ROTATED**. Owner confirmation only; neither key inspected. Issuer revocation and usage review are not verified. |
| Documentation | README, THIRD_PARTY_NOTICES, PRIVACY, SECURITY, CONTRIBUTING, installation and component limitations prepared. |
| Private reporting | **OWNER_ACTION_REQUIRED** for GitHub Private Vulnerability Reporting on the eventual approved destination. No setting or delivery channel is claimed enabled. |
| Publication authority | **BLOCKED pending separate approval of the exact artifacts, public destination and actions.** No repository creation, push, tag, release, Actions enablement, visibility change or deployment authorized. |

No remaining known critical/high npm finding or bundled asset-rights issue blocks
the selected source-only artifact. Missing optional models and production services
are not source-distribution requirements. Before public launch the owner must
complete/verify the preferred private reporting channel as part of an approved
publication plan. Provenance qualifications below remain visible for review.

## Fresh validation

Host: Windows x64, Node 24.13.0/npm 11.6.2, Python 3.11.15, existing FFmpeg/FFprobe.
Use a currently patched supported Node version for deployment; the test-host
version is evidence, not a security recommendation. Counts overlap across runs.

| Check | Result |
| --- | --- |
| Public-registry credential-free Node install | PASS, new isolated dependency tree/cache, 106 installed packages, lifecycle scripts disabled; 121 non-root lock entries including other-platform optional packages. |
| Native Opus rebuild | PASS, local C++ source build after Node 24 prebuilt download returned 404. No original environment copied. |
| Targeted dependency compatibility | 4/4 PASS: native-installer streamed tar extraction, ONNX ZIP entry API, brace expansion, real Discord REST/undici on synthetic loopback HTTP. |
| Native codec/DAVE | 3/3 PASS: real Opus encode/decode, voice resource conversion, native DAVE binding. This does not establish live Discord compatibility. |
| v0.2 text/memory/search | 45/45 PASS. |
| v0.3 voice/launcher | 30/30 PASS. |
| Music | 30/30 PASS using synthetic audio and mocked Discord. |
| Integration suite | 215 PASS, 5 inherited failures / 220. |
| Complete Node suite | 491 PASS, 7 inherited failures / 498. Four new dependency tests are included. No new failing test remains. |
| Feiyu synthetic Python | 8/8 PASS; existing small test venv used read-only with bytecode writes disabled. No model/GPU loaded. |
| Shared Qwen synthetic Python | 9/9 PASS; same test environment, no model/GPU loaded. |
| Asset policy | 1/1 PASS: Feiyu acquisition refuses before network/filesystem mutation without opt-in; four Metal launch scripts refuse before execution. |
| Syntax | 16 Python files compile; 6 shell files pass Bash syntax checks. No inference performed. |
| Exact artifacts | Source/history/permissions/license/manifests, actual source TAR and actual npm pack payload are verified; per-file hashes and final check outcomes are in the external release manifest. |

Inherited failures are unchanged in scope: five `integration-v0.test.js` cases
access an absent fixture connection's `setStatus`; `autojoin.test.js` expects the
old resume behavior; `luna.test.js` expects the old Moved/Joined wording. They are
disclosed alpha limitations and were not repaired or hidden in this preparation.
The generic-identity assertion was updated to match the sanitized persona. A README
configuration omission found during preparation was fixed and retested.

## Limitations for operation, not reasons to bundle assets

GPU inference, live Discord/music, empty-OS installation, container builds and
production privacy/deletion are unverified. Feiyu weights/references, wake models,
other voices and artwork require independent permission/provenance review. Legacy
acquisition paths require explicit opt-in, which grants no rights. Synthetic tests
cannot establish real microphone reliability, listening quality or latency.

The Windows launcher uses broad participant mode. Runtime opt-out resets on restart.
Storage encryption, retention, backups and provider-side deletion depend on the
operator. Legacy unauthenticated MCP stays disabled in the recommended profile.
These are deployment limitations; no unrelated hardening or new service is required
to prepare this source-only alpha.

The original openWakeWord port revision is not recorded; the cited upstream
verification revision is not asserted as its origin. Maintainers should confirm
unrecorded borrowed material. All currently identified source notices are preserved.
Pattern scans are not proof against arbitrary secret formats or natural-language
PII; no Gitleaks/TruffleHog executable was available. Candidate findings were
reviewed as synthetic fixtures, placeholders or code expressions. Native/OS/Python
and Node bundled dependencies are outside the npm advisory result.

## Proposed migration — requires future explicit authorization

1. Approve this exact candidate commit/tree, source TAR hash and source-only scope.
   Any content change produces a new hash and requires artifact revalidation.
2. Choose a new, separate repository owner/name. Keep the existing repository,
   every branch, its history, visibility and all working environments unchanged.
3. In a separately authorized publication step, create an empty destination with
   no generated README/license/history. Keep Actions disabled. Never mirror or
   import old refs; do not change the original repository's visibility.
4. Approve and push only the new candidate commit to the chosen single public
   branch. No tags, old history, PRs, credentials, model bundles or local evidence.
5. On that approved public destination, the owner/admin enables and verifies
   GitHub Private Vulnerability Reporting and maintainer notifications, following
   SECURITY.md and GitHub's documentation. Do not claim it exists before verification.
6. Compare the remote tree/commit and downloadable contents against the manifest.
   A tag, GitHub Release, CI enablement or deployment each requires separate approval.

Nothing in this proposed strategy has been executed. The npm pack artifact is a
local content-inspection artifact, not an approved npm release or supported install
path; install from the source tree with its reviewed lockfile and root overrides.
