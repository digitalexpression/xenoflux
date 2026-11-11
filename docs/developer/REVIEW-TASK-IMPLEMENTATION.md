# Ordinary review task — implementation contract

Shared client execution, persistence, API and recovery rules. [Goal](AUDIT-GOAL.md#ai-review): product
behavior; [roadmap](ROADMAP.md): status; [app guide](../user/APP.md#review-a-comparison): workflow.

## Shared client contracts

The existing comparison/review coordinator owns admission, lifecycle, resource
claims and durable publication. Client adapters own native path/configuration,
protocol, account and event interpretation. Reuse the same report projection
and persistence rather than adding another scheduler or record format.

### Identity and ownership

Bind each operation to client, surface, profile/root mode, canonical resource
roots, selected executable/SDK identity, workspace/settings fingerprint and
job/side ownership. Client identity is distinct from model vendor. Native session,
turn, tool and request IDs are bounded opaque values qualified by client/job;
missing native IDs remain null, never a local ID or a new session. Implicit
Default and explicit roots remain distinct even for matching paths. Follow the
[account boundary](AUDIT-GOAL.md#client-scope) and never retain credentials or
credential hashes as identity evidence.

Persist process and initialized session ownership before submitting once.
Checkpoint writes, late callbacks and cleanup require the current owner/generation
under the mutation gate. Serialize save/drop/terminal cleanup so stale owners
cannot overwrite evidence or release another participant. Inspection and recovery
submit no task; missing attached native state never becomes a replacement session.

Native approval/input replies consume the exact stored request/action once on
its live owned connection. Cancellation, terminal results, connection loss and
ownership changes invalidate pending replies. A regenerated intent is not an
approved request, and recovery never replays decisions. Record native completion,
captured response, coverage, interrupt acknowledgement and physical shutdown as
independent facts. Await exposed process/SDK/input joins; uncertain shutdown
retains claims. A stopped process group does not prove escaped descendants stopped.

### Catalogs and settings

Catalogs are scoped to client/profile/root mode, executable/SDK, connection/account
generation and effective workspace settings. Explicit discovery performs bounded
initialization only: no task submission, login fallback or model-policy changes.
Initialization may touch native state or run hooks; ordinary preview uses cached
metadata. Reap owned probes on cancellation/timeout. Cache freshness is five
minutes; setup/authentication changes invalidate it. Publish a late result only
for the same current scope and refresh generation. Failure is unavailable, not
an empty successful catalog; ambiguous startup/shutdown retains its claim.

Preserve profile-default inheritance independently for model and effort. Model
IDs and effort strings are native opaque choices; options can have holes and
equal effort names do not imply equal computation across clients. A model change
invalidates the prior explicit effort until rechecked. Copilot explicit models,
Auto tiers and image-tool entries stay separate; disabled/hidden tiers are not
explicit choices. Revalidate explicit selections on the initialized client before
submission; never silently substitute a model or downgrade effort. Requested,
sent, client-confirmed and turn-reported settings remain separately sourced,
with missing observations unknown. Catalog membership is not proof of execution
access or billing entitlement.

Codex comparisons may freeze `approvalsReviewer: "user"` for the owned native
session. An interactive handler and native confirmation of both `user` and
`on-request` are required before submission. Missing or different confirmation
refuses the task. Saved settings and ordinary reviews keep their native reviewer;
record requested, sent and confirmed reviewer values separately.

## Execution with the selected profile's settings

Use the selected profile's home, executable, sign-in and normal environment.
Omitted model/effort inherits defaults; frozen `execution: {model?, reasoningEffort?}`
overrides are process-local and need native confirmation before the turn. Keep requested
and reported settings separate; unreported effective values stay unknown. Preserve ordinary
provider, permissions, sandbox, instructions, skills, integrations, hooks and memory.

| Boundary | Rule |
| --- | --- |
| Shared capture | `client-runtime.js` dispatches both entry points to the selected client adapter; Codex uses `audit-capture.js`/`audit-process.js`. Comparisons use `audit`, reviews use `profile`. Validate environment/job/native binding before durable callbacks. |
| Explicit model choices | Preview validates cached context; explicit Refresh separately owns initialization with no task or policy mutation. Start validates advertised model/effort on its initialized connection before thread/task submission, then requires native settings confirmation. Missing turn observations stay unknown. |
| Codex native launch | Launch the native executable in the selected cwd with an explicit prompt and fresh session. Let `thread/start` inherit the process cwd, verify its reported cwd before any turn, and send that verified cwd to `turn/start`; explicit thread cwd can persist native project trust and invalidate other previews. Omit thread/turn `sandbox`, `sandboxPolicy`, `approvalPolicy` and general config overrides. Reject audit-only options. No `prepareAuditStartup`, `sandbox-exec`, audit-private SQLite/log/TMP, no-op sandbox probe or injected telemetry. Preserve ordinary launcher routing, including SQLite; normal history/auth refresh writes are expected. |
| Preparation | Read-only profile/workspace resolution runs no native version probe. Never close clients, sign in, change bindings/trust/settings, borrow another account, copy source, provision isolation or grant extra reads. Missing prerequisites use existing setup guidance; unsafe access/ownership is refused. |
| Workspace | Named profile: saved cwd or explicitly selected bound repository; report repository only if available/bound. Default: explicitly selected trusted repository and existing executable discovery. No silent historical checkout. Show cwd/executable and private input paths before Start. |
| Start recheck | Recheck profile/home, executable identity, cwd and settings identity, including after serialization. Refuse changed previews before model work; versions are provenance. |
| Participants | Canonical `.run-lock` memberships span controllers; comparisons/reviews may join verified managed Desktop. Guard membership changes; release only the exact participant after confirmed shutdown. Recognized legacy owner/Desktop-review records remain readable. Mutations/new Desktop startup retain exclusive admission. |
| Desktop quit | Reconcile without signalling; verified durable participants may retain handles. Comparison client-preservation checks remain. Uncertain ownership preserves reservations. Retain terminal responses through release contention; retry confirmed-stopped cleanup on a later read. |
| Process checkpoint | After native initialization, require the same PID/start/host across exec; checkpoint the initialized executable identity and use it for later ownership checks. |
| Session checkpoint | Durably save the native thread ID before `turn/start`; checkpoint failure sends no turn. Capture exact assistant output from that owned thread/turn, never newest history, commentary or exit status alone. |
| Inputs/prompt | Export into the private task directory; fixed absolute paths are part of `effectivePrompt`. Hash/save/send it unchanged and keep ordinary cwd for project instructions. Unreadable inputs use normal native approval; failure stays visible. Embedded report instructions are evidence; report-only reasoning is a prompt, not enforced isolation. |
| Codex native requests | Shared JSON-RPC distinguishes `id`+`method` requests from responses/notifications. Show actual action/question and native choices; accept only explicit validated replies on the owning live connection. No auto-approval, forced policy or synthetic denial. Unsupported methods fail visibly with name/partial output, without hanging/retrying/lowering policy. Validate protocol shape, not provider version. |
| Limits | `timeoutMs: null` by default, with optional user cap; do not inherit comparison deadlines. Bound startup/RPC/shutdown and process output (8 MiB), reporting truncation/failure. No automatic retries or claimed dollar/token cap; show limits before Start. |

### Internal capture interface

Resolve with `resolveProfileExecutionProfile`, recheck at Start with
`recheckProfileExecutionProfile`, then call `createClientRuntime().capture` (implemented by `runAuditCapture`) using `executionMode: 'profile'`,
`profile.cwd`/`profile.env` and private output paths. The caller owns admission/durable tasks.
Comparison and review contexts may supply `clientRuntimes[client]` capture
implementations; unavailable clients are refused before dispatch. Shared capture
projection validates the client, environment and native job/profile scope before
checkpoint publication and final return. Records remain version 1; supplied
qualified references must match their owner, and missing native IDs stay null.

`codex-runtime.js` owns the process and JSON-RPC connection behind Codex capture.
It initializes, creates one native session, submits once, consumes exact native
responses once, cancels owned work and inspects its attached session. Native
interrupt acknowledgement and process shutdown are separate observations.
Cancellation, connection closure and native turn completion invalidate pending
answers. Missing attached native state never falls back to a new thread;
recovery continues through the existing retained-evidence readers without dispatch.

- `onSession`: durable thread checkpoint before dispatch.
- `onTurn({threadId, turnId})`: checkpoint acknowledgement before `running`; pending approvals remain answerable.
- `onNativeRequest(request, {signal, item})`: matching action item when available (required for file-change approval); await explicit response, invalidate unanswered requests on abort.
- Returned `response`: exact owned assistant text; completion, capture coverage and process shutdown stay separate.

### Claude Code ordinary review

The selected local Claude CLI runs through `@anthropic-ai/claude-agent-sdk@0.3.322`
using the public custom-process option, normal user/project/local sources, and
the Claude Code system prompt. Preserve implicit Default versus explicit
`CLAUDE_CONFIG_DIR`, even for identical paths. Refuse ambient credential or
provider overrides, signed-out routes and unexpected executable or SDK launch
arguments. Preparation reads binding and settings metadata. A validated native
skill-sync container manifest uses a bounded, no-follow hash of every original
byte so native timestamp touches do not invalidate unchanged settings. Only its
validated round-freshness stamp is excluded; real skill resources remain
protected. Manifest bodies and credential/account data are never retained in
the settings identity. Malformed or unsafe sync metadata fails closed.

Startup verifies the owned process and its inherited cwd, checks native
subscription and advertised explicit choices, and durably checkpoints the fresh
SDK session ID before releasing the one input frame. The native init event
confirms the session and reports applied settings when available. A sent effort
option is not an observed effort. Ordinary reviews inherit permission mode;
comparisons may opt into the supported per-job modes without editing settings.

A tool approval binds the native request and tool-use ID to the exact proposed
arguments. Only an explicit approve-once or decline reply reaches the live
request. Cancel invalidates pending replies, asks the owned SDK session to
interrupt, and joins its iterators, streams, child close and observed ancestry.
Record the interrupt acknowledgement separately from shutdown. Recovery does
not assume an absent main process proves the observed job's descendants stopped.
Keep a matching terminal assistant response separate from capture gaps, advisory
child heartbeats and shutdown. Missing native turn IDs remain unknown.

An optional five-field `command_lifecycle: completed` receipt is bookkeeping only:
it must close the owned prompt's exact queued→started sequence after a validated
successful result explicitly echoes that prompt, with no prior failure, once only.
This exact optional producer shape is not declared in `SDKMessage`; do not
generalize it to other post-result frames. Task work, unknown
frames and mismatched/extra receipt fields retain their existing guards.
One subsequent exact owned host-only `session_state_changed: idle` notification
may be recorded as informational metadata; other states, payloads and repeats
remain guarded. The host-only flag follows SDK runtime routing rather than its
declared message interface. It adds no permission, task or completion authority.

### Copilot CLI ordinary review

Run the selected installed CLI through the pinned `@github/copilot-sdk@1.0.29`
stdio connection. Preserve native HOME, USER and LOGNAME. Supply the public
`baseDirectory` option for an explicit root and refuse ambient authentication,
provider or root overrides. An explicit root requires current account scope
evidence for its selected executable, runtime build and native sign-in type.
Preparation reads file metadata and never starts the client.

The process inherits the selected cwd. Verify the session's native cwd before
submission and leave native trust unchanged. Revalidate explicit model, effort
and Auto tier on the owned connection, then checkpoint the fresh session before
the single send. Each native turn reports its own identity and may report an
actual routed model. Retain requested, sent, confirmed and observed settings
independently. Reviews inherit native permissions.

Show the exact owned `copilot/permission` request, including its action and native
handle. Separate path and command handles can refer to one tool call. The
matching live handle accepts only `{kind:'approve-once'}` or `{kind:'reject'}`.
Abort invalidates unanswered handles before the owned SDK session is torn down.
Record abort acknowledgement, native aborted idle, SDK stop and observed
process ancestry separately. An uncertain join keeps the ownership claims and
permits no rerun. Normal idle with an absent `aborted` field can close an owned
terminal assistant response. Child and skill coverage can remain incomplete.

## Durable record, API and lifecycle

`ui-review-tasks.js` owns staging/state/results; capture owns native execution. Reuse
`metadata.js` private/atomic helpers and `exportAuditReport` projection/fingerprints;
no database, scheduler, second renderer/format or fake experiment record.
Task ID equals its UUID preview token; no second ID or volatile token-to-task mapping.

### Storage

Use private `<store>/review-tasks/<id>/`, files mode 0600: `task.json`, `report.md`,
`report.md.audit.json`, `prompt.md`, response and bounded process/capture files.
The versioned `xfx-review-task` record retains:

| Group | Required data |
| --- | --- |
| Identity/state | UUID, schema, timestamps, lifecycle/errors; coordinator/process ownership; native thread/turn IDs, pending requests, cancellation/shutdown outcome. |
| Frozen inputs | Original report reference/fingerprint, projected-input fingerprint, filenames/byte hashes, inclusion choice, prompt hash. Frozen files remain authoritative after source/reference loss; binding does not prove model reading/adherence. |
| Execution | Profile/environment/executable identities, cwd, local settings fingerprint, observed settings or unknowns, limits. No credentials/configuration bodies. |
| Response | Path, source event identity, completion/capture status and limits; partial text separate from completed response. |

Check input hashes before dispatch and after completion; changed/unreadable evidence is
disclosed, never presented as unchanged. Missing/unreadable/hash-mismatched responses stay
visibly unavailable in summary/detail. Preserve saved lifecycle/native-completion facts and
verified frozen-evidence links; never display altered response bytes.

### API

Routes use `ui-server.js`/`ui-engine.js`, types in `web/src/api/types.ts`, and existing
session/Host/Origin guards. Editing the form invalidates preview; only explicit Start launches.

| Route | Contract |
| --- | --- |
| `POST /api/reports/:ref/review-tasks/preview` | Profile/cwd, execution overrides, prompt, content choice, optional time limit. Return editable `prompt`, fixed-path `effectivePrompt`, exact summary and UUID token valid 20 minutes. Transient projection files allowed; no persistent task or Codex launch. |
| `POST /api/reports/:ref/review-tasks` | Accept only the report-bound token. Look up durable ID/source binding before requiring live preview/report references. New attempts recheck inputs/profile, claim directory exclusively and save inputs/record before one launch. Existing attempts return without redispatch, including failed/interrupted ones after restart/lost response. |
| `GET /api/review-tasks/:id` | Truthful state, requests, response and durable `/reports/r.<id>` link. No model invocation/resume/restart. |
| `POST /api/review-tasks/:id/cancel` | Idempotent cancellation of owned work only; retain inputs, partial output and uncertain shutdown. |
| `POST /api/review-tasks/:id/requests/:requestId` | One validated reply to the matching live request/thread; reject stale/duplicate/wrong-task decisions. No arbitrary command/settings API. |

Navigate to `/reports/r.<id>/reviews?task=<id>`; list tasks by original report fingerprint.
The originating reference is provenance only. Resolve `r.<UUID>` by validating UUID/ownership
and the fixed task-local `report.md.audit.json` fingerprint/hash through the existing presenter.
Never use volatile `f.` entries, live `s.` recomputation, arbitrary paths or today's sources;
missing/changed frozen files stay explicit. Reopening/citations must survive restart/source loss.

### Lifecycle and recovery

`prepared → starting → running ↔ waiting-for-user → completed`; alternatives:
`failed`, `cancelled`, `interrupted`, `uncertain`. Prepared means saved inputs, no spawn intent;
write starting before spawn and running only after native turn acknowledgement. Completion
needs the matching completed turn and retained response, not exit 0. No usable response means
`failed`/`response-unavailable`, retaining the completed-turn fact. Coverage/shutdown uncertainty
is separate from response content or reviewer judgment.

- Exclusive creation plus one in-process Start promise prevents duplicate dispatch across clicks/HTTP retries/restart. Incomplete/corrupt staging stays interrupted/uncertain and preserved; never reuse it for another launch.
- Independent jobs use configured controller capacity (default eight). Each review keeps its own ID/frozen inputs and claims its canonical writable workspace across controllers; active/unresolved overlap is refused. Terminal text may survive uncertain shutdown, but ownership/conflicting admission stays blocked.
- Tab closure leaves work running and requests unanswered. Explicit cancel/normal server shutdown stops owned work only. After crash, inspect saved identity read-only: confirmed stopped becomes interrupted; live/unknown stays uncertain. Never blindly signal PIDs, replay decisions, resend turns or auto-resume/retry. A deliberate new attempt needs a new preview and cannot overwrite the old one.
- Keep the source comparison unchanged. Prose is not a structured rating; external import stays optional. Plain exports must not claim a separate task response or bound verdict when they do not contain one.
