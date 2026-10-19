# Audit acceptance summary

This is a curated public summary of verification for the local Xenoflux **2.0.0**
`latest` candidate, prepared 2026-10-19. The candidate was built and checked locally;
it has not been published. Private originals and raw native evidence are retained
separately. This page intentionally contains summarized results rather than raw
receipts, transcripts, local archive locations, task identifiers, or profile and
project names.

## Recorded functional checks

The earlier functional candidate source passed syntax and native-launcher checks, whitespace
validation, and the full test suite: **752 tests, 751 passed, 0 failed, and 1
existing opt-in Desktop open/focus/reopen check skipped**. Detached bundle smoke
and isolated global install, command, audit show/diff/export/reopen, and uninstall
checks passed. The checks used disposable installation state and did not operate
real profiles or clients. The Desktop skip remains opt-in; this result does not
claim Desktop acceptance.

The rebuilt public candidate also checks the package boundary against synthetic
private receipts and unreviewed documentation. Its bundle manifest pins the final
source revision, package hashes and detached smoke result.

Machine-readable results are in the [sanitized evidence summary](evidence/audit-2.0.0-summary.json).

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
