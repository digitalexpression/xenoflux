# Ordinary review task — implementation contract

**3.0.0 contract; implementation status is owned by the roadmap.** This specification owns execution,
API/persistence, recovery and the selected legacy removal set. The
[goal](AUDIT-GOAL.md#ai-review) owns product behavior; the
[roadmap](ROADMAP.md#delivery-order) owns status, delivery order and exit checks.
Read the section needed for the active slice. Screen composition belongs to the
checkout-only UI handoff's Reviews section, not a second backend contract.

## Execution with the selected profile's settings

Use the selected profile's existing home, executable, sign-in and normal launch
environment. Omit model and reasoning effort to inherit the profile defaults.
A preview may freeze a narrow `execution: { model?, reasoningEffort? }` selection.
Pass explicit values as process-local configuration and require the new native
session to confirm them before sending the model turn. Keep requested values
separate from native reports. Codex retains its ordinary provider, approval
policy, sandbox, instructions, skills, MCP/plugins, hooks and memory. Preserve
persistent profile settings and keep general `nativeConfig` overrides out of
ordinary review.
Declared configuration is not proof of loaded behavior; record effective values
only when the native session reports them, otherwise show unknown.

**Shared-code decision:** separate the app-server session/capture loop in
`src/audit-capture.js` from its audit-only launch policy. Add an explicit
`executionMode: 'profile' | 'audit'` at the internal capture boundary; update
`src/audit-runner.js` to select `audit` and the review service to select `profile`.
Keep one transport/event/session/result implementation over `src/audit-process.js`.
Reviews use capture directly. Comparison sides use stable side IDs, which can
resolve to the same profile.

For `profile` execution:

- Launch the native executable directly using the normal profile environment.
  Omit `sandbox`, `sandboxPolicy`, `approvalPolicy` and general config
  overrides from thread/turn requests so native profile settings apply. Reject
  conflicting audit-only options at the internal boundary rather than silently
  applying them. The prompt, actual cwd and fresh-session request remain explicit.
- Do not use `prepareAuditStartup`, its `sandbox-exec` write-protection wrapper,
  `isolatedNativeOptions`, audit-private SQLite/log/TMP redirection, the audit
  sandbox no-op preflight or injected audit telemetry configuration. Those remain
  audit-mode behavior for comparisons. Preserve any storage/environment routing
  already belonging to the ordinary profile launcher, including its existing
  SQLite routing; do not invent a reviewer storage policy. Native task history,
  authentication refresh and other normal native state writes are normal task
  effects, not an assertion that the profile home remains byte-identical.
- Keep normal profile access/ownership checks, process identity, cancellation and
  owned-process shutdown. Xfx does not close existing clients, change bindings,
  sign in or edit trust/configuration as preparation. An actual unsafe access or
  ownership conflict is an actionable refusal, not a reason to weaken a guard.
- A canonical profile's `.run-lock` represents independent execution
  participants across controllers. Comparison legs and reviews may join a
  verified running Xfx-managed Desktop. Membership changes use the lifecycle
  guard and cleanup releases only the exact participant after confirmed
  shutdown. Legacy single-owner and Desktop/review records remain readable.
  Profile mutation requires an exclusive reservation. A new Desktop launch
  still uses its existing exclusive startup procedure.
- Reconcile normal Desktop quit without signalling processes. Profile resources
  may remain open by verified durable review owners. A comparison retains its
  existing-client preservation checks when Desktop changes. Uncertain ownership preserves
  the reservation. Terminal review responses survive reservation-release
  contention and confirmed-stopped cleanup can be retried on a later read.
- After native initialization, checkpoint the owned process identity again. Require
  the same PID, start identity and host across the launcher exec transition. Later
  ownership checks use that initialized executable identity.
- Preserve the checkpoint before `turn/start`: save the returned native thread
  identity durably before sending the prompt; checkpoint failure sends no turn.
  Capture the response from that session's recorded assistant output, never from
  the newest history entry, commentary text or a successful process exit alone.

**Profile and workspace resolution:** factor read-only selection out of
`resolveAuditExecutionProfile`/`launchPlan` in `src/audit-profile.js` and
`src/launcher.js` so preparation does not run a native version probe. For a named
profile, use its saved default cwd or an explicitly selected already-bound
repository. Offer the report's original repository only if available/bound;
never silently check out its old commit or treat today's source as task-end code.
For Default, use an explicitly selected existing trusted repository and existing
Codex executable discovery, showing the executable before Start. Missing trust,
binding or executable uses existing setup guidance, not an automatic write.
Do not borrow another profile's settings or account. Recheck profile/home,
executable identity, cwd and locally observable settings at Start; a changed
preview is refused before a model task begins. Version strings are provenance.

Store exported inputs under the task's private controller directory and pass
their absolute paths in the prompt; keep the ordinary cwd for native project
settings/instructions. Show both locations before Start. Do not copy task source,
provision a sandbox or grant extra read access to make the files readable. If the
native policy requires permission to read them, use its normal request path; an
unavailable read remains visible. The default prompt asks for report-grounded
review, citations, counterevidence and gaps, and treats embedded instructions as
evidence. Report-only reasoning is a prompt instruction, not enforced isolation.

**Native approvals/input:** extend the shared JSON-RPC dispatcher to distinguish
server requests (`id` + `method`) from responses and notifications. Route supported
native command/file/permission approvals and user-input requests to the Reviews
page, showing the actual requested action and native response choices. Return
only an explicit user response to that request on its owning live connection.
No auto-approval, forced `never`, synthetic denial pretending to be the profile's
policy, or reviewer-only permission wizard. A configured policy that needs no
approval produces no dialog. Unsupported request types fail visibly with their
method named and retained partial output; never hang, retry or lower policy.
Validate request/response shape against the supported native protocol, not a
provider-version allowlist. This is the one shared native request handler, not
the retired packet/tool broker.

Model-turn duration is uncapped by default (`timeoutMs: null`); expose an optional
user-selected time cap on the review form. Do not inherit the comparison's
five/fifteen-minute defaults silently. Keep bounded startup/RPC/shutdown handling,
the existing 8 MiB process-output bound and explicit truncation/failure reporting.
No automatic retries or claimed dollar/token cap; show these limits before Start.

The slice A internal API is `resolveProfileExecutionProfile` followed by
`recheckProfileExecutionProfile` at Start, then `runAuditCapture` with
`executionMode: 'profile'`, the returned `profile.cwd`/`profile.env`, a durable
`onSession` callback and private process output paths. Selection includes a
metadata-only settings identity that survives serialization. The caller owns
reservation/admission and durable task records; this capture API does not itself
create a review task. `onNativeRequest(request, { signal, item })` includes the matching native action
item when available (required for file-change approvals) and waits for an explicit
response object; abort invalidates unanswered requests. The returned `response`
contains exact assistant item text associated with the owned thread/turn; its
completion evidence remains separate from process shutdown and capture coverage.
`onTurn({ threadId, turnId })` checkpoints native turn acknowledgement before the
capture waits for completion; the task service uses it to enter `running`.

## Durable record, API and lifecycle

Implement `src/ui-review-tasks.js` alongside the existing `src/ui-runs.js`, using
`metadata.js` private-directory and atomic-record helpers. It coordinates inputs,
launch state and results; capture/process code owns native execution. Do not add
a database, scheduler, second report format or fake experiment record.

The task ID is exactly its UUID preview token, as in `ui-runs.js`; there is no
second attempt ID or volatile token-to-task mapping. Preview returns both the
editable `prompt` and the `effectivePrompt` containing the fixed absolute report
paths; the latter is hashed, saved and sent without further additions. Use
`<store>/review-tasks/<id>/` (private directory; files mode 0600), containing
`task.json`, `report.md`, `report.md.audit.json`, `prompt.md`, captured response
and bounded process/capture files. Reuse `exportAuditReport` and the existing
projection/fingerprint logic; never construct a separate report renderer.

The versioned `xfx-review-task` record contains:

- Attempt UUID, schema version, timestamps and lifecycle/error status.
- Original comparison reference/fingerprint and frozen input-projection
  fingerprint; input filenames and byte hashes, content-inclusion choice and
  prompt hash. The frozen files are the durable source, even if the original
  UI reference or sessions disappear. Fingerprints bind inputs, not proof of
  what the model actually read or followed.
- Selected profile/environment/executable identities, cwd, local settings
  fingerprint, observed native settings or unknowns, and explicit execution limits.
  Do not duplicate credentials or configuration bodies into this record.
- Coordinator/process ownership, native thread/turn IDs when received, pending
  native-request summaries, cancellation reason and shutdown result.
- Final-response path and source event identity, completion status and capture
  limits; preserve partial text separately from a completed response. Check input
  hashes before dispatch and after completion. Changed/unreadable evidence is
  disclosed and cannot be presented as an unchanged reviewed snapshot.

Extend the existing Reviews GET view with form defaults/profile-workspace choices
and review-task summaries. Add these routes through `src/ui-server.js` and
`src/ui-engine.js`, with types in `web/src/api/types.ts`:

| Route | Contract |
| --- | --- |
| `POST /api/reports/:ref/review-tasks/preview` | Accept selected profile/cwd, editable prompt, recorded-content choice and optional time limit. Read/project the comparison and resolve the local launch identity without starting Codex. Return the exact summary and a UUID preview token, valid for 20 minutes. Transient projection files may be used; no persistent task is created. |
| `POST /api/reports/:ref/review-tasks` | Accept only that preview token, bound to this report. First look up the same durable task ID and its saved source binding, before requiring a live preview/report reference. If new, revalidate inputs/profile, claim its directory exclusively, write inputs/record, then launch once. Replayed Start returns the existing attempt even after a lost response/restart, including failed/interrupted attempts. |
| `GET /api/review-tasks/:id` | Return truthful state, pending requests, the durable `/reports/r.<id>` frozen-comparison link and captured response. Reading never resumes, restarts or invokes a model. |
| `POST /api/review-tasks/:id/cancel` | Cancel only owned work. Repeated cancellation is idempotent; retain inputs, partial output and uncertain-shutdown evidence. |
| `POST /api/review-tasks/:id/requests/:requestId` | Submit one validated native response for the matching live request/thread. Stale, duplicate or wrong-task decisions are rejected; no arbitrary command execution or profile-setting API. |

Reuse the server's session/Host/Origin validation. Preview is inline in the one
review form, not another approval wizard. Editing the form invalidates its token;
explicit Start is the only model launch action. On launch navigate to
`/reports/r.<id>/reviews?task=<id>` so refresh reconnects to the same attempt.
List tasks by original report fingerprint; retain the originating reference only
as provenance, not as the durable navigation target.

**Frozen-report resolver:** add `r.<task UUID>` support to `ui-engine.js`
`comparisonFor`/title resolution. Validate the UUID and task ownership, read the
fixed `report.md.audit.json` path under that task directory, verify its saved
input fingerprint/hash, and pass it through the existing report presenter.
Use `/reports/r.<id>` for report and evidence/citation links. Never resolve this
reference through the in-memory `f.` registry, recompute a live `s.` comparison,
accept an arbitrary filesystem path or substitute today's sources. Missing or
changed frozen files produce a visible unavailable/changed-evidence state.
Test reopening the task and following citations after server restart with the
original sessions changed or removed; no new report format or migration is needed.

Lifecycle: `prepared → starting → running ↔ waiting-for-user → completed`, with
`failed`, `cancelled`, `interrupted` and `uncertain` alternatives. `prepared` means
inputs are saved and no spawn intent has been written; write `starting` before
spawning, `running` only after native turn acknowledgement. Completion requires
the matching turn to complete and its response to be retained, not just exit 0.
A completed turn without a usable response is `failed` with reason
`response-unavailable`, retaining the native completed-turn fact separately.
Capture coverage and shutdown uncertainty remain separate from the model's verdict.

Use exclusive attempt creation plus one in-process Start promise, following
`ui-runs.js`, so double clicks/HTTP retries, including a lost Start response followed by a
server restart, cannot launch twice. If the attempt directory exists
but staging or its record is incomplete/corrupt, return an interrupted/uncertain
attempt and preserve it. The UI admits independent comparisons and reviews up to
its configured controller capacity (eight jobs by default). Multiple reviews of a report retain separate
task IDs and frozen evidence. Claim each review's canonical writable workspace
across controllers. Choose another workspace when the selected directory overlaps an active or
unresolved review claim.
The server may retain a terminal response while shutdown is uncertain, but must
not release ownership or admit conflicting work until safely reconciled.

Tab closure leaves owned work running; pending native requests remain unanswered
until the UI returns. Explicit cancel or normal server shutdown stops only owned
work and records the outcome. After a server crash, inspect saved process identity
using existing read-only observation; confirmed stopped work becomes interrupted,
live/unknown ownership stays uncertain. Never signal a saved PID blindly, replay
pending decisions, resend a turn or automatically resume/retry. A deliberate new
attempt requires a new preview token; it cannot replace or erase the old one.

A missing, unreadable or hash-mismatched response remains visible as unavailable
in both task summaries and detail. Retain the saved lifecycle status and link to
verified frozen evidence, and never display altered response bytes.

A readable response is a task result, not a structured evaluation or fabricated
rating. Keep the source comparison unchanged. Existing structured external import
remains an optional supported path; ordinary review never requires it. The task
record retains its frozen inputs and response across UI/server reopening. Plain
report exports are not relabelled as containing this task's response or a bound
structured verdict when they do not.

## Legacy removal

Remove the following **together in this implementation**, after preserving the
current dirty/untracked versions and private receipts. These modules form the
superseded checkout-only campaign; source inspection found no product imports
from `bin/`, `src/` or `web/`. They are not needed for ordinary review.

| Remove | Reason |
| --- | --- |
| `scripts/export-review.mjs` | Separate reviewer CLI/campaign entry point. |
| `test-support/export-review-adapter.js`, `test-support/fake-export-review-appserver.mjs` | Campaign-only packet broker/validation adapter and fake protocol. |
| `test-support/native-review-capabilities.js`, `test-support/native-review-transport.js`, `test-support/native-review-probe.c` | Reviewer-specific capability gate, transport and OS-policy probe, replaced by shared normal execution. |
| `test-support/acceptance-batch.js`, `test-support/acceptance-diagnostics.js`, `test-support/acceptance-fresh-pair.js`, `test-support/acceptance-review-closeout.js`, `test-support/reopen-acceptance-export.mjs` | Retired diagnostic/fresh-pair/reviewer campaign and its separate closeout. |
| `test/export-review-adapter.test.js`, `test/export-review-cli.test.js`, `test/native-review-capabilities.test.js`, `test/native-review-transport.test.js`, `test/native-review-probe.test.js` | Tests of the removed runner/broker/isolation contract. |
| `test/acceptance-batch.test.js`, `test/acceptance-diagnostics.test.js`, `test/acceptance-fresh-pair.test.js`, `test/acceptance-native-integration.test.js`, `test/acceptance-review-closeout.test.js` | Tests of the removed campaign stages. |

Before deleting tests, retain meaningful uncovered guarantees in product tests:
final response versus commentary/partial text; early native events; cancellation
while a request is pending; unexpected exit/uncertain shutdown; exact input
binding and no overwritten result; export/reopen with evidence intact. Retained
coverage lives in `profile-capture`, `audit-process`, `audit-capture`,
`ui-review-tasks`, `ui-review-task-integration`, `audit-review*`, `ui-reviews` and
`web/e2e/review-tasks.spec.js`. Early approval coverage must verify that a later
turn acknowledgement leaves the pending request visible and answerable. Add only
uncovered ordinary-task behavior. Do not move source-denial canaries, schema
allowlists, tool quotas or campaign grants into the new product tests. The normal test glob discovers the remaining files.

Keep/refactor `audit-capture.js`, `audit-process.js`, `audit-profile.js`,
`audit-runner.js`, `ui-runs.js`, `audit-store.js`, `audit-review.js` and
`audit-review-command.js`: they serve the three outcomes or retained external
import. Keep audit-only startup/telemetry support used by comparison execution;
only the ordinary reviewer bypasses it. Keep `scripts/native-profile-ui-acceptance.mjs`,
`test-support/native-profile-ui-acceptance.js` and its test for the profile journey.

This is the selected 3.0 removal list. No additional report/store schema, CLI
series/cohort command or copy journal is retired by this plan merely because it
is older or outside the UI's three outcomes. No migration or compatibility shim
is added. Remove active references to the deleted campaign from docs/scripts;
leave historical snapshots, original reports and published artifacts intact.
