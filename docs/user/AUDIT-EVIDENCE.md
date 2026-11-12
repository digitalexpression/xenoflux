# Audit evidence and capture reference

Commands: [audit guide](AUDIT.md). Execution/recovery: [experiments](AUDIT-EXPERIMENTS.md). Dated native outcomes: [release evidence](../developer/AUDIT-ACCEPTANCE.md).

## Session replay

New xfx runs freeze replay at completion, including capture-unavailable states. Older/direct sessions are derived at read time and labelled accordingly. Export freezes that derivation; reopening adds no later activity. Independent session trees/order, call/result links, event IDs, ownership, source lines and omissions survive source-free reopen. Root-relative elapsed spans are not active time or synchronized clocks; overlapping child spans are never summed.

| Bound | Limit |
| --- | --- |
| Native source / record | 32 MiB / 1 MiB |
| Event body / workflow bodies / events | 1 MiB / 16 MiB / 10,000 |
| Retained check output | 64 KiB per stream |
| New report target / frozen JSON | 12 MiB / 64 MiB |
| Child discovery | 100 children, depth 4, 250,000 index rows or 2.5 seconds |

After temporary-index removal, retained actor observations identify candidates, but same-home headers/owned turns must corroborate them; discovery remains partial. Bodies never captured stay unavailable. Private internal reasoning is excluded. Content opt-in, redaction and fingerprint-binding rules are in [export](AUDIT.md#export-a-frozen-report).

## Per-run resource provenance

`resourceProvenance` joins owned catalogs to safely sampled definitions: logical/canonical references, aliases, origin/provider, actor/native skill identity and known plugin versions. A `SKILL.md` fingerprint covers that file, not the package; plugin fingerprints cover an allowlisted manifest projection. `plugin@market` binds to its exact cache version and canonical `.codex-plugin/plugin.json`; unsafe/conflicting/multiple versions stay ambiguous.

| Bound | Limit |
| --- | --- |
| Resources / observations each | 160 / 2 |
| File / total acquisition / serialized block | 512 KiB / 8 MiB / 128 KiB |
| Symlink hops | 8 |

Sample the root before task; terminal descendants after task, active descendants as partial late observations. Matching endpoints prove neither continuous stability nor loaded bytes/adherence. Recheck canonical target/root before and after reading; changed aliases/roots yield no trusted fingerprint. Share aliases only when canonical target, origin and provider agree. Unsupported roots, credentials/state, cycles and unsafe/denied reads remain omitted/partial.

Frozen provenance retains omission counts and never enriches history from current files. Historical labels use recorded absolute roots: repeated identical declarations are valid; conflicting, escaping or unsupported ones are omitted. Exclude definition bodies/arbitrary manifests and recursive package hashing; names, aliases and hashes can still be private.

Managed `admin`/`system` catalog scopes and `mdm`/`cloudManagedConfig` hook sources are reported provenance, not proof of enterprise enrollment, delivery or enforcement. `/etc`, broad system paths and arbitrary `skills/.system` fragments alone do not establish origin; known bundled-cache layout is a separate location inference. Configured scan roots and redirected `CODEX_HOME` do not provision native managed policy. Genuine managed-environment acceptance remains unverified.

## Skill catalogs and telemetry

| Observation | Establishes |
| --- | --- |
| Catalog | Discoverable for that actor/cwd; not loaded or used. |
| Accepted selection | Explicit root-turn request. |
| `native-invocation-observed` | Received `codex.skill_invocation` detection, with reported actor/turn/name/scope/plugin; not exhaustive execution. |
| Successful read/resource activity | That operation, not adherence. |
| Model mention | Self-report unless corroborated. |

Use only the reading actor's catalog. Same-name/path candidates remain ambiguous, including missing plugin identity; telemetry has no resource path and does not establish lineage. Unknown actors stay unattributed. In-process children share capture; independent processes require their own capture.

A successful single literal `cat` can corroborate a unique skill directly or in one `sh`/`bash`/`zsh` `-c`/`-lc`/`-cl` wrapper. Native read or matching supported unknown-command action, actor catalog and cwd must agree. Preserve target authority/wrapper/confidence. Failed, compound, expanded, redirected, option-like, traversal or ambiguous commands do not qualify. Historical imports never resolve aliases against today's filesystem.

Prospective audit processes use an authenticated loopback OTLP/HTTP receiver, process-local exporter overrides and no prompt logging. Only projected skill metadata enters `skill-telemetry.jsonl`; other native logs are discarded. Saved settings are unchanged. Detection may suppress repeated reads, and transport may omit/repeat events; receipt IDs identify received rows, not unique executions. Snapshot/journal replay preserves IDs without adding receipts again; legacy rows retain their older coarse deduplication.

### Journal and accounting

- V2 commits synced journal data plus a synced/hash-bound `.commit.json` checkpoint, atomically publishes it and syncs the directory before HTTP 200. Required storage failure latches 503, including later empty admissible batches.
- Recovery verifies the pair and replays only the committed prefix. Extra tail bytes remain uncertain; invalid/missing v2 checkpoints never become legacy input. Event-only legacy journals remain `legacy-unverified`.
- Assumptions: one writer, private owned directory, sync/atomic-rename support. Fault/process-kill controls do not prove power-loss durability. A recoverable checkpoint does not prove sender acknowledgement.
- `skillTelemetry.diagnostics.deliveryAccounting` separates request admission/rejection; examined/relevant/accepted/durable/invalid/unclassified/ignored/cap-dropped/persistence-rejected rows. Unexamined counts stay null/lower-bound after traversal limits; ambiguous attribute maps are unclassified. Known omissions produce OTLP partial-success information, which exporters may ignore. Disabled journaling has `durable: null`.
- Live scope is `receiver-lifetime`; recovered scope is the checkpoint's `committed-prefix`, not lifetime HTTP history. Upstream suppression/loss, acknowledgements, unique executions and billing remain unknown. Fixed health/counter fields exclude raw payloads, private paths and free-form errors. Receiver enabled/no events, unsupported capability and unknown capability stay distinct.

## Skill source time

`sourceTime.schemaVersion = 1` retains separate reported domains:

| Field | Wire source | Clock label |
| --- | --- | --- |
| `nativeEvent` | `event.timestamp` | `producer-reported` |
| `otlpEvent` | `timeUnixNano` | `otlp-event` |
| `otlpObserved` | `observedTimeUnixNano` | `otlp-observed` |

`unixNano` is a positive unsigned 64-bit decimal string or null. Native time accepts valid UTC `Z` dates with up to nine fractional digits; wire nanoseconds require strings, not lossy JSON numbers. Invalid/zero/out-of-range values stay unknown without discarding the receipt. SDK time never fills event time.

`clockRelationship` stays unknown: units/zero padding imply no clock precision, calibration, latency or cross-domain ordering. Source time is not identity/deduplication. Fixed validated fields survive replay/export within row bounds; raw attributes are excluded. Legacy `timestampNs` stays independent and older rows gain no inferred labels.

## Tokens by agent and turn

| Projection | Contract |
| --- | --- |
| Snapshots | Owned actor/turn/source, `last`, cumulative `total`, context window and missingness. Input/output/cached-input/reasoning/cache-write/total fields stay separate; null is not zero. `last` is source-defined, not automatically a whole turn. |
| `usage.workflow` | Count each owned thread's final cumulative fields once, with valid baselines, continuity and complete captured usage. Initial total must match initial response counters before assuming zero; a fresh child alone proves no baseline. |
| `usage.turns` | Terminal cumulative minus prior terminal cumulative. First turn uses zero only when proved; later turns may use verified prior boundaries. Never add cumulative snapshots or treat each `last` as whole-turn usage. |
| `usage.recorded` | Validate explicit response records, IDs, terminal/context/turn evidence, response sums and cumulative continuity. Hash response IDs; exclude bodies. Keep a resumed thread's prior baseline separate from selected totals. |

Duplicates, resets/regressions, malformed/overflowed/context-saturated values, invalid subsets or `last > total` block affected totals. Missing boundaries/lineage/source fields stay unavailable. Comparisons pair unique actor roles and turn ordinals only. Frozen compact reports retain precomputed values and disclose omitted derivation inputs; required missing inputs invalidate recorded totals.

Validated captured-session sums are not proof of exhaustive workflow discovery. New captures retain bounded post-shutdown index evidence; indexed, captured and verified replay actors must agree for completeness. Missing indexes/truncated history/legacy inherited baselines remain partial. Opaque external processes, MCP/plugin-internal model calls and billing are outside scope. No token subsets or overlapping time spans are added twice; frozen receipts are never upgraded automatically.

## Tools and MCP during experiments

Normalize owned root/child command, file-change, search, delegation, dynamic-tool, MCP, image and sleep lifecycles. Retain identity, supplied status/duration/exit, counts and coverage; merge start/completion/hydration as one call. Missing-turn phases merge only with unambiguous actor/item identity. Observer receipt timing includes delivery delay; turn duration is not each tool's duration or active/wait time.

Native plugin IDs and safe relative `scriptPath` may attribute scripts; command location alone cannot. Normalized rows exclude absolute script paths, arguments, results, output and error prose. Replay bodies have their separate explicit export opt-in.

MCP startup/readiness and plugin-owned calls remain separate, including unattributed process-wide startup. Observe existing notifications without another inventory RPC/login/connection. Retain server/tool/namespace/plugin identity, startup status, typed failures and compact inventory state; support older compact `mcpServers`. Omitted rows keep comparisons partial. Historical imports use recorded fields only; explicit inner `isError: true` and outer transport `Err` are failures even when RPC transport returned `Ok`. Reclassification requires a new import, not rewriting frozen reports.

## Hook execution

Use opaque SHA-256 handler IDs plus actor, nullable turn and occurrence index. Sequential repeats remain distinct; indistinguishable overlaps stay partial until all starts complete. Conflicting metadata/timing clears terminal conclusions rather than choosing one event. Retain event/source kind/scope/mode/status and supplied Unix-second timestamps/millisecond durations; exclude source paths, commands, output, entry text and status prose. Thread hooks may lack turns; turn hooks need owned turns. Configured names and absent events prove no execution count; unsupported/absent historical rows remain unavailable.

## Plugin usage

Derive usage only from natively attributed skill, MCP or script activity. Catalog presence/readiness is not use; ordinary non-plugin events are excluded. Failed calls count as attempts separately from success. Missing identity/opaque nesting/unauthenticated service gaps stay unknown; call counts imply no token cost or exhaustive activity.

## Capture completeness and strict mode

Declare positive `captureRequirements`; evaluated `captureAcceptance` is separate from task quality and overall coverage:

```json
{
  "minAgents": 2,
  "usage": {"agents": "all", "fields": ["inputTokens", "outputTokens", "totalTokens"], "minTurns": 1, "wholeTurns": true},
  "skills": [{"agent": "descendant", "origin": "system", "name": "skill-creator", "min": 1}],
  "tools": [{"agent": "descendant", "kind": "command", "min": 1}],
  "hooks": [{"agent": "descendant", "eventName": "subagentStop", "sourceKind": "user", "status": "completed", "min": 1}]
}
```

| Selector | Values / meaning |
| --- | --- |
| Usage | `agents: root/all`; `minTurns` applies per selected actor. `wholeTurns: true` needs verified boundaries, not a claimed summary; false/omitted accepts source snapshots. |
| Skill/tool/hook actor | `root`, `descendant`, `any`; positive `min`, default 1. |
| Skill | `name`, `origin` (profile/user/repository/system/admin/plugin), explicit/implicit `invocationType`; unique catalog and owned turn required. |
| Tool | `kind`, `server`, `tool`, exact `pluginId`; plugin commands may require safe relative `scriptPath`. Matching terminal attempts include failures; readiness or another plugin/script cannot satisfy use. |
| Hook | `eventName`, `sourceKind`, `scope`, terminal `status`; thread hooks may have null turns. |

Missing/ambiguous lineage, invocations or unsafe counters fail declared requirements. `allowIncompleteCapture: true` cannot waive them. Without requirements, strict default needs complete capture, which best-effort skill telemetry cannot prove. Explicit requirements or exploratory `allowIncompleteCapture` do not turn partial coverage into complete; accepted useful runs can still exit 2.

## Required loaded context

`instructionSources` snapshots retain ordered/repeated logical-location hashes,
safe filenames, origin/phase and omission counts; absolute paths and contents are
excluded. Hash equality identifies a location, not equal instruction bytes.
Root snapshots never fill child gaps; `reported-empty` does not prove no instructions
applied. Child inspection uses only owned, loaded idle threads and may update their
native client metadata/listeners.

Within `captureRequirements`:

```json
{"context":[
  {"agents":"root","origin":"repository","path":"AGENTS.md","phase":"before-task"},
  {"agents":"descendants","origin":"repository","path":"AGENTS.md","phase":"after-task"}
]}
```

Require each selected owned actor: `root` (default), `all` or `descendants`; selecting absent descendants fails. Origins: repository/profile/user. Paths are exact normalized relative labels under the actual audit workspace/home, including child prefixes; absolute/traversal/credential/state/unsafe selectors are rejected.

Root evidence is checked after setup/thread creation and before a model turn; failure prevents task and quality checks. Descendants are checked from loaded snapshots after capture and before quality checks. Supported phases: root `before-task`, loaded idle descendants `after-task`; omitted phase accepts supported recorded evidence, explicit phases cannot substitute. Missing/truncated/ambiguous/unsupported observations fail; current files/catalogs cannot fill gaps. Trust, settings and bindings are not changed.

The gate proves reported logical source references, not bytes, precedence, stability, adherence or integration activation. Native distinct-directory actor evidence remains limited; a child-directory command does not prove a different actor cwd. Selectors/results/references/phases survive checkpoint/export; filenames/hashes can still be private.

## Captured task-end patch content

Retain at most 256 KiB redacted text per side, bound to source baseline, post-setup fingerprint and task-end snapshot. Baseline-to-task-end patches may include setup changes; ignored/unchanged/binary/oversized contents are absent or explicitly limited. After-process fallback timing remains labelled. Imports never fetch missing historical code from recorded paths. Body export opt-in and review fingerprint preservation follow [export rules](AUDIT.md#export-a-frozen-report); [the app](APP.md#inspect-captured-code-changes) exposes the UI.


## Read-only client conversation imports

Import is distinct from execution, managed-profile isolation and desktop session
association. Both sides must pass admission before publication. Retain immutable
private sources separately from sanitized projection hashes; export/reopen uses
the frozen projection without rereading vendor history. Missing profile/account,
surface/location, completion, usage or applied effort stays unknown. A historical
resume/shutdown event is not an operation performed by the reader.

### Claude Code

Select two UTF-8 UUID-named JSONL files, each at most 8 MiB and 10,000 records.
Admission validates identity/shape and retains a private snapshot. The pinned
Agent SDK's public stored-session reader runs in a bounded helper against only
that isolated snapshot, with native credentials excluded and subprocess, network
and write entry points guarded before SDK loading. It initializes no agent.
Do not replace this boundary with a private-format semantic decoder; SDK changes
require renewed reader-effects, malformed-input and privacy checks.

Only SDK-selected public user/assistant text enters replay. Thinking, signatures,
tools, system content and oversized bodies remain explicit omissions. Projection
line ordinals do not claim to be original JSONL line numbers. Raw JSONL never
enters the public report; explicit body exports still use redaction and bounds.

### Copilot CLI

Select two explicit local session IDs. The pinned SDK's public
`sessions.readPersistedEvents` uses the selected installed CLI and validated root
without creating, resuming or activating a session. Preserve native user context;
refuse ambient token/provider/root overrides before startup, including empty
`COPILOT_PROVIDERS_CONFIG` and `COPILOT_PROVIDER_*` values. Import performs no
sign-in, model-policy change, task, tool or model prompt.

Pin one journal generation and page sequentially, at most eight 200-event pages;
require `cursorStatus: ok` and final `hasMore: false`. Expiry, unsupported RPCs,
changed scope or bounds fail without a replacement read. Each owned read has
30 seconds plus 18 seconds cleanup, an 8 MiB combined native-output bound and a
separate 8 MiB retained-snapshot bound. Rollback removes only newly owned files.

Only public user/assistant `data.content` text enters replay. Retain available
native event IDs, timestamps and assistant model observations; reasoning, tools,
system/transformed content, assets and opaque fields are omitted. Raw pages stay
private. Successful reader shutdown does not establish historical task completion.
