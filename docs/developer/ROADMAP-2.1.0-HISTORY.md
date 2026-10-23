> **Historical record — not active instructions.** Historical 2.1.0 roadmap copied from the published v2.1.0 source on 2026-10-23; only navigation links were adjusted. It records the release-era plan and verification; none of its authorization or next-step language is active. See [current roadmap](ROADMAP.md).

---

# Xenoflux roadmap: Codex CLI and Desktop on macOS

Updated 2026-10-23. This is the sole active delivery roadmap. The
[shared product goal](AUDIT-GOAL.md) owns the outcome and acceptance contract;
the [capability assessment](PROFILE-AUDIT-ASSESSMENT-2.1.0-HISTORY.md) owns source evidence and
implementation proposals. Historical handovers, isolation runbooks, benchmark
campaigns and mockups are evidence or proposals, not alternative plans.

## Goal and current authorization

Let users create and change independent profiles, see full useful setup diffs,
and compare behavior and outcomes on the same task, whether xfx launched it or
it was started directly in Codex CLI or Desktop. Support optional human review,
AI review or both, and assess consistency from repeated evidence. Work directly
on the user's Mac. No third-party version pins, compatibility matrix or separate
execution-environment platform is required.

The first delivery is a release-ready Codex CLI/Desktop product on macOS. After
that release, assess UI and other providers, including Claude and Copilot. Do not
start a provider framework or UI implementation to complete this release.

Current authorization: verify R5 against the R1–R4 candidate, including macOS
Codex CLI/Desktop workflows and the exact local release package. Reuse relevant
retained evidence and make necessary local fixes revealed by acceptance checks.
The final review identified two bounded blockers: partial integration definitions
reported unchanged and a Node minimum below compressed-history requirements.
The user authorized their correction and a rebuilt local 2.1.0 verification.
Preserve user profiles and running clients. Temporary package installs and
bounded native test fixtures are verification, not an installed xfx update.
UI and other providers remain deferred. Do not publish or update installed xfx.

## Current position

R1/R2 are implemented in the working candidate and have passed local verification:
readable bounded setup diffs, complete-inventory absence evidence, explicit
same-task declarations, recorded client/setup provenance, claim-specific eligibility
and capability-based audit readiness. Existing profile, runner, history and frozen
report paths are reused. See the assessment's implementation checkpoint for limits.

R3 is implemented locally: both audit entry paths accept optional attributed
human/AI reviews, exact-evidence supplemental checks and immutable revisions;
ordinary show/export/reopen includes the current review view and original evidence.
R4 adds repeated findings and outcome comparisons to scheduled series and
selected existing-session cohorts, with per-claim coverage and optional attributed
reviews. R5 now includes actual native CLI capture/import and a complete retained
Desktop pair through comparison, review and source-free export/reopen. Final
source and exact-package checks are recorded with each local candidate artifact;
fixture-only results are not substituted for this native evidence. No publication
or installed update has occurred in this work.

Published/installed 2.0.0, the local 2.1.0 candidate and a release-ready product are distinct
states. Historical M1 report checks and M2's real reviewed pair are useful evidence,
but neither satisfies the full contract. One pair cannot establish consistency.

## Delivery milestones

All five milestones are required for this release. Complete usable outcomes;
passing a fixture or implementing a schema alone does not close a milestone.

| Milestone | Concrete change | Observable completion |
| --- | --- | --- |
| R1 — Complete profile setup diffs | Extend existing discovery/comparison/render/export for safe config values, instructions/agents/rules, skill package resources, installed/available tools, MCP/plugin definitions and memory settings. Show origin, scope and coverage; retain the copy policy. | Create/change independent profiles and explain each requested category's differences, including a changed skill resource with unchanged SKILL.md. Missing, unreadable, redacted and unresolved effective state never become false equality or absence. Native/manual changes are supported; no generic settings editor is required. |
| R2 — Both audit entry paths | Reuse the Codex runner and exact existing-session/frozen-report readers. Record task association and declared differences with provenance; separate recorded setup from today's setup. Replace blanket comparability and version-only gates with per-claim evidence and actual capability checks. | xfx-started runs, directly started CLI sessions and directly started Desktop sessions enter the same comparison flow. IDs resolve to the owning profile without cross-profile fallback. Intentional config/model differences retain supported findings. Unknown historical input or task-end code limits dependent claims; supported data does not fail solely for an unfamiliar version. |
| R3 — Coherent outcomes and optional review | Reuse immutable evidence/review storage for direct comparisons and series. Attach supplemental checks and human/AI reviews to the exact compared evidence; include them in the ordinary current view, export and reopen. | Unreviewed, human-only, AI-only and combined cases work. Reviewer identity/type, scope, revisions and disagreement stay visible. Original failures remain distinguishable from later checks. A human or another agent can review an exported packet and attach the result; no automatic judge is required. |
| R4 — Consistency and understandable reports | Extend existing repeated-run statistics with recurring/contradictory findings, eligible pair counts and associated outcomes. Support selected existing-session cohorts, retaining failures and unknown denominators. Apply the goal's reading order. | Readers answer what differed, how often and with what outcome without an agent reconstructing scattered records. Repetitions from both entry paths retain all selected/planned sample states. One pair remains usable with consistency unmeasured. Export/compact/source-free reopen retains claims and limits. |
| R5 — Codex macOS release acceptance and packaging | Verify R1–R4 on actual supported CLI/Desktop workflows, preserve normal profile/client operations and recovery, document the user paths, and build/test the exact distributable through the existing release process. | The product acceptance and package gates below pass against the final candidate, with no unresolved blocker to the promised scope. Evidence is specific about what is live, fixture-backed, partial or unknown. Publication and installation into existing user state remain separate actions. |

R1–R3 reuse the existing discovery, comparison and review paths. R4 builds on
their common semantics. Keep the assessment's implementation
packages aligned with these milestones instead of maintaining a second priority list.

## Release-ready acceptance

Use one concise acceptance record for the final candidate, with links to retained
evidence and explicit remaining limitations. Reuse existing controls and historical
evidence where still applicable; obtain fresh evidence for materially changed paths.

- **Profiles and setup:** create/select at least two independent Codex profiles;
  demonstrate useful differences for every requested discoverable category and
  distinguish declared, installed, available and observed-use states. Check CLI
  and Desktop applicability. Preserve unrelated settings, integrations and state.
- **Three user journeys:** xfx-started same-task comparison; direct Codex CLI tasks
  selected by session ID; direct Codex Desktop tasks selected by session ID. Show
  task association, paired actions, outcome/artifact evidence and honest gaps.
  The existing xfx runner can supply the first journey; a new Desktop automation
  runner is not a release dependency.
- **Review and repetition:** exercise optional review modes, immutable revisions,
  original/supplemental checks and selected existing-session cohorts as well as
  scheduled runs. Use enough repeated evidence to exercise recurrence and
  contradiction; include missing/failed samples. No fixed 12-slot benchmark or
  forced statistically significant winner is required.
- **Usability and durability:** a reader follows the documented commands, sees
  findings and evidence in the agreed order, exports and reopens without original
  source sessions, and understands unknowns. Check wrong/missing IDs, partial
  capture, interruption/resume/recovery and safe owned cleanup. Preserve running
  clients, credentials, profile ownership and unrelated work. Investigate concrete
  blockers locally; do not introduce a VM prerequisite.
- **Final source and distributable:** run required syntax/native/full-suite checks,
  inspect the public source/package boundary, and use the existing detached bundle
  and temporary-prefix install smoke from [the release process](LOCAL-RELEASE.md).
  These packaging fixtures are not isolated model-execution requirements. Test
  packaged commands/examples and export/reopen, and verify reviewed public goal,
  roadmap and assessment links are included in the package allowlist. Keep private
  handovers, receipts and session data out. Record source/artifact identity and
  distinguish candidate, released and installed versions.
- **Release record:** document behavior changes, migration/update implications,
  known evidence limits and recovery instructions. Prepare clean reproducible
  release source and the verified artifact under the necessary authorization.
  Do not substitute a dirty-checkout test result for an installable final release.
  Publishing or updating a live installation requires the applicable user request.

Unknown native state is an accepted evidence limitation when it is clearly shown;
a missing implemented path or misleading comparison is a release blocker. Record
actual third-party versions for reproducibility, without promising a version matrix
or pinning users to the verification build.

## Cleanup and next action

Cleanup completed in documentation: one public active roadmap, explicit first
release scope, historical-only isolation/campaign instructions, dated release
records, and clear separation between roadmap, copy policy and acceptance evidence.
Original receipts and dormant harnesses remain preserved. R2 now replaces the runtime version-only and blanket comparability gates.
R3 now integrates previously separate review supplements into saved evaluation
reports; documentation changes alone never count as runtime fixes.

R1/R2 local implementation and verification are complete. Final checks: 985 tests
passed, zero failed, one existing opt-in Desktop check skipped; syntax, packaged
native-helper integrity and whitespace checks passed. Retained real M2 run evidence
reopened with recorded same-task association and nine findings, without native
session access or new model execution. Review fixes cover absent/pre-task evidence,
source-free task evidence retention, and skill executable modes. This is not fresh
account-backed CLI/Desktop acceptance. R3/R4 were subsequent local implementation milestones; no
publication or installed update occurred. Do not resume the old campaign, remove
production preservation controls, delete unrelated output or start UI/provider work
as implied cleanup.

R3 implementation adds `audit evaluate UUID|REPORT.json [--spec REVIEWS.json]`
to the existing private evaluation store. A packet binds the normalized source,
review scopes and references; check references identify their run. Human/AI
identities, optional rubric scores, preferred runs, revisions and disagreement
remain separate. Supplemental check identity must match a recorded run candidate
and frozen recipe; its self-attributed result never replaces original failure.
Frozen exports contain the source and full review history for source-free reuse.
The older series human-rubric input remains supported. No judge or check executor
was added. See the [review workflow](../user/AUDIT.md#review-either-audit-entry-path).

R3 verification on 2026-10-22: **1,004 tests passed, zero failed, one existing
opt-in Desktop check skipped**. Syntax, native-helper integrity and whitespace
checks passed. The extended CLI series fixture separately passed typed AI rubric
review and source-free export, with no additional task launches. Direct CLI/Desktop
session fixtures cover review modes, revisions, disagreement and removal of source
sessions/store before reopen. A retained real M2 pair produced an unreviewed packet
with two runs, two candidates and two recipes, then reopened with identical text
after its temporary source/store were deleted. A bounded independent review found
no remaining material R3 defect after the evidence-ownership and series fixes.
These are local/retained-evidence checks, not fresh account-backed client acceptance.

## R4 implementation checkpoint

Scheduled series and `audit cohort --spec COHORT.json` now share consistency,
outcome, review and export paths. Cohorts select exact profile/session IDs, saved
runs or frozen comparisons/evaluations; missing and failed selections remain in
the selected denominator. Reused evidence and inconsistent profile arms are
rejected. Cohorts are captured evidence records with no tasks to resume or owned
processes/workspaces to recover or clean.

Reports identify recurring, variable and contradictory ordered findings, their
eligible/excluded/missing counts, and named-check results associated with those
behaviors. Task identities form separate groups. Original checks and external
supplements remain distinct; optional reviewer scores stay separate by reviewer
and exact rubric. One pair stays unmeasured. Native recorded span and token scope
survive compaction; no elapsed-span-to-task-time conversion or quality/cost claim
is introduced. Pooled metrics are labeled when selected tasks differ.

The ordinary report follows conditions → findings → paired action evidence →
verification → time/tokens → outcome/code, with detailed retained evidence below.
Export/reopen rebuilds derived claims from frozen evidence and canonical review
history, preserving existing R3 review bindings. Identity is keyed by profile ID,
even when display names or native session UUIDs overlap across profiles.

R4 verification on 2026-10-22: the full repository suite passed **1,033 tests,
zero failed, one existing opt-in Desktop skip**. Final semantic-reversal and mixed-outcome
refinements were then verified by the focused cohort/consistency/statistics/
integration suite: **56 passed, zero failed**. Syntax, native-helper integrity
and whitespace checks passed on the final source. The extended scheduled CLI
fixture passed show/export/review/reopen with six fixture task launches and no
extra launches for reviews. Actual native readers exercised synthetic CLI and
Desktop rollouts, including declared task association, scoped span, missing
samples and source-free reopen.

The retained real M2 pair also passed cohort creation, optional unreviewed packet
creation and identical source-free rendering after temporary sources/store were
deleted: two original runs, nine findings, one selected pair and consistency
unmeasured. No repetitions were manufactured from that pair. Independent review
found and helped fix profile-name collisions, lost native metrics, task grouping,
per-check eligibility and declaration handling; its bounded re-review found no
remaining supported blocker. This is local/retained-evidence verification, not
fresh account-backed client acceptance.

R5 verification is underway in the checkpoint below. UI and other providers
remain deferred. No publication or installed update is authorized.

## R5 verification checkpoint

The local 2.1.0 candidate was checked on macOS 26.6.2 with Node 23.11.0 and the
installed Codex native binary 0.163.0-alpha.11.1. These are observed test versions,
not requirements or an allowlist. The exact package verification record belongs
with the local release artifacts; this checkpoint does not declare publication.

Fresh native checks exercised actual app-server startup/protection and a completed
workspace-write capture through the normal xfx startup path, plus direct
`codex exec --json` and exact session-ID import. The bounded tasks used a
credential-free local scripted provider. They prove protocol/capture mechanics,
not account authentication, model quality or outcome superiority. Best-effort
skill coverage remains partial. The macOS LaunchServices fixture passed open,
focus, reopen and close using a disposable synthetic vendor app; it is lifecycle
evidence, not an account-backed Codex Desktop task.

Read-only inspection also exercised actual profile discovery for CLI/Desktop.
The initially missing Default Desktop rollouts were retained as `.jsonl.zst`
while the native index still referenced `.jsonl`. The reader now supports that
exact compressed sibling, with bounded decoding and unchanged source ownership
checks. A complete retained Default/comparison-profile pair entered the ordinary
comparison, one-pair cohort, attributed AI review and source-free export/reopen
path. Both sources identify Codex Desktop and contain byte-identical initial task
text plus native completion. Later follow-up instructions differ and are declared.
The report retains 32/35 normalized actions and nine findings; the Default side's
bounded child-discovery coverage remains partial. One pair leaves consistency
unmeasured, and unknown historical checks/code do not become outcome proof.
Retained real M2 evidence supplies a separate paired outcome/review example.

Acceptance found and fixed three narrow integration defects: native process
observation rejected macOS's negative-UID system rows; explicit Default history
listing failed to resolve the built-in profile; and `codex_exec`/`exec` evidence
was not recognized as CLI provenance. Regression checks cover each. Package
allowlisting now includes the public goal, roadmap and assessment and excludes
the private operational handover, while retaining reviewed sanitized summaries.

The read-only failure was traced to executable resolution, not the requested
sandbox policy: both policies passed with the native binary and failed with the
packaged shell wrapper. The startup guard had named the wrapper instead of the
process image it launches. It now recognizes the supported wrapper layout/body,
verifies the canonical bundled Mach-O image, and launches it under the existing
policy. Symlink escapes and unverified wrappers fail closed. No preservation
exception or silent policy change was added. Both native policy preflights passed;
a wrapper-selected read-only task completed through one local scripted response,
and all 20 native protection controls passed after the fix.

These two named R5 gaps are closed by workflow evidence. The compressed reader
checks the runtime's built-in Zstandard capability and reports unavailability on
older Node runtimes without it; it does not require a system decoder or rewrite
native history. Compression, stored-source hashes and decoded byte counts remain
explicit. Regression checks and independent review cover bounded decoding, exact
profile ownership, unsafe fallback, source-free export and native-image validation.
The final source suite and rebuilt distributable are verified together in the local
closure acceptance record, including packaged links and temporary-prefix commands.

Evidence boundaries remain: local scripted native tasks do not prove remote
account behavior or model quality; retained Desktop sessions are historical, not
new tasks; the lifecycle fixture uses a synthetic vendor app. Partial historical
coverage is visible, not a missing implemented entry path. No paid campaign, UI,
other-provider work, publication or live installation update is implied.

## After the Codex macOS release

Assess UI against the usable CLI/report workflows and revisit the Evidence
Workbench proposal. Assess Claude Desktop/CLI, the specific desired Copilot
surface and other providers against real local interfaces and evidence. Identify
support and gaps before proposing adapters or promising parity. These are later
assessment topics, not accepted implementation milestones or current blockers.

## Repeated native acceptance — 2026-10-23

A bounded account-backed check completed two balanced Default/comparison-profile pairs
through each entry path: four xfx-started tasks and four direct Codex CLI tasks.
All eight completed without replacement or timeout and passed the existing two
visible and six acceptance cases. Saved profile settings, prior running clients,
Desktop ownership state and installed xfx 2.0.0 were preserved. UI and additional
providers remain deferred; no publication or installed update occurred.

The scheduled report correctly records two eligible pairs, recurring editing-scope
and visible-test observations, and the same named outcome in both pairs. Separate
AI review found no better profile on those checks. Models/reasoning differed, so
elapsed/token differences do not establish a profile-caused improvement.

Direct-session validation exposed two narrow local fixes: the saved-profile
startup guard now permits a constrained `codex exec` invocation with the existing
native command sandbox, and exact-ID audit lookup reuses the bounded same-profile
retained-rollout locator when the native index has no row. Unsafe/ambiguous sources
and malformed indexes still fail closed. The original local 2.1.0 tarball remains
unchanged and does not contain these fixes.

**Direct-session evidence gap closed:** the shared native reader now derives named
actions and relative edit paths from recorded session/turn working directories,
without reading today's checkout. The existing `audit evaluate --spec` path can
attach attributed task boundaries, retained file manifests and check recipes to
exact native run/profile/session/source identities. New immutable evaluations
accept supplemental checks through the existing review packet; original claims,
checks and historical reports remain unchanged.

Reassessment used the same four completed direct sessions and existing checker
receipts, with no new model tasks or check executions. The ordinary CLI cohort now
retains two eligible pairs, recurring observed in-boundary edits and visible-test
execution, and two matching paired supplemental acceptance outcomes. Other findings
remain unmeasured. Unknown native token totals remain unknown. Supplied historical
manifests/checks are explicitly attributed, not promoted into original native
observations or proof of complete capture. Optional AI review found no better
outcome on the retained checks; no human scores or consensus were invented.

The bridge reuses comparison, review, cohort, statistics and export storage. It
also supports recorded Desktop context through the same reader; the retained real
Desktop pair remains historical evidence with differing follow-ups and no supplied
task-end checks. Exact candidate acceptance must include the full source checks,
packaged direct-session attachment/cohort workflow, retained Desktop workflow,
source-free exports, package boundaries and preservation of the live installation.
The local acceptance receipt records the exact replacement bundle identity and
results. UI, other providers, publication and installed updates remain deferred.

## Final-review blocker corrections

The local source now leaves matching partial MCP/plugin/hook definitions unknown
instead of claiming equality from their disclosed fields. Known safe field changes
remain visible; ordinary CLI export and source-free reopen retain this distinction.
The regression first reproduced the false equality, then passed with the correction.

Node requirements now start at 22.15.0 in the 22.x line or 23.8.0+, including the
built-in Zstandard decoder needed by compressed Desktop history. Package metadata,
installer checks, user guidance and the minimum-runtime CI job agree. Compressed
session tests no longer skip for a missing decoder. This is an application runtime
requirement, not a provider version pin or compatibility matrix.

The replacement local bundle must pass final source/package checks and reuse the
retained xfx/direct CLI/Desktop reports to verify the agreed goal. Its private
acceptance record identifies the exact artifact, checks and preservation evidence;
earlier artifacts and reviews remain unchanged. No additional model runs, UI,
provider work, publication or installed update are required for these corrections.
