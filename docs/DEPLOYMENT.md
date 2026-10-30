# Short deployment guide

Deployment is pending [release blockers](PUBLIC_RELEASE_AUDIT.md). These are future
operator steps; the audit started or changed no running service.

1. Use an approved sanitized snapshot and resolved dependency lock. Keep the
   existing repository private: a branch does not hide sibling branches/ancestors.
   Keep GitHub Actions disabled.
2. Complete [installation](INSTALLATION.md), native checks and separately licensed
   local STT/TTS assets. Use a dedicated account and encrypted data volume. Do not
   expose STT, TTS, legacy MCP or databases publicly.
3. Publish an operator privacy/deletion/support policy, establish private security
   and conduct contacts, grant minimum Discord permissions, and obtain participant
   agreement. Keep all credentials outside Git.
4. Start from the manual inert profile, review the effective environment, use a
   participant allowlist, and keep history/search/music/paid replies off. When
   separately authorized, start local STT/TTS, verify loopback health, then run
   `npm start` in Luna. This connects Discord and is not an installation check.
5. Deliberately register guild-scoped commands, join the selected channel and
   verify notice, opt-out, move/leave/stop and silence for ineligible users. Paid
   tests require an explicit budget and external-transmission agreement.
6. Enable other features one at a time. Use authorized local music and separately
   validate real playback, speech interruption/resume and failure recovery. Keep
   release-note limitations visible.
7. Protect/rotate logs and verify retention/deletion across scopes, backups and
   exports. `/stop` leaves the bot online; terminate your instance for a full stop.
   Model services may remain until deliberately stopped by their operator.

No container, system service, cloud deployment or portable Feiyu installer was
verified. CPU-only Feiyu is unsupported by this adapter. Roll back to approved
source/configuration only after stopping your instance; do not downgrade a live
memory database without a migration/backup plan.
