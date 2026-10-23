# Historical repeated evaluation campaign

Status: archived on 2026-10-22. This is a campaign-specific historical record,
not an active execution plan or a product/release prerequisite. Follow the
[shared goal](AUDIT-GOAL.md) and [active roadmap](ROADMAP.md):
Codex CLI/Desktop on macOS first, directly in the user's normal environment.

The old VM/whole-client isolation, exact-version envelope, mandatory human reviewer
and fixed campaign gates below describe that experiment only. They do not govern
ordinary profile comparison, audit entry paths or the next release. No campaign
is scheduled for resumption. Preserve original evidence, blocked launchers and
helper safety constraints; this archival change neither activates nor bypasses them.
Do not run guest probes on the host or remove production preservation controls.

<details>
<summary>Archived specification and observations (preserved verbatim)</summary>

# Repeated substantive coding evaluation, version 1

Status: offline preparation. No paid evaluation, model task or human rating has
been performed. The fixture launchers reject every invocation except `--version`.
A ready fixture preview proves scheduling and input validation only.

## Frozen question and design

Compare a fresh baseline setup with a fresh setup that selects the provided
`evaluation-workflow` skill. This is a contrast between **assigned setups**;
selection, catalog presence and passing checks do not establish that the model
read or followed the skill. Record any native invocation/read evidence separately.
No personal profile, credential, memory, integration or cache is copied. Fresh
homes do not prove isolation from machine-wide native policy or provider state;
record their observability limits instead of assuming they are absent.

Use three task repositories, two setups and two repetitions: **12 planned runs**.
Each task is a separate two-trial xfx series. No product-runner extension is needed.

| Task, fixed order | Work | Role | Profile order, repetition 1 / 2 |
| --- | --- | --- | --- |
| booking-ledger | Pure capacity ledger: peak overlap, cancellation, replay and immutable snapshots | Primary | Baseline/Workflow, then Workflow/Baseline |
| retry-queue | Sequential asynchronous retries, abort and exact result accounting | Primary | Workflow/Baseline, then Baseline/Workflow |
| config-overlay | Validated recursive configuration merge, provenance and JSON-stdin CLI | Held-out task family | Baseline/Workflow, then Workflow/Baseline |

Both setups appear first three times and second three times. Task families run
sequentially, not interleaved. Task order and cache warm-up remain possible
confounds. Repetition creates a new committed-snapshot workspace and native thread;
it does not reset profile or provider caches. Do not claim cold-cache equivalence.

Freeze all prompts, fixture/source hashes, task commits/trees, workflow skill,
check commands, rubric, sequence and stop rules before paid execution. The third
task is withheld from tuning and pilot feedback. Its published contract is complete;
only acceptance inputs and reference controls are outside the task workspace.
If its results inform a change to the treatment, retire it as a holdout for that
new recipe. These authored fixtures are not an unseen external benchmark.

## Preparation and independent controls

Sources live in `test-support/substantive-evaluation/`. Each task has a deliberately
incomplete `workspace/`, a `task.json` contract and a separate `oracle/` containing
acceptance checks and a passing reference. Only `workspace/` is materialized in the
model's repository; references and acceptance source never enter its Git tree.
Their separation is a protocol boundary, not a security guarantee against arbitrary
same-user filesystem access. The task prompt prohibits outside-workspace access.

Prepare into a **new absolute directory whose parent already exists**:

```sh
node test-support/substantive-evaluation/prepare.mjs --output /absolute/path/to/new/preparation
```

Preparation does not overwrite or clean an existing directory. It creates private
fixture homes/store, a blocked fake launcher, three deterministic fixture Git
baselines, frozen acceptance/checker copies, specs, quality fingerprints, unfilled
human-review templates and scheduling previews. These Git commits exist only in
new fixture repositories; the Xenoflux checkout is not committed. No authentication
files or credential values are generated or inherited. The fake version is an
explicit fixture version, not a native compatibility claim.

The one required `acceptance-suite` command first checks immutable support files,
editable-file scope and frozen checker/oracle hashes. It then runs **both** visible
and independent acceptance suites even if one fails, in a disposable HOME/temp
environment. A zero exit requires both suites to pass. No dependencies or network
are needed. Scope rejects changed tests, contracts, CLI support, package metadata,
missing support files, extra files and symlinks; ordinary xfx ownership markers are
excluded from that comparison. This is integrity checking, not a sandbox for
malicious candidate code. Paid execution must use xfx's bounded owned-process path.

Run `node --test test/audit-substantive-evaluation.test.js` for offline verification.
It executes only the known starter/reference controls, never a model task.
Preparation verification must show: starter fails; reference passes visible and
acceptance checks; a changed support file is rejected; no oracle/reference is in
committed task input; all three CLI dry-runs plan four slots; launcher execution is
blocked; both profile configurations match except the selected-skill treatment.
A reference control is checker evidence, not a model completion or performance score.

Regenerate from these sources if a temporary preparation expires. A new path can
change spec/check fingerprints even when task commits match. Bind approval and
later reviews to the actual retained manifest, never silently substitute it.

## Paid execution gate

The generated specs remain **non-executable against a paid provider**. Do not
replace their fake launcher or reinterpret fixture previews as authorization.
After review, create a separate private execution envelope using the frozen task
baselines and checker recipe, with all of the following explicitly agreed:

- An available exact model identifier and one reasoning-effort setting for both
  setups. `medium` is proposed, not yet an approved execution input. Verify actual
  per-run model/effort; stop on mismatch or unknown routing rather than correcting
  an existing user's profile.
- An exact native executable/version/hash, observer commit/source hashes, new
  dedicated profile/home/store paths and private workspace root outside unrelated
  projects. Approve repository bindings and any necessary trust only in those new
  disposable homes. Do not inherit source-path trust into relocated workspaces.
- One authenticated account/provider route with explicit authorization. Sign-in
  and credentials stay outside public specs and fixture files. Do not copy auth
  from existing profiles or use their live processes. Existing production profiles
  and bindings remain untouched.
- A monetary budget and provider-side enforcement if a hard money cap is needed.
  xfx enforces time/output limits; it does **not** enforce a currency budget.
  No cost estimate is asserted here because model, route and prices are unselected.
- A named human reviewer and the fixed review procedure below.
- An approved isolation boundary for host-side acceptance checks. The native task's
  sandbox does not carry into xfx's command checks. Time/process-group bounds and a
  private HOME do not prevent model-edited modules from accessing absolute host
  paths or the network when imported by Node. Paid execution on the current user
  account is blocked until this is resolved. Preferred plan: run the entire
  campaign in a disposable VM/test account with no real profile, credential or
  client paths mounted. Give the model client controlled provider access; run
  acceptance workers without network or provider credentials and with only their
  fixture, runtime and disposable workspace/temp paths available. Approve its
  exact mounts, writable roots, process permissions and network boundary, then
  verify a deny-read/write/network probe there before any paid candidate checks.
  The fixture preparer does not create a VM, account, sandbox or host policy.
  Subsequent [offline Apple Container worker preparation](EVALUATION-ISOLATION.md)
  verifies a disposable acceptance boundary. It does not authorize paid execution,
  complete native-client isolation or change these blocked fixture specs. A later
  execution envelope must bind the isolated worker command and check fingerprint.

A subsequent preparation step now creates a separate **pending execution envelope**
and maps candidate acceptance into the verified Apple VM worker. It preserves the
old specs and records new argv/fingerprints plus a proposed 10-minute check bound.
Whole-client native startup remains blocked by managed-preference synchronization;
no provider request or native tool execution passed that gate. The envelope is
not an executable paid campaign. See [envelope and native preparation](EVALUATION-ISOLATION.md#execution-envelope-preparation).

Bounds: 15 minutes per profile run; 32 minutes per paired trial including checks;
64 minutes per task series; nominal campaign allocation 192 minutes plus preflight,
filesystem and shutdown overhead. Output cap: 8 MiB per run. The acceptance command
is bounded to 40 seconds with two subprocess limits of 15 seconds each. These are
ceilings, not time or spend forecasts. There are no automatic evaluation-run retries. Native provider retries may still
occur; record them where observable without treating them as additional task slots.

Before asking to run, resolve the host-check isolation gate and present the exact execution manifest/hash, 12-slot schedule,
model/effort, account route, time ceilings, money limit/enforcement and reviewer.
Obtain the user's explicit approval. Preparation itself requires no paid calls.

At execution: use the current working-source CLI, explicit private `--store`, the
approved spec and existing `audit run --spec` interface. A dry-run is not execution
approval. Required root context must report the workspace `AGENTS.md` before a
model turn; missing context fails and persists denial without weakening the gate.
The setup deliberately has no external MCP/plugin dependency or required child.
Check selected-skill evidence separately; never turn missing telemetry into no use.

## Quality and human review

Mechanical completion requires explicit native completion, successful process
exit, the required acceptance suite, bounded task-end changes and preserved
settings/clients. Capture acceptance is a separate requirement. Overall audit
coverage can remain partial and evidence exit 2 remains correct. Task failure,
missing evidence and not-started slots remain distinct.

The human rubric is required, versioned and bound to the check fingerprint:

| Criterion | Weight | Score anchors, 0–4 |
| --- | --- | --- |
| Correctness | 3 | 0 unusable; 1 major contract failures; 2 partial; 3 correct with minor gaps; 4 complete and robust within the contract |
| Verification | 2 | 0 none/false; 1 weak; 2 partial evidence; 3 relevant checks with limits; 4 clear behavioral and integration evidence |
| Maintainability | 1 | 0 incomprehensible; 1 fragile; 2 unnecessary complexity; 3 clear and scoped; 4 concise and easy to change |
| Honesty | 1 | 0 fabricated claims; 1 material overclaims; 2 incomplete disclosure; 3 accurate outcome/limits; 4 precise evidence-backed account |

Minimum weighted score: 75%, with all required gates passing. A blank/null score
remains unknown, never zero or a pass. The supplied templates are unfilled and
must not be submitted as human ratings. Reviewers cite recorded run/check/workspace
references accepted by `audit evaluate`; save revisions as new evaluation records.

After runs, a curator assigns neutral packet IDs and withholds setup labels,
execution order and token/timing summaries from the first human scoring pass.
Each packet includes task contract, task-end patch, scoped check evidence and
completion claims. Keep the label-to-run map private and apply ratings to the
correct recorded run/fingerprint. Style or task content can still reveal treatment;
record any unblinding. No model judge or synthetic rater substitutes for a human.

## Stops, analysis and preservation

Stop the campaign on lost monetary oversight, account/model/effort drift, a
preservation or ownership failure, required-context failure, unknown live owner,
recovery-required result or unavailable check inputs. Record the slot as observed;
do not replace it with a convenient rerun. A code-quality failure is a result,
not a reason to tune the skill or hide a sample. Inspect phase/capture status and
exit meaning before continuing; an expected evidence exit 2 alone is not failure.
A preservation failure blocks continuation. Explicit later resume may advance only
unused slots; never replay a started slot or clear an uncertain lease by force.

Report each task/setup's 2 planned slots, executed/missing/failed/incomplete counts,
mechanical pass and human quality separately. Primary comparisons are paired by
task and repetition; show raw outcomes and paired differences, then descriptive
medians/ranges only for comparable measured fields. Do not pool unlike tasks into
a causal winner or use N=2 for a significance claim. Do not filter to successful
skill detections or successful trials. Attributable native token totals depend on
the exact supported accounting contract; unavailable totals stay unavailable.
Tokens are not an invoice, provider cost, active/waiting time or complete network use.

Keep raw prompts, outputs, patches, run IDs, account routing, paths, receipts and
review maps private. Public reporting contains sanitized synthetic task names,
versions, hashes, aggregate observations and explicit limits. Preserve every failed
attempt and original; export full/compact JSON and actual Markdown, reopen after
source removal, and retain immutable recipe/check hashes. Never publish raw reports
or claim exhaustive skills, managed/admin coverage or external-service behavior.
Preparation/execution does not authorize commit, push, release, installed update
or any operation on existing clients.

</details>
