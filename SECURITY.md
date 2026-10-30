# Security policy

This source-only v0.4.0-alpha candidate is experimental. No production security
support SLA is promised. The preferred disclosure channel is **GitHub Private
Vulnerability Reporting** on the eventual approved repository.

**Reporting status: OWNER_ACTION_REQUIRED.** No public destination has been created,
and repository administration settings have not been changed or verified. Once the
owner enables the feature, use Security → Advisories → Report a vulnerability.
Until a private reporting channel is verified, do not put exploit details, tokens,
recordings, transcripts, IDs or private paths in public issues. No security email
or working private channel is asserted here.

An owner/admin should follow [GitHub's configuration instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository),
enable Private Vulnerability Reporting on the approved public destination, verify
that the private reporting form is available, and verify maintainer notifications.
The feature is for public repositories; this step belongs to a separately approved
publication plan and must not change the existing private repository's visibility.
The default GitHub form is sufficient. Report affected version, impact, redacted
reproduction and a synthetic fixture where possible.

## Prior credential exposure

**OWNER_CONFIRMED_ROTATED** — the repository owner confirmed rotation of the
previously exposed API key during local preparation. Neither the old nor new key
was requested, inspected or tested. This is owner confirmation, not issuer-verified
revocation, and no completed usage review is evidenced. Removing secret text from
Git alone never proves revocation.

## Dependency and deployment boundaries

The [npm review](docs/DEPENDENCY_SECURITY_REVIEW.md) documents all 11 original
affected packages and 40 advisories; the targeted fixed-lock audit has zero npm
findings. Native Opus/DAVE, ONNX, Node's bundled dependencies, Python, OS and GPU
libraries require their own maintenance. Use a currently patched Node release.

Keep STT/TTS on loopback and unused features disabled. Legacy LM Studio MCP can
bind without authentication; keep `LLM_TOOLS=false`. Apply participant/operator
allowlists, Discord permissions, notice/consent and restrictive storage permissions.
SQLite attestations do not encrypt data. Counters are not a durable billing limit.
No private model or reference is implicitly licensed by this source release.

No Actions workflows are included. Pushing, tags, releases, visibility changes,
Actions enablement and deployment require separate approval. See
[the current gate](docs/PUBLICATION_GATE.md) for source-publication and operational
limitations, which are distinct.
