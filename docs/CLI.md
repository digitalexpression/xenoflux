# CLI recipes

Use `xfx --help` for the command/option list. [Installation](INSTALLATION.md) owns
prerequisites and executable discovery; the [user guide](GUIDE.md) explains the
browser workflow. Uppercase values below are placeholders. Preview native mutations
before applying and run them from an external interactive terminal.

## Profiles, copy and recovery

The following commands describe Codex profiles. Use the app's client selector
for Claude Code/Copilot setup and native sign-in guidance.

```sh
xfx profile create Research
xfx profile create Research --apply --close-clients
xfx profile signin Research --apply --close-clients
xfx profile list
xfx profile inspect Research --json
xfx desktop open Research
xfx desktop list --observe
xfx launch Research
xfx history --profile Research
xfx resume Research TASK_ID
xfx pick
```

`Default` is the normal native setup and a copy source only. Named profiles use
separate roots under `~/.xfx/profiles`. Standalone launch/resume needs exclusive
profile use; app comparisons/reviews use shared execution participants.
`desktop open` focuses an existing instance; `focus`, `close` and `recover` target
only the verified profile. Desktop `prepare`/`refresh` is explicit maintenance of
stopped launcher caches, not a prerequisite to every open.

```sh
xfx copy Default Research --advanced
xfx copy Default Research --advanced --apply --close-clients
xfx profile create Research --from Default --advanced --apply --close-clients
xfx copy undo COPY_ID
xfx copy undo COPY_ID --apply --close-clients
```

Advanced selection starts empty: arrows navigate, Space selects, `/` searches,
`d` opens details, Enter reviews. Type `replace` for a selected conflict or skip it.
`--include config,instructions,agents` is category selection and cannot combine
with `--advanced`. Missing source items do not delete destination-only content.
Skill replacement includes obsolete package files; unsafe packages/transitions
are refused. Manual plugin/hook/MCP guidance is conditional and outside Undo.
Preserve the copy journal/payload while Undo is needed; intervening edits block it.

Preparation, copy, sign-in and Desktop integration are separate. A later failed
sign-in does not erase completed copying. For a hard-interrupted login/CLI run:

```sh
xfx profile recover NAME
xfx profile recover NAME --apply
xfx desktop recover NAME --dry-run
xfx desktop recover NAME
```

Profile apply rechecks a same-host owned lock, absent matching owner and native
writers before releasing it. Desktop recovery reconciles only its stopped journal
and reservation. Neither launches, resumes or force-closes clients. Live/reused
identities, mismatched bindings or uncertain handles preserve the block. After
recovery, retry sign-in only if its marker did not already record completion.
`--close-clients` permits graceful shutdown where offered; standalone terminal
sessions may need manual closure. Desktop ownership can remain unobservable.

Registration/binding and registry-only management:

```sh
xfx profile register NAME ROOT --codex EXECUTABLE --codex-version VERSION
xfx profile bind NAME REPOSITORY
xfx profile unbind NAME REPOSITORY
xfx profile unbind NAME
xfx profile rename NAME NEW_NAME
xfx profile delete NAME
```

Recorded versions are provenance, not a profile pin. The single-argument `unbind`
removes native binding; a repository argument removes that project binding.
Registry changes preserve native files and refuse active/unresolved operations.

## Read and export evidence

```sh
xfx audit profiles Default Research --repo /path/to/repository --surface cli
xfx audit profiles Default Research --repo /path/to/repository --surface desktop
xfx audit show --profile Default --id NATIVE_UUID
xfx audit diff --left-profile Default --left-id LEFT_UUID \
  --right-profile Research --right-id RIGHT_UUID
xfx audit show /path/to/run.audit.json
xfx audit diff /path/to/left.audit.json /path/to/right.audit.json
```

Use `--surface cli|desktop`; the former `--client cli|desktop` selector was removed.
Add `--same-task TASK --variables "model,instructions"` only for a known association.
Declarations do not override conflicting recorded fingerprints. Optional
`--expect-model MODEL --expect-effort EFFORT` checks observations without changing
settings. Setup discovery does not prove copying eligibility, loading or adherence.

Exact history lookup and whitelisted turn context:

```sh
xfx history --profile Default --id TASK_ID --turns --json
```

Lookup stays within the selected profile and never resumes work. `--id` cannot
combine with search/limit/archived filters. Without `--turns`, lookup reads index
metadata and validates the rollout path without scanning conversations. Turn
metadata retains recorded cwd/model/effort and source lines; current settings
never fill gaps. Child turns need positive same-profile ownership; inherited turns
are excluded and parent rollouts are not scanned. Bounds are 32 MiB total, 1 MiB
per line and 10,000 metadata records. Partial/unknown context stays explicit.

```sh
xfx audit export RUN_OR_COMPARISON_UUID --output report.json
xfx audit export RUN_OR_COMPARISON_UUID --format markdown --output report.md
xfx audit export --profile Default --id NATIVE_UUID \
  --include-replay-content --format markdown --output replay.md
xfx audit export profiles Default Research --include-content --output setup.json
```

Markdown has a reopenable `.audit.json` sidecar; keep both. Output/sidecar paths
must be unused. `--json` controls command output; `--format` controls exported
files. Replay/check/patch bodies are excluded by default; explicit inclusion uses
redaction and size limits, not a guarantee that all private text is removed.
Frozen reports survive source loss without acquiring later activity. Bound review
evidence cannot be silently stripped. A new import is a new derivation.

Comparison exits: 0 complete evidence; 1 invalid/missing selection; 2 partial or
unavailable evidence (including useful exports); 3 a complete recorded-control
mismatch. Exact history lookup uses 1 for no matching task in a readable index and
2 for unavailable/partial lookup or requested turn metadata.

Read tokens in their reported scope. Cached/reasoning subsets are not additional
totals; cumulative snapshots are not whole-turn values. Captured-session sums do
not establish exhaustive workflow discovery or billing. Matching check recipes
and rubrics are needed for their comparisons; one pair cannot prove consistency
or causality. No observed skill/hook/plugin event does not prove no use.

## Run a controlled experiment

Save as `experiment.json`, replacing the repository, task and registered names:

```json
{
  "schemaVersion": 1,
  "repository": "/absolute/path/to/repository",
  "revision": "HEAD",
  "task": "Improve the setup documentation and summarize the change.",
  "profiles": ["Research", "Careful"],
  "setup": [],
  "checks": [{"name": "unit tests", "argv": ["npm", "test"], "timeoutMs": 300000}],
  "limits": {"runMs": 900000, "experimentMs": 1920000, "outputBytes": 8388608},
  "allowIncompleteCapture": true
}
```

```sh
xfx audit run --spec experiment.json --dry-run
xfx audit run --spec experiment.json
xfx audit show EXPERIMENT_UUID
xfx audit diff RUN_A_UUID RUN_B_UUID
xfx audit recover EXPERIMENT_UUID
xfx audit recover EXPERIMENT_UUID --apply
xfx audit clean EXPERIMENT_UUID --apply
```

Dry run resolves prerequisites and starts no task, reservation or workspace. Start
pins a commit and creates independent checkouts; only committed source enters.
Inputs exclude credentials/configuration, worktree filters, submodules and LFS
pointers, and are bounded to 50,000 entries, 1 GiB total and 64 MiB/blob.
Setup precedes tasks, checks follow them, and snapshots distinguish their changes.
These commands execute outside the model sandbox and can affect external state.
There are no automatic retries or automatically selected checks.

String profile names select Codex. An explicit selection can use
`{"name":"Research","client":"claude-code","sideId":"a","execution":{"permissionMode":"plan"}}`.
Codex modes are workspace-write/read-only, Claude modes default/acceptEdits/plan,
and Copilot modes manual/assisted. Omitted choices inherit supported defaults;
CLI experiments have no interactive approval queue. Use the app for individual
native approval requests. Requested model/effort and observed settings remain separate.

Each setup/check command has a unique name and `argv`, without a shell; at most
20 of each, default timeout 60 seconds and maximum one hour. Durations default
to 15 minutes per side and a derived experiment bound, each capped at 24 hours;
output defaults to 8 MiB per process (1 KiB–64 MiB). Set both duration fields to
JSON `null` for uncapped non-series work. Startup, cancellation and output bounds
still apply. A `taskContract` labels identity/editable files, not enforced sandbox scope.

`allowIncompleteCapture` permits useful partial evidence. It does not waive
positive `captureRequirements` for agents, usage, tools, skills, hooks or reported
loaded context. Without such requirements, the strict default needs complete capture.
Requirements prove recorded observations, not instruction bytes/adherence or all
native activity. Advanced fields are defined by the shipped
[spec validator](../src/audit-spec.js) and [capture rules](../src/audit-capture.js).

Recovery previews unless applied. It verifies stopped ownership without signalling
saved PIDs or rerunning tasks/checks; recovery-time snapshots are not task-end code.
Cleanup removes only verified inactive, unchanged owned workspaces, preserving
reports. Drift, uncertain ownership, changed content/configuration or unfinished
work blocks removal. Keep the UUID and export evidence before discarding work.

## Repeat trials or select a cohort

Add these fields to the experiment above and save as `series.json`:

```json
{
  "trials": {"count": 3, "order": "balanced", "budgetMs": 2160000},
  "quality": {
    "schemaVersion": 1, "id": "tests-and-scope", "version": "1",
    "checks": [{"name": "unit tests", "required": true}],
    "workspace": {"maxChangedFiles": 20}
  }
}
```

Run/show/export the series as above; `xfx audit resume SERIES_UUID` explicitly
advances only not-started slots. Started slots never run again. Frozen inputs,
schedules, preassigned IDs and deadlines survive restart without budget renewal.
Bounds are 20 trials, eight profiles and 160 planned runs; `balanced` rotates order.
Variables label differences rather than applying settings. All checks are required
unless explicitly optional; human rubric scores are not an automatic judge and
quality acceptance never repairs incomplete capture. Changed-file criteria use
verified post-setup/task-end changes, including ignored files and modes.

For existing evidence, save this as `cohort.json`:

```json
{
  "schemaVersion": 1, "kind": "audit-cohort", "name": "Selected task pairs",
  "sameTask": "booking-task", "variables": ["instructions"],
  "pairs": [{"left":{"profile":"Default","id":"LEFT_UUID"},"right":{"profile":"Research","id":"RIGHT_UUID"}}]
}
```

`xfx audit cohort --spec cohort.json` reads 1–80 selected pairs without starting
work. Saved run/report/comparison selectors are also accepted. Reused underlying
sessions and inconsistent profile arms are refused. Cohorts have selected, not
planned-attempt, denominators; no resume/recover/clean workspaces exist. Keep distinct
tasks separate, retain missing/contradictory samples and never treat unknowns as zero.

## External reviews

Ordinary AI review is in the [app guide](GUIDE.md#request-a-review). These commands
prepare/import attributed external judgments without invoking a judge or checks:

```sh
xfx audit export --left-profile A --left-id LEFT_UUID \
  --right-profile B --right-id RIGHT_UUID --same-task TASK --output comparison.json
xfx audit evaluate comparison.json
xfx audit export EVALUATION_UUID --output review-packet.json
xfx audit evaluate EVALUATION_UUID --spec reviews.json
xfx audit export NEW_EVALUATION_UUID --output reviewed.json
```

Copy fingerprint, claim scope and reference placeholders from the frozen packet:

```json
{
  "schemaVersion": 1, "kind": "xfx-audit-review-submission",
  "evidenceFingerprint": "FROM_PACKET",
  "reviews": [{
    "id": "review-1", "reviewer": {"type":"human","name":"Reviewer"},
    "reviewedAt": "2026-11-12T12:00:00Z", "method":"retained-evidence-review",
    "scope":"FROM_CLAIM_SCOPES", "conclusion":"inconclusive",
    "summary":"Judgment, evidence and limits.", "evidenceRefs":["FROM_PACKET"]
  }],
  "supplementalChecks": []
}
```

Other conclusions are positive/negative/mixed and need evidence references. Ratings
need the subject's matching rubric. Later revisions use a new ID and `supersedes`
for the same reviewer/scope; conflicting judgments stay separate. AI reviewers
include their model when known and never overwrite human scores. Binding checks
validate references, not reviewer identity or external execution. Supplemental
checks require exact frozen candidate/recipe identities and attribution; original
failures remain unchanged. Each evaluation gets a new immutable UUID and can be
reopened/reviewed from an export without the original source.

Direct-session evidence attachments use `kind: "xfx-audit-session-evidence"`,
the packet fingerprint and exact run/profile/session/source IDs. Optional editing
boundaries, task-end hashes or checker recipes must be attributed. They read no
historical files and execute no checks. Attach before review: the new packet has
a different fingerprint. See the shipped [review validator](../src/audit-review.js)
for full submission fields; use emitted packet values rather than today's checkout.

## Diagnostic log routing

RAM routing applies only to recreatable diagnostic SQLite main/WAL/SHM files;
settings, credentials and conversations remain on disk. It needs native clients
idle. From an external terminal:

```sh
xfx ramlogs status
xfx ramlogs enable --close-clients
xfx ramlogs disable --close-clients
xfx ramlogs recover --close-clients
```

The login service resolves supported Node from its saved/terminal search path,
not shell startup files; `--background-path PATH` is an explicit checked override.
Install can succeed with disk logs when no background Node exists. An explicit
enable failure restores disk mode. Check status after real login/reboot before
repair so manual intervention does not hide startup failure; the job is one-shot.

Conflicting disk/RAM diagnostics are preserved. Recover only after disk routing
is restored: it verifies/archives recognized RAM files plus current disk diagnostics,
removes only unchanged RAM originals and retries enable once. It refuses unsafe,
already-linked or open files and preserves archives on later failure. SQLite
lifetimes are never merged. If CLI installation succeeded before log setup failed,
repair logs rather than reinstalling the CLI.
