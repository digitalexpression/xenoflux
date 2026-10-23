# Audit profiles and Codex runs

Audience: developers comparing Codex setups and investigating work. `profiles`, `show`,
`diff`, and `export` inspect selected sources without starting model tasks. `run`
executes a bounded experiment through its own native app-server processes.

## Compare profile setup for a repository

```sh
xfx audit profiles Default Research --repo /path/to/repository --client cli
xfx audit profiles Default Research --repo /path/to/repository --client desktop
```

This compares setup sources for the selected client context and repository: settings, instruction files, agents, skills, rules, plugin components, MCP, hooks, and project resources. It reports source, origin, presence/readability, and coverage where those facts can be observed. `--repo` selects project roots; `--client` records the intended CLI or Desktop context. Static discovery currently labels client applicability unknown, including shared machine-user and version-dependent roots. Neither option starts a client or proves runtime discovery or historical loading.

The working candidate adds safe setting and memory-setting values, readable
instruction/agent/rule changes, skill package resource differences, and vetted
integration configuration fields. Changing a script while keeping `SKILL.md`
unchanged remains visible. Truncated, unreadable, unsafe and redacted detail stays
partial; matching disclosed text does not establish equality of undisclosed data.
Configured/installed sources do not prove enabled, available or observed-use state.

Setup reports are local snapshots and can contain selected source text and paths.
Known credential forms are redacted, but arbitrary prose cannot be guaranteed safe
for public sharing. Setup exports omit source text by default. Use
`xfx audit export profiles Default Research --include-content --output setup.json`
to explicitly retain the selected redacted text and readable diffs. Both modes use
private file permissions and may retain paths/metadata; review them before sharing.
Neither is an automatic public-publication sanitizer.
Run reports continue to omit raw prompts, tool arguments/results and transcripts.
No copying, installation, activation or memory-content migration occurs.

Audit discovery is independent of profile creation and copying. A resource can appear in the audit even when Xenoflux cannot copy, create, enable, or launch it. Discovery covers relevant profile/native-home and user roots, project roots, system/admin resources, bundled resources, and plugin resources where supported. A filesystem or manifest entry proves presence only, not advertisement, loading, invocation, or use.

Managed source labels require separate evidence. A native catalog's explicit
`admin`/`system` scope or a recorded hook source such as `mdm`,
`cloudManagedConfig` or a legacy managed-config source is retained as reported
provenance. It does not establish device enrollment, authenticated enterprise
delivery, policy enforcement or instruction adherence. Static administrator-root
inventory also leaves client applicability unknown; a configured scan root is
not a validated native administrator-source contract.

Historical path references do not become administrator sources because they
start with `/etc` or contain `admin/skills`. Likewise, broad `/opt`, `/usr/share`
or arbitrary `skills/.system` fragments do not establish system origin. The known
bundled-cache layout under the selected native/profile or user Codex home can
retain its location-based system classification. Explicit structured native
scope stays separate from these path inferences. Historical classification does
not consult today's filesystem or resolve old references against current files.

Genuine MDM/enterprise/admin acceptance remains unverified without an
already-managed disposable environment. The pinned macOS loader uses host managed
preferences and a fixed Unix managed-config path; redirecting `CODEX_HOME` does
not provision that policy. Native test injections and custom discovery roots are
synthetic controls. The current verification covers recorded-label plumbing and
ordinary native profile/project/system countercontrols, with partial evidence
preserved through export/reopen; it does not close the genuine managed gap.


## Inspect and compare existing sessions

Select each session by its owning profile and native UUID:

```sh
xfx audit show --profile Default --id NATIVE_UUID
xfx audit diff \
  --left-profile Default --left-id LEFT_UUID \
  --right-profile Research --right-id RIGHT_UUID

# Reopen previously exported normalized evidence without native sources.
xfx audit show /path/to/run.audit.json
xfx audit diff /path/to/default.audit.json /path/to/research.audit.json
```

The profile plus UUID is the source identity. Lookup does not fall back to another profile when the UUID is absent. Each side retains its usable evidence when the other is missing or incomplete. Historical sessions are read from their native source; importing them is not required.

If the native index has no matching row, audit lookup also checks the selected
profile's retained session date directories for that exact UUID. The bounded
lookup requires one safe file and a matching session header; ambiguous files,
unsafe paths and malformed indexes remain unavailable. Reports identify this
discovery path and its missing index metadata. This does not repair the native
index or establish complete child-session coverage.

Tasks started directly in Codex CLI or Desktop use the same commands; xfx need
not have launched them. Client identity is reported only when recorded source
signals support it. Today's profile files are never substituted for historical
setup or task-end code.

When you know two selected sessions concern the same task, declare that explicitly:

```sh
xfx audit diff --left-profile Default --left-id LEFT_UUID \
  --right-profile Research --right-id RIGHT_UUID \
  --same-task "booking ledger" --variables "model,reasoning effort"
xfx audit export LEFT_RUN.json RIGHT_RUN.json --same-task "booking ledger" \
  --output comparison.md --format markdown
```

These labels are user declarations, not proof of identical inputs. Matching
recorded task fingerprints take precedence; conflicting fingerprints remain a
conflict even with a declaration. Omit `--same-task` when association is unknown:
supported behavior remains inspectable, while dependent same-task metrics stay
unavailable. Declarations and selected identities survive export/reopen. `--variables`
describes intended differences; it does not prove which settings were effective.

### Read a same-task comparison

The development candidate presents a comparison in this order:

1. **Comparison conditions** — task and run identities, baseline, recorded native/model/effort controls, declared setup variables, order, environment, and evidence coverage. Configured resources, loaded-source records, observed reads or invocations, and adherence are separate facts. A matching label alone does not establish equivalent conditions.
2. **Behavioral findings** — scoped differences, similarities, or inconclusive results, with per-side coverage, pair counts, evidence references, and limits. A single pair always reports consistency as unmeasured.
3. **Paired action evidence** — the retained left/right actions referenced by findings, including actor, turn, source and order where available. A read/edit ordering claim is limited to actions in the same positively owned source stream; generic reads do not identify what was read or prove understanding.
4. **Verification** — agent claims, native completion, named frozen checks, capture checks, and human review remain distinct. Current generic action records cannot identify agent boundary-check activity or agent final-diff inspection, so both are reported as unknown.
5. **Time and tokens** — scoped measurements and eligible deltas only. Unknown accounting or ineligible conditions suppress a delta; these values do not establish billed cost or quality.
6. **Outcome and code changes** — recorded checks, review, task-end change evidence, and artifacts, with any association limited to the named criterion and observed pair.

The current file-scope finding uses the frozen `editableFiles` declaration and positively attributed file-change actions. It can report a located edit inside or outside that boundary. An in-boundary edit does not prove that all edits were in scope. “No file-change records” is shown only when captured action, actor, and source-detail coverage is complete; otherwise scope remains unknown or partial. When both sides have the same declared boundary and supported observations, the finding can be classified as different or similar for that observed pair. Missing or conflicting conditions make it inconclusive. The read/edit finding only compares source order within one owned stream; unsupported agent verification and diff inspection remain unknown.

An optional `taskContract` field in a complete experiment specification declares the task identity and relative editable-file boundary explicitly, for example:

```json
{
  "taskContract": {
    "id": "booking-ledger",
    "editableFiles": ["src/booking-ledger.js"]
  }
}
```

This is an illustrative contract shape, not a real run or baseline. Task text and machine-specific paths remain private. The public synthetic illustration is [a booking-ledger comparison](../examples/audit-booking-ledger-comparison.md); it demonstrates report wording only and contains no measured effect. It is not a real booking-ledger baseline/workflow run or human walkthrough.

Comparison eligibility is claim-specific. Different setup, model, reasoning effort
or native versions remain visible conditions and do not erase supported behavior
findings. Timing needs a recorded or user-declared same-task association; checks
also need matching check recipes, and rubric comparisons need matching quality
definitions. Code deltas need a known common baseline. Token comparisons retain
their accounting and scope limits. Unknown historical context limits dependent
claims without hiding other observations. None of these comparisons establishes
causality or a universal winner. One pair leaves consistency unmeasured.

Markdown export includes a frozen JSON sidecar (`OUTPUT.audit.json`). Reopen the JSON sidecar with `xfx audit show` without native source sessions; `xfx audit diff` accepts two frozen run JSON files. Markdown is the human-readable view, not a parsed source. Keep it with its JSON sidecar. Existing raw/full exports remain private and may contain sensitive paths or metadata. The behavior described in this section belongs to the local Xenoflux 2.1.0 release candidate; published and installed Xenoflux 2.0.0 does not include it. Candidate verification does not publish or install the package.

Native history may retain an indexed `.jsonl` rollout as `.jsonl.zst`. xfx reads
the exact compressed sibling only when the indexed plain file is absent, preserving
profile ownership and source identity. Compressed and decoded input are bounded;
malformed or oversized archives remain unavailable. The supported Node minimum
(22.15.0 in the 22.x line, or 23.8.0+) includes built-in Zstandard decoding.
Runtimes without that capability report an actionable upgrade requirement.
No native session file is extracted, rewritten or restored. Fingerprints identify
stored source bytes; decoded and parsed byte counts are reported separately.

Depending on the native record format and completeness, reports can include recorded turn contexts, agent relationships, tool activity, usage observations, skills, and evidence references. A recorded event describes what the source captured; it is not a complete account of hidden or unlogged activity. Historical final workspace changes are unknown unless the selected source contains an adequate baseline and final artifact. The current checkout is never substituted for a historical final state.

Where the supported native app-server exposes loaded instruction-source metadata,
the audit records one bounded snapshot per positively owned agent. A root snapshot
is taken before its task; an already-loaded idle child snapshot is taken after
its task using that child's own native resume metadata. Child resume is limited to
threads owned by the audit run and does not reconstruct protected or historical
threads. The capture can update the audit-owned child client identity and its
listeners while inspecting it. Missing or malformed channels remain unavailable
or partial. Snapshots retain only a logical-source SHA-256 identifier, broad
origin, safe filename label, native source/phase, source line, and reported,
omitted, or rejected counts. Absolute paths and instruction contents are excluded.
Native source order and repeated references are retained. Source identifiers
describe logical file locations, not file contents or instruction equality.
This is loaded-source provenance: it does not show that an agent followed the
instructions, and the reported list may be incomplete. `reported-empty` means the
native list was empty; it does not prove that no instructions affected the agent.
Cross-run comparison aligns only uniquely identified agent roles. It does not
inherit a root snapshot into a child or treat a missing child row as empty.

Optional recorded model and effort expectations check selected sessions:

```sh
xfx audit diff \
  --left-profile Default --left-id LEFT_UUID \
  --right-profile Research --right-id RIGHT_UUID \
  --expect-model gpt-6.1-sol --expect-effort medium
```

These values check recorded observations; they do not change settings or prove effective backend configuration. Missing observations remain unknown.

### Reopen a saved audit run in the development checkout

`xfx audit show AUDIT_RUN_ID` and `xfx audit diff LEFT_RUN_ID RIGHT_RUN_ID`
project retained evidence without rerunning the task. Experiment and series
reports use the same projection. Saved execution reports, check failures and
human reviews remain unchanged.

Where an exact same-profile native rollout remains available, the report joins
its task-turn model and reasoning controls separately from configured overrides
and native startup metadata. Missing, conflicting or ambiguously owned turn
contexts remain unknown; startup values do not fill missing turn observations.
The source fingerprint identifies the retained snapshot read now, rather than
independently attesting to its bytes at the original capture time.

Supported literal command records name repository-relative reads, edit
invocations, test files and inline assertion-script constructs, with actor,
turn, call, input/result line and source fingerprint references. No retained
command or script is executed. A process exit is scoped to its operation or
whole invocation; a multi-command exit does not prove every earlier command
succeeded. Script constructs do not establish branch or assertion coverage.
Unsupported syntax and partial action coverage remain explicit.

Export after inspection to retain these findings and references without access
to the native homes. Frozen JSON and Markdown sidecars reopen from their own
evidence. Original runner checks and separately obtained follow-up checks are
distinct records; replay does not turn a failure into a pass or submit a human
review.

## Understand skill evidence

The audit treats skill discovery and skill use as separate questions. It inspects relevant origins independently of copy eligibility and reports evidence connecting skills to agents or turns. Depending on client support, discoverable origins include profile/native-home and user roots, project roots, admin/system resources, bundled resources, and plugin packages. Provider, origin, and source references distinguish same-name skills. Symlink aliases and canonical locations may both be shown when safely inspectable.

| Evidence | What it supports |
| --- | --- |
| Filesystem or manifest entry | The resource exists at that source; use is not established. |
| Native catalog or recorded context | The resource was advertised or discoverable in that context; loading is not established. |
| Explicit selection or invocation record | The agent requested or invoked it according to that event's semantics. |
| `$skill` in user text | A selection mention only; quotations, negation, and hypothetical uses are not interpreted as requests. |
| Definition read/load or linked resource/tool activity | Access or activity was observed; this does not prove the instructions were followed. |
| Tool input references a skill, followed by an outer tool return | Read/resource intent and a paired outer return only; a wrapper can return without executing that reference. |
| Agent text mentions a skill | Self-report only unless another source corroborates it. |

The report attributes observations to root or delegated agents only when session evidence supports that relationship. A parent's catalog is not counted as a child invocation, and copied context is not a new use. A child whose identity or ownership cannot be corroborated remains unresolved rather than being merged by name, time, or model.

A parsed shell read is evidence of an attempt. A successful single literal `cat`, `/bin/cat` or `/usr/bin/cat` can become an observed read when native action evidence corroborates it. Supported shell wrappers must contain only that literal command. Compounds, pipelines, expansions and unsupported wrappers cannot establish a successful read because their exit can mask a failed read. Native skill load/read events retain their own recorded semantics.

Historical data may not contain every skill root, catalog, definition read, invocation, or child event. Reports name coverage gaps and retain `partial`, `unavailable`, or `unknown` status. No observed skill event is not proof that no skill was used. The current inventory is not presented as the historical inventory for an old session.

## Export a frozen report

Export one session or a two-session comparison:

```sh
xfx audit export --profile Default --id NATIVE_UUID \
  --format markdown --output /path/to/audit.md

xfx audit export \
  --left-profile Default --left-id LEFT_UUID \
  --right-profile Research --right-id RIGHT_UUID \
  --format json --output /path/to/audit.json

xfx audit export profiles Default Research --repo /path/to/repository \
  --client cli --format markdown --output /path/to/profiles.md
```

JSON output is the frozen normalized report and preserves source identity, coverage, warnings, observations, and derivation metadata. Markdown output includes evidence limitations alongside findings and creates a frozen JSON sidecar at `OUTPUT.audit.json`; `show` and `diff` can reopen those files after native sources disappear. Export prints a receipt with the output path, format, evidence path, SHA-256, source kind, and source status. Raw transcripts and tool output are not included by default. Paths, resource names, and usage metadata can still reveal private information. Every output file, including the Markdown sidecar, is created exclusively; choose unused paths and keep both files together.

## Per-run resource provenance (development checkout)

The development checkout records bounded `resourceProvenance` with live controlled
experiments. This is unreleased work; the published 2.0.0 package and installed
CLI are unchanged.

Provenance joins owned native skill catalogs to filesystem observations. It keeps
logical resource locations, native skill and actor references, bounded alias and
canonical references, definition fingerprints and supported plugin manifest
versions. A definition fingerprint covers `SKILL.md` bytes; it does not establish
that an entire package, scripts or dependencies are identical. Plugin fingerprints
cover an allowlisted manifest projection, not arbitrary manifest contents.

Native plugin catalogs identify packages as `plugin@market`. For the supported
cache layout, provenance binds that identity to the exact market, plugin and
version directory, then validates the canonical `.codex-plugin/plugin.json` name
and version. Missing, unsafe or conflicting canonical metadata stays partial;
another manifest cannot substitute for it. Full logical cache references remain
recorded, while verified versions of the same plugin skill can align for
comparison. Multiple matching installed versions remain ambiguous.

Root definitions are sampled before the task. Descendant catalogs can arrive
later: terminal descendants receive an after-task observation; active descendants
receive a `late-observation` with partial coverage. Neither establishes what the
descendant loaded earlier. A second root observation can show changed
endpoint contents. Matching endpoints do not prove uninterrupted stability,
loaded-content identity, instruction adherence or a causal quality effect.
Native instruction-source references remain separate from content evidence.

Only bounded resource roots and regular, safely readable definitions are admitted.
Each run admits at most 160 resources, with up to two filesystem observations per
resource, 512 KiB per file, 8 MiB of acquisition reads, eight symlink hops and a
128 KiB serialized provenance block. Truncated resource or alias detail remains
explicitly partial.
Aliases that resolve within one approved root share a resource only when their
canonical location, origin and provider identity agree. Different catalog origins
or providers remain separate even when they point to the same file; a shared
name does not resolve that ambiguity. Merging filesystem provenance does not
resolve ambiguous invocation candidates. Unsupported roots stay omitted or unknown.

Definition samples recheck the canonical target and approved source-root mapping
before and after reading. A retargeted alias cannot attach another definition's
fingerprint to the original resource. Changed bindings produce partial evidence
without a trusted fingerprint; missing or retargeted roots cannot reuse a stale
approval for an after-task sample. These endpoint checks do not prove continuous
link or content stability between observations.
Credential/state files, unrelated paths, unsafe links, cycles, permission failures
and acquisition limits cannot produce trusted fingerprints. Missing or unsafe
evidence remains explicit; partial provenance does not become complete skill
observability or change the existing partial evidence exit status 2.

The versioned block survives durable checkpoints, comparisons, repeated-trial
compaction and JSON/Markdown exports. Markdown's `.audit.json` sidecar keeps the
same normalized provenance. Frozen `show` and `diff` read recorded evidence without
looking up current definitions. Historical sessions without contemporaneous
provenance report it as not recorded; they are not enriched from today's files.
Historical rendered catalogs resolve root labels only from their recorded
absolute declarations. Label case is normalized consistently; identical repeated
declarations are accepted, while conflicting, invalid, unknown or escaping aliases
are omitted with partial evidence. The importer does not guess an alias chain or
consult today's filesystem to repair a historical reference.
When compaction omits detail, reports retain omission counts and incomplete status
rather than inferring matching resources from missing records.

No definition bodies, credential contents or arbitrary catalog/manifest payloads
are stored in the provenance block. Acquisition uses bounded file and byte limits,
and no recursive package-content hashing. Logical names, aliases, versions and
unkeyed hashes can still reveal private information: audit exports remain private
evidence, not automatically safe public summaries. Keep machine-specific records
and recovery details private and curate public documentation separately.

## Read results carefully

Observed process completion, task success, verification success, and audit coverage are separate outcomes. A successful exit or an agent's final claim does not by itself establish task quality. Historical audits report only acceptance checks and artifacts present in selected evidence.

For experiments, outcome coverage is complete when every declared check has a recorded pass or failure. Interrupted or unrun checks keep it partial; no declared checks means unavailable. A completed native task and evaluated checks can coexist with partial skill coverage and exit 2. Known streaming and state notifications retain their type and ownership metadata, without exposing message text, command output, live diff bodies, moderation data or read-state payloads. Streaming rows do not count as additional tool calls or token usage.

Successful literal `/bin/cat` and `/usr/bin/cat` skill reads can also be confirmed when native reports one matching unknown command action. The command and action must both identify the same single literal target through the supported grammar; failed, missing, compound or mismatched actions do not qualify. Read evidence records this corroboration separately from a native read action.

Historical ingestion supports this absolute-cat route when the retained command,
single unknown action, actor catalog and recorded working directory corroborate
the target. It never resolves historical symlinks against the current filesystem.
An alias catalog entry alone cannot identify a read through its canonical target;
that read stays unattributed unless the history supplies the matching identity.
Comparisons and full or compact frozen exports retain the read-corroboration label.

New skill telemetry records carry an observer-generated `observationId`, preserved in journals and exports. Distinct received rows stay distinct even without timestamps, while replaying the same snapshot or journal does not add them again. Counts describe received observations: native detection can suppress repeated reads and delivery can omit or repeat events. They do not establish unique executions or exhaustive skill consumption. Legacy records without observer identity retain their original coarse replay deduplication.

Metrics are reported only at supported granularity. Token values may be cumulative, overlapping, or scoped differently across parent and child sessions. The report does not add values whose ownership or inclusion semantics are unknown. Missing data is not zero. Recorded event spans are not necessarily wall-clock process time, and unexplained timestamp gaps are not automatically classified as waiting.

Comparisons show observations and deltas, not causal proof that one setting produced an outcome. Different baselines or incomplete evidence are called out; no winner is declared when quality or measurement coverage is unknown.

## Exit status

Successful inspection with complete requested evidence exits 0. Invalid input or a missing selection exits 1; partial or unavailable evidence exits 2; a recorded-control expectation mismatch exits 3 when the required evidence is complete. An incomplete side takes precedence over a missing other side. Historical skill, agent, outcome, and usage gaps commonly produce exit 2 even when useful observations are present. Export can succeed in creating its files while retaining that evidence exit status. `--json` selects structured stdout; export `--format` selects `json` or `markdown`.

## Run a controlled experiment

An experiment runs one task sequentially in each selected profile, from the same
immutable committed repository snapshot. It creates a private checkout per run
and saves the report and artifacts under the selected Xenoflux store's audit
directory. The source worktree can be dirty. No task is run by `--dry-run`:

```sh
xfx audit run --spec experiment.json --dry-run
xfx audit run --spec experiment.json
xfx audit show EXPERIMENT_UUID
xfx audit diff RUN_A_UUID RUN_B_UUID
```

The dry run resolves the requested revision to a full commit ID and checks profile
resolution and bindings, executable version, safe client coexistence, and the
ability to fingerprint relevant profile settings. It does not acquire audit
leases or create workspaces or records. A real run resolves and pins the commit
once, creates every workspace from that exact commit, acquires private audit-only
leases, then runs the profiles one at a time in the order listed in the spec. A
later source branch move does not change the pinned input. Runs are not retried.
Keep the experiment UUID to inspect or recover durable evidence after a restart.

### Experiment specification

Create a UTF-8 JSON file. This is a compact example; include setup and checks only
when the project needs them:

```json
{
  "schemaVersion": 1,
  "repository": "/path/to/repository",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "task": "Implement the requested change and summarize the result.",
  "profiles": [
    "Research",
    {
      "name": "Careful",
      "executable": "/Applications/Codex.app/Contents/Resources/codex",
      "version": "0.153.4",
      "skills": ["review-checklist"]
    }
  ],
  "setup": [],
  "checks": [
    {"name": "unit tests", "argv": ["npm", "test"], "timeoutMs": 300000}
  ],
  "limits": {
    "runMs": 900000,
    "experimentMs": 1920000,
    "outputBytes": 8388608
  },
  "sandbox": "workspace-write",
  "allowIncompleteCapture": false,
  "captureRequirements": {
    "usage": {"agents": "all", "fields": ["inputTokens", "outputTokens", "totalTokens"]}
  }
}
```

The repository must be an absolute normalized path to a Git repository.
`revision` is required and must resolve to a commit; use a full commit ID for the
clearest reproducibility. A branch name such as `develop` is resolved once to a
full commit ID at experiment preflight, and all run workspaces use that pinned
object even if the branch later moves. The report records the selected commit,
source HEAD, and whether the source worktree was dirty. Dirty tracked changes and
untracked files are context only: they are not included in the experiment input,
and the original worktree and index are left untouched. Ignored files are also
excluded. Xenoflux materializes the selected committed tree into a private,
separate checkout. It refuses submodules, Git LFS pointer files, unsupported Git
objects, and trees over its size limits (50,000 entries, 1 GiB total, 64 MiB per
blob). Source Git configuration and credentials are not copied. The task therefore
runs at a different absolute path from the source checkout, which can affect
project path-specific configuration or trust. Review the resolved baseline and
source-dirty flag before interpreting results.

Select between two and eight distinct profiles. Named profiles must already be
bound to the selected source repository and have a registered executable/version.
If needed, bind the existing profile to the original source directory first with
`xfx profile bind NAME /path/to/repository`; this changes Xenoflux registry
metadata only, not the profile's settings or authentication files.
`Default` requires the selected repository to be trusted in its existing Codex
configuration and requires an explicit executable in its profile entry. An
explicit `executable` must be an absolute executable path. Xenoflux observes its
version with saved profile definitions write-protected; an optional `version`
asserts an expected value. The series freezes the observed value to detect drift
within that comparison. Native instruction support depends on validated response
metadata, not a list of accepted release versions. Use only executable files from
a source you trust. A profile entry can also be a string name, or an object with `name`, optional `executable` and
`version`, optional `nativeConfig`, and optional `skills`.

`nativeConfig` applies a narrow set of native `-c` overrides to this invocation
without changing the saved profile: `model`, `model_reasoning_effort`,
`plan_mode_reasoning_effort`, and `forced_login_method`. For example:

```json
{
  "name": "Default",
  "executable": "/path/to/codex",
  "nativeConfig": {
    "model_reasoning_effort": "low",
    "plan_mode_reasoning_effort": "low",
    "forced_login_method": "chatgpt"
  }
}
```

These are requested settings. Native observed model/effort and actual behavior
remain separate evidence. The frozen recipe and setup fingerprint include the
overrides, and resume rejects changes. Use the native executable directly for the
command sandbox transition; a shell launcher cannot supply its caller identity.

`skills` is a list of distinct names requested for that profile's root task. The
native app-server must resolve each name uniquely from its catalog. This is a
selection request, not a complete skills-used list. Capture separately records
the available inventory/catalog and observations for loading, reading, explicit
selection, and package activity where the protocol exposes them. It obtains
catalogs for the root and corroborated child-agent working directories and keeps
origin and agent attribution. Same-name skills from different origins remain
distinct.

Inventory, native selection, and activity are different evidence:

- A catalog entry means the skill was discoverable for that agent's working
  directory; it does not prove the agent loaded or used it.
- A native selection accepted for the root turn records an explicit request.
- A `native-invocation-observed` observation comes from Codex's separate
  `codex.skill_invocation` telemetry channel. It records explicit injection or
  detected implicit use, with thread, turn, skill name, optional native scope and
  plugin identity. It is stronger evidence than selection or a model self-report.
- A read/load or linked resource activity records the observed event and agent;
  it does not prove the agent followed the skill's instructions.
- Agent text mentioning a skill remains self-report unless corroborated.

Prospective runs enable a private, authenticated OTLP/HTTP JSON receiver on a
random loopback port. CLI overrides apply only to the audit-owned app-server
process; no saved settings are changed. Prompt logging is disabled for that
process. Other native log events are discarded, and only projected skill-event
metadata enters the private `skill-telemetry.jsonl` journal. A required journal
must commit before HTTP 200; storage failure latches HTTP 503 for later admissible batches,
including empty batches. Recovery reads the bounded journal without restarting a
task.
The local exporter adds a small observation overhead and replaces that process's
saved log-export destination for the duration of the audit.

Capture applies across profile, user, project, plugin, system/admin origins and
root or corroborated delegated agents, independently of profile-copy support.
In-process child threads share the exporter. Independently launched Codex
processes need their own capture; they are not assumed to be observed. Telemetry
does not establish lineage: unknown thread IDs remain unattributed. Missing
catalog entries retain standalone invocation evidence. Same-name resources stay
ambiguous when the available scope/plugin metadata cannot distinguish them;
the native event has no resource path. Missing plugin identity also stays
ambiguous when a plugin candidate could match.

Read evidence is matched only against the reading agent's catalog. A path shared
by multiple catalog identities remains ambiguous; it is never assigned to the
first matching skill or to another agent's catalog. A completed, successful
single literal `cat` read can be observed directly or inside one `sh`, `bash` or
`zsh` `-c`/`-lc`/`-cl` wrapper, with exactly one native read action. The literal
command target must match a unique skill in that agent's catalog; existing
filesystem aliases are resolved without changing reported paths. Reports retain
the command-target authority, wrapper and confidence through comparisons and
frozen exports. Expansions, compound commands, redirections, option-like operands,
`..` traversal, failed commands and ambiguous matches retain weaker evidence.
This records command completion, without establishing exhaustive instruction
consumption. Native invocation evidence is retained independently of that check.

Codex's implicit detection and telemetry delivery are best effort, and implicit
detections may be deduplicated within a turn. Native invocation counts describe
received events, not every file access or exhaustive instruction consumption.
Reports keep inventory and usage coverage separate; missing origins or child
evidence remain partial or unavailable. No event does not establish no skill use.
Telemetry diagnostics distinguish an enabled receiver with no observed events,
received events, explicit unsupported capability and unknown capability. Bounded
transport byte/rejection counts, journal health, and per-agent/origin catalog and
invocation counts help explain gaps without retaining log payloads.

New journals use a v2 header and a private `.commit.json` sidecar. The receiver
syncs journal data, writes and syncs a hash-bound checkpoint, atomically publishes
it, then syncs the run directory before reporting success. Recovery validates the
pair and replays only that committed prefix. Extra bytes stay on disk as an
uncertain tail and are excluded from replay. A missing, replaced or invalid v2
checkpoint cannot fall back to legacy replay. Readable legacy event-only journals
remain explicitly `legacy-unverified`, without reconstructed durability counters.

This assumes one writer in an audit-owned private directory and filesystem sync
and atomic-rename support. Process interruption and injected storage faults are
covered; actual power-loss durability is not established. A published checkpoint
can remain recoverable even if the final directory sync or HTTP acknowledgement
fails. A replayed receipt does not prove that the sender received HTTP 200.

`skillTelemetry.diagnostics.deliveryAccounting` separates HTTP requests received,
admitted and rejected from records examined, relevant, accepted, durable, invalid,
unclassified, ignored, dropped at the event cap or rejected by persistence.
`classification: complete` applies only to the examined JSON traversal. When a
traversal or byte budget prevents inspection, known counts are lower bounds and
`unexamined` is null; ambiguous attribute maps count as unclassified rather than
invalid skill rows. Known omitted rows produce OTLP partial-success information,
although the pinned native exporter may ignore it. An explicitly disabled
journal has `durable: null`; it is separate from required storage failure.

Live snapshots use the `receiver-lifetime` scope. Recovery uses the last published
checkpoint's `committed-prefix` scope, which may omit later requests, failures and
shutdown diagnostics. Its admission counters are the checkpoint snapshot, not a
record of HTTP responses received by the sender. Full and compact JSON,
Markdown, persisted reports and offline reopen retain these scopes; comparisons
show each side separately. Upstream loss and acknowledgements remain unknown.
These counters cannot quantify native detector suppression, queue/export drops,
unique executions or billing. Delivery metadata contains fixed health fields,
enums and counters, without journal paths, raw payloads, tokens or free-form
storage errors.

### Skill source time

New receiver receipts retain a versioned `sourceTime` object with three separate
reported domains:

| Field | Source field | Clock label |
| --- | --- | --- |
| `nativeEvent` | Native `event.timestamp` attribute | `producer-reported` |
| `otlpEvent` | OTLP `timeUnixNano` | `otlp-event` |
| `otlpObserved` | OTLP `observedTimeUnixNano` | `otlp-observed` |

Each domain stores `unixNano` as an exact positive unsigned 64-bit decimal string,
or null when unavailable. The native attribute accepts a validated UTC `Z`
calendar timestamp, with optional one-to-nine fractional digits. Unsupported
formats, invalid dates, excessive precision, zero/unset fields and out-of-range
values stay unknown. Wire nanoseconds require decimal strings; numeric JSON
values are not trusted because they may have lost precision. Invalid time does
not discard an otherwise valid skill receipt. SDK observation time never fills
missing native or OTLP event time.

Clock labels describe reported domains, not calibrated or synchronized clocks.
`clockRelationship` remains `unknown`; differing values are retained without
computing latency, clock drift or an ordering. The pinned native control reports
a UTC millisecond attribute, unset OTLP event time and a separate SDK observation
time. The producer timestamp helper was not available in the retained pinned
source, so its exact clock contract remains unverified. Nanosecond units and
zero-padded ISO display do not establish nanosecond clock precision or accuracy.

Journal replay, full and compact reports, comparisons, JSON/Markdown export and
offline reopen retain the projection within existing row limits. Time is never
used as receipt identity or a new deduplication key. Legacy `timestampNs` remains
an independent compatibility field; older rows without `sourceTime` do not gain
inferred clock labels. Partial skill coverage and exit 2 remain unchanged.
Only fixed domain labels and validated times enter this object; raw attributes,
paths, prompts, credentials, arbitrary nested fields and errors are excluded.
Projected times still disclose the reported activity timing when exported.

### Tokens by agent and turn

Reports retain ordered source snapshots with exact agent/turn identity, source
references, separate `last` and cumulative `total` counters, context window and
field missingness. Supported counters are input, output, cached input, reasoning
output, cache-write input and total tokens. A missing counter is null, not zero.
`last` retains the source's meaning; it is not assumed to be an entire turn's
increment. Multiple snapshots in one turn are not added together.

Continuity checks identify duplicate observations, regressed/reset counters,
malformed fields and inconsistent `last` values greater than their cumulative
counter. Affected totals are unavailable for comparison. Per-agent and per-field
coverage remains visible; a complete observed stream does not establish a
whole-workflow token total by itself. Parent and child counters remain visible
separately, and cache/reasoning subsets are not added to other token categories.

New fresh paginated captures on the tested native version can also report a
`usage.workflow` total under a verified, version-pinned accounting contract.
The [public acceptance summary](../developer/AUDIT-ACCEPTANCE.md) describes the
bounded source evidence for these threads accumulating their own response usage
and paginated children starting independent counters. `last` on the tested version is the
latest response's usage; `total` is cumulative thread usage. The audit sums each
owned thread's final cumulative field once only after complete tree/turn/usage
capture and clean continuity. Missing fields remain null with contributing-agent
counts; overflow, inconsistent/context-saturated counters and unknown ownership
block the affected total. Reports, side-by-side comparisons and repeated-trial
statistics retain this scope and field missingness through frozen exports.

The same verified captures also report `usage.turns`: a whole-turn field is the
terminal cumulative counter minus the previous turn's terminal counter for that
owned thread. The first turn uses a zero baseline only under the verified fresh
thread contract. This includes multiple responses in one turn without adding
cumulative snapshots or treating `last` as the turn total. Missing boundaries,
out-of-order turns, resets, incomplete capture and invalid subsets leave affected
fields unavailable. Reports retain the baseline, derivation and source references.
Comparisons pair only unique agent roles and recorded turn ordinals; ambiguous
agent mappings stay unpaired. Frozen summaries disclose omitted detail and keep
their precomputed values rather than deriving new totals from truncated evidence.

Development source also supports `usage.recorded` for historical native
`0.163.0-alpha.10.2` rollouts containing explicit response-usage records. It
validates response, thread, session and turn identities, terminal markers,
per-turn response sums and cumulative thread continuity. Response identifiers
are retained as hashes; prompts, outputs and instruction bodies are excluded.
The first retained response record can establish a nonzero prior baseline,
which is kept separate from the selected response totals. Resumed turns therefore
do not count earlier cumulative usage again. This inspection starts no native task
and does not resume a client.

Recorded totals cover the validated response records in the selected threads;
they do not establish exhaustive workflow usage or provider billing. Unsupported
versions, missing fields, duplicate response identities, inconsistent counters,
incomplete source files or missing terminal evidence leave them unavailable.
Reports and comparisons show this scope separately from fresh-thread accounting.
Frozen JSON/Markdown and bounded trial evidence retain revalidation inputs;
omitting required record detail makes affected recorded totals unavailable.

Legacy child forks can inherit a parent usage baseline. Historical imports,
unsupported versions, truncated evidence, incomplete trees and unverified fresh
history therefore do not acquire a workflow total. Existing immutable receipts
are not upgraded automatically. The scope is captured workflow agents, excluding
opaque external processes, model calls inside MCP servers/plugins and provider
billing or cost estimates. Tool calls do not supply independent token costs.

### Tools and MCP during experiments

Reports retain privacy-projected command, file-change, web-search, delegation,
dynamic-tool, MCP, image-view/generation and sleep tool lifecycle observations for the root and corroborated
children. They show per-agent call counts, tool/server/plugin/namespace identity,
status, success/failure and duration where supplied, with comparisons of recorded
counts. Started/completed notifications and later child hydration count as one
call. Arguments, results, tool output and free-form error text are excluded from
these normalized observations and ordinary exports.

Command calls retain a native exit code and execution duration when supplied.
When native command attribution supplies a plugin ID and safe plugin-relative
`scriptPath`, reports retain that script identity and compare its counts
separately from other scripts in the same plugin. This field comes from native
attribution; a command merely running inside a plugin directory does not establish
ownership. Absolute paths, command arguments and script contents stay excluded.
Observer receipt start/end and elapsed time are separate fields: they include
notification delivery and observation delay, and do not establish active or
waiting time. A history turn's start/end is never assigned to each tool in that
turn. Missing-turn lifecycle phases merge only when actor and item identity are
unambiguous; ambiguous phases leave tool coverage partial. Frozen reports retain
these fields, observed turn timestamps and typed MCP startup failure reasons.

MCP startup notifications and called servers are observed without an additional
inventory RPC, connection, login or installation. Process-wide startup events
may have no agent identity. Startup notifications without plugin attribution
remain separate from same-named plugin-owned call records; readiness alone
does not establish plugin ownership or use. This is runtime evidence, not a list of every
configured or available MCP tool. Nested or opaque execution, missing lifecycle
events and external processes remain outside the proven boundary; missing
capture never becomes a zero count. Raw process transcripts remain private and
may contain sensitive data.
Compact reports retain the observed server identities, startup statuses, typed
failure reasons and inventory state. Report and comparison views also read the
older compact `mcpServers` layout. If row or byte limits omit tool/server evidence,
the affected coverage stays partial and comparisons do not present retained
counts or deltas as complete.

Historical inspection uses the same typed tool projection when the selected
rollout actually records the fields. Supported typed items and legacy command/MCP
lifecycle records retain native plugin IDs, safe relative script names, distinct
server/tool names, status, duration and exit codes. Linked child evidence still
requires verified ownership. Missing serialized attribution stays unknown; the
importer does not infer plugin ownership from a command path, consult today's
catalog to reconstruct old state, or manufacture telemetry absent from the source.
Legacy MCP results distinguish an RPC returning `Ok` from the tool succeeding:
an explicit `isError: true` inside that result is a failed call, as is an outer
transport `Err`. The result body and error text remain excluded. Existing frozen
reports retain their original observations; corrected historical classification
requires a new import of the retained source. Declared tool requirements count
matching terminal attempts, including failed calls; passing one does not establish
that the tool succeeded or the task passed.

### Hook execution

Live and historical reports retain native hook start/completion lifecycles for
owned agents. Native handler IDs embed source paths and can repeat, so normalized
reports use opaque SHA-256 IDs plus exact actor/nullable turn and occurrence index.
Sequential repeated invocations stay separate; overlapping indistinguishable
lifecycles remain partial until every outstanding start has a completion; a later
independent invocation can then be recorded normally. Contradictory completion
timing clears terminal status and timing even when a start was captured. Reports show event, source kind,
thread/turn scope, handler type, execution mode, terminal status and supplied
timing. Native timestamps are Unix seconds; durations are milliseconds. A missing
turn stays null, including thread-scoped hooks. Conflicting lifecycle metadata
invalidates terminal evidence and makes hook coverage partial. Reports, count
comparisons and frozen exports exclude hook source paths, commands, output,
entries and status prose. Configured hook names alone do not establish execution,
and an absent event does not prove that no hook ran. Conflicting lifecycle metadata
does not identify which conflicting value is correct; the report retains partial
coverage and does not resolve the conflict by choosing one event.
In native acceptance on the pinned version, hook lifecycles appeared on the
app-server wire and were absent from the selected rollout files. Historical inspection reports
hook coverage unavailable when those rows are absent; it does not compare that
absence as zero execution. Persisted audit reports retain the live observations.

Disposable native controls on `0.163.0-alpha.10.2` also verified a synchronous
MCP hook lifecycle. With the same event explicitly disabled, a bounded native
task completed without a matching MCP call or lifecycle; this does not establish
exhaustive zero execution outside that control. That version emits lifecycle notifications only for
synchronous hooks. An async hook listed in configuration has no measured
execution count without separate runtime evidence; its absent notification is
unknown. Null turns, overlapping starts and contradictory metadata have replay
regression coverage; those controls do not establish native emission of each shape.

### Plugin usage

Plugin usage is derived from observed skill invocation events, MCP calls and
plugin script commands with an explicit native plugin identity. It retains agent/turn evidence, unresolved
plugin ownership and bounded omission counts. A discoverable plugin skill or a
ready MCP server does not count as plugin use. Ordinary non-plugin skill events
are excluded from plugin counts. Failed calls still show attempted use, separately
from success. Native telemetry remains best effort; no plugin event does not
establish that no plugin ran, and tool/plugin token cost is not fabricated from
call counts.

The [public acceptance summary](../developer/AUDIT-ACCEPTANCE.md) records bounded
native evidence for manifest-owned MCP calls with plugin identity, including
successful and failed calls, and for a trusted Documents script with a safe
plugin-relative identity. Those checks used disposable state and a local scripted
provider. They support the tested shell-command attribution path; they do not
establish every script schema or exhaustive plugin use. Ordinary local-plugin
commands without native attribution remain unowned.

A further disposable control on `0.163.0-alpha.10.2` observed plugin-owned MCP
success on both the root and an owned child, plus child tool-reported and JSON-RPC
failures. Full/compact JSON and Markdown exports reopened after source removal.
Live startup readiness remained separate from plugin-owned calls; retained
historical rollouts without startup rows kept that status unknown. This covers
one credential-free local integration. Authenticated external services, transport
disconnects, reauthentication and exhaustive nested execution remain unverified
by that native control; typed reauthentication reasons have fixture coverage.

`setup` and `checks` are arrays of at most 20 named commands each. Each command
has a unique `name`, an `argv` array (the executable is `argv[0]`, followed by
arguments), and optional `timeoutMs`. Commands run without a shell, in the private
workspace, with a minimal environment and a per-command timeout (60 seconds by
default; maximum one hour). Setup runs before the task. Checks run after the task,
and the report snapshots the workspace both at task end and after checks so their
changes remain distinguishable. These commands execute as local processes; the
Codex sandbox setting does not sandbox setup or check commands. Only include
commands you trust.

`limits.runMs` defaults to 15 minutes per profile and can be at most 24 hours.
`limits.experimentMs` bounds the whole experiment and defaults based on the run
limit and profile count; maximum is 24 hours. `limits.outputBytes` defaults to
8 MiB and can be set from 1 KiB to 64 MiB for each captured process output.
Timeouts, output caps, cancellation, failed checks, and incomplete capture remain
visible in the report. Runs are sequential and are not retried.

The sandbox is `read-only` or `workspace-write` (default). `workspace-write`
allows Codex to write only within that run's private checkout and disables network
access for the Codex task. `read-only` disables workspace writes and network
access. Setup/check commands are outside that app-server sandbox as described
above.

The 2.1.0 candidate resolves the supported Desktop-bundled Codex wrapper to its
verified native executable before preparing the command sandbox. This fixes the
`sandbox_apply: Operation not permitted` startup failure observed through that
wrapper. Both read-only and workspace-write preflights passed with saved-profile
protection intact. An unrecognized or unsafe wrapper fails before task execution;
xfx does not silently relax the requested policy.

### Capture completeness and strict mode

Use `captureRequirements` to declare the positive observations an experiment
needs. Its evaluated `captureAcceptance` is separate from task-quality checks and
overall coverage. For example, a delegated task can require all owned agents'
token snapshots plus a particular child skill and tool invocation:

```json
{
  "minAgents": 2,
  "usage": {"agents": "all", "fields": ["inputTokens", "outputTokens", "totalTokens"], "minTurns": 1, "wholeTurns": true},
  "skills": [{"agent": "descendant", "origin": "system", "name": "skill-creator", "min": 1}],
  "tools": [{"agent": "descendant", "kind": "command", "min": 1}],
  "hooks": [{"agent": "descendant", "eventName": "subagentStop", "sourceKind": "user", "status": "completed", "min": 1}]
}
```

`usage.agents` is `root` or `all`; `minTurns` is the minimum number of recorded
turns for each selected agent, and every recorded turn needs attributable usage.
Set `usage.wholeTurns: true` to require verified complete-turn fields derived
from clean cumulative boundaries. Omit it or use `false` to require source
snapshots only; a saved claimed summary cannot satisfy whole-turn acceptance
without the underlying verified capture. Hook selectors use the same agent roles
and can select `eventName`, `sourceKind`, `scope` and terminal `status`. Thread
hooks may have null turns; turn-scoped hooks need an owned recorded turn.
Skill/tool selectors use `agent: root`, `descendant` or `any`. Skills can select
`name`, `origin` (profile, user, repository, system, admin or plugin), and native
`invocationType` (explicit or implicit). Tools can select `kind`, `server`, `tool`
and an exact `pluginId`. Command selectors with `pluginId` can also require a safe plugin-relative
`scriptPath`, such as `skills/documents/scripts/a11y_audit.py`. A call from another
plugin, an unowned command or a different script cannot satisfy those selectors.
A server's availability alone does not satisfy a tool-use requirement. Failed
terminal calls count as observed attempts; task quality and successful outcomes
remain separate checks.
Only uniquely catalogued, turn-attributed skill invocation events satisfy skill
requirements. Missing/ambiguous events, unverified lineage or unsafe counters
fail the declared contract. Each selector has a positive `min` count, default 1.

Declared requirements are enforced even with `allowIncompleteCapture: true`.
Passing them means those observations were captured; exhaustive instruction
consumption remains unknown, so a useful accepted run can still report partial
coverage and exit 2. Without declared requirements, the strict default still
requires complete capture, which best-effort skill telemetry cannot establish.
Use explicit requirements for controlled acceptance, or `allowIncompleteCapture:
true` for an exploratory report. Neither option makes unknown evidence complete.

### Required loaded context (development checkout)

The development checkout supports `captureRequirements.context` for required
native instruction-source references in the actual audit workspace. This is
unreleased work; installed and published xfx 2.0.0 remain unchanged.

```json
{
  "context": [
    {"agents": "root", "origin": "repository", "path": "AGENTS.md", "phase": "before-task"},
    {"agents": "descendants", "origin": "repository", "path": "AGENTS.md", "phase": "after-task"}
  ]
}
```

Place this object inside `captureRequirements`. Each selector requires the source
for every selected owned actor: `root` (the default), `all`, or `descendants`.
Selecting descendants fails when none are captured. `origin` is `repository`,
`profile`, or `user`; `path` is an exact normalized relative path within the
corresponding workspace or home. Repository paths are relative to the audit
workspace root, including any child directory prefix. Absolute paths, traversal,
credential/state paths and unsafe selectors are rejected.

Root requirements are checked after setup and native thread creation, before any
model turn starts. A missing, malformed or unsupported root observation is saved
as a required-context failure; the model task and quality checks do not run.
Xenoflux leaves trust grants, profile settings and registry bindings alone.
Descendant requirements are checked from each owned descendant's recorded loaded
snapshot after capture, before quality checks. `allowIncompleteCapture` cannot
waive a failed declared context requirement.

The supported native contract currently reports the root at `before-task` and
loaded, idle descendants at `after-task`. An explicit different phase cannot be
satisfied by substituting available evidence. Omitting `phase` accepts the
supported recorded phase. Missing historical snapshots, unsupported native
versions, incomplete lineage, ambiguous rows and truncated source lists fail a
declared requirement. No current file, saved setting or catalog entry fills a
missing loaded-source observation.

The tested native `0.163.0-alpha.10.2` delegated-agent tool does not expose a
working-directory parameter. Distinct-directory actor matching has fixture
coverage; the native control verifies three owned actors in the same workspace.
A command run in a child directory does not establish a different agent directory
or loaded instruction list.

This gate compares reported logical source references, not instruction bytes,
continuous stability, precedence, adherence, project trust or effective
configuration. Use the existing hook/tool requirements for their observed
executions; source presence does not prove their activation. Required selectors,
per-actor results, reference IDs and sampling phases survive checkpoints,
compaction and private JSON/Markdown export/reopen. Logical filenames and hashes
can still reveal private context; curate public summaries separately.

### Profile and client safety

The experiment uses each profile's existing home, settings, skills, and
authentication. It does not copy profiles, change registry bindings, close
clients, or alter Xenoflux's native `.run-lock`. Instead, it creates an audit-only
lease at `<store>/audits/leases/<SHA-256 of native home>`, separate from the
native reservation. This lease serializes audit experiments for that home while
leaving native client reservations alone.

Ordinary observed CLI/Desktop resource holders may continue running. A native
`.run-lock` reservation is accepted when it belongs to an exact live Desktop
instance with a verified process set and ownership journal. A valid unchanged
Desktop journal whose recorded processes have all exited or been replaced can
also coexist when no process holds its profile resources; audit records
`stopped-owner-observed` and leaves the lock and journal untouched. A stale main
with a live recorded helper or any resource holder still blocks. An untrusted,
malformed, foreign, or changing reservation, unknown resource-holder state, or
uncertain profile access blocks the run. Xenoflux compares observed client
identities before and after each run. A baseline client that disappears or a
verified Desktop reservation that changes is reported as a preservation failure;
a newly observed normal client does not fail the experiment automatically. The
audit never stops clients.

Xenoflux takes bounded before/after fingerprints of relevant saved settings and
instruction/agent/skill/rule paths, and checks that baseline client identities
remain present. It does not intentionally write those saved settings or change
registry bindings. If a tracked setting changes or cannot be verified, the run is
reported partial and remaining profiles do not start; the audit preserves the
change and does not roll it back. The app-server reads the real `HOME` and
`CODEX_HOME` so it can use the selected profile's existing configuration, skills,
and authentication. Auth remains in its original home and is not copied into the
run directory. Native version probes and app-server startup use a process-scoped
macOS write guard for saved auth, configuration, instructions, agents, skills and rules,
including resolved skill links. The guard changes no saved file permissions and
copies no credentials. Authentication that requires persistence may fail rather
than modify the saved profile. There is no unprotected fallback.

Each app-server process gets an owned audit session plus a private per-process
SQLite location, log directory, telemetry receiver, and temporary directory
through invocation-scoped overrides. Prompt logging is disabled and non-skill
telemetry is discarded. Audit sessions persist native rollout files in the owning
profile's session storage so supported full child-history interfaces can be used;
ephemeral threads cannot supply that history on some native builds. The audit
creates its own session records and leaves existing sessions and saved settings
alone. Native rollout files can contain prompts and tool output and remain private;
ordinary exports include normalized evidence only. Workspace cleanup retains the
audit reports and native session evidence.

The thread inherits the owned process's private checkout directory, which is
verified in the native start response before the task begins. Audit omits an
explicit `thread/start` directory because writable startup can otherwise save a
new project-trust entry in `config.toml`. The turn still requests the declared
workspace-write or read-only sandbox and explicit working directory; native
managed constraints remain in force. Audit grants no new trust: project-local
configuration, hooks and execution policies remain disabled where native trust
policy disables them. Skills remain discoverable under native skill policy.
Unexpected directory responses stop capture before task execution. Resume still
blocks on any actual settings drift; it never restores or exempts trust entries.

These overrides isolate the intended thread, SQLite state, logs, and temporary
files, but do not promise that Codex has no incidental
native cache behavior; audit does not claim every byte under the profile home is
immutable. The guard blocks bundled `skills/.system` refreshes as well as saved
auth writes.
Before any model turn, audit requests a harmless native command under the same
task sandbox to check coexistence with the guard. An unsupported method, failed
command or missing result stops the run before task execution. This probe is
observer activity, not agent verification or model-quality evidence.

The native image may hand a command to the system sandbox launcher, which
applies Codex's ordinary task sandbox independently. Startup helpers cannot
re-enter the native image or inherit that transition permission. Version-only
probes do not receive the transition. The guard also denies random auth/config
atomic-save siblings and profile-directory rename. Exact native runtime/cache
entries and new native session storage remain writable; this does not promise
that every byte under the profile home is immutable.

Offline native acceptance exercised workspace commands and the native patch
helper, denied outside-workspace writes, networking and nested sandbox escape,
and retained synthetic auth/config/system-skill bytes and metadata. The per-run
no-op gate checks launch/coexistence only; the negative canaries establish the
bounded policy evidence for the tested native image. A different binary requires
new native evidence for an execution packet, without a version allowlist.
Preflight-only capture can verify startup/context/command launch without sending
a model turn. It leaves task outcomes unknown. Subscription authentication and
any refresh requirement remain unverified until authorized execution; a required
saved auth update fails safely.

Codex runs against the private checkout, at a different path from the source
repository, while retaining the selected profile's original configuration and
authentication. Path-specific project configuration or trust can therefore
behave differently. The checkout does not isolate external services or undo
actions performed outside it by task code. The task sandbox restricts Codex's
workspace and network access according to the selected mode.

### Inspect, recover, and clean

`show EXPERIMENT_UUID` opens the saved experiment report. `diff RUN_A_UUID
RUN_B_UUID` compares its persisted run records. You can also export a run or
experiment report to frozen JSON/Markdown as described above.

Recovery is preview-only unless explicitly applied:

```sh
xfx audit recover EXPERIMENT_UUID
xfx audit recover EXPERIMENT_UUID --apply
```

Recovery checks the recorded coordinator/process identity and exact audit-lease
ownership. If the coordinator, an owned process, or ownership state is live or
uncertain, it preserves resources and reports a blocked action. Applying recovery
reconciles confirmed stopped work, recovers the durable normalized capture
checkpoint and skill telemetry where available, marks the recovered evidence
partial, snapshots the workspace as recovery-time evidence, and releases only
that run's audit lease. Recovery can include captured session observations even
when the app-server thread is no longer available; it never recreates the native
session or reruns a task or checks. The separate native `.run-lock` and any live
verified Desktop client remain untouched.

A missing process-group leader does not establish that its children stopped.
Recovery also checks for a surviving group before releasing the audit lease,
including older records without a complete process identity. An observable group
or a denied liveness probe keeps recovery blocked. These are read-only checks;
recovery never signals saved PIDs or groups. Children that leave the recorded
group remain unverified, even after that group stops.

Cleanup also previews by default:

```sh
xfx audit clean EXPERIMENT_UUID
xfx audit clean EXPERIMENT_UUID --apply
```

Applying cleanup removes only verified inactive private workspaces whose ownership
and final content fingerprint still match the audit record. It keeps the report
and normalized evidence. Ignored-file contents contribute private hashes to that
fingerprint; their bodies are not embedded in snapshots. Modified Git configuration,
special files such as sockets/FIFOs, changed content, active or unfinished work,
and uncertain ownership prevent cleanup. Recovery may be needed first. Native
process and Git command deadlines are bounded; filesystem work and shutdown can
add overhead beyond the task's process deadline.

## Repeated trials and explicit quality criteria

Use a series when you want the same task and frozen checks to run several times
across the selected profiles. A series requires a versioned `quality` definition.
The series manifest freezes the full normalized spec, committed repository
baseline, resolved profile identities, settings metadata tokens, task/check
fingerprints, schedule, and preassigned experiment IDs before starting a task.
Settings tokens contain bounded file metadata only; authentication content is
not copied or hashed. The manifest and each child experiment are private durable
records. See [audit-quality-trials.json](../examples/audit-quality-trials.json)
for a complete example; replace its clearly marked repository path with an
absolute path on your machine.

The example uses the already registered `Research` and `Careful` profiles, runs
the same task and `npm test` check for three trials, and rotates profile order
with `balanced`. `listed` keeps the profile order in the spec for every trial.
The maximum is 20 trials, eight profiles, and 160 planned runs. `budgetMs` is a
total execution budget; each trial receives a fixed experiment deadline bounded
by `limits.experimentMs`, including setup, task execution and checks. Preflight,
filesystem work and shutdown can add overhead beyond that deadline. Unused time
is not transferred between trials or replenished by a restart.
The `variables` labels document intended setup differences; Xenoflux does not
mutate profiles or apply those variables.

Quality criteria are declarations about evidence, not an automatic judgment of
the task's merit. A named check passes its declared criterion only when its
recorded status is `passed` with exit code zero. Required criteria that are
missing or unverifiable remain unknown/incomplete. All declared command checks
are required by default, including a check omitted from `quality.checks`; use an
explicit `required: false` criterion to make it optional. Optional checks do not
block required quality. A workspace `maxChangedFiles` criterion uses the verified
change count between the post-setup and exact task-end snapshots. Unchanged setup
files, including ignored dependencies, do not count; actual ignored-file additions,
removals, content changes and mode changes do. Raw snapshot file counts and
fingerprints remain available for preservation and cleanup. Missing historical
identities or ambiguous tracking/ignore reclassification leave the task-change
count unknown. Comparisons and frozen exports keep these counts separate.
Include a human rubric only when people will review the results; `required: false` makes it optional. Xenoflux does not run a model or
other judge to score the task. A passing quality result does not repair partial
native capture: incomplete coverage remains visible and can still determine the
series exit status.

Run and inspect a series with:

```sh
xfx audit run --spec audit-quality-trials.json --dry-run
xfx audit run --spec audit-quality-trials.json
xfx audit show SERIES_UUID
xfx audit resume SERIES_UUID
```

`resume` is explicit. It uses the saved manifest and may advance only slots
still recorded as not started. A slot recorded as started is never run again,
even if interruption left no child experiment or task evidence. Such evidence
remains interrupted/unknown; recovery can reconcile a child only after its
coordinator and owned process are confirmed stopped. Profile, task, criterion,
check, order, and budget changes require a new series. `audit recover
SERIES_UUID --apply` reconciles stopped child work without advancing pending
slots. `audit clean SERIES_UUID --apply` removes only owned inactive workspaces
whose saved content fingerprint still matches.

Series summaries retain every planned run in denominators, including not-started
and interrupted slots. They report unknowns and execution failures explicitly,
and summarize available numeric samples with median, quartiles, IQR, and sample
counts. Root-agent counters retain their source-reported scope. Separately labelled
`workflow.*` metrics require the verified workflow accounting contract described
above; missing or incompatible samples stay out of numeric pairs and remain in
the planned denominator. Repeated observations describe these profiles and runs;
they do not establish causality. Cache warmth is uncontrolled and is recorded
as not reset. Profile settings and existing clients are preserved under the
same safety checks as a single experiment, and drift stops further work.
Metric comparisons show the median of paired trial differences with paired and
planned sample counts; incomplete pairs are explicitly labelled. Human-score
distributions keep unreviewed and unscored runs in their missing counts.
Series/evaluation exports retain bounded per-turn/per-agent usage, field coverage,
child lineage, skill identities/invocations, tool/MCP ownership, hook lifecycles, telemetry diagnostics
and declared capture acceptance. They can explain this evidence after reopening
with an empty controller. Omitted evidence counts and size bounds remain explicit;
root metrics and all planned run accounting are retained when detail is capped.
Use `audit show RUN_UUID` or `audit diff RUN_A_UUID RUN_B_UUID` for further detail.
Export individual run reports alongside a series
when that detailed evidence needs to be available offline.

### Compare consistency across repeated runs

Scheduled xfx series now include a consistency summary before the detailed trial
evidence. It follows the same reading order as a single comparison: conditions,
behavioral findings, paired action evidence, verification, time/tokens, then
outcomes and code changes. The summary shows which ordered left/right behaviors
recurred, which contradicted earlier observations, how many pairs support each
finding, and which compatible named-check outcomes accompanied those behaviors.

For tasks started directly in Codex CLI or Desktop, select explicit pairs in a
cohort file. Left and right must refer to the same two profile identities across
the file. Pairing is explicit; xfx does not infer matches from titles or dates.

```json
{
  "schemaVersion": 1,
  "kind": "audit-cohort",
  "name": "Booking task profile comparison",
  "sameTask": "booking-task",
  "variables": ["instructions", "model"],
  "pairs": [
    {
      "left": { "profile": "Default", "id": "LEFT_FIRST_SESSION_UUID" },
      "right": { "profile": "Advanced", "id": "RIGHT_FIRST_SESSION_UUID" }
    },
    {
      "left": { "profile": "Default", "id": "LEFT_SECOND_SESSION_UUID" },
      "right": { "profile": "Advanced", "id": "RIGHT_SECOND_SESSION_UUID" }
    }
  ]
}
```

Replace each UUID placeholder with its exact task/session ID, then run:

```sh
xfx audit cohort --spec cohort.json
xfx audit show COHORT_UUID
xfx audit export COHORT_UUID --format markdown --output consistency.md
```

The saved cohort is an ordinary immutable series report. It can be exported,
reopened without the original sessions, or passed to `audit evaluate` for optional
reviews. Cohort creation reads existing evidence and never starts tasks or checks.
It owns no processes or workspaces to resume, recover or clean.

Each side can instead use `{ "runId": "SAVED_XFX_RUN_UUID" }` or
`{ "report": "run.json" }`. A pair can use
`{ "comparison": "comparison.json" }`, including an exported R3 evaluation of
that comparison. Relative paths resolve beside the cohort spec. Attached review
histories from evaluation files are retained and revalidated. This also lets you
select existing xfx runs instead of starting a scheduled series. The cohort accepts
1–80 pairs and rejects reused underlying sessions/runs and inconsistent profile
arms, so copying an export cannot manufacture an independent repetition.

`sameTask` is a user declaration, not proof of identical inputs. Recorded conflicts
remain conflicts. Different supported task identities form separate finding and
outcome groups; two repetitions of task A remain usable if task B also appears.
Other task groups are excluded from each group's denominator of eligible pairs.
Existing pooled time/token statistics are explicitly labeled when the selection
contains multiple tasks; they are not statistics for an individual task group.
Without recorded task identity or a supported common declaration, repeated
same-task claims stay unavailable. Declared model or setup
differences remain visible. Today's setup is not substituted for historical state.

Read the denominators beside each claim:

- Scheduled series retain planned slots, including failed and unstarted work.
- Selected cohorts report the number selected; the total number planned or possible
  remains unknown. Selection may omit other attempts, so findings describe this
  selected corpus only.
- Missing, ineligible, duplicate and inconclusive evidence stays separate. No action
  record does not establish that an action never happened.
- One pair leaves consistency unmeasured. Opposite left/right patterns remain
  contradictory even when both pairs were classified as “different.” Changing
  action targets alone indicates variation, not a contradiction.
- Direct sessions retain source-recorded elapsed span separately from xfx task
  duration. Tokens retain their recorded accounting and scope; missing totals
  never become zero.
- Named outcomes require matching frozen check recipes. Reviewer score comparisons
  keep reviewer identity/type and exact rubric definitions separate. Missing scores
  are not zero, and reviewers are not pooled into an automatic winner.

The association between a behavior pattern and an outcome is descriptive. It does
not prove that the profile change caused that outcome, establish statistical
significance, or make elapsed time/token counts measures of quality. Supplemental
checks and reviewer judgments remain distinguishable from original check failures.

### Review either audit entry path

Optional review uses the same saved evaluation records for xfx-started runs,
experiments and series, and for comparisons selected from direct CLI or Desktop
sessions. A review is optional: a packet with no submissions is explicitly
unreviewed. Xenoflux does not launch an AI judge or execute supplemental checks.

For directly started tasks, first freeze the exact profile/session selection:

```sh
xfx audit export --left-profile A --left-id LEFT_SESSION_UUID \
  --right-profile B --right-id RIGHT_SESSION_UUID \
  --same-task YOUR_TASK_LABEL --output comparison.json
xfx audit evaluate comparison.json
```

For xfx-started work, use `xfx audit evaluate RUN_UUID`, `EXPERIMENT_UUID` or
`SERIES_UUID` instead. Each command returns a new evaluation UUID. Export that
evaluation for a human reviewer, another AI agent, or both:

```sh
xfx audit export EVALUATION_UUID --output review-packet.json
xfx audit export EVALUATION_UUID --format markdown --output review-packet.md
```

The JSON contains `subject` (the frozen evidence), `reviewPacket` (its fingerprint,
allowed claim scopes, evidence references, candidate snapshots and check recipes),
`reviewHistory` and the current `reviewState`. The Markdown export includes its
JSON sidecar. Give the reviewer the evidence and ask them to distinguish observed
behavior, consistency and outcome quality from unknowns. One pair does not establish
consistency. Keep sensitive details out of reviewer text intended for sharing.

The reviewer supplies UTF-8 JSON in this format. Replace placeholders with exact
values from `reviewPacket`; do not invent missing evidence:

```json
{
  "schemaVersion": 1,
  "kind": "xfx-audit-review-submission",
  "evidenceFingerprint": "FROM_REVIEW_PACKET",
  "reviews": [{
    "id": "review-1",
    "reviewer": { "type": "human", "name": "Reviewer name" },
    "reviewedAt": "2026-10-22T12:00:00Z",
    "method": "retained-evidence-review",
    "scope": "EXACT_VALUE_FROM_CLAIM_SCOPES",
    "conclusion": "inconclusive",
    "summary": "State the judgment, observed evidence and remaining limits.",
    "evidenceRefs": ["EXACT_VALUE_FROM_EVIDENCE_REFS"]
  }],
  "supplementalChecks": []
}
```

Use reviewer `type: "ai"` and include `model` when known for an AI review. Submit
multiple distinct reviewers together or attach them in later revisions. Allowed
conclusions are `positive`, `negative`, `mixed` and `inconclusive`; `preferredRunId`
may identify a run from the packet when the reviewer judges one outcome better.
It is a reviewer judgment, not an automatic winner. Non-inconclusive judgments
require evidence references. Optional `assessments` contain `runId` and `ratings`
using the existing rubric criteria below, when the frozen subject declares a rubric.
AI ratings retain their reviewer type and never populate legacy human scores.
Packet check references use `check:RUN_ID:NAME`, so identically named checks in
different profiles cannot be confused. Run-scoped reviews cannot cite another
run's evidence. Rubric ratings retain the older `check:NAME` format inside their
explicit per-run assessment.

```sh
xfx audit evaluate EVALUATION_UUID --spec reviews.json
xfx audit show NEW_EVALUATION_UUID
xfx audit export NEW_EVALUATION_UUID --output reviewed.json
```

The returned UUID is the current combined view. Every evaluation is immutable;
previous evaluations remain available. To revise one review, use a new entry `id`
and `supersedes` containing its previous ID, with the same reviewer identity and
scope. The report retains the superseded judgment and identifies current entries.
Different conclusions or preferred runs within the same scope show disagreement;
xfx does not combine them into a consensus score. Different scopes are not treated
as disagreement. Series views label original human-score aggregates separately
from the current attached scores for each reviewer and run.

Supplemental check entries use `id`, `runId`, `name`, `candidateFingerprint`,
`recipeFingerprint`, `checkedAt`, `method`, `status`, `exitCode`, `evidenceRefs` and
`attribution: { "type": "human", "name": "Checker name" }`. Attribution type may
also be `agent` or `automation`. Copy candidate and recipe identities for that run
from the packet. A passed result requires exit code zero. The command rejects
missing candidates, unknown recipes, contradictory exits and wrong evidence
fingerprints. For a directly started task, attach retained historical evidence as
described below before submitting checks. Without a candidate and recipe it remains
reviewable, but cannot accept a bound supplemental check. Do not label a check of
today's workspace as a check of historical task-end code.

Original failures and later supplied checks appear together; supplemental results
do not rewrite original outcome status or command exit codes. Identities, timestamps
and results are supplied by the submitter. Evidence binding validates what they
refer to, not the identity of the reviewer or whether an external command ran.
No model cost is inferred.

An exported evaluation can be shown or revised without the original sessions or
store: `xfx audit show reviewed.json` and
`xfx audit evaluate reviewed.json --spec more-reviews.json`. The latter saves a new
evaluation in the current xfx store and preserves the embedded history.

### Attach retained evidence to directly started CLI or Desktop sessions

Native sessions can contain named reads, edits and test executions without a saved
xfx task contract or checked candidate. The reader uses the session's recorded
working directory and matching turn context to identify supported relative targets;
it does not inspect today's checkout. Missing context and unsupported commands stay
unknown.

Use the existing evaluation store to associate a retained task contract, task-end
file manifest and check recipe with an exported native run or pair. This executes
neither a task nor a check:

```sh
xfx audit export --left-profile A --left-id SESSION_A --right-profile B --right-id SESSION_B --same-task booking-ledger --output pair.json
xfx audit evaluate pair.json --json
xfx audit evaluate pair.json --spec session-evidence.json --json
```

The second command supplies the original `reviewPacket.evidenceFingerprint` for
the attachment specification. Submit attachments against `pair.json`, before
reviewing the new evidence-bearing evaluation. Its packet has a new fingerprint
and lists the supplied candidates and recipes for subsequent supplemental checks.

`session-evidence.json` has `schemaVersion: 1`,
`kind: "xfx-audit-session-evidence"`, the original `evidenceFingerprint`, and an
`attachments` array. Each attachment contains:

- `runId`, `profileId`, `nativeSessionId`, `sourceFingerprint`: copy the exact
  identities from that side of the exported report.
- `attributed: { "type": "automation", "name": "Retained task checker" }` and
  `recordedAt`: identify who supplied the evidence and when. Attribution can also
  be `human` or `agent`.
- `taskContract: { "id": "booking-ledger", "editableFiles": ["src/booking-ledger.js"] }`:
  an explicitly supplied editing boundary, not independently verified task identity.
- `taskEnd: { "capturedAt": "...", "files": [{ "path": "src/booking-ledger.js", "sha256": "..." }] }`:
  hashes of retained task-end files. Use actual timestamps and 64-character SHA-256
  digests. A full manifest may include unchanged or out-of-scope files.
- `checkRecipes: [{ "name": "acceptance-suite", "argv": ["node", "check-candidate.mjs", "booking-ledger"], "inputs": [{ "path": "check-candidate.mjs", "sha256": "..." }] }]`:
  the actual check command and hashes of its checker, tests and other relevant
  inputs. Use the same recipe for comparable checks. Raw command arguments are
  hashed into the recipe identity and omitted from the saved report.

Supply only retained evidence: the last three fields are independent and optional,
but at least one must be present. File paths are relative manifest labels; xfx does
not read them or reconstruct a historical snapshot. Hashes bind supplied evidence;
they do not prove capture time, manifest completeness or external execution. The
report labels these limitations and keeps native completion and original checks
unchanged. Review a corrected attachment by creating a new evaluation from the
original report; existing attachments and reviews are immutable.

After attaching supplemental checks or optional reviews to the returned evaluation,
export it and use that file in `audit cohort`'s existing `comparison` selection.
Across repeated pairs, supplemental outcomes are grouped by matching recipe and
kept separate from original runner results. Conflicting checks remain inconclusive.
JSON, Markdown and source-free reopen retain the same evidence and attribution.

### Existing series human rubric input

After a series report has been finalized, `evaluate` can attach review records
and create a new immutable evaluation UUID without changing the source series:

```sh
xfx audit evaluate SERIES_UUID --spec reviews.json
```

The review file is UTF-8 JSON with a top-level `schemaVersion: 1` and `reviews`
array. Each review identifies one run and the fingerprint printed with its
quality evaluation. `reviewedAt` must be an ISO-parseable timestamp. Ratings
must cover each declared rubric criterion exactly once; a null score records an
unscored criterion. A scored rating needs at least one evidence reference that
exists in that run, such as `run:RUN_UUID`, `check:npm test`, or
`workspace:task-end:FINGERPRINT`.

```json
{
  "schemaVersion": 1,
  "reviews": [
    {
      "schemaVersion": 1,
      "runId": "RUN_UUID_FROM_THE_SERIES_REPORT",
      "fingerprint": "QUALITY_FINGERPRINT_FROM_THE_RUN",
      "reviewer": "Reviewer name",
      "reviewedAt": "2026-10-16T12:00:00Z",
      "ratings": [
        {
          "criterionId": "correctness",
          "score": 4,
          "rationale": "The requested behavior is present and the declared check passed.",
          "evidenceRefs": ["check:npm test", "run:RUN_UUID_FROM_THE_SERIES_REPORT"]
        },
        {
          "criterionId": "clarity",
          "score": 4,
          "rationale": "The instructions are actionable and easy to follow.",
          "evidenceRefs": ["run:RUN_UUID_FROM_THE_SERIES_REPORT"]
        },
        {
          "criterionId": "scope",
          "score": 5,
          "rationale": "The change stays within the requested documentation task.",
          "evidenceRefs": ["run:RUN_UUID_FROM_THE_SERIES_REPORT"]
        }
      ]
    }
  ]
}
```

Replace the example identifiers and criterion with the exact values in the saved
series report and rubric. Evaluation validates review/run/definition identity,
score bounds, and evidence references. It regenerates the summary from saved
observations; it does not start model tasks, checks, or judge calls. The original
series report remains immutable, and each evaluation produces its own UUID.
Reviewer names, timestamps, ratings, rationales and evidence references are
included in the evaluation and its exports. Keep sensitive details out of review
text you intend to share. This existing input remains human-only. For external
AI or combined reviews, use the typed review packet workflow above; no model
cost is inferred from a human review.
