# Concurrent profile desktop development

> Sanitized historical record: native identities, private profile labels and local
> artifact roots have been replaced with neutral labels. Result values are
> preserved. References to unpublished source revisions use descriptive labels;
> original revision identifiers and records are retained privately.

Updated: 2026-10-14. Branch: `main`; `codex/concurrent-profiles` merged through PR #4.

## Child-task reader change on 2026-10-13

Status: the user approved implementation with “Continue”; the approved plan
below is now implemented and verified locally. The source baseline included the
native task comparison implementation. The outcome is exact lookup of one
selected child task with positively attributed child turns; no new native task
or saved-setting changes were needed.

### Implementation and native verification

The existing reader now projects bounded lineage only for exact lookup with
turns enabled, checks parent existence in the same database snapshot, and
corroborates child headers. Its bounded scan joins native ownership identifiers
to starts/contexts, excludes unassigned turn IDs and preserves existing
observation/source-line semantics. It adds only `parentTaskId` and
`unattributedTurnCount` to the child turn descriptor and a conditional terminal
summary. No additional reader, dependency, flag or inherited-ordinal rule was
introduced.

| Native child | Returned contexts | Model / effort | Status / exit | Unattributed turns excluded |
| --- | --- | --- | --- | --- |
| Worker `session-01` | 3, lines 25/123/289 | `gpt-6-luna` / medium | partial / 2 | 2 |
| Reviewer `session-02` | 3, lines 8/100/136 | `gpt-6-sol` / high | ready / 0 | 0 |

The worker's two inherited parent turn IDs are absent from its returned child
observations. The reader does not claim their ownership, so partial remains the
deliberate result. Child-to-child comparison returns exit 2 with three observations
on each side and retains known values alongside unknown set comparisons. Both
child rollouts match their frozen planning hashes. Neither child was restarted.

Required syntax, native launcher, full suite and diff checks passed: 406 tests
passed, one opt-in native launch fixture skipped. Four focused child tests cover
lineage rejection, cross-home parent refusal, ownership/root conflicts, repeated
observations and agreeing tuples, start-only/token-only behavior, matching parent
models, privacy/preservation and the 10,000 metadata-record budget. The existing
comparison checker passed all 30 cases. An independent source review found no
remaining definite issue; an initial alleged start-root bypass was retracted
after confirming validation occurs before the start-record return.

Both existing primary task pairs retain exactly their previous comparison JSON
and expected exit codes (complex pair 0; original pair 3 for Comparison profile's low-effort
preflight). Reading Comparison profile's closed WAL index required permission for existing
read-only SQLite coordination sidecars. Database rows and settings were not
written. All 174 saved-setting/registry/selected-primary-rollout snapshot entries
match their pre-change hashes, modes and membership; no restoration was needed.

Evidence: `PRIVATE_ARTIFACTS/record-01`, including
`native-children-verification.json`, the two child outputs,
`children-comparison.json`, primary comparison outputs, `acceptance.json`,
check/full-suite logs, before/after snapshots and `verification.json`.
This is local source integration without installation or publication.

### Approved plan and source evidence

Read-only inspection of the two Default pilot children found:

| Child | Positively attributed context observations | Model / effort | Context source lines | Other context observations |
| --- | --- | --- | --- | --- |
| Worker `session-01` | 3 | `gpt-6-luna` / medium | 25, 123, 289 | 2 inherited parent turns, lines 7 and 17 |
| Reviewer `session-02` | 3 | `gpt-6-sol` / high | 8, 100, 136 | none observed |

All six owned contexts record
`PRIVATE_ARTIFACTS/record-02/default` as cwd. Their native
`token_usage_record` identifiers link the corresponding turn IDs to the selected
child thread. At planning time the product reader returned unavailable for both;
the implemented reader now returns the verified observations shown above.

Both native index rows declare parent
`session-03` in
`source.subagent.thread_spawn.parent_thread_id`. Each first rollout header has
its own child ID, that parent's session ID, and matching parent/source fields.
Only the worker has a `forked_from_id` and an inherited parent header. Its
`subagent_history_start_ordinal` is 19. That number is not a verified physical
line boundary; the proposed first version will not interpret it. Copied records
also have rewritten timestamps, so creation time is not an ownership boundary.

### Approved implementation scope

1. Extend the existing exact lookup only when turns are requested. Project a
   bounded optional native `source` value, accept the observed `thread_spawn`
   lineage shape, validate a distinct UUID parent, and confirm that exact parent
   row exists in the same checked profile/home and read-only SQLite snapshot.
   Independently corroborate the rollout header against that index lineage. A
   header cannot redirect lookup to another profile or home.
2. Keep the ordinary primary header rules. For a verified child, require the
   first header's ID to equal the requested child and its session ID,
   `parent_thread_id` and nested source parent ID to equal the verified parent.
   `forked_from_id` may be absent; when present it must agree. Later headers may
   identify only that same child/session pair or the verified parent with its
   own session ID. Malformed or unrelated identities invalidate the source and
   return unavailable with no turns.
3. Reuse the bounded rollout scan. For child attribution, inspect only
   `thread_id`, `session_id`, `turn_id` and `root_turn_id` from native ownership
   records; do not collect usage amounts. Form candidate turn IDs from starts
   and contexts, then retain only those with a matching child-thread/parent-session
   ownership tuple. Roots must be valid and consistent across the same turn's
   available start/context/ownership records. Session or root ID alone never
   establishes ownership. Repeated agreeing ownership tuples are harmless;
   contradictory identities or roots invalidate the source. Ownership-only IDs
   must never create synthetic turns.
4. Exclude unattributed candidates from `turns`, count them by distinct turn ID,
   and mark retained child evidence partial. Do not relabel absent ownership as
   proven parent ownership. The worker should therefore expose three child
   observations with status partial and two unattributed turns; the reviewer
   should expose three with status ready and zero unattributed turns. Zero safe
   attributed observations is unavailable. A positively attributed start without
   context retains the existing null-field partial observation.
5. Add only child-specific `parentTaskId` and `unattributedTurnCount` to the
   existing turn descriptor after identity validation, plus one conditional
   lineage/count line in the existing terminal reports. Preserve context source
   lines, duplicates, conflicts, missing values and the existing JSON structure.
   `compare-tasks` consumes the child observations and retains its current
   partial/unavailable and expectation exit precedence.

Touched files: `src/history.js`, the existing `test/history.test.js`
fixtures, conditional terminal rendering in `bin/xfx.js` and
`src/task-comparison.js`, and the existing `docs/user/PROFILES.md` guide.
No new reader, dependency, CLI flag, recursive parent scan, child discovery,
aggregate model/time/cost report or evaluation store is needed. Saved settings,
latest index model/effort and inherited context cannot supply missing child values.

### Acceptance contract

- Metadata-only disposable fixtures reproduce both observed layouts and their
  ownership tuples. Worker output contains exactly the three child turn IDs,
  never either parent's `gpt-6.1-sol` observation; reviewer output contains its
  three turn IDs. Models matching the parent's must also work: model differences
  are not an attribution rule. Native source-line provenance remains exact.
- Missing/invalid index lineage, a missing parent in the selected home,
  conflicting header links, self-parenting, unrelated later headers and
  contradictory ownership/root tuples yield unavailable with no attributed data.
  Another profile containing the same parent/task UUID cannot satisfy the lookup.
- Missing ownership excludes that candidate and produces partial known evidence
  with a distinct-turn count. Repeated contexts and ownership records do not
  inflate that count. Token-only IDs do not create turns. Positively owned
  start-only turns preserve null fields; conflicting model/effort/cwd contexts
  remain visible and partial under the existing reader rules.
- Malformed/truncated ownership evidence and existing byte, line, snapshot and
  record limits remain explicit. Include ownership records in the child metadata
  record budget to keep its attribution map bounded. Unrecognized ownership
  layouts never fall back to ordinal, timestamps, settings or latest task rows.
- Primary-task schema and behavior, unsafe-path refusal, archived exact lookup,
  privacy whitelist and `compare-tasks` exit precedence remain covered by the
  existing tests. Messages, instructions, tool outputs and usage/cost payloads
  never appear in output or fixtures copied from live conversations.
- After approval and implementation, run syntax, native launcher, full suite,
  diff and the existing 30-case comparison checks sequentially as appropriate.
  Then inspect both real children without starting new turns and rerun the two
  existing primary-task pair checks. Compare before/after hashes and membership
  of saved config, instructions, agents, rules, skills, registry and selected
  rollout files. No native settings writes or restoration should be needed.

An independent source/evidence review found this ownership-only scope sound,
including the deliberate worker completeness limit. Fully classifying its
inherited history requires separately verified native ordinal/ownership
semantics; it is not necessary for this first useful reader change.
Planning evidence remains metadata-only under
`PRIVATE_ARTIFACTS/record-03`.

## Native task comparison integration on 2026-10-13

Integrated the smaller Comparison profile candidate from the complex pilot below,
with Default's broader Unicode handling. Independent review of both candidates
found no other definite contract defect; a fresh review of the integration also
found no actionable issue. The integration reuses the existing history fixtures
and profile guide, adds one `src/task-comparison.js` module, and introduces no
dependency, native reader, evaluation store or client action.

```sh
node bin/xfx.js compare-tasks Default LEFT_TASK_ID "Comparison profile" RIGHT_TASK_ID \
  --expect-model gpt-6.1-sol --expect-effort medium --json
```

The command compares exact native task sources through `findHistory` with turns
enabled. It retains source-ordered observations, unknowns and provenance; paired
optional expectations check every recorded observation. Exit precedence remains
2 for partial/unavailable evidence, 1 for not-found, 3 for a ready expectation
mismatch, otherwise 0. Existing history/settings commands retain their behavior.
Unicode Cc/Cf/Zl/Zp controls are rejected in expectation values and removed from
terminal reports and command errors. Structured task metadata keeps its recorded
values. Expanded regressions include bidi overrides, zero-width formatting,
line/paragraph separators and supplementary Unicode format controls.

Syntax, native launcher and diff checks passed. The full suite passed 402 tests
with one opt-in native launch fixture skipped; the corrected pilot acceptance
checker passed all 30 cases. Both suites use disposable fixtures. Required checks
were run after integration, not inferred from the candidate results.

The integrated CLI also verified both real pilot pairs without starting a turn:

| Native task pair | Recorded distinct turns, Default / Comparison profile | Expected model/effort result | Exit |
| --- | --- | --- | --- |
| Complex: `session-03` / `session-04` | 4 / 4 | match: all `gpt-6.1-sol`, medium | 0 |
| Original: `session-05` / `session-06` | 2 / 3 | different: Comparison profile's preflight records low effort | 3 |

Both sources are ready in each pair. The original mismatch identifies turn
`session-07`, native rollout line 8. It is retained
historical evidence, not filled from the currently saved profile settings. Model
sets match, absolute workspace sets differ as intended, and unknown lists are
empty for these primary turns. Both sources record backend
`0.162.0-alpha.17.2`; effective loaded configuration and remote routing remain
unverified. Child-task metadata retains the existing reader limitation described
below; this integration does not change its identity policy.

All 174 captured settings/registry/pilot-rollout entries match the pre-integration
snapshot exactly, including hashes, modes and membership. No saved setting or
native task was written, and no native client was launched or closed. The two
additional snapshot entries are the complex pilot rollouts. This verification
needed no config restoration. Authentication/keychain contents were not inspected.

Evidence and logs: `PRIVATE_ARTIFACTS/record-04`, including
`acceptance.json`, `full-tests.log`, `unicode-tests.log`, `review.json`,
`native-verification.json`, both native comparison outputs and `preservation.json`.
The pilot candidate clones remain unchanged and uncommitted. This is a local
source integration and commit, without installation or publication.

## Complex Desktop comparison pilot on 2026-10-13

Both profiles completed a fresh three-stage task: implement a read-only
`compare-tasks` command using the existing per-turn reader, add paired expected
model/effort controls, then review and fix definite defects. Candidate source
remains uncommitted in independent disposable clones; no command was integrated,
installed or published. This handover records the evaluation only.

Both clones started clean at the recorded-turn metadata baseline (original
revision retained privately):

- Default task `session-03`, checkout
  `PRIVATE_ARTIFACTS/record-02/default`.
- Comparison profile task `session-04`, checkout
  `PRIVATE_ARTIFACTS/record-02/advanced`.

Native metadata verifies all four primary turns per task, including preflight:
`gpt-6.1-sol`, medium effort and the intended checkout. Both report backend
`0.162.0-alpha.17.2`. Task, follow-up and review text matches across profiles.
Default received those prompts through the native app tool's delegation wrapper;
Comparison profile received native user messages. The first preflight pair recorded
the old pilot folders and was rejected before implementation; replacement fresh
chats verified the intended clean clones.

| Evidence | Default | Comparison profile |
| --- | --- | --- |
| Initial command, external checks | 21/21 | 21/21 |
| Expectation follow-up, external checks | 30/30 | 30/30 |
| Final candidate, external checks | 30/30 | 30/30 |
| Implementation duration | 513.529 s | 174.576 s |
| Follow-up duration | 281.973 s | 134.224 s |
| Review duration | 171.311 s | 83.370 s |
| Total active phase time | 966.813 s (16m07s) | 392.170 s (6m32s) |
| Final reported full suite | 401 passed, 1 skipped | 402 passed, 1 skipped |
| Changed/new files | 6 | 4 |
| Net production/test/doc line growth, including new files | 136 / 303 / 102 | 127 / 262 / 73 |
| Candidate delegation | Test worker and reviewer | None observed |

Syntax, native package and diff checks passed in both candidates. Test suites ran
sequentially because existing fixtures share an operation lock. Durations are
native task-complete events joined by turn ID and exclude setup, preflight,
evaluator work and user waiting. More tests or less code do not establish better
quality by themselves.

Both final reviews independently found and fixed raw terminal controls in lookup
errors. A supplemental disposable probe then found a remaining Comparison profile
defect: U+202E bidi format control survives its ASCII/C1-only sanitization. Its
expectation validation also accepts this character. The relevant candidate paths
are `bin/xfx.js:399` and `src/task-comparison.js:36,89`. Independent reassessment
confirmed the reproduction and source boundary. Default removes the character
and rejects it in expectation values. Comparison profile therefore still needs this
contract defect fixed before integration, despite passing the 30 core cases.
Neither candidate was changed by the evaluator. Fresh independent reviews found
no other definite defect within their checked scope; Comparison profile's reviewer also
passed three targeted expectation fixture tests.

The evaluator corrected one faulty assertion after Default's follow-up and before
Comparison profile's follow-up. It demanded a missing effort on the ready right source;
the fixture actually records that effort. Original code, hash and 29/30 result
are retained in `evidence/acceptance-original.mjs`,
`default-stage2-acceptance-original-checker.json` and
`acceptance-correction.json`. The corrected checker is
`596ca316916980affeac2ab1f87ff1b2eb6985b399169bb3c6e9fa856f02a3f7`;
fixture inputs and task requirements were unchanged. Both final candidates use
that same checker. Supplemental Unicode results remain separate from its score.

After saved-setting restoration, both candidate CLIs successfully compared the
real native task pair with expected `gpt-6.1-sol` / medium, returning exit 0 and
identical JSON. Each side is ready with four recorded turns; expectation, model
set and effort set match. Absolute workspace sets differ as intended. There are
no missing primary model/effort/workspace observations. This verifies native
metadata consumption through the candidate command; effective loaded
configuration and remote routing remain unverified.

### Child metadata comparison refresh on 2026-10-14

Fresh exact lookups using the child-ownership reader verify both observed Default
children under parent `session-03`:

| Delegated task | Verified contexts | Recorded model / effort | Completeness |
| --- | --- | --- | --- |
| Worker `session-01` | 3, lines 25/123/289 | `gpt-6-luna` / medium | partial; 2 unattributed turn IDs excluded |
| Reviewer `session-02` | 3, lines 8/100/136 | `gpt-6-sol` / high | ready; 0 unattributed turn IDs |

All six contexts record the Default pilot workspace. These are positively
attributed per-turn observations, not substituted current index settings.
Inherited worker context is excluded; the reader does not assert ownership of
those excluded IDs. Exact lookup of two observed children does not establish
exhaustive child discovery. Comparison profile's captured primary activity contains no
delegation calls; this is an observation, not proof of complete child coverage.

The primary chats remain a controlled `gpt-6.1-sol` / medium comparison. The
entire workflows are not controlled to the same model and effort: Default's
known delegation used the additional models above. This evidence supports
comparing the observed execution strategies, without attributing their differences
causally to profile settings. The 16m07s versus 6m32s values remain sums of primary
phase elapsed durations. Child execution may overlap, so no child durations are
added or complete workflow effort inferred.

The committed comparison is
[Default vs Comparison profile, 2026-10-14](evidence/profile-comparison-2026-10-14-summary.json).
It is a sanitized summary; original source evidence and local pilot artifacts
are retained privately and are not bundled with the repository. Updated local comparison and checkpoint remain in
`PRIVATE_ARTIFACTS/record-02/evidence/comparison.json` and `pilot.json`.
Refresh evidence and preserved pre-refresh originals are in
`PRIVATE_ARTIFACTS/record-05`. Fresh child outputs exactly match
the implementation verification outputs. Acceptance scores, telemetry, candidate
snapshots and supplemental Unicode results are unchanged. Subsequent integration
of compare-tasks with the Unicode fix and child attribution
is recorded separately from those historical candidate results.

Primary task token telemetry totals are 4,062,129 input / 3,978,624 cached input /
14,925 output for Default and 1,687,797 / 1,599,744 / 18,616 for Comparison profile.
Input includes repeated context across requests. Child usage and billed cost are
not established; these counters do not support a total-cost comparison.

Fresh native setup added two project-trust entries in each config and changed
Comparison profile's saved effort from low to medium. The latter was observed after
chat setup; attributing it to native UI persistence is an inference. Only these
captured deltas were restored using exact baseline bytes, unchanged hashes,
owned private regular files and no-active-writer guards. All 172 captured config,
instruction, agent, rule, skill, registry and original-pilot rollout entries
match their baseline hashes, modes and membership. Current pilot history is
expected new activity. No clients were closed or launched by the evaluator;
credential/keychain contents were not inspected and authentication was not
retested. Comparison profile's three stage prompts required user UI dispatch because the
app tools cannot access that profile and Computer Use refused Codex control.

This task supports a small native task comparison command with explicit
expectations and unknowns. Comparison profile was faster and made fewer additions;
Default retained broader Unicode handling. One task pair, different profile
instructions, delegation and prompt delivery do not establish a general or causal
profile winner. Partial worker attribution, unverified exhaustive child coverage
and native saved-default persistence are concrete limits exposed by this longer
workflow. The metadata refresh did not change saved profile settings or dispatch
new native turns; all 174 captured settings/registry/selected-primary-rollout
entries and both child rollout hashes remain unchanged.

At the subsequent report commit review on 2026-10-14, Default's `config.toml`
hash differed from the earlier refresh baseline; the other 173 entries matched.
The cause is unverified. This report review did not write settings or restore
that difference. Preservation for the commit review uses the current settings
as found, recorded in `settings-precommit.json` in the refresh evidence directory.

Complete comparison: `PRIVATE_ARTIFACTS/record-02/evidence/comparison.json`.
That directory also retains per-stage candidate snapshots, patches, acceptance
results, activity and primary metrics, native comparison outputs, supplemental
probe and independent reviews, and guarded restoration/preservation evidence.
`pilot.json` at its parent is the completed checkpoint. At pilot completion, main
source and HEAD were unchanged; the later local integration is recorded above.

## Native task metadata and profile-comparison pilot on 2026-10-13

The native task metadata implementation reuses the Comparison profile pilot's
exact profile-scoped task lookup and adds opt-in turn metadata:

```sh
xfx history --profile NAME --id TASK_ID --turns --json
```

Default reads its standard home without registration. Named sources use their
bound home. The reader verifies the selected rollout's task ID and reports native
turn context with file/line provenance; missing or conflicting values remain
explicit. It never fills them from saved profile settings or latest task settings.
Ordinary lookup does not scan rollout contents. The new opt-in reader scans a
bounded snapshot and emits whitelisted metadata. See the
[user guide](../user/PROFILES.md) for bounds and exit codes.

An independent source/fixture review found no required correctness, privacy or
regression fixes. Syntax, native package and diff checks passed; the final suite
passed 393 tests with one opt-in native launch fixture skipped. Separate
disposable probes verified the 32 MiB and 10,000 metadata-record bounds. Both
existing Desktop pilot tasks were then read successfully using the committed
command, without starting another turn or opening/closing a client.

The original pilot used separate checkouts from `5cfc0ed77d3230bb9d408585296f7276c66e6757`:

- Default task: `session-05`, workspace
  `PRIVATE_ARTIFACTS/record-06/default`.
- Comparison profile task: `session-06`, workspace
  `PRIVATE_ARTIFACTS/record-06/advanced`.

Every observed turn records `gpt-6.1-sol` and its selected checkout as `cwd`.
The native backend version recorded in both rollouts is `0.162.0-alpha.17.2`.

| Profile | Phase | Recorded effort | Context line | Native phase duration |
| --- | --- | --- | --- | --- |
| Default | Implementation, including preflight | medium | 8 | 240.638 s |
| Default | User-requested review | medium | 111 | 95.527 s |
| Comparison profile | Initial preflight, stopped before implementation | low | 8 | 27.859 s |
| Comparison profile | Implementation after user correction | medium | 40 | 255.730 s |
| Comparison profile | User-requested review | medium | 164 | 81.755 s |

The effort and workspace fields come from the new reader. Durations come from
previously captured native task-complete events joined by turn ID; the reader
does not collect timing or costs. User waiting time is outside these phase
durations. Default records only its checkout as a workspace root. Comparison profile
Check's implementation/review also record its native visualization directory.
These paths do not prove which resources were loaded.

Both original implementations passed all 17 frozen CLI acceptance checks and
their required checks (388 tests passed, one native fixture skipped). Correctness
is tied for this bounded task. Implementation and review model/effort match,
but the full workflows were not uniformly medium: Comparison profile had a low-effort
preflight and one user correction. Different global instructions, preceding
conversation context and one small task prevent causal attribution or a general
profile/speed ranking. Remote model routing and complete effective configuration
remain unverified.

The original candidates differed on absent-index semantics, which the frozen
oracle did not specify. The committed integration uses Comparison profile's result:
an absent index is unavailable/exit 2; a miss in a readable index is not-found/exit 1.
Original candidate acceptance remains distinct from verification of the new reader.

The committed read-only refresh preserved all 172 captured settings, registry
and selected-rollout entries, including file membership and hashes. SQLite
needed permission to create coordination sidecars for Comparison profile's closed
WAL index; task rows and saved settings were not written. The earlier pilot's
temporary native project-trust changes and exact restoration remain recorded
in its original preservation evidence.

Updated comparison and per-turn outputs:
`PRIVATE_ARTIFACTS/record-06/evidence/comparison.json`,
`default-turns.json` and `advanced-turns.json` in the same directory. The report
contains full turn IDs, source paths/lines, phase joins and output hashes. Original
reports were retained as `comparison-before-turn-metadata.json` and
`pilot-before-turn-metadata.json`. The candidate changes remain uncommitted in
their separate pilot checkouts; the reviewed source integration is committed locally.

## Goal and authority

Multiple fixed-profile CLI/Desktop instances, one recognizable `Codex · NAME`
Dock/Cmd+Tab entry per Desktop profile. Default retains normal paths including
`~/.codex`; named Codex/UI data remains under `~/.xfx/profiles`. Preserve the
ordinary long-running Codex session. Local source work and disposable checks are
authorized; the user supplied the real-profile acceptance below and explicitly
authorized PR merge and GitHub/npm publication. Publication completed without
live profile/app/keychain mutation, client closure or installation.

## Native open/focus acceptance on 2026-10-12

The user ran the packaged launcher check successfully, then opened Compatibility profile and
Comparison profile and repeated each open. Terminal output recorded:

| Profile | First open | Process label | Start label | Repeated open |
| --- | --- | --- | --- | --- |
| Compatibility profile | opened successfully | process-a | start-a | focused, same PID/start |
| Comparison profile | opened successfully | process-b | start-b | focused, same PID/start |

The final `desktop list --observe` reported both instances running, with their
own profile-labelled executable paths and descendant processes, and
`liveHomeChanged: false`. Before opening, the old journal entries still said
running but process observation reported stopped with no processes for either
old PID (process-02 and process-03). These were fresh launches from stopped records; the
commands did not close a live instance.

This establishes actual concurrent startup and repeat-open focus using the
current checkout after packaged-launcher validation. The transcript alone does
not measure compilation/signing calls or prove all sign-in/data isolation,
Dock/Cmd+Tab, Intel execution, or Default-preservation checks. No agent-side
live-profile operation was performed to record these results.

## Version 1.0.0 merged and published

[PR #4](https://github.com/digitalexpression/xenoflux/pull/4) passed both macOS
CI jobs (Node 22.13.0 and 24) on its final head
`2f91c8d2e3d2f96c57e95d85240f00863b7f4caa`. It was squash-merged into main on
2026-10-12 at 13:31:46 Europe/Bucharest (10:31:46 UTC), producing
`f35a08478f1f4244a4e22f40af2781a8a6eb6fd9`.

[GitHub release v1.0.0](https://github.com/digitalexpression/xenoflux/releases/tag/v1.0.0)
was published on 2026-10-12 at 13:33:15 Europe/Bucharest (10:33:15 UTC), as a
stable release, not a draft or prerelease. Its tag targets the merged commit above.
It includes all four verified assets:

- `xenoflux-1.0.0.tgz`
- `smol-toml-1.9.0.tgz`
- `manifest.json`
- `install.mjs`

[npm xenoflux@1.0.0](https://www.npmjs.com/package/xenoflux/v/1.0.0) is publicly
available under the `latest` tag; `preview` remains at `0.3.0-rc.7`. After npm
processing completed, the public version/tag and downloaded tarball were verified.
The npm download matched the GitHub asset and release manifest SHA-256:
`762b197136363998507559da4d3c3257ee0806ca702298fab4e1d3927efb3e87`.
The npm SHA-1 is `76c0cf762e1f7a144769905bd776c635311c2e4d`.

The final bundle was built from the merged commit under
`release-artifacts/1.0.0`, replacing the earlier branch candidates as the release
of record. Its manifest pins that exact source revision, records dependency and
package hashes, and reports a passed detached offline installed-package and
installation-lifecycle smoke check. `npm run check:native` also passed on the
merged source; the local suite had 385 passes and one opt-in native skip. The
published tag and artifacts remain tied to the release commit; subsequent
handover-only commits do not alter the published package.

Release scope confirmed by the user on 2026-10-12: 1.0.0 is the first stable
release. Migration from older preview installations is unsupported and is not a
release requirement. The review findings about removed paired restore/resume
paths and v1/v2 copy-journal recovery are therefore out of scope, not blockers.
Do not reintroduce legacy compatibility or inspect/mutate live installations to
implement a migration. Current v3 journal validation and cached running-instance
preservation remain in place. Native acceptance limits above remain distinct
from the successful open/focus test and publication.

The user's running instances were not closed or installed over. Temporary npm
authentication files used for publication were removed; existing npm configuration
was left unchanged. Release artifacts are ignored local outputs, not PR contents.

## Prebuilt launcher package

The package now ships `src/native/XfxProfileLauncher`, a signed universal Mach-O
for arm64 and x86_64 targeting macOS 13, with a source/binary hash manifest.
Runtime preparation verifies the packaged bytes and copies them; it never calls
Swift or falls back to a compiler. Maintainers explicitly run `npm run build:native`
after Swift changes and `npm run check:native` before packaging. Install/pack hooks
do not compile anything. Customized profile apps still use macOS codesign on a
cache miss or refresh; valid cached apps are reused.

Private helper entries use binary hashes so a new package cannot overwrite a
legacy or running instance's pinned helper. The live open/focus path is unchanged
and bypasses current-package loading. No real profile/app, journal, keychain,
installation or running instance was modified during this work.

Verification: 385 full-suite tests passed, with the opt-in native fixture skipped;
the separate native fixture passed open, repeat-open focus, stopped reopen and
close using the shipped launcher. Six tests also passed from an offline packed
and detached package, confirming packaged bytes/mode, compiler-free preparation,
cache reuse, legacy helper preservation and invalid-package refusal. Syntax,
manifest/architecture/signature/entitlement checks and diff checks passed. Native
execution was verified on Apple Silicon; the Intel slice was cross-built and
inspected, not executed on Intel hardware. Release generation requires these
package inputs to be tracked and the source tree clean.

## Single-command cached opens

The latest user request supersedes the explicit preparation workflow: normal
users run only `desktop open NAME`. Open first focuses a verified running
instance without loading or refreshing the cache. Otherwise it reconciles a
validated stopped journal and its own reservation, loads a valid cached app,
and prepares or refreshes only on `PROFILE_APP_PREPARE_REQUIRED` or
`PROFILE_APP_REFRESH_REQUIRED`. Ownership, integrity and signature failures
remain refusals. A dead operation guard is released only for the exact same
host/store/profile/journal; live and foreign guards stay untouched. Missing
run-locks can be reconciled only for stopped instances, never live ones.

`desktop prepare NAME`, `desktop refresh NAME`, and `desktop recover NAME` remain
explicit maintenance/debugging tools. Cached apps are reused on normal opens;
first opens and stale stopped caches copy the prebuilt helper and sign as needed. A Finder
bootstrap cannot refresh its executing bundle and asks for CLI open instead.
Preparation also refuses raw processes executing from that profile's app root.

The user reported a repeated Compatibility profile open with `RESOURCE_INSPECTION_FAILED` after
opening PID process-01. A read-only host check found that recorded process stopped and
all five profile-resource lsof calls idle (exit 1, empty stdout/stderr). The earlier
failure was not reproduced; no crash or focus failure is established by that
observation. Resource inspection now reports the stage/path and bounded reason
without dumping arbitrary process output or resource contents. Its fail-closed
semantics remain unchanged. No live profile preparation, recovery, launch,
signing or closure was performed by this development turn.

Verification: 379 full-suite checks passed with the opt-in native test skipped.
The separate host-permission native fixture passed automatic cache-miss
preparation, LaunchServices open, same-PID repeated-open focus, stopped-journal
reconciliation and cached reopen without another preparation, wrong-start quit
refusal, and controller close of its own synthetic app. The successful retry
cleaned up its disposable files. Its kernel/native/ps timestamps agreed.
`npm run check` and `git diff --check` passed. Independent source review found no
actionable automatic-open defect. Logs: `PRIVATE_ARTIFACTS/record-07`
and `PRIVATE_ARTIFACTS/record-08`.

User acceptance on 2026-10-11: Compatibility profile opened as PID process-02 and Comparison profile
as PID process-03. Repeated opens returned `focused` with the same PID and start time
for each profile; `desktop list --observe` reported both running with their own
app paths and descendants. The user confirmed focus reached the correct instance.
This establishes real concurrent open and repeated-open focus. Full Dock/Cmd+Tab
labels, sign-in, data isolation and Default preservation still require their
separate acceptance checks.

## Current result and causes

The previous signer fix (4d7fc7e) preserved nested vendor code and allowed the
user's Compatibility profile GUI to open. The user cancelled a “Keychain Not Found” prompt;
Xenoflux still returned `DESKTOP_OPEN_RECEIPT_MISMATCH`.

Two causes now have bounded reproductions:

- An interaction-disabled, read-only `SecKeychainCopyDefault` probe returned
  -25307 under a disposable HOME, and success with the normal login-keychain
  path under the account HOME. No credentials were read and no keychain setting
  changed. Desktop now derives HOME from the macOS account; CLI keeps its
  isolated user-home. Explicit Codex, SQLite, UI-data and temporary routes stay
  profile-specific. Account-home discovery remains account-wide.
- The full native controller fixture failed on an identical PID/UID/start:
  native receipt path `Codex · NAME` versus ASCII-locale ps path
  `Codex M-BM-7 NAME`. A disposable sleep binary reproduced that rendering.
  Process inspection now uses English UTF-8 and explicit UTC timestamps.

The native receipt and focus/quit helper use kernel process start time, matching
ps, rather than NSRunningApplication.launchDate. Delayed bootstrap tests did not
show different clock values; Unicode rendering was the demonstrated mismatch.
Errors now include the expected and observed identity without credential data.
Finder still requires exact bootstrap PID/UID/start and same-PID exec.

The full native close check also reproduced a quitting process briefly shown by
ps as `S (Codex)` with unchanged PID/UID/start. The local ps manual describes this
fallback when argv is unavailable. After graceful quit, close only waits through
that uncertain label; it never adopts or controls it and never releases ownership
until the process disappears. Different lifetimes/executable paths fail closed;
a timeout preserves the last verified identity and reservation.

## Verification and limits

The updated opt-in fixture passed under a controller `TZ=UTC` on this Bucharest
Mac. It exercises production controller open/focus/close, delayed same-PID exec,
native profile name and bundle ID, independent framework loading, fixed Codex/UI
routes and account HOME, and matching kernel/native/UTC-ps start seconds. A quit
with the wrong start time is refused. It observed the actual `(Codex)` shutdown
fallback and then closed successfully. Disposable fixtures exit automatically.
The normal bootstrap signing/routing tests passed, including inherited foreign
HOME rejection. Final verification passed:

- `TZ=UTC XFX_NATIVE_PROFILE_OPEN=1 node --test --test-concurrency=2 test/*.test.js`:
  all 370 tests passed, including the native fixture; no skips.
- `npm run check` and `git diff --check` passed.
- Independent review caught late shutdown-child tracking and timeout evidence
  gaps; both were repaired with regressions and confirmed in the final review.

Installed/default Codex, real profile apps, journals and keychains were unchanged.
The actual Default main was previously read-only observed as PID process-04. The user
subsequently reported Compatibility profile running as PID process-05 with its profile-labelled executable.
These are past observations; inspect current journals and resource handles before
any explicitly authorized cleanup. Do not infer stopped/idle from an absent GUI.

Real profile sign-in, separate data, account-home discovery, vendor helper group
state, Dock/Cmd+Tab activation/reopen and Default preservation remain native
acceptance work. The signer retains nested publisher signatures/application-group
grants. Generated-app replacement still has its previously documented abrupt
interruption window; this work adds no cache migration/recovery framework.

## Next action

Use the existing xfx_dev helper against this checkout. Already prepared valid
apps need only `desktop open NAME`; a running instance is focused. Use `desktop
prepare NAME` for an absent app and `desktop refresh NAME` for a stale stopped
app. Recover any interrupted target reservation after its resources are idle.
Do not close the user's running instances for this work. The remaining native
acceptance checks are in `docs/developer/DESKTOP-IMPLEMENTATION.md`; do not reset keychain
defaults or claim full profile isolation from the synthetic fixture.
