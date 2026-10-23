# Profile comparison and audit: capability assessment

Baseline assessed 2026-10-22, before R1/R2 implementation, against the clarified [shared product goal](AUDIT-GOAL.md).
Scope: current working source, existing fixture checks and retained documentation.
Delivery scope: Codex CLI and Desktop on macOS first, as defined in the
[active roadmap](ROADMAP.md). UI and other providers are assessed after that release.
The original assessment did not authorize implementation. The user subsequently
authorized R1/R2, R3, R4 and R5 verification; the implementation checkpoints below supersede
affected baseline gaps and proposals. Final native/package release acceptance remains R5.

Package metadata alone does not mean that candidate behavior is released.
Implementation checkpoints distinguish local verification from published and
installed versions. Source was inspected directly; the assessment does not claim
Claude/Copilot support from documentation or from shared report schemas.

## R5 verification checkpoint

Native acceptance exposed three repaired integration gaps: explicit built-in
Default history listing, macOS negative-UID process observation, and native
`codex_exec`/`exec` CLI provenance. Public documentation is now included in the
package allowlist; a private operational handover is excluded. The local candidate
is 2.1.0; published/installed 2.0.0 remains separate.

See the [R5 checkpoint](ROADMAP.md#r5-verification-checkpoint) for fresh native,
retained Desktop and lifecycle-fixture evidence and its limits. The two subsequent
acceptance gaps were diagnosed and repaired: the startup guard now resolves and
validates the supported packaged wrapper's actual native image; the session reader
supports bounded `.jsonl.zst` history with explicit stored/decoded byte semantics.
The wrapper-selected read-only capture completed with protection intact. The
retained Desktop pair passed comparison, optional AI review and source-free reopen;
its initial task text matches, while later follow-ups and partial coverage remain
visible. Final-source and exact rebuilt package checks belong to the local closure
record. These changes add no UI, providers or execution-environment platform.

## R4 implementation checkpoint

Repeated xfx series and selected existing-session cohorts now share the existing
series/report format. The new [cohort reader](../../src/audit-cohort.js) selects
exact native profile/session IDs, saved runs or frozen comparison/evaluation
files, including source reviews. It preserves missing/failed slots, rejects reuse
of underlying evidence and requires stable profile arms. Profile IDs take
precedence over display names; session UUIDs remain scoped to their owner.

The [consistency projection](../../src/audit-consistency.js) extends existing
[statistics](../../src/audit-statistics.js) with ordered recurring/variable/
contradictory findings, per-claim sample counts, task-specific groups, named-check
outcome associations and attributed reviewer/rubric comparisons. An incompatible
check recipe does not suppress an unrelated matching named check. Unknown,
missing or duplicate evidence cannot become a negative observation or an extra
repetition. Selected cohorts have an unknown overall planning denominator.

Native session spans remain explicitly distinct from xfx task duration. Existing
pooled metrics remain descriptive and labeled when they span task groups. The
ordinary renderer follows the agreed reading order and retains detailed trial
evidence. Source-free export/reopen recomputes projections without changing
fingerprint-bound R3 subjects; imported review history is validated again.

The [documented command path](../user/AUDIT.md#compare-consistency-across-repeated-runs)
supports optional review and ordinary show/export for both entry paths. R4 adds
no task executor, automated judge, UI, provider adapter or version matrix. Local
verification is recorded in the [roadmap checkpoint](ROADMAP.md#r4-implementation-checkpoint);
fresh client acceptance and packaging remain R5.

## R3 implementation checkpoint

The existing `audit evaluate`, immutable evaluation records and report export
paths now support finalized runs/experiments/series and frozen comparisons from
direct CLI/Desktop session selection. Without a submission, evaluation creates
an explicitly unreviewed packet. Human-only, AI-only and combined submissions
bind the exact frozen evidence, run-qualified references and declared review scope.
Optional rubric ratings reuse existing validation; AI ratings do not masquerade
as legacy human scores. Revisions retain prior judgments, identity and attribution;
different current conclusions or preferred runs expose disagreement.

Supplemental results require a recorded candidate fingerprint and check recipe
for that run, and explicit external attribution. They remain separate from original
checks and do not rewrite original status/exit codes. Missing historical candidate
or recipe evidence prevents attaching a falsely bound check, while qualitative
review remains possible. xfx does not launch a model judge or run these checks.

Ordinary show/export/reopen renders current attached reviews alongside the original
outcomes. New packets include frozen source and canonical review history, so an
export can be revised in an empty store after original sessions disappear. Stored
history is revalidated on reopen; malformed references, conflicting fingerprints
and branching revisions are rejected. Existing series human-rubric input remains
available, and its original score aggregates are explicitly distinguished from
new per-reviewer scores.

Implementation: [review model](../../src/audit-review.js),
[evaluation controller](../../src/audit-review-command.js), existing
[command dispatch](../../src/audit-experiment.js), [store](../../src/audit-store.js)
and [renderer](../../src/audit-report.js). The
[user workflow](../user/AUDIT.md#review-either-audit-entry-path) covers both entries.
Review fixes include compact-series rubric validation, duplicate supplemental IDs,
preserving preferred-run judgments and rejecting references from the wrong run.
This is local implementation; actual Codex macOS release acceptance remains R5.

R3 verification: **1,004 passed, zero failed, one existing opt-in Desktop skip**
in the full repository suite; syntax/native-helper integrity/whitespace passed.
The extended existing CLI series fixture separately verified typed AI rubric
assessment, original/current score labels, export/reopen and no extra task launches.
Both direct-client fixtures and stored-run fixtures exercise the normal command
path. Retained real M2 evidence also passed unreviewed packet creation and identical
source-free rendering. The independent review's final bounded pass found no
remaining material issue. No real client/model execution, publication or installed
xfx update was performed for R3.

## R1/R2 implementation checkpoint

The working candidate now extends the existing paths:

- Setup discovery retains bounded redacted instruction/agent/rule and skill-package
  details, safe configuration/memory/integration/tool values and file modes. Complete
  matching inventories can prove additions/removals; partial or redacted observations
  cannot prove equality or absence. Runtime activation/availability stays unknown
  when static sources cannot establish it.
- Direct and frozen-run comparisons accept `--same-task LABEL` and
  `--variables LABEL,LABEL`. The durable selection records owning profile/session,
  recorded client identity where available, declarations and task-association basis.
  Recorded conflicting task fingerprints override a user declaration. Export/reopen
  revalidates the comparison rather than trusting a saved eligibility label.
- Behavior, same-task timing, check recipes, rubric definitions, code baselines and
  token accounting have separate evidence rules. Intentional model/config/version
  differences no longer suppress supported behavior. Missing sources and pre-task
  failures must not count as observed tasks.
- Audit readiness treats native versions as descriptive metadata; execution still
  checks executable identity and the existing startup/capture capabilities. Unknown
  derived token accounting remains unknown. No provider compatibility matrix added.
- Setup exports omit source text by default; `--include-content` explicitly retains
  selected redacted details. Exports remain private local records with possible paths
  and metadata, not automatically public-safe artifacts. Run transcripts remain out.

Relevant additions are [setup detail comparison](../../src/audit-profile-diff.js)
and [comparison selection](../../src/audit-selection.js), integrated into existing
[discovery](../../src/audit-discovery.js), [commands](../../src/audit.js),
[reports](../../src/audit-report.js), [store](../../src/audit-store.js),
[session reads](../../src/audit-session.js) and [runner](../../src/audit-runner.js).
The [user guide](../user/AUDIT.md) describes the candidate commands. Installed and
published xfx have not been changed. No real Codex account-backed task or Desktop
client operation was performed; native release acceptance remains R5.

R1/R2 verification on 2026-10-22: the final repository suite passed **985 tests,
0 failed, 1 existing opt-in Desktop skip**. Syntax, prebuilt native-helper integrity,
whitespace and 70 local documentation links passed. The suite ran outside the
outer tool sandbox so its own macOS sandbox-exec fixture controls could execute;
production startup preservation was not weakened. A scoped reviewer verified the
absent-session/task-start and source-free compaction fixes and found no remaining
material issue in that pass. Retained real M2 runs also reopened as a recorded
same-task pair with nine findings, without native session access or new execution.
These results establish local implementation checks, not a new live Codex/Desktop
pilot or completed release acceptance.

## Baseline findings and proposals

The remaining sections preserve the pre-implementation source assessment and its
original verification. Use the checkpoint above for implemented R1/R2 behavior and
the roadmap for current priority. Historical source line numbers may have moved.

## Main finding

Reuse the existing paths. `xfx audit profiles` already compares broad setup sources,
`audit show/diff` already reads selected existing Codex CLI/Desktop sessions, and
`audit run` already executes local Codex experiments. The missing outcome is a
complete, understandable comparison across the requested categories and both
Codex clients. Other-provider gaps below describe later work, not this release gate.

The largest gaps are: detailed source/package/settings diffs; MCP/tool/memory
coverage; client-started task association and outcomes; a global comparability
gate that rejects intentional profile differences; optional AI/human review of
either entry path; and behavioral consistency across repeated evidence. Support
beyond Codex is absent and deferred to assessment after the Codex macOS release.

## Baseline capability map

| User requirement | What current source supports | Missing or limited | Evidence |
| --- | --- | --- | --- |
| Create independent profiles | Named Codex homes, preview/apply creation, optional selected seeding, binding, inspect, CLI/Desktop routing; later changes remain independent. | Codex/macOS-specific. No general provider-neutral editor; user/native settings edits and supported copy operations are the current mutation paths. | [profile command](../../src/profile-command.js), `profileCommand`; [profiles](../../src/profiles.js); [profile guide](../user/PROFILES.md). |
| Broad profile comparison | `xfx audit profiles LEFT RIGHT [--repo ABS_PATH --client cli\|desktop]` compares profile/user/project/system/admin/plugin resources independently of copy eligibility. | A declared-source inventory, not resolved effective runtime state. Client choice labels intended context; applicability and precedence remain unknown. | [audit](../../src/audit.js), `compareAuditProfiles`, lines 11–54; [discovery](../../src/audit-discovery.js), `discoverAuditProfile`, lines 317–356. |
| Config values | Safe selected model/effort, approval/sandbox, agent and feature settings receive value comparisons. Other setting names remain visible with omitted values. | Broad settings, memory settings and provider-specific configuration are not fully projected. A whole-config fingerprint excludes secret values; it cannot establish full config equality. | [discovery](../../src/audit-discovery.js), `safeSettingValue` / `publicConfigProjection`, lines 13–70, 180–229; privacy fixtures in `test/audit-discovery.test.js`, lines 85–123. |
| Instructions, agents, rules | Source identity/origin and bounded content fingerprints establish observed content changes. | Ordinary audit profile report does not show textual hunks explaining those changes. Copy previews have selected text-diff machinery, but are a mutation workflow and have a narrower selection scope. | [discovery](../../src/audit-discovery.js), `fileResource` / `discoverHome`; [copy planner](../../src/advanced-copy.js), `buildAdvancedCopy`; [renderer](../../src/audit-report.js), profile comparison branch around line 1685. |
| Skills and packages | Discovers same-name skills across origins, canonical aliases and plugin association; fingerprints `SKILL.md`. Selected skill-copy preview compares a broader package tree. | Audit comparison does not establish equality of all scripts/resources inside the package. Catalog/presence does not prove availability, loading or adherence. | [discovery](../../src/audit-discovery.js), `discoverSkillRoot`, lines 142–168; [advanced copy](../../src/advanced-copy.js); discovery fixtures in `test/audit-discovery.test.js`. |
| Tools, MCPs, plugins, hooks | Setup comparison records configured integration names; plugin caches provide limited manifest/version data and plugin skill discovery. Captured runs have tool/MCP/hook observations. Manual setup guidance compares additional definition metadata. | No complete field-level integration diff or static installed/available tool inventory. Same integration names can hide changed definitions. Cache version is not installed/enabled/authenticated state. Observed tool use is not the available-tool catalog. | [discovery](../../src/audit-discovery.js), lines 224–289; [setup guidance](../../src/setup-guidance.js), `inspectSetupGuidance`; [tool evidence](../../src/audit-tools.js). |
| Memory settings | Full profile inspect contains a names-only memory inventory; unsupported config keys can be listed without values. | Audit setup comparison has no explicit memory-settings model. Inspecting memory filenames is not comparing memory settings. Memory contents/copy remain outside the requested scope. | [inventory](../../src/profile-inventory.js), lines 312–327; [discovery](../../src/audit-discovery.js), `discoverHome`; [copy policy](PROFILE-COPY-POLICY.md). |
| Added/removed/unknown states | Uses added/removed/changed/unchanged/unavailable buckets; only explicit present-versus-missing supports addition/removal. One-sided uncorroborated records stay unavailable. | Discovery-wide partial coverage prevents some simple-looking absent-resource claims. Preserve this distinction while improving scoped coverage; do not turn every one-sided item into an addition/removal. | [audit](../../src/audit.js), lines 25–54. |
| Audit an existing session | Exact owning profile plus native UUID, including archived CLI/Desktop sessions indexed under that home; no cross-home fallback or task launch. Frozen run reports also compare offline. | Codex history schema/UUID assumptions. No provider-qualified non-Codex ID support. The chosen profile must own the Desktop session; there is no separate Desktop service connector here. | [audit](../../src/audit.js), lines 56–113; [session reader](../../src/audit-session.js), `auditNativeSession`, lines 1078–1114; CLI fixtures in `test/audit-cli.test.js`. |
| Run through xfx | `xfx audit run --spec FILE` and `--dry-run`; 2–8 Codex profiles, explicit Git revision/task, local task workspaces, setup/check commands, task capture, optional criteria and repeated trials. | Structured experiment path, not arbitrary client invocation. Requires registered execution details and repository state. Current version equality checks can reject otherwise capable clients. | [spec](../../src/audit-spec.js), `validateAuditSpec`; [runner](../../src/audit-runner.js), `previewAuditExperiment`; [series](../../src/audit-series.js). |
| Same task from direct sessions | Can display and compare retained actions, controls and coverage. | Ordinary historical sessions do not automatically have the frozen task/input/check/setup identities created from an xfx spec. No durable user-declared association path supplies their provenance. A title is not sufficient proof. | [conditions](../../src/audit-conditions.js), `buildAuditComparisonConditions`; [explanation](../../src/audit-explanation.js), `compareAuditConditions`; [replay](../../src/audit-replay.js). |
| Historical outcomes | Retains supported completion, action and artifact evidence; does not substitute today's checkout for a task-end result. | Code baseline/final artifacts and independent checks may be absent. Retrospective audit cannot recover evidence that was never recorded. | [session](../../src/audit-session.js); [report](../../src/audit-report.js), `compareArtifacts` / `compareOutcomes`; [audit guide](../user/AUDIT.md). |
| Understand behavior | Local candidate derives named actions, findings, source/actor references and explicit unknowns; export/compaction/reopen retain them. | Narrow literal recognition; unsupported wrappers stay unknown. Current global eligibility makes all findings inconclusive when model/effort/version/setup differs. Report detail can overwhelm findings. | [actions](../../src/audit-actions.js); [explanation](../../src/audit-explanation.js), lines 392–456; [report](../../src/audit-report.js). |
| Optional human / AI / both reviews | Immutable human rubric evaluations of finalized xfx series via `audit evaluate SERIES_UUID --spec FILE`; export permits external review. | No equivalent attachable review path for direct-session comparisons; no typed AI reviewer/result contract or multiple reviewer identities per run in one evaluation. AI review can occur outside xfx but is not an integrated result. | [series](../../src/audit-series.js), `evaluateAuditSeries`, lines 339–359; [quality](../../src/audit-quality.js), review validators; [guide](../user/AUDIT.md), “Add a human review.” |
| Repeated comparisons | xfx series scheduling, planned/not-run slots, distributions and paired metric/quality summaries. | Finding-level recurrence/contradiction and arbitrary existing-session cohorts remain incomplete. One accepted pilot does not establish consistency. | [series](../../src/audit-series.js); [statistics](../../src/audit-statistics.js); [explanation](../../src/audit-explanation.js). |
| Multiple providers/clients | Codex CLI execution/capture and Codex CLI/Desktop history; shared report/evidence code provides reusable foundations. | No Claude or Copilot profile/session/launch adapters found. Metadata called provider/plugin is resource provenance, not support for another coding client. | [package](../../package.json); [profiles](../../src/profiles.js); [discovery](../../src/audit-discovery.js); [capture](../../src/audit-capture.js), Codex app-server protocol; [version probe](../../src/version-probe.js). |

## Both existing audit entry paths

These are current commands, not proposed syntax. Examples are illustrative and
were not run against user profiles during this assessment.

```sh
# Setup comparison
xfx audit profiles Default Research --repo /absolute/project --client cli

# Session started directly in Codex CLI or Desktop, in the selected profile home
xfx audit show --profile Default --id SESSION_UUID
xfx audit diff --left-profile Default --left-id LEFT_UUID \
  --right-profile Research --right-id RIGHT_UUID

# xfx-started experiment
xfx audit run --spec /absolute/experiment.json --dry-run
xfx audit run --spec /absolute/experiment.json

# Existing frozen evidence; no source session required
xfx audit diff /absolute/left-run.json /absolute/right-run.json
```

The direct path already meets “xfx did not have to start the task” for supported
Codex session sources. The gap is a useful same-task interpretation, optional
review and coherent outcomes when historical inputs are sparse. Do not solve
that by making a wrapper or a new xfx-run campaign mandatory.

## Concrete goal mismatches

**Intentional profile differences disable findings.**
`compareAuditConditions` currently requires task, baseline, nativeVersion, model,
effort and setup equality before declaring the pair eligible. `setupFingerprint`
includes the per-profile `nativeConfig`. Declared `variables` only relax the
selected-skill difference check; they do not relax model/effort/setup/version
requirements. `finding` changes every classification to inconclusive when the
global eligibility fails, and check/review eligibility also depends on it.
Existing tests (`test/audit-explanation.test.js`, lines 82–88) explicitly enforce
that behavior. This is a confirmed current contract mismatch, not a new
runtime failure discovered by the test run.

**Version independence is incomplete.** Required-context capture was changed to
capability validation, but [runner readiness](../../src/audit-runner.js), lines
148–175, still requires a version and compares it to requested/registered version;
execution rechecks frozen version around lines 334–336. Profile/version parsing
also assumes Codex version strings. Separately, [usage accounting](../../src/audit-usage.js),
lines 9–20, permits derived workflow accounting only for one inspected native
version. Those are different concerns: remove version-only launch/comparison
gates, but do not turn unverified counters into valid totals. Replace ongoing
release-specific accounting support with a validated semantic contract where
available; otherwise retain scoped source counters and unknown derived totals.
Do not extend a daily version allowlist.

**Review is bound to the experiment harness.** The current immutable evaluation
path requires a finalized series and admits at most one submitted review per run
in that evaluation. Its output explicitly labels the method human rubric review.
The user's optional AI/human/both requirement cannot be met by putting AI scores
into that human field. External packet review is useful existing functionality;
automatic model invocation is not needed for the first integrated review path.

## Proposed implementation packages for the Codex macOS release

These proposals are not new commands or shipped capabilities. Reuse current entry
points and storage before adding another subsystem. The [roadmap](ROADMAP.md) owns priority and release acceptance;
the table identifies concrete scope and acceptance.

| Package | Concrete changes and reuse | Observable done condition |
| --- | --- | --- |
| R1 — Full setup diff | Extend `discoverAuditProfile`, `compareAuditProfiles` and existing report/export layouts. Add category coverage, safe setting values including memory settings, bounded readable source diffs, and skill package file/resource differences. Reuse safe copy-preview primitives where applicable without invoking apply or widening copy eligibility. Compare vetted integration definition fields and retain explicit redacted/unknown values. Distinguish provider/ownership identity from path or display-name equality. | After changing config, instruction text, a skill script with unchanged SKILL.md, a safe MCP setting and a memory setting, the existing profile comparison explains each change. System/plugin/project sources remain visible; a missing/unreadable source cannot become “identical” or a false removal. Secret sentinels do not escape sanitized output. |
| R2 — Both entry paths, useful comparison conditions | Keep exact profile/session selection and frozen JSON paths. Add a small durable comparison descriptor associating provider/client/profile/session identities with the task/input basis, declared differences and evidence origin. Recorded facts, user declarations and unknowns remain separate. Reuse `audit-conditions`, explanation, replay and store. Separate action-level observations from task comparability and metric/check/rubric eligibility; intended model/config differences remain visible rather than globally disabling findings. Remove execution rejection based solely on exact native-version equality; validate required protocol/data capabilities and retain source counters when derived accounting is unknown. | A direct CLI pair and a direct Desktop pair can be selected without xfx launching them and produce the same readable structure as xfx-run evidence. Declared task association is labeled, never forged into recorded proof. Missing historical code/controls limit only dependent claims. Different models or versions do not erase supported actions. |
| R3 — Outcomes and optional review for either path | Reuse review validation and immutable evaluation storage for direct comparisons as well as series. Bind original/supplemental checks to exact candidate/task/recipe evidence. Add explicit human/AI reviewer type, identity, method, rubric when used, scope and revisions; preserve multiple/disagreeing reviews. Support exporting a review packet and attaching a separately produced review before considering any automated judge. | Human-only, AI-only, both and unreviewed comparisons render honestly, export and reopen. Original checker refusal, later passing checks and confirmed review appear together without rewriting originals. AI scores cannot masquerade as human ratings. |
| R4 — Consistency and ordinary-user acceptance | Extend existing series/statistics with per-finding eligible pair counts, recurrence/contradiction and outcome associations. Allow selected existing-session cohorts with an explicit corpus/unknown planning denominator. Refine the existing report and documented CLI workflow. Defer UI assessment until after this release. | Users can explain differences, follow paired evidence, distinguish limitations/reviews, assess repeated patterns, export/reopen and use the local workflow without an agent reconstructing it. All selected/planned samples remain represented. A single pair shows consistency unmeasured. |

R5 in the roadmap closes release acceptance: actual Codex CLI/Desktop workflow
evidence, normal profile/client lifecycle and recovery, final-source checks,
reviewed public documentation, and detached packaging/install verification. This
assessment does not replace those gates or claim the candidate is release-ready.

Dependencies are narrow: R1 can proceed independently; R2 establishes common
comparison semantics; R3 can reuse retained data; R4 builds on those semantics.
No fixed benchmark campaign, isolated native environment, UI or new provider
adapter is a prerequisite. This assessment alone grants no runtime or evaluation authorization;
R1/R2 implementation was subsequently requested by the user.

After the Codex macOS release, assess UI and other providers against concrete
sources. “Copilot” does not yet identify a precise CLI/editor integration surface.
Establish that surface and available evidence before promising adapter behavior;
extract only the interfaces a demonstrated next integration needs.

## Documentation cleanup completed and runtime proposals

| Area | What creates drift | Disposition and boundary |
| --- | --- | --- |
| Shared goal and active handover | Audit-only framing and stale “current/resume” instructions | Completed: align the goal to the clarified outcome, move the sole active release plan to public `ROADMAP.md`, and preserve private handovers as non-operative history. First release is Codex CLI/Desktop on macOS; UI/provider assessment follows it. |
| `EVALUATION-ISOLATION.md`, repeated-campaign guide and isolation-helper README | Historical VM/whole-client gates and mandatory human review can look like universal product requirements | Completed: replace active framing with archived campaign-specific status and goal/roadmap pointers; collapse original specifications as preserved history. No campaign gate governs ordinary product use. Original envelopes, receipts, helper constraints and blocked launchers remain unchanged. |
| `test-support/evaluation-isolation/` and its tests | A substantial optional harness can attract new platform work | No production import or package-script prerequisite was found. Retain as dormant historical test support until a separately approved deletion checks references and preserved evidence. Its existence does not make it a milestone. |
| Discovery/inventory/copy/setup guidance | Overlapping scanners invite a second “unified diff” implementation | Extend existing `audit profiles`. Share small safe reading/diff primitives only when needed. Keep mutation selection/preservation and read-only observation responsibilities distinct; do not merge them merely to reduce file count. |
| Global eligibility and version gates | Controlled-experiment restrictions are treated as prerequisites for any comparison | Replace with claim-specific evidence rules and format/capability handling. Update tests that currently enforce overbroad suppression. Keep precise failure reasons and historical accounting limits. |
| Manual supplemental comparisons | Latest useful answer is separated from ordinary stored output | Reuse immutable revisions and attach evidence/review to one current view. Preserve earlier records, including failures; do not overwrite them or make manually authored summaries the normal workflow. |
| Pilot names and completion labels | M1/M2 completion can be mistaken for full-product delivery; old M2 assumes both reviewers | Completed in active guidance: keep M1/M2 as dated achievements, make review optional, and use R1–R5 for Codex macOS delivery. Other providers are later assessment. No automatic 12-run campaign resumption. |
| Generated mockups and artifacts | Illustrative screenshots can imply supported metrics or implemented controls | Retain the selected direction and label illustrative artifacts. Assess the UI only after the Codex release. Use real evidence for later usability acceptance; do not delete unrelated output or build UI as a report prerequisite. |
| Documentation packaging | The package allowlist includes the developer README but not the new goal/roadmap/assessment files | Before a future authorized release, include the linked public documents and verify packaged links; keep private handovers out. The public roadmap now avoids depending on private records. No package metadata or release changes are made by this assessment. |

Do not remove ordinary profile ownership, safe local task workspaces, permission
boundaries or startup-preservation controls merely because they use the word
“isolation.” The rejected requirement is a separate execution-environment platform.
Any simplification of production controls needs a specific causal assessment and
preservation check, not a blanket deletion or bypass.

## Verification and evidence limits

Executed only existing offline fixture suites:

```sh
node --test test/audit-discovery.test.js test/audit-cli.test.js \
  test/audit-session.test.js test/audit-explanation.test.js test/audit-quality.test.js
```

Result: **57 passed, 0 failed, 0 skipped**. They exercise broad static origins,
privacy, exact-home historical selection, source-free comparison/export, condition
gates and human-review validation. They also confirm today's strict comparability
behavior; passing that test does not make it correct for the clarified goal.

No full suite, native CLI/Desktop run, live provider authentication, runtime
installation, evaluation, profile mutation or release was performed. Creation,
runner and cross-provider conclusions above are source-grounded; these selected
fixtures do not prove live compatibility. Historical M2 remains the bounded real
Codex pilot, not validation of every client or this proposed implementation.

Documentation verification checks internal links, the active roadmap/goal contract,
whitespace and exact preservation of archived runbook/handover text. Runtime
cleanup remains proposed; no runtime behavior was changed by this documentation work.

Documentation cleanup verification (2026-10-22): 106 active local links resolved;
scoped whitespace checks and the edited release-example shell syntax passed.
Four archived runbooks/handovers and the original 3,105-line experiments record
were preserved verbatim. An independent read-only review found no material scope
or release-gate contradictions. Runtime, tests and package metadata were not
changed by the cleanup; no runtime suite was rerun for these prose-only changes.
