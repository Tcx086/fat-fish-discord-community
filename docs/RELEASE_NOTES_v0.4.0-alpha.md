# v0.4.0-alpha — unpublished source-only candidate

Includes dynamic Discord voice controls, local Whisper integration, bounded optional
DeepSeek/Feiyu responses, optional memory/text/search, local music coordination,
Windows helpers and offline tests. Luna MIT and adapted openWakeWord Apache notices
are preserved. No model, reference voice, recording, artwork or music is supplied.

The independent snapshot has no private commit ancestry. Targeted npm fixes remove
the 11-package/40-advisory finding from the fresh lockfile audit. This is not an
audit of Python/GPU/native/OS dependencies. See [dependency disposition](DEPENDENCY_SECURITY_REVIEW.md)
and [the final gate](PUBLICATION_GATE.md) for exact results.

Seven inherited Node test failures remain. GPU inference, clean OS/container setup,
live Discord/music and production privacy/deletion behavior are unverified. These
are disclosed alpha/operational limitations, not a requirement to ship model assets.
Runtime opt-out is not durable; Windows launcher participation is broad; storage
encryption and provider deletion are operator responsibilities. No production SLA,
asset permission, live latency guarantee or stable API is implied.

The owner confirms the previously exposed key was rotated (OWNER_CONFIRMED_ROTATED).
Issuer revocation and usage review were not verified. GitHub Private Vulnerability
Reporting remains OWNER_ACTION_REQUIRED. No push, tag, release, Actions enablement,
visibility change or deployment has been performed or authorized.
