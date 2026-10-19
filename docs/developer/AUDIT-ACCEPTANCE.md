# Audit acceptance summary

Xenoflux **2.0.0** was published on **2026-10-19** under npm's `latest` tag.
The [npm package](https://www.npmjs.com/package/xenoflux/v/2.0.0) and
[GitHub release](https://github.com/digitalexpression/xenoflux/releases/tag/v2.0.0)
were verified against source revision
`dc502ebcfcf79f64b8bb2ad4c99a38b7ab78e4d6`. Public npm package bytes and all
four GitHub bundle assets match the tested release bundle.
The Xenoflux tarball SHA-256 is
`445a80487093a15bab5b77731c5e16b147d34e043fd4c461f232f8be4ceb35d9`.

This curated public record contains summarized results and coverage limits.
Private originals and raw native evidence remain separately retained. Machine-local
paths, profile/project names, native identifiers and operational recovery details
are excluded. This page includes post-release verification; the published 2.0.0
assets retain their original contents and source revision.

## Recorded functional checks

The earlier functional candidate source passed syntax and native-launcher checks, whitespace
validation, and the full test suite: **752 tests, 751 passed, 0 failed, and 1
existing opt-in Desktop open/focus/reopen check skipped**. Detached bundle smoke
and isolated global install, command, audit show/diff/export/reopen, and uninstall
checks passed. The checks used disposable installation state and did not operate
real profiles or clients. The Desktop skip remains opt-in; this result does not
claim Desktop acceptance.

The final published source passed **753 tests, 752 passed, 0 failed and 1 existing
opt-in Desktop skip**, plus syntax, native-launcher and whitespace checks. Detached
installed-package smoke and isolated global install/audit/export/reopen/uninstall
checks passed. Package-boundary coverage rejects synthetic private receipts and
unreviewed documentation. The full outgoing object set, source snapshot and actual
npm archive were reviewed for known private metadata. The release manifest pins
the final source revision, package hashes and detached smoke result. These are
local checks; the final commit had no hosted check runs because the repository
workflow triggers on pull requests.

Machine-readable results are in the [sanitized evidence summary](evidence/audit-2.0.0-summary.json).

## Existing local installation verification

One existing managed macOS installation was updated to **2.0.0** from the verified
published package. CLI help, the existing profile listing, read-only desktop
observation and RAM-log status passed. Isolated frozen audit show/diff/export/reopen
checks retained read corroboration and partial exit 2.

The update preserved profile registrations, settings, bindings, credential
metadata, service configuration and observed running-client process identities.
Only the application payload was replaced; the previous app was retained privately.
This is a dated result for that installation, not a general unattended-update
recipe or fresh-install, native launch, sign-in, restart or reboot acceptance.
Detailed machine state and recovery locations remain in private records.

## Audit evidence

- **Native capture and attribution:** On the tested native version
  `0.163.0-alpha.10.2`, a disposable root/child/grandchild workflow recorded 16
  definition reads, including 10 successful absolute `cat` reads corroborated by
  matching native actions and actor-owned catalog and working-directory evidence.
  Child catalog and working-directory ownership guards prevent a child from
  borrowing a parent's evidence. The native run used a scripted local provider;
  it does not establish provider billing or model quality.
- **Historical reads:** Retained original native records were byte-copied into an
  isolated verification environment; only the index and profile registration
  needed for lookup were reconstructed. Historical import confirmed 13 reads:
  7 absolute-command reads and 6 native-read-action reads. Three other commands
  targeted canonical resources but lacked the historical alias link needed for
  attribution, so they remain unmatched. No current filesystem alias was used to
  fill that gap.
- **Paired coding check:** A bounded two-profile coding pair passed 191
  independent oracle cases per side and its required checks. This is evidence for
  those runs only; it does not establish that either profile caused a better
  result.
- **Additional native breadth:** Disposable native checks observed hook lifecycle
  events, manifest-owned MCP success and failure, and a trusted Documents script
  with plugin-relative identity. The script result covers the tested shell-command
  attribution path. It does not establish every script schema or exhaustive hook,
  tool, MCP, or plugin activity.
- **Coverage status:** Partial skill coverage and exit status 2 are preserved when
  observed evidence is useful but incomplete. No observation is not proof of no
  activity. Recorded activity is not a complete account of hidden or unlogged work.

## Retained failed controls

Original failures remain recorded privately. These include an original harness
read-count mismatch followed by separate post-capture verification, native
suppression of repeated same-definition detections, protected-workspace permission
failures before a corrected disposable recipe, and restricted local-listener
failures before permitted fixture checks. Successful later verification does not
relabel those original attempts as passed. No new account-backed task was run for
publication sanitization.

## Token accounting

Source inspection for the tested native version supports independent per-thread
cumulative counters and fresh paginated child threads. The adapter sums each
owned thread once after complete capture and continuity checks; `last` represents
the latest response. This exact-version contract is not a billing claim or proof
for historical/resumed threads or other native versions.

## Limits

Verification covers the named candidate, checks, native version, retained records,
and bounded workflows above. It does not establish behavior for every origin,
client version, resource type, or possible activity. Native delivery can omit or
repeat observations; receiver IDs identify received records, not guaranteed
unique executions. A passed bounded comparison does not prove causation, universal
quality, exhaustive capture, or billing. Historical records retain their original
coverage gaps and are not completed from today's inventory.
