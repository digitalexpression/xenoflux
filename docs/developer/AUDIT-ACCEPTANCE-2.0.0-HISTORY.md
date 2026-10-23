> **Historical record — not active instructions.** Historical 2.0.0 acceptance record copied verbatim from the published v2.1.0 source on 2026-10-23. Its original text is retained as historical evidence and is not the current release record. See [current 2.1.0 acceptance](AUDIT-ACCEPTANCE.md).

---

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

## Historical development notes — not current acceptance

The following candidate checks and blockers are dated development evidence,
not the current delivery plan or acceptance of the clarified product goal.
Use the [shared goal](AUDIT-GOAL.md), [active roadmap](ROADMAP.md) and
[capability assessment](PROFILE-AUDIT-ASSESSMENT.md) for the Codex CLI/Desktop
macOS release. Historical M1 completion, later pilot results and suite counts
do not establish release readiness; UI and other providers follow that release.

<details>
<summary>Retained candidate observations and verification (original text)</summary>

## Uncommitted comparison explanation candidate

The current development checkout contains a deterministic, evidence-backed
comparison explanation candidate in `src/audit-explanation.js` and the comparison
renderer. It presents conditions, behavioral findings, paired action evidence,
verification, time/tokens, and outcome/code changes in that order. The candidate
can identify supported recorded file edits against a declared relative
`editableFiles` boundary and same-owned-source read/edit order. It marks agent
boundary-check activity and agent final-diff inspection unknown because the
retained generic actions do not establish those behaviors. Similarity is scoped
to an observed dimension and pair; missing or incompatible evidence remains
inconclusive, and one pair leaves consistency unmeasured. Ineligible deltas are
suppressed. Markdown export carries a normalized JSON sidecar that can be opened
without native source sessions.

The [synthetic booking-ledger report example](../examples/audit-booking-ledger-comparison.md)
is illustrative only: it is not a measured effect, real booking-ledger baseline
or workflow run, or human walkthrough. No result here establishes that the
supplied task identity was followed by a native agent, that configured resources
were loaded or followed, or that unobserved actions did not occur. This candidate
is uncommitted and is not part of the published/installed 2.0.0 package. The offline checks
complete M1 acceptance. Real paired execution, repetition, and
ordinary-user acceptance remain separate milestones; the overall feature goal
is not complete.

Offline acceptance exercised 17 authored controls, including a substantive scope
difference, similarity, inconclusive/partial evidence, missing runs, incompatible
conditions and capped contradictory observations. Two retained unmatched native
comparisons remained ineligible for same-task claims. Full/compact explanations,
JSON, Markdown sidecars and source-free CLI reopen preserved claims, references
and missingness. An independent automated report reader followed the paired
references; no human walkthrough is claimed.

The final suite passed 937 tests, with zero failures and one existing skip.
`npm run check`, `npm run check:native` and `git diff --check` passed. These are
software and evidence-preservation checks, not measurements of model quality,
human review or behavioral consistency.

## Native capability and startup repair candidate — 2026-10-21

The local candidate validates bounded native instruction-source metadata rather
than requiring a particular native version. Executable-only selections observe
the version with profile definitions write-protected; the pair freezes that
observation to detect drift. Missing or malformed evidence remains unavailable,
and historical failed receipts are not upgraded from current capabilities.

Offline OS fixtures verified saved auth/config/instruction/agent/skill/rule write
protection, linked skill targets, guarded version discovery and before-turn
rejection of an unavailable command sandbox. No saved permissions or real
credentials were changed or copied. An installed-native smoke in a disposable
synthetic home passed startup and root instruction context while preserving the
synthetic files. Its ordinary workspace command failed to initialize the nested
sandbox (exit 71). Native coding execution therefore remains blocked; no model
turn was used to test it and no sandbox bypass is accepted.

The final offline suite passed 940 tests with zero failures and one existing
skip. Syntax/native-launcher checks and diff whitespace checks passed. The 17
report/compaction/export/source-free-reopen controls passed. These establish
software behavior and fail-closed preservation, not successful subscription
authentication, a working native coding run or measured model quality. The next
two-run packet remains blocked until preservation and ordinary command execution
are demonstrated together; prior failed slots remain immutable.

## Same-Mac native command sandbox repair — 2026-10-21

The next local candidate retains saved-definition write protection while allowing
only the selected native image to hand commands to the system sandbox launcher.
Startup helpers cannot re-enter that image to obtain the transition. Native task
commands receive their ordinary workspace/network policy independently. Random
atomic auth/config siblings and profile-home rename are denied; exact identified
native cache/runtime entries remain writable. Narrow invocation-only native
configuration replaces the shell launcher for common model/reasoning/login
controls, and survives recipe freezing, resume checks and compaction.

Nineteen installed-native synthetic controls passed against the production
policy/capture: workspace command and patch helper, outside-write and direct
sandbox-escape denial, atomic-save/home-rename protection, unchanged saved
synthetic bytes/metadata, root AGENTS acceptance, and zero-turn capture readiness.
A matched localhost command succeeds with network access enabled and fails with
it disabled; this isolates native task network enforcement from the additional
offline-only outer network deny. The per-run no-op gate establishes launch only.

Final regression verification: 947 tests, 946 passed, zero failures and one
existing skip; syntax/native-launcher and diff checks passed. Seventeen authored
report/compaction/export/source-free reopen controls passed. Read-only actual
profile/binding/reservation and checker-service inspections were ready. No
real-profile native startup or authentication was tested: automatic approval
review rejected the proposed real-profile version probes, and the task used
read-only metadata plus exact-binary disposable evidence instead. No evaluation,
worker, service start, profile/settings change, commit or release occurred. This
makes a new bounded two-run packet ready for explicit approval; it establishes no
booking-ledger behavior, outcome advantage, human score or consistency result.

## Retained report projection — development checkout

Ordinary saved-run, experiment and series inspection now derives a read-only
report projection from retained records. It joins the frozen series conditions
and exact owned task-turn controls, and names supported literal action records.
Original final reports and their recorded failures remain immutable; required
human review remains pending until a human submits it.

Offline acceptance uses an actual retained same-task pair in addition to
authored controls. It verifies named source/test read invocations, matching
visible-test execution, differing inline assertion-script constructs, and
separate configured/startup/per-turn controls. Comparison support survives
compaction, JSON/Markdown export, and source-free CLI inspection with the original
controller store inaccessible. This replays recorded evidence; it is not a new
model evaluation or a claim of consistent profile superiority.

Regression controls reject changed parent conditions, foreign/duplicate turn
contexts, cross-turn call/result collisions, duplicate outcomes, dynamic wrapper
syntax, and outside-workspace attribution. Missing sources cannot supply model
controls or negative action claims. The current source snapshot fingerprint
does not independently prove original-capture bytes. Whole-invocation exit
codes and literal script constructs retain their narrower meaning.

## Limits

Verification covers the named candidate, checks, native version, retained records,
and bounded workflows above. It does not establish behavior for every origin,
client version, resource type, or possible activity. Native delivery can omit or
repeat observations; receiver IDs identify received records, not guaranteed
unique executions. A passed bounded comparison does not prove causation, universal
quality, exhaustive capture, or billing. Historical records retain their original
coverage gaps and are not completed from today's inventory.

</details>
