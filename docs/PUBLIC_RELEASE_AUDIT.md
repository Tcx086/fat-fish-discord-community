# Public release audit — local snapshot follow-up

This follows the previously completed and reviewed public release audit. It does
not restart or replace that private baseline with a new audit of all old branches.
Private historical inventories, commit metadata and operational narratives remain
excluded. Final-export/history verification applies to the independent candidate.

| Baseline gate | Current candidate disposition |
| --- | --- |
| Private history / participant metadata | Resolved for the separate snapshot: new root history only, no original Git directory or refs imported. Original private repositories remain preserved. |
| Prior API-key exposure | **OWNER_CONFIRMED_ROTATED**. Owner confirmation received during preparation; neither key requested/inspected/tested. No issuer-verified revocation or completed usage review claimed. |
| Npm dependency findings | 11 packages and 40 advisories individually reviewed; four targeted root-library fixes; fresh fixed-lock audit: zero findings. Focused/native compatibility evidence and remaining platform limits are recorded separately. |
| Luna / openWakeWord notices | MIT attribution/license retained; Apache copyright/license and modification notice retained, including in generated npm contents. |
| Feiyu/model/voice/art rights | Source-only scope excludes assets. No turnkey/production claim. Generic fictional persona replaces the fan-character description; asset opt-in does not grant a license. |
| Security reporting | GitHub Private Vulnerability Reporting is preferred; **OWNER_ACTION_REQUIRED**. No destination/settings changed or verified, and no security email invented. |
| Existing failing tests | Seven inherited failures are disclosed separately from passing focused regressions. |

See [PUBLICATION_GATE](PUBLICATION_GATE.md) for final source-publication gates,
test results and production limitations, and [DEPENDENCY_SECURITY_REVIEW](DEPENDENCY_SECURITY_REVIEW.md)
for every package/advisory, exposure boundary and compatibility risk.
Public repository creation, pushes, tags, releases, Actions enablement, visibility
changes and deployment remain unauthorized. Stop at local candidate review.
