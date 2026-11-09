# Controlled audit experiments

Read-only inspection: [audit guide](AUDIT.md). Capture contracts: [evidence reference](AUDIT-EVIDENCE.md). Repetitions: [series/cohorts](AUDIT-REVIEWS.md).

## Run a controlled experiment

```sh
xfx audit run --spec experiment.json --dry-run
xfx audit run --spec experiment.json
xfx audit show EXPERIMENT_UUID
xfx audit diff RUN_A_UUID RUN_B_UUID
```

Dry run resolves the commit, profiles/bindings, executable version, coexistence and settings fingerprintability; it starts no task and creates no reservation/workspace/record. Start pins one commit, creates separate checkouts and runs sides sequentially without retries. Independent comparisons/reviews can overlap on one profile through shared execution participants; mutations stay exclusive.

## Experiment specification

UTF-8 JSON example; replace repository/commit/profile values and use only trusted commands:

```json
{
  "schemaVersion": 1,
  "repository": "/path/to/repository",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "task": "Implement the requested change and summarize the result.",
  "profiles": ["Research", "Careful"],
  "setup": [],
  "checks": [{"name": "unit tests", "argv": ["npm", "test"], "timeoutMs": 300000}],
  "limits": {"runMs": 900000, "experimentMs": 1920000, "outputBytes": 8388608},
  "sandbox": "workspace-write",
  "allowIncompleteCapture": false,
  "captureRequirements": {"usage": {"agents": "all", "fields": ["inputTokens", "outputTokens", "totalTokens"]}}
}
```

| Field | Contract |
| --- | --- |
| Repository/revision | Absolute normalized Git root; required revision resolves once to a commit. Record source HEAD/tree; do not execute configured worktree filters. |
| Inputs | Committed files only: dirty/untracked/ignored contents, Git config/credentials excluded. Source worktree/index preserved. Reject submodules, LFS pointers, unsupported objects, more than 50,000 entries, 1 GiB total or 64 MiB/blob. Separate paths can affect trust/project configuration. New cleanliness is unknown; older recorded flags remain. |
| Profiles | 2–8 sides; name string or object with `name`, optional `executable`, `version`, `sideId`, `execution`, `nativeConfig`, `skills`. Repeated homes need distinct `sideId` values. |
| Resolution | Named profiles need the source repository bound and executable/version registered. `Default` needs existing native trust and an explicit executable. Executables must be trusted absolute paths; `version` records requested context, not a version gate. Series freeze observations for drift checks. No provider-version allowlist. |
| `execution` | Optional per-side `model`/`reasoningEffort`; omitted inherits defaults. Process-local values need native confirmation before the turn; do not duplicate them in `nativeConfig`. |
| `nativeConfig` | Narrow `-c` overrides: `model`, `model_reasoning_effort`, `plan_mode_reasoning_effort`, `forced_login_method` (`chatgpt`/`api`), `agents.max_depth` (1–4), `features.multi_agent` (`false` only). Requested settings are separate from observed behavior; recipe fingerprints include them and resume rejects drift. Use the native executable, not a shell wrapper. |
| `skills` | Distinct requested root-skill names, each uniquely resolved by native catalog. Selection is not proof of use. See [catalog/telemetry semantics](AUDIT-EVIDENCE.md#skill-catalogs-and-telemetry). |
| `taskContract` | Optional explicit identity/edit boundary, e.g. `{"id":"booking-ledger","editableFiles":["src/booking-ledger.js"]}`; an evidence label, not enforced sandbox scope. |

If needed, `xfx profile bind NAME /path/to/repository` changes registry metadata only. Preparation never grants native project trust.

## Setup, checks and process limits

`setup` and `checks`: at most 20 commands each, unique names and `argv` (program first), optional `timeoutMs` (default 60 seconds, maximum one hour). Run without a shell in the private workspace/minimal environment. Setup precedes task; checks follow it; snapshots separate task-end changes from later check changes.

These commands run outside the Codex sandbox and can affect external files/services. Only select commands you trust; the private checkout does not undo external effects.

| Limit | Default / bound |
| --- | --- |
| `runMs` | 15 minutes/side; maximum 24 hours. |
| `experimentMs` | Derived from sides/run limit; maximum 24 hours. |
| `outputBytes` | 8 MiB/process; 1 KiB–64 MiB. |
| Sandbox | `workspace-write` (default) or `read-only`; native task networking disabled, writes limited accordingly. |

For uncapped non-series work, both duration fields may be explicit `null`; omitted fields retain defaults. Cancellation/output/setup/check/startup/shutdown bounds still apply; series retain budgets. Filesystem/preflight/shutdown overhead can exceed the process deadline. No automatic retries.

## Profile and client safety

- Use existing home/configuration/authentication without copying credentials, editing bindings or closing clients. Comparison jobs join verified native `.run-lock` participants across controllers; they no longer serialize through a separate per-home audit lease. Legacy leases still require ownership-aware recovery.
- Verify resource holders, Desktop journal/process identities and baseline preservation. Untrusted, changing, foreign or uncertain ownership blocks work; unexpected baseline-client loss is reported. Normal newly observed clients are not automatically a failure. Profile mutation remains exclusive.
- Fingerprint relevant saved settings/instructions/agents/skills/rules before/after. Unverifiable drift makes the run partial and stops remaining sides; preserve external changes instead of rolling them back.
- Native version/startup probes write-protect saved authentication/configuration/definitions, including resolved skills. No saved permission changes or unprotected fallback. Auth requiring persistence can fail safely. This guard is comparison-only; ordinary reviews follow their [normal-profile contract](../developer/REVIEW-TASK-IMPLEMENTATION.md).
- Private process-local SQLite/log/TMP/telemetry state isolates owned execution. Native rollout files persist in the owning profile and may contain private prompts/output; existing sessions stay untouched. Native caches can still change; do not claim a byte-identical home.
- Verify native cwd matches the private checkout. Omit writable thread-start cwd that could save trust; turn cwd/sandbox remain explicit. Existing managed/trust policy applies; unsupported cwd/guard/no-op startup checks stop before the model turn. These observer checks do not establish task quality or all native security behavior.

## Inspect, recover, and clean

```sh
xfx audit recover EXPERIMENT_UUID
xfx audit recover EXPERIMENT_UUID --apply
xfx audit clean EXPERIMENT_UUID
xfx audit clean EXPERIMENT_UUID --apply
```

Both preview unless `--apply`. Recovery verifies coordinator/process/group and exact participant ownership; a missing group leader alone is insufficient. Live, reused, foreign or uncertain resources remain blocked. It never signals saved PIDs, restarts a session, reruns a task/check or replays approvals.

Applied recovery retains normalized checkpoints/telemetry and available source-bound capture, marks partial/interrupted evidence, and may snapshot recovery-time workspace state (not original task-end code). It releases only the confirmed-stopped run's participant/reservation, preserving other jobs and Desktop. Older records retain their legacy lease handling. Escaped descendants remain outside group-observation proof.

Cleanup removes only verified inactive private workspaces with matching ownership/final fingerprint; report/evidence remain. Ignored contents contribute hashes, not embedded bodies. Changed content/Git config, special files, unfinished work or uncertain ownership blocks removal. Keep UUIDs and use [show/export](AUDIT.md#export-a-frozen-report) to inspect retained results.
