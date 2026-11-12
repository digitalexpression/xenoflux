# Repeated trials and external reviews

Advanced CLI workflows. Start with [experiments](AUDIT-EXPERIMENTS.md) or [session inspection](AUDIT.md#inspect-and-compare-existing-sessions). Ordinary in-app AI review uses the [app workflow](APP.md#review-a-comparison).

## Repeated trials and explicit quality criteria

Save this as `series.json`, replacing the repository, task and registered profile
names. It repeats each profile three times and checks the recorded test result
and changed-file count:

```json
{
  "schemaVersion": 1,
  "repository": "/absolute/path/to/repository",
  "revision": "HEAD",
  "task": "Improve the setup documentation and summarize the change.",
  "profiles": ["Research", "Careful"],
  "trials": {"count": 3, "order": "balanced", "budgetMs": 2160000},
  "checks": [{"name": "unit tests", "argv": ["npm", "test"], "timeoutMs": 300000}],
  "quality": {
    "schemaVersion": 1, "id": "tests-and-scope", "version": "1",
    "checks": [{"name": "unit tests", "required": true}],
    "workspace": {"maxChangedFiles": 20}
  },
  "limits": {"runMs": 900000, "experimentMs": 1920000, "outputBytes": 8388608},
  "allowIncompleteCapture": true
}
```

The profile names above select Codex profiles. Use explicit client selections as
shown in [experiment specifications](AUDIT-EXPERIMENTS.md#experiment-specification)
for other clients. Checks run outside the model sandbox; choose trusted commands.
`allowIncompleteCapture` permits a partial report, not a claim of complete evidence.

```sh
xfx audit run --spec series.json --dry-run
xfx audit run --spec series.json
xfx audit show SERIES_UUID
xfx audit resume SERIES_UUID
```

| Rule | Meaning |
| --- | --- |
| Frozen manifest | Normalized spec, committed baseline, resolved profiles, metadata-only settings tokens, task/check identities, schedule and preassigned run IDs. No copied/hashed authentication content. |
| Bounds | 20 trials, eight profiles, 160 planned runs. `listed` preserves order; `balanced` rotates it. Variables label intended differences; xfx does not apply them. |
| Budget | Fixed trial deadlines bounded by `limits.experimentMs` and total `budgetMs`; no transfer/replenishment on restart. Preflight/filesystem/shutdown add overhead. |
| Check criterion | Passed only with recorded `passed` and exit 0. All declared checks required unless explicitly `required: false`; missing/incompatible evidence stays incomplete. |
| Changed files | `maxChangedFiles` uses verified post-setup/task-end changes, including actual ignored-file/mode changes. Unchanged setup files do not count; ambiguous tracking/identity leaves unknown. |
| Human rubric | Optional unless declared required; not an automatic judge. Passing quality never repairs partial native capture or changes exit 2. |
| Resume | Explicitly advances only not-started slots; a started slot never runs again, even with missing child evidence. Changes to frozen inputs require a new series. |
| Recover/clean | `audit recover SERIES_UUID --apply` reconciles stopped child work without advancing slots. `audit clean SERIES_UUID --apply` removes only verified inactive owned workspaces. |

Retain planned/unstarted/interrupted/missing slots in denominators. Report available numeric samples with median/quartiles/IQR/counts and paired-difference medians; missing values/scores are not zero. Root counters retain source scope; `workflow.*` requires [verified accounting](AUDIT-EVIDENCE.md#tokens-by-agent-and-turn). Cache warmth is uncontrolled/not reset. Drift stops further work.

Compacted series retain bounded actor/turn/tool/hook/skill/capture detail and disclose omissions; export individual runs when full offline detail is needed. Original human scores and later attributed reviewer ratings stay separate.

## Compare consistency across repeated runs

CLI series retain a findings-based consistency summary; the app prioritizes replay. Recurring/opposite/variable patterns and compatible check outcomes remain claim-specific: one pair leaves consistency unmeasured, changed targets alone are variation, and contradictory left/right patterns are not merged.

For existing tasks, explicitly select stable left/right profile identities in a cohort:

```json
{
  "schemaVersion": 1, "kind": "audit-cohort", "name": "Booking task comparison",
  "sameTask": "booking-task", "variables": ["instructions", "model"],
  "pairs": [
    {"left":{"profile":"Default","id":"LEFT_SESSION_UUID"},"right":{"profile":"Research","id":"RIGHT_SESSION_UUID"}}
  ]
}
```

```sh
xfx audit cohort --spec cohort.json
xfx audit show COHORT_UUID
xfx audit export COHORT_UUID --format markdown --output consistency.md
```

Cohorts read evidence only: no tasks/checks/processes/workspaces to resume/recover/clean. Accept 1–80 pairs; reject reused underlying sessions/runs and inconsistent profile arms. Alternatives: side `{"runId":"SAVED_RUN_UUID"}` or `{"report":"run.json"}`, pair `{"comparison":"comparison.json"}` including exported evaluations. Paths resolve beside the spec; embedded reviews are revalidated.

Scheduled series use planned denominators; cohorts use selected counts with unknown total attempts. Recorded task conflicts remain conflicts despite declarations. Group distinct tasks separately, exclude other task groups from each denominator and label any pooled metrics. Check comparisons need matching recipes, rating comparisons matching reviewer/type/rubric. Keep direct-session spans separate from runner duration and recorded tokens scoped. Associations are descriptive, not causality/statistical significance or automatic winners.

## Review either audit entry path

These commands prepare/import external human/AI judgments without running a judge or supplemental check. First freeze direct sessions, or use a saved run/experiment/series ID:

```sh
xfx audit export --left-profile A --left-id LEFT_UUID \
  --right-profile B --right-id RIGHT_UUID --same-task TASK --output comparison.json
xfx audit evaluate comparison.json
xfx audit export EVALUATION_UUID --output review-packet.json
xfx audit export EVALUATION_UUID --format markdown --output review-packet.md
```

No submissions means unreviewed. JSON contains frozen `subject`, `reviewPacket` (fingerprint, claim scopes, references, candidates, check recipes), `reviewHistory` and `reviewState`; Markdown includes its JSON sidecar. Review only supplied evidence; keep private text out of shareable submissions.

Minimal UTF-8 submission; copy placeholders from the packet:

```json
{
  "schemaVersion": 1, "kind": "xfx-audit-review-submission",
  "evidenceFingerprint": "FROM_PACKET",
  "reviews": [{
    "id": "review-1", "reviewer": {"type":"human","name":"Reviewer"},
    "reviewedAt": "2026-10-22T12:00:00Z", "method":"retained-evidence-review",
    "scope":"FROM_CLAIM_SCOPES", "conclusion":"inconclusive",
    "summary":"Judgment, evidence and limits.", "evidenceRefs":["FROM_PACKET"]
  }],
  "supplementalChecks": []
}
```

```sh
xfx audit evaluate EVALUATION_UUID --spec reviews.json
xfx audit show NEW_EVALUATION_UUID
xfx audit export NEW_EVALUATION_UUID --output reviewed.json
```

| Field / operation | Contract |
| --- | --- |
| Reviewer | `human` or `ai`; AI includes `model` when known. Multiple distinct reviewers may attach in one or later revisions. AI ratings never populate legacy human scores. |
| Conclusion | `positive`, `negative`, `mixed`, `inconclusive`; optional `preferredRunId` must identify a packet run. Non-inconclusive claims require references. Judgment is attributed, not independently authenticated. |
| Scope/references | Exact packet values; checks use `check:RUN_ID:NAME`. A run-scoped claim cannot cite another run. |
| Revision | New entry ID plus `supersedes`, same reviewer identity/scope; prior entries remain. Conflicting current judgments in one scope show disagreement, never consensus averaging. |
| Ratings | Optional `assessments` with `runId`/`ratings` when frozen subject declares a rubric. Per-run ratings retain legacy `check:NAME` reference format. |
| Supplemental check | `id`, `runId`, `name`, `candidateFingerprint`, `recipeFingerprint`, `checkedAt`, `method`, `status`, `exitCode`, `evidenceRefs`, `attribution: {type,name}`; type human/agent/automation. Copy exact candidate/recipe IDs. Passed requires exit 0; unknown recipes/candidates, contradictions and wrong fingerprints are rejected. |

Evidence binding validates references, not who submitted or whether an external command ran. Original failures/status/exit codes remain separate from supplied checks and reviewer scores. No model cost is inferred. Missing candidate/recipe remains reviewable but cannot accept a bound supplemental check; today's checkout is not historical task-end code.

Each evaluation is a new immutable UUID. Exported `reviewed.json` supports source-free `audit show` and `audit evaluate reviewed.json --spec more-reviews.json`, saving a new evaluation while preserving embedded history.

## Attach retained evidence to directly started CLI or Desktop sessions

Readers use recorded cwd/turn context, not today's checkout. To attach retained editing boundaries, task-end hashes or check recipes, first export the exact pair and obtain its `reviewPacket.evidenceFingerprint`:

```sh
xfx audit evaluate pair.json --json
xfx audit evaluate pair.json --spec session-evidence.json --json
```

`session-evidence.json`: `schemaVersion: 1`, `kind: "xfx-audit-session-evidence"`, original `evidenceFingerprint`, and `attachments`. Each attachment needs:

| Field | Value |
| --- | --- |
| Identity | Exact `runId`, `profileId`, `nativeSessionId`, `sourceFingerprint` from that report side. |
| Attribution | `attributed: {type,name}` (human/agent/automation), `recordedAt`. |
| `taskContract` | Optional `id` and relative `editableFiles`; supplied boundary, not independently proved task identity. |
| `taskEnd` | Optional `capturedAt`, `files: [{path,sha256}]` with actual 64-character hashes. |
| `checkRecipes` | Optional `[{name,argv,inputs:[{path,sha256}]}]`; hash checker/test inputs. Raw arguments become recipe identity and are omitted from saved reports. |

At least one optional evidence field is required. Relative paths are labels only; xfx reads/reconstructs no historical files and executes no task/check. Hashes prove binding, not completeness/capture time/execution. Attach before review: the resulting packet has a new fingerprint. Correct an attachment through a new evaluation of the original report; previous evidence/reviews remain unchanged. Cohorts accept the exported evaluation; conflicting recipe-bound checks stay inconclusive and separate from original results.

## Existing series human rubric input

`xfx audit evaluate SERIES_UUID --spec reviews.json` also accepts the older human-only format:

```json
{"schemaVersion":1,"reviews":[{
  "schemaVersion":1,"runId":"FROM_SERIES","fingerprint":"QUALITY_FINGERPRINT",
  "reviewer":"Reviewer","reviewedAt":"2026-10-16T12:00:00Z",
  "ratings":[{"criterionId":"FROM_RUBRIC","score":null,"rationale":"Unscored","evidenceRefs":[]}]
}]}
```

Cover each declared criterion exactly once; null means unscored. Scored values must satisfy bounds and cite retained run/check/task-end evidence. Validate run/definition identity and ISO-parseable time. Save a new immutable evaluation without launching a model/check/judge. Export retains names/timestamps/rationales; inspect privacy before sharing. For AI/combined review, use the typed packet above.
