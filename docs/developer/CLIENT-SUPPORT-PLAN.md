# Multi client architecture and support plan

Release 4.0.0 adds Claude Code and GitHub Copilot CLI alongside Codex with the
same journey: profiles, catalogs, comparison, approvals, cancellation, report
and review, including mixed-client pairs. Retain the existing job ownership,
workspace separation and report lifecycle as the shared core.

Status and order live in the [roadmap](ROADMAP.md). The
[goal](AUDIT-GOAL.md#planned-multi-client-scope) owns product outcomes and the
account, restart and scope decisions of 2026-11-10. This file owns the
interfaces, implementation boundaries and package checks. Vendor desktop/import
contracts were checked on November 10, 2026.

Local macOS and native subscription connections only. Custom endpoints/BYOK, SSH
and cloud execution are deferred. Retain execution-location identity in records
so later surfaces need no record change. The desktop section describes later
scope beyond the opening, import and navigation capabilities already built.

## Native client and model identity

A profile selects a client, such as `codex`, `claude-code`, or `copilot`.
Its model vendor and inference connection are separate facts. A Claude model
selected inside Copilot remains a Copilot run, with Copilot's tools, policy,
credentials, billing, and session format.

Also record surface, desktop app build, backend build, and execution location
(local, SSH or cloud). Distinguish a desktop session from a CLI/SDK run opened
in the app afterward. Keep these identities in catalog keys, previews, durable
records, session filters and report citations.

Extend profile metadata with the client discriminator and its bound executable,
configuration and runtime roots. Preserve whether the profile uses the client's
implicit default root or an explicit managed root. Represent Default separately
for each client. Root mode is independent of path: an explicitly set root can
equal the implicit default path while changing native credential routing.
Keep selected provider/configuration, observed account and effective runtime
route separate; a saved selection or matching path proves neither authentication
nor the route used by a turn. Use stable profile UUIDs and job/side IDs for
selection and ownership. Client session, turn, tool, and approval IDs are bounded opaque
strings qualified by client and job, rather than globally unique Codex UUIDs.
Existing supported Codex records keep their attribution. Define any new record
version and read boundary explicitly before changing persistence.
[Profile validation](../../src/profiles.js) ·
[Current execution profile resolution](../../src/audit-profile.js)

## Integration choices

Transports were selected on 2026-11-10 from the native results summarized in the
[roadmap](ROADMAP.md#current-work-and-stop-condition).

| Client | Execution interface | Model and effort discovery |
| --- | --- | --- |
| Codex | Existing app-server adapter, moved behind the runtime interface. | Paginate `model/list`. Use `supportedReasoningEfforts`, `defaultReasoningEffort`, visibility, and model identifiers from that response. |
| Claude Code | Pinned official TypeScript Agent SDK starting the user's selected, unmodified installed `claude` through its public custom-process option, with normal settings sources and the `claude_code` preset. | The SDK initialization snapshot: aliases, resolved IDs and optional effort fields. Absent fields stay unknown. |
| Copilot CLI | Pinned official Node SDK against an owned, selected installed CLI process over stdio. | The runtime's model listing with returned policy, reasoning options and defaults. Auto routing, hidden or disabled tiers and image-tool entries stay separate from explicit models. |

Codex catalogs vary by client and account. Claude's SDK exposes model capability
metadata but optional fields may be absent. Copilot's public SDK surface includes
model listing, current-model inspection, permissions, input, cancellation, and
session management. Copilot SDK source exposes per-model effort strings and a
separate default. [Codex catalog](https://learn.chatgpt.com/docs/app-server#list-models-modellist) ·
[Claude SDK](https://code.claude.com/docs/en/agent-sdk/typescript#modelinfo) ·
[Copilot SDK compatibility](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility) ·
[Copilot model schema](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/rpc.ts)

One transport per client, with no automatic transport switch during a task. Pin
each SDK, record runtime versions as provenance and let capability checks decide
support for unfamiliar versions. Xenoflux always starts the selected installed
CLI, so the binaries bundled with the SDK packages should be unnecessary; package
H verifies an install without optional dependencies before documenting it as the
slim install.
[Copilot local CLI setup](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/local-cli)

ACP is not a 4.0.0 Copilot transport. Zero-prompt initialization and one scoped
history page passed, but execution, approval and cancellation were qualified
only on the SDK. Keep T3 Code's ACP adapter as a reference for model-dependent
option refresh and lost-session behavior.
[T3 Copilot adapter](https://github.com/pingdotgg/t3code/blob/c65f8d552baca1b51e15b5fb4737f07e18cce177/packages/provider-acp-registry/src/server/adapter.ts) ·
[GitHub ACP contract](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)

T3's initialization probe suppresses tools/hooks/MCP, and its Claude choices
also use a bundled catalog. Reuse the bounded initialization pattern while
qualifying Xenoflux's actual execution context independently.
[T3 Claude probe and catalog](https://github.com/pingdotgg/t3code/blob/c65f8d552baca1b51e15b5fb4737f07e18cce177/apps/server/src/provider/ClaudeProvider.ts)

### Authentication and profile storage

Users sign in through the native client's own flow: separately for per-root
profiles, or through the verified shared route for shared-scope profiles. The
[goal](AUDIT-GOAL.md#planned-multi-client-scope) allows the same account in several
profiles. Xenoflux owns bindings and metadata-only attribution; native clients
retain credentials. API-key/cloud-provider authentication cannot replace the
required subscription journey.

Anthropic's [October 7 subscription update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
says SDK and `claude -p` usage signed in with a Claude plan still draws from
subscription limits. Its authentication guidance also allows end users to sign
into an unmodified Claude Code binary with their own subscription, including on
platforms running Claude Code. It separately restricts offering Claude.ai login
inside a third-party application or collecting/intermediating subscription credentials,
and directs SDK products toward API-key/provider authentication. Subscription
billing and third-party credential intermediation are separate questions; neither
statement alone qualifies every embedded SDK product.

**Decision, 2026-11-10 (product owner): proceed on the native-owned route.**
Sign-in happens only inside the unmodified Claude Code client; Xenoflux offers no
Claude.ai login and never reads, stores or forwards credentials. This is an
engineering reading of the published guidance, not legal advice. Re-check it when
the guidance or the SDK pin changes; if the route stops being supported, Claude
execution becomes unavailable and API keys are not substituted silently.
[Anthropic guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)

Copilot documents native browser/device login, macOS Keychain storage, remembered
accounts and higher-priority environment tokens. Separate configuration directories
alone cannot prove independent account selection. Qualify the pinned runtime's
native account binding and refuse conflicting ambient credentials/fallbacks before
effects; never switch a shared global account to simulate concurrent profiles.
[Copilot authentication and credential precedence](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)

Claude uses `CLAUDE_CONFIG_DIR` for managed configuration. ai-profiles' source
shows that implicit default and explicit roots can select different account
metadata and Keychain namespaces. Preserve that distinction and let the native
client resolve credentials. Its stock-default helper compares paths and assumes
the stock path is implicit; it cannot qualify an explicitly set identical path.
Test both modes against the selected native runtime rather than copying the
undocumented Keychain-name derivation into Xenoflux. Copilot's current SDK source
exposes
`baseDirectory`/`COPILOT_HOME`; other SDK documentation describes
`configDir`. Select and test the public option for the pinned SDK rather than
assuming these names are interchangeable. Preserve the real macOS HOME and
native user context where authentication requires them. The selected CLI lost login visibility when a
probe stripped USER/LOGNAME; restoring those existing values recovered its
Pro attribution without signing in. See the [source-bound route record](history/CLIENT-ROUTES-2026-11-10.md).
Qualify config, sessions, memory, plugins, credentials, and caches individually.
[Claude settings](https://code.claude.com/docs/en/settings) ·
[ai-profiles credential namespace](https://github.com/bartekczyz/ai-profiles/blob/1650f8197dbf5d75aadca6e9787dd227c3d3a738/apps/ai-profiles/src-tauri/src/usage/credentials.rs) ·
[Copilot SDK root options](https://github.com/github/copilot-sdk/blob/main/nodejs/src/types.ts)

A per-root managed home must not fall back to another profile's or the stock
client's credentials. Shared-scope profiles use only their verified, labelled
native route; no profile borrows an ambient token or silently changes routes.
Start with native sign-in/setup guidance and metadata-only account attribution.
Account validity and filesystem separation need separate evidence. Copy
configuration through a client-specific allowlist
and the existing preview/journal/Undo flow. Preserve source provenance for shared
instructions. Cross-client copying needs an explicit mapping for each setting.
Keep field ownership, mutation/recovery and Undo checks in the transfer contract;
do not adopt vendor database/history synchronization as profile copying or
evidence import. Imported reports retain their own immutable source evidence.
[Profile copy policy](PROFILE-COPY-POLICY.md)

Each client records an **account scope** for the observed native route and root
mode, established by a zero-prompt check before its adapter is built: start the
selected CLI on an empty managed root and read its sign-in status and auth type.
Recheck after binding or authentication changes; one route's result does not
qualify a different route.

- *Per-root* (expected for Claude Code): the empty root reports signed out while
  the stock client stays signed in. Each profile needs its own sign-in.
- *Shared* (expected for Copilot, whose existing sign-in is the `gh-cli` route):
  the empty root reports the same login. Profiles of that client share the
  account and differ only in setup; the UI states that and names the route.
- Environment tokens and ambient provider/root overrides are refused in both
  cases. The adapter's explicit, validated profile-root binding is allowed.

Account checks for 4.0.0:

1. **Scope.** The check above. For a per-root client, no task, catalog or review
   on a signed-out root uses another login.
2. **Second root.** Per-root: after the user signs into a disposable second root,
   record both roots' and the stock client's sign-in state. After the user signs
   out of that root through the native client, verify the companion and stock
   client stay signed in; the user then signs the test root back in. This establishes
   independence rather than assuming it; cover restart. Native token-refresh
   qualification follows the [current release scope](AUDIT-GOAL.md#planned-multi-client-scope)
   and is not a 4.0.0 gate.
   The [roadmap](ROADMAP.md#recorded-user-instructions-2026-11-10) records the
   approved user-operated checkpoint. Shared: the second root runs with its own
   configuration and sessions under the labelled shared account; never sign out
   the shared route for this check.
3. **Distinct accounts (later scope).** Profile A bound to account A and profile
   B to account B concurrently, including callback routing and account changes
   during catalog discovery. Until this passes, show account independence as not
   verified.

Verify both metadata attribution and an authorized native operation; matching
folders or display labels are insufficient. Keep credential bodies/hashes out of
receipts. Failed scope or second-root checks leave managed profiles unavailable,
including an empty root using another login without a recognised shared route.
Ordinary opening/import remains a separately qualified capability.

## Dynamic catalogs

Copilot's explicit `models` array, `auto` routing metadata and image-tool models
are separate. An empty explicit array with an enabled visible Auto tier is not
an empty account catalog or a sign-in failure. Retain disabled/hidden tiers and
unknown effort without offering them as explicit model choices; image entries
must not become conversation choices. [Native observation](history/CLIENT-ROUTES-2026-11-10.md) ·
[GitHub model access](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-access-to-ai-models)

Replace the free-form model field and six-value global effort list with a
profile-scoped catalog. Both `ExecutionFields.tsx` and
`audit-spec.js::validateExecution` currently encode a Codex-shaped boundary.
Validate the request's bounded shape first, then validate its model/effort
combination against the selected client's catalog at preview and Start.
`web/src/components/ExecutionFields.tsx` ·
[Execution validation](../../src/audit-spec.js)

The catalog response should carry the profile and client identity, executable
and SDK identity, workspace/settings fingerprint, opaque account or connection
scope when available, retrieval time, generation, and discovery status. Model
entries carry their native identifier, display name, optional resolved alias,
visibility/policy state, and effort capability. Distinguish supported with
returned values, explicitly unsupported, and unknown. Keep the raw effort
strings. Equal names such as `high` do not establish equal computation across
clients.

Treat model IDs as bounded opaque identifiers accepted by the adapter, passed as
structured values or argument entries. Effort sets can have holes, such as
support for `max` with no `xhigh`. Select the model before resolving its
options again, because an initialization response can describe choices across
several models. Keep native effort distinct from any prompt text that asks the
agent to think harder.

Offer Use profile default independently for model and effort. Changing model
invalidates the previous explicit effort until checked against the new model.
An unavailable catalog leaves default inheritance visible and explicit choices
unverified. It must not become an empty successful catalog. Catalog membership
establishes what the client advertised, while successful execution establishes
access for that attempt. Static registries, pricing tables, model family names
and usage/quota displays cannot establish account entitlement.

Discovery is an explicit bounded action. Launch only an initialization/catalog
handshake, with no prompt or inference request from Xenoflux. Initialization may
authenticate, touch native state, or run startup hooks, so ordinary preview
renders cached metadata and offers Refresh available models separately.
Refresh must not enable models, change model policy or invoke a login/setup flow
as a discovery fallback. Native authentication refresh and initialization writes
remain disclosed effects; model-policy changes require a separate explicit action
outside discovery. If the selected discovery path cannot preserve policy, leave
that capability unavailable. Fixture the selected SDK's initialization path and
assert zero task submissions and zero model-policy mutations.
Cancel and reap the owned probe on timeout or UI cancellation. Freeze the
discovery context separately from the job's model selection.
Pi's Copilot login can enable models; that flow is not a read-only catalog
reference. [Pi login and model policy](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/ai/src/auth/oauth/github-copilot.ts)

Cache by client, profile/root mode, executable/SDK identity, connection/account
scope generation, and effective workspace settings. Use a short documented TTL,
explicit refresh, and invalidation after setup/authentication changes. Check
the captured scope again before publishing a late result. Keep credentials and
credential hashes out of the catalog. A missing account observation is not proof
of a matching account: use a verified connection/scope generation or retain the
result as unverified. Check scope again after asynchronous reconciliation before
publication, and discard results from superseded refresh generations. Keep
the last verified snapshot's age/source visible. At Start, revalidate an explicit
selection against the current initialized client. A removed/disabled choice returns an
actionable error before sending the task. Preserve unknown capability as unknown,
and never silently downgrade effort or select a replacement model.

For later custom-connection support, Copilot BYOK model listing can require an
`onListModels` handler. Add an endpoint-specific catalog only when that connection is supported and can
actually advertise its models. A public model list from another connection is
insufficient. [Copilot custom model listing](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/byok#custom-model-listing)

## Architecture and interfaces

Refactor around client and surface boundaries in working packages. Keep the
existing coordinator, persistence and report mechanisms, replacing modules
where their responsibilities require it. Codex must exercise the new contracts
before adding the second implementation. Each completed package leaves normal
comparison and review entry points usable.

The following operations describe responsibilities and data boundaries.
Implement them as small modules or existing injected functions as needed.

| Boundary | Operations and result | Ownership rule |
| --- | --- | --- |
| Job coordinator | Preview, Start, respond, cancel, inspect and recover an existing durable job. Freeze task/report inputs and conditions; coordinate capacity, reservations, workspace claims and publication. | Owns job/side IDs, admission and lifecycle transitions. Checkpoint writes/cleanup and late callbacks require the current owner/generation; stale owners cannot release another participant or restart a job. |
| Profile environment | `resolve(selection, workspace)` returns the client/surface binding, root mode, canonical resource roots, executable/build identities and settings fingerprint. `recheck(binding)` validates it before effects. | Resolution is read-only. The client implementation owns path/configuration interpretation and credential routing; the coordinator owns reservations on the returned resources. |
| Client runtime | `initialize(binding, callbacks, signal)` returns an owned handle and native capabilities. `submit(handle, frozenTask)` produces identified native events. `respond(handle, request, answer)`, `cancel(handle)` and `inspect(nativeRef)` retain native semantics. | Persist process ownership and any initialized session before submission; checkpoint returned native IDs on acknowledgement. Cancel returns turn and shutdown observations separately; inspect submits no task. |
| Capability catalog | `discover(context, signal)` returns a bounded snapshot of advertised models, per-model efforts and operations, with source, scope, generation and freshness. Validate an explicit selection against that context. | Explicit discovery owns and reaps its probe, submits no task and changes no model policy. Publishing a late result requires the same current profile/account/settings scope and refresh generation. Catalog failure retains unknown status. |
| Desktop surface | Discover app/backend identity, open/focus, hand off an exact session, inspect/import evidence, and invoke supported native controls. | Each operation is capability-gated for its surface/build/location. App opening, task submission and cloud cancellation have distinct effects and receipts. |
| Evidence and reports | Project native events and retained sources into existing run/report records, validate provenance, finalize, export and reopen. | Client decoders interpret native records. Shared projection preserves identity, unknowns and frozen evidence; model completion, capture, publication and shutdown remain independent facts. |

The frozen execution context binds existing job/side and ownership identities
to client, surface, profile/root mode, workspace, executable/app/backend/SDK
identity, settings fingerprint and requested model/effort. Keep credentials in
native authentication. Native references carry exact session/turn/item/request
IDs when available, plus client and job scope; a local ID cannot fill a missing
native field. Native replies use the client's bounded response schema.

Checkpoint updates use the existing atomic persistence and ownership guards.
Bind resumable native state to job/client/profile, exact native references and
the current coordinator owner/generation. Save/drop and terminal cleanup must
serialize so cancellation or a new owner fences out stale writes. Recovery
inspects retained evidence without submitting work; a missing native session
cannot silently become a new thread described as resumed. Capability records
represent supported, unsupported and unknown explicitly rather than defaulting
missing booleans to false.

Route UI/API/CLI operations through the coordinator. The coordinator obtains
profile bindings and capabilities through these boundaries and dispatches to
the selected runtime or desktop operation. Preserve the same lifecycle guards
around native callbacks and resource updates. Surface capability determines
which operations the UI can offer.

Use `createUiRuns` and `createUiReviewTasks` as the application entry points.
Turn their existing capture/profile-resolution injection into the client
boundary, and move direct Codex/Desktop dependencies behind the corresponding
profile, runtime or surface implementation. Reuse `runAuditCapture` as the Codex
implementation first, separating shared evidence projection as another client
requires it. [Comparison service](../../src/ui-runs.js) ·
[Review service](../../src/ui-review-tasks.js) ·
[Codex capture](../../src/audit-capture.js)

The current implementation maps those responsibilities without another scheduler:

| Contract | Implementation |
| --- | --- |
| Identity and profile environment | `client-contracts.js`, `audit-profile.js`; ordinary resolution records the actual explicit `CODEX_HOME` route, including Default. Unknown effective runtime roots remain null. |
| Runtime | `client-runtime.js` dispatches local CLI capture through the selected `context.clientRuntimes[client]` implementation; Codex defaults to `runAuditCapture`. `codex-runtime.js` owns app-server initialization, submission, exact replies, cancellation and attached-session inspection. Missing implementations are refused. |
| Catalog | `client-catalog.js` provides bounded pagination and initialized selection validation; `ui-catalog.js` owns explicit probes, exclusive claims and five-minute cache freshness. GET/preview never starts discovery. |
| Desktop | `desktop-surface.js` delegates existing Codex ownership/lifecycle; `stock-desktop-apps.js` independently verifies vendor signature/build/executable before ordinary Claude/Copilot opening. Copilot app-local session navigation separately requires a registered scheme and a bounded opaque ID. Opening/navigation submits no new task; successful OS dispatch does not prove session association. |
| Evidence | `codex-decoder.js` interprets native fields; `capture-projection.js` qualifies shared run/checkpoint identities and settings. Normalized run/report/review records validate supplied client, native reference and environment attribution; missing older observations stay unknown. `claude-transcript.js` imports a private selected snapshot through the isolated official SDK file reader, separately from native execution. |

Codex capture initializes an owned process/connection, checkpoints process and
native session ownership, then submits once through that runtime. Discovery and
owned-child reads remain Codex-specific RPC operations. Replies consume the
exact pending native request once; cancellation, connection closure or a terminal
native turn invalidates it. Cancellation records native interrupt acknowledgement
separately from process shutdown. Attached inspection requires the exact existing
session/turn and rejects contradictory client/job/profile scope. Inspection
without attached native state is unavailable and never initializes or submits work.

A Codex comparison may freeze `approvalsReviewer: "user"` in its audit spec
(`advanced.approvalsReviewer` in comparison preview requests). This requires an
interactive request handler. The runtime sends the setting to `thread/start`
and requires native confirmation of both `user` and `on-request` before
submission. Missing or different confirmation stops the comparison. The choice
lasts for the owned native session; saved settings and ordinary reviews keep
their native reviewer. The run records requested, sent and confirmed reviewer
evidence separately.

Current audit/review records retain version 1 with additive identity/evidence and
owner-generation fields; supported older version-1 records remain readable without
rewriting originals. Client-qualified `nativeReference` fields carry client, job,
profile and nullable native session/turn/item/request IDs. Readers validate supplied
scope against the owning record; an absent native ID stays unknown and never
becomes a local job ID or a fresh session. Existing retained-history readers remain
read-only and separate from attached runtime inspection. Once a reservation owner exists, checkpoint updates require
its exact generation under the record mutation gate. Catalog probe records use
`xfx-catalog-probe` version 1 in the private controller store. Only confirmed
shutdown releases a started probe's claim; cancellation after restart inspects
the saved identity without signalling or reinitializing. Ambiguous pre-checkpoint
startup retains its claim. A cache failure is unavailable, never an empty success.

## Execution and evidence invariants

Each implementation must establish:

- The exact client/profile/workspace and owned process before submission, then
  the native session and turn/request identity when acknowledged.
- Requested and actually sent model/effort/route, client-confirmed settings, and
  turn-reported model, effort and route as separately sourced fields. Missing runtime effort remains
  unknown even when the launch option was accepted.
- Native approval/input requests scoped to job, session, turn, request and exact
  action, including persisted arguments/resource identity, with stale answers
  rejected after cancellation or ownership changes. Regenerated intent cannot
  substitute for an approved request. Any supported continuation consumes the
  exact stored decision at most once; recovery reads never replay decisions.
- Terminal response content, capture coverage, and confirmed process shutdown
  as independently recorded facts. Retrying Start or reading recovery state adds
  zero task submissions.
- Exclusive profile mutation remains incompatible with active execution.
  Uncertain ownership retains its resource claims; cleanup releases only the
  exact participant whose owned execution is confirmed stopped.
- Startup inherits the process working directory, verifies the native working
  directory before submission and writes no native project-trust state.
- Shutdown is confirmed by following process ancestry from the owned native
  process, with birth time, group and arguments frozen when observed. Vendor
  tools can run in their own process groups, so a stopped owned group alone is
  insufficient. A process that disappears between queries is absent, not changed.

For Claude, preserve normal settings sources and the Claude Code system prompt
when using the SDK. Qualify instructions, hooks, skills, MCP, and permission
handling through the selected runtime. For Copilot, qualify the SDK's
`copilot-cli` behavior and native configuration against a normal CLI session.
Examples that approve every action cannot define Xenoflux's approval policy.
Cancellation must abort the owned session and confirm process shutdown.
Disconnecting an SDK handle alone is insufficient evidence that its tools or
background agents stopped. Await owned work and helpers where the runtime exposes
a join; record a timeout as uncertain and retain claims. A database cancellation
transition or `abort(): Promise<void>` return alone cannot establish shutdown.

Normalize messages, tools, artifacts, checks, usage and child links into the
existing report with client-qualified source references. Store the bounded
source evidence needed for reopen. Keep unsupported child discovery, historical
import, usage accounting and skill-use capture visible as unavailable. Preserve
independent checks and task completion even when one attribution field is
unknown. Evaluate cross-client outcomes against the same task/checks and pinned
workspaces, recording differences in permissions, tools and settings. One pair
cannot establish client superiority.
Compatibility projections and synthetic events retain their decoder/source
identity; they cannot manufacture client-confirmed settings, a native ID, zero
usage, or a free cost from missing observations.
[Evidence contract](AUDIT-GOAL.md#evidence-and-privacy-contracts)

Each package reaches the applicable profile validation/resolution, native
initialization, capture/session readers, comparison/review requests and report
serialization together. Update `web/src/api/types.ts`, execution fields,
setup/review pickers and session filters with the same identities. Add the
catalog API through the existing controller access checks. Separate request
shape validation from model/effort validation against the resolved catalog.
Record format changes define supported read/reopen boundaries explicitly;
preserve existing supported evidence attribution and leave unsupported
originals untouched.

## Setup reading, session lists and permission modes

**Setup reading.** Claude Code and Copilot each get a reader with the Codex
reader's categories ([`audit-discovery.js`](../../src/audit-discovery.js)):
instructions, skills, agents or rules, settings, hooks, MCP servers and plugins,
each with origin and scope. Presence, configuration, installation and enablement
stay distinct, and partial discovery is shown as partial. Readers never open
credential stores and never show secret values from MCP or hook definitions.
Setup comparison is offered between profiles of the same client; a mixed pair
shows each side's setup separately without claiming equivalent categories. The
[copy policy](PROFILE-COPY-POLICY.md) alone decides what may transfer.

**Session lists.** Per profile and on explicit request, list recent native
sessions through the pinned SDK's public listing: Claude's file-based session
readers, and Copilot's session listing through the selected CLI. Zero prompts, no
session activation, bounded pages and output. Listing metadata (titles, folders
and listing timestamps) stays local and out of receipts and exports.

Bind each selection to its client, profile, root mode, native route and exact
source identifier. Recheck that binding before import and pass the same root
through the public reader; changed or unavailable context fails without reading
stock or another profile's history. The import contracts below retain their
source/privacy bounds. The selected root identifies the read context, not an
otherwise unknown historical execution profile. Qualify list → select → import
→ export/reopen for managed roots; fixture identical session IDs in different
roots and a binding change after listing. Copilot listing was observed once,
over ACP; qualify the SDK route before building on it.

**Permission modes.** A side may override its permission mode next to model and
effort. Offer only non-bypass modes that the selected client's pinned SDK exposes
(for Claude: default, accept edits, plan); where a client exposes none, only "Use
profile default" appears. The override applies to that job's process and writes
no native settings. Record requested, sent and applied mode separately. Native
requests are queued per job and answered one at a time; Xenoflux never answers on
the user's behalf. A mixed pair states that its sides ran under different
permission rules.

Codex is included. Today one comparison-wide "Codex access" setting chooses
`read-only` or `workspace-write` for both sides, defaulting to `workspace-write`,
and Xenoflux sets the approval policy itself. In 4.0.0 that setting becomes the
per-side permission mode for Codex with the same two values and the same
default; `danger-full-access` is never offered. Where a profile's own settings
select a bypass mode and the side uses the profile default, the preview shows it
as a warning; Xenoflux never selects a bypass mode itself. Reviews keep the
selected profile's settings.

## Desktop surfaces and implementation checks

**Later scope.** Nothing in this section gates 4.0.0 beyond keeping the already
built stock opening, conversation import and Copilot session navigation working.

Track launch/focus, managed-profile isolation, model/effort controls, exact
session import, cancellation and automated execution as individual capabilities
for each surface/build/location. Assign supported, unsupported or unknown from
its evidence. A successful launch qualifies launch only. Keep user-confirmed
handoffs distinct from task submissions.

Deliver each proven capability independently. Opening/handoff/import can precede
multi-account isolation and automation, but cannot satisfy the managed-profile
requirement. Local macOS operations are the initial target; the cloud controls
and location-specific checks below are later gates. Retaining/importing an existing
cloud task does not enable cloud execution. A pending desktop capability does not
block an otherwise qualified CLI client release.

Implement the common desktop foundation first. Discover the signed vendor app
and backend build, inventory its documented configuration and storage routes,
then extend Xenoflux's named shortcuts and exact-process receipts. Preserve
vendor signatures and qualify credential/Keychain, app data, settings, history,
connectors and caches separately. If a profile route cannot be established,
expose ordinary app opening with managed isolation unavailable. Record native
sign-in as an app capability separately from the SDK authentication contract.
Bind launch receipts to the app identity, client/config root, app-data root and
callback/deep-link route. Test the stock app alongside two managed contexts and
reject misrouted callbacks before claiming isolation. Rebranded/re-signed vendor
bundles cannot pass signature preservation; use supported launch routes and
Xenoflux-owned shortcuts. Import retains original evidence without rewriting
vendor databases, transcript IDs or history to force an association.
[Existing desktop contract](DESKTOP-IMPLEMENTATION.md)

| Surface | Implementation steps | Acceptance checks |
| --- | --- | --- |
| Claude Chat | 1. Bind the signed app and observed account/project context. 2. Qualify app-data/login routes and connector state. 3. Add exact conversation import through a supported export/read interface and retain its source fingerprint. | Open/focus the intended context; cancel opening without sending a message. Before claiming independent profiles, demonstrate two managed contexts alongside the stock app with separate account/history markers. Reopen imported content after the original disappears; unavailable model, effort or tool evidence stays unknown. |
| Claude Code in Desktop | 1. Record the embedded backend independently of terminal Claude. 2. Resolve Desktop-specific MCP precedence, model/effort selection, permissions and workspace/worktree. 3. Qualify the documented exact-ID CLI/Desktop handoff and capture the resulting desktop session. | An MCP name collision resolves to the documented Desktop source. A handoff preserves native session ID and context without resubmitting the task. Check model changes per turn, approvals, concurrent workspace isolation and cancellation preserving another session. Import/export reopens exact evidence. Automated comparisons require a separately proven control interface. |
| Claude Cowork | 1. Detect account, plan and actual execution location, including retained local sessions. 2. Inventory cloud/session storage and desktop-mediated folder/connector grants. 3. Add exact task import and qualify location-specific cancellation and reconnect. | Closing the app while cloud work continues records connector unavailability rather than task cancellation. Confirm cancel against the owning task/location. Reconnect returns the same task without a second submission. Qualify folder grants, account separation and evidence reopen for each supported location; inaccessible cloud evidence remains unavailable. |
| GitHub Copilot app | 1. Discover the standalone app, backend, account and app-specific enterprise policy. 2. Qualify local worktree versus cloud session routing, native model/effort selection and shared CLI customizations. 3. Implement documented confirmation-based deep links and exact session/task import. | Test app-policy denial separately from CLI readiness. Deep-link cancellation creates no task; confirmed opening uses the intended repository/branch and native selection. Distinguish app-local session IDs from GitHub task IDs. Cancel one local/cloud task while another survives, then reopen its captured report after restart. Claim profile isolation only after two managed accounts/roots pass alongside the stock app. |

Claude documents shared CLI settings, additional Desktop MCP sources and
different precedence, while its Desktop feature table excludes scripting and
automation. Use the installed app's effective settings and supported handoff
instead of inferring Desktop behavior from an SDK run. Treat Chat, Code and
Cowork as logical execution surfaces even where Chat and Cowork share a UI.
[Claude Desktop reference](https://code.claude.com/docs/en/desktop) ·
[Claude Chat and Cowork](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)

Current Cowork documentation places new Pro, Max and Ultra tasks in the cloud;
older local tasks and other plan configurations need their own receipts.
Copilot's standalone app is built on CLI and has a separate enterprise app
policy. Its new-session deep links prefill repository, branch/PR, prompt and
mode, then require confirmation. Model, effort and account/profile selection
need another verified interface. Keep private prompts and frozen review content
out of URLs.
[Cowork locations](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile#how-cowork-in-the-cloud-works) ·
[Copilot app](https://docs.github.com/en/copilot/concepts/copilot-surfaces/github-copilot-app) ·
[Copilot deep links](https://docs.github.com/en/copilot/how-tos/github-copilot-app/open-with-deep-links)

Desktop model/effort discovery uses the same scoped catalog contract above,
extended with surface, app/backend build and execution location. Qualify parity
before reusing a CLI catalog. If the app exposes only a native picker, retain
an explicitly observed selection with time/source and leave exhaustive
availability unverified. Copilot's completed-response model display describes
the main agent; child model attribution needs its own evidence.
[Copilot model selection](https://docs.github.com/en/copilot/how-tos/github-copilot-app/choose-a-model) ·
[Copilot session locations](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions)

## Delivery sequence and acceptance

The [roadmap](ROADMAP.md#current-work-and-stop-condition) owns status and order.

| Package | Deliverable | Decisive acceptance |
| --- | --- | --- |
| A | Back up the ignored `local/` evidence and `docs/knowledge/` outside the checkout now. Push the branch and open a draft pull request once the user authorizes it. | The backup matches a hash manifest. CI passes on both Node versions once the pull request exists. A does not block B. |
| B | Lock behaviour first: replay recorded Codex app-server streams through the current capture and keep the resulting run records and reports as the reference. Then extract the transport from `audit-capture.js` into a runtime with initialize, submit, respond, cancel and inspect, separate shared evidence projection from the Codex decoder and keep owner/generation guards. Define the record version and read boundary for client-qualified native references. | The replay produces identical records and reports after extraction. Existing Node and browser suites pass. Duplicate Start, exact approvals, same-profile jobs, independent cancellation, uncertain ownership and restart pass through normal entry points via the interface. A fake second runtime completes a comparison in fixtures. Missing native state causes no fresh-thread fallback. One native Codex regression batch passes under the Codex allowance; it includes an action that triggers a native approval and a stale-answer rejection, which the [November 9 batch](history/CODEX-APPROVAL-QUALIFICATION-2026-11-09.md) never observed. |
| C | Claude Code: account-scope check first, then profile binding (`CLAUDE_CONFIG_DIR`, implicit and explicit root modes), runtime, catalog, permission modes, decoder, profile-bound session listing/import and review execution. Extend the [review contract](REVIEW-TASK-IMPLEMENTATION.md) to Claude. Include minimal client/Default-profile selection and mixed-comparison UI wiring for Codex versus Claude. | The Default pair completes preview → Start → report through the normal UI in fixtures, without waiting for D or E. Fixtures replay the captured Claude streams: approval bound to the exact current request, several queued requests, pending and running cancellation, companion completion, child-ID heartbeats kept as advisory, a "stopped while running" tool result and absent optional fields. Manifest or prompt effort is not native capability. Cancellation joins iterators, streams and child close. Startup and shutdown meet the working-directory, trust and ancestry invariants. |
| D | Copilot CLI: account-scope check first, then profile binding through the pinned SDK's public root option, runtime, catalog including Auto routing, permission modes, decoder, profile-bound session listing/import and review execution. Extend the review contract to Copilot. Conversation import accepts native sign-in types established by the selected binding's account-scope check, not only `gh-cli`. | Fixtures replay the captured Copilot streams: separate path and commands handles for one action, only `approve-once`/`reject`, several queued requests, nullable static tokens, yielded shell versus typed exit with one owned `read_bash`, idle with `aborted` absent and abort before teardown. Refresh never enables models; ambient token/provider/root overrides are refused before startup, while the adapter supplies the validated profile root. Startup and shutdown meet the working-directory, trust and ancestry invariants. |
| E1 | Profiles: client choice at creation, per-client setup and sign-in guidance, account-scope display and signed-out detection. | Account checks 1 and 2. Preview/cancel creates nothing. A shared-scope client is labelled as shared; account independence is displayed as not verified. |
| E2 | Setup readers for Claude Code and Copilot with the Codex reader's categories; setup comparison for same-client profiles. | Each category shows origin and scope; hooks, MCP servers and plugins appear in detail without secret values; partial discovery is shown as partial. Fixtures cover project versus user scope, plugin-owned components and unreadable sources. |
| E3 | Same-client selected-parts copy through the existing planner, journal and Undo, with each client's allowlist added to the [copy policy](PROFILE-COPY-POLICY.md). | Copy and Undo pass the policy's field-ownership and failure cases per client; credentials, history, hooks, MCP and plugin definitions are not copied. |
| F | Extend C's minimal comparison UI to all three clients and managed profiles: UI/CLI execution fields with supported permission-mode overrides, replacing the comparison-wide Codex access setting; request queue; mixed pairs; per-side catalog validation; session list and selection pages; setup comparison; CLI `--client cli\|desktop` renamed to `--surface`; notices for auto-routed models, differing permission rules and usage or rate-limit failures; client identity in session filters and report citations. | All six pair types run in fixtures with pinned inputs and common checks and reopen with separate provenance and missing metrics. Session selection/import preserves the bound root and rejects changed context. Unsupported permission overrides cannot be submitted; default inheritance remains available. Cross-client ID collisions, publication failure and a failed optional review preserve both results. A limit-reached failure is shown as such. Keyboard, narrow layouts and both themes pass. |
| G | Native qualification of C–F through the normal UI/API entry points under the recorded allowances. | The native checklist below passes, with source-bound evidence for each client and explicit unknowns. |
| H | Product statement in README, PRODUCT.md and user guides: "Profile manager and task comparison for Codex, Claude Code and GitHub Copilot CLI on macOS." Slim-install verification; release checks. | The [release procedure](LOCAL-RELEASE.md) passes on the source-bound candidate. An isolated global install works with and without optional dependencies. Documented limits include account scope and unverified independence, Auto-routing reproducibility, unknown applied effort and no reattach after restart. |

The [roadmap allocation](ROADMAP.md#qualification-prompt-allocation) accounts for
B and G together, including failed/cancelled attempts and remaining allowance.

### Native qualification checklist

For each new client:

- Refresh the catalog and list sessions with zero task submissions. Select
  sessions from a managed profile, import from that bound root, export and reopen
  after the owned source copies become unavailable; preserve vendor history.
- Complete a comparison with an exact approval and exercise several queued
  requests. Where supported, exercise a job-local permission override and retain
  requested, sent and applied observations separately. Otherwise verify native
  default inheritance, an unavailable override control and rejection of explicit
  unsupported overrides before submission. Missing applied-mode evidence stays
  unknown.
- Cancel pending and running work while a second job survives and completes.
  Complete an ordinary report review, verify its frozen inputs and exact
  response association, and reopen it. Keep controller-interruption/no-resend
  fixtures; its additional native review qualification is deferred under the
  [current scope](AUDIT-GOAL.md#planned-multi-client-scope).
- Pass account checks 1 and 2, including the user-operated per-root checkpoint
  when applicable. Copied-setup native loading is deferred; retain copy/Undo
  preservation and missing/wrong-scope marker fixtures. Configuration or copy
  success must not be described as observed loading or skill invocation.

Complete one native mixed-client pair. The remaining pair/mode cross-product
and repeated concurrency stress are deferred; retain all fixture coverage.
B supplies the Codex runtime regression; reuse it only while its source
and behaviour remain applicable. All submitted attempts consume the roadmap's
client-specific allowances.

Build C and D against sanitized captured native streams before spending prompts,
so qualification tests the product path. Run focused fixtures through the actual orchestration entry points before
broader checks. Include duplicate native request IDs across jobs, a late event
after cancellation, a mid-turn model change, a catalog refresh after account
switch, and failure after response capture but before report publication.
Also cover a stale-owner checkpoint racing cancellation, changed approved
arguments/resource, missing native resume state, explicit same-path roots,
superseded refresh generations and model-policy writes during discovery.
From the captured streams, cover several native turns for one host prompt and
distinct ordered events that share a timestamp; order by event sequence and
unique IDs, never by a clock increment.
Exercise a privacy canary with positive controls across reports and review
inputs so a scanner that saw no data cannot pass. Every assertion needs a
positive control proving the compared data exists; two absent fields are not a
match. Source-loss tests move only Xenoflux-owned copies and leave vendor
history untouched.

For every package, run focused regressions through normal entry points, then the
affected and required developer checks. Rebuild and verify the bundled UI when
its source changes. Fixtures establish controller handling; native acceptance
establishes only the client, build, authentication route and location exercised.
[Developer checks](README.md#checkout-and-checks)

## Next bounded qualification batches

Native qualification consists of B's Codex regression and package G. It runs
through the product adapters and normal entry points; private harness actors are
no longer the qualification vehicle. The
[roadmap](ROADMAP.md#recorded-user-instructions-2026-11-10) records the current
allowances, limits, used counts and authorization for necessary cap increases.

- **Capture live, grade offline.** Only safety guards stop a live run: job and
  owner identity, the exact approved action and resources, budget, time and
  output bounds. Acceptance matchers (wording, byte counts, event counts, marker
  order) run afterwards on the retained capture and can be corrected and re-run
  without a new prompt.
- **Take shapes from the pinned SDK types.** A field the SDK declares optional is
  accepted when absent; one captured sample never defines a required field.
- **Replay before dispatch.** Every guard change passes the retained captured
  streams before a batch.
- **Count and preserve.** Each batch updates the roadmap's used count and
  records the usage each client reported beside it; a prompt count and an output
  cap bound neither tokens nor billed cost. Stopped results and raw receipts stay
  unchanged; a corrected assessment is a separate derived record.
- **Use current installations.** Profiles are not pinned to CLI/Desktop
  versions. Resolve the selected current installation and verify capabilities
  on each fresh operation; an update invalidates stale observations, not the
  profile. Keep preview-to-execution identity checks and record observed
  versions. Rerun affected zero-prompt smoke after a change, not a historical
  version matrix. SDK dependency changes retain their source/effects checks.

Discovery must not enable models, borrow ambient credentials, change
account/policy settings or infer a usage budget from sign-in. Previous Codex
[qualification](history/CODEX-QUALIFICATION-2026-11-09.md) and
[approval-stop](history/CODEX-APPROVAL-QUALIFICATION-2026-11-09.md) records retain
their outcomes and limits. New Codex runs use only the separate Codex allowance.

## Read-only Claude Code import

`@anthropic-ai/claude-agent-sdk` is pinned at `0.3.322` for its supported stored
session file readers in this import. The import itself starts no agent and
establishes no execution or subscription-authentication behaviour; the selected
execution transport is recorded under [Integration choices](#integration-choices). The SDK documents
[`getSessionMessages`](https://code.claude.com/docs/en/agent-sdk/typescript#getsessionmessages)
and a [file-reader session browser](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser).
Native transcript layout remains internal; do not replace these readers with a
private-format semantic decoder.

Explicitly select two UTF-8 UUID-named `.jsonl` files, at most 8 MiB and 10,000
JSONL records each. Admission validates shape/identity and retains a private
immutable copy; a bounded helper reads only its isolated configuration snapshot.
Its environment excludes native credentials, it guards subprocess/network/write
entry points before loading the pinned SDK, and it never initializes an agent.
SDK changes require renewed source/effects, malformed-input, privacy and
export/reopen qualification before updating the pin.

Only SDK-selected public user/assistant text enters the frozen replay. Thinking,
signatures, tools, system content and oversized bodies are omitted explicitly.
Keep raw-source hashes distinct from sanitized projection hashes; source-line
ordinals refer to that retained projection, not original JSONL lines. Preserve
unknown account/profile, model/effort, usage/outcome, original surface and execution
location. The import is a partial conversation projection, never a complete native
run or claimed desktop association. Reopening/exporting frozen evidence must not
read native histories or initialize the reader again. Raw JSONL stays private and
is never embedded in a public report. Existing redaction and opt-in body export
still apply.

Copilot [`ghapp://sessions/<id>` navigation](https://docs.github.com/en/copilot/how-tos/github-copilot-app/open-with-deep-links#available-app-links)
uses an app-local ID and the verified signed app only. Reject URLs, task IDs,
query strings, overlong identifiers and build/scheme changes before dispatch.
A dispatched link and a missing-session screen establish no successful target
association or task completion.


## Read-only Copilot conversation import

Open saved accepts two explicit local session UUIDs. The pinned
`@github/copilot-sdk@1.0.29` calls public `sessions.readPersistedEvents` through the
selected installed Copilot CLI, without creating, resuming or activating a session.
This qualifies a read interface, not an execution transport or managed profile.
The currently qualified route preserves the native user home/context and implicit
`gh-cli` sign-in. Package D extends it to the selected profile's validated root,
root mode and native authentication route under the
[session selection contract](#setup-reading-session-lists-and-permission-modes).
Ambient token/provider/root overrides remain refused; the adapter supplies only
the bound root through the pinned public option. No sign-in, policy change,
remembered grant, task, tool or model prompt follows from import.
Provider overrides include `COPILOT_PROVIDERS_CONFIG` and every
`COPILOT_PROVIDER_*` variable, including empty values; reject them before native
startup rather than changing the inherited environment to force a native route.

The bounded reader pins one journal generation, pages sequentially up to eight
200-event pages and requires `cursorStatus: ok` plus `hasMore: false`. Expiry,
unsupported RPCs, changed scope and bounds fail without a replacement read.
Each read has 30 seconds plus 18 seconds cleanup inside the owned process-group
wrapper, 8 MiB combined native output and a separate 8 MiB retained snapshot budget.
Native versions are recorded provenance; supported protocol/fields and method
behavior decide compatibility. Both sides must succeed before publication;
rollback removes only newly owned artifacts.

Private raw pages and sanitized text retain distinct hashes. Only public
`user.message`/`assistant.message` `data.content` text enters replay; reasoning,
transformed/system content, tools, assets and opaque fields stay out. Native event
IDs/timestamps and observed assistant model IDs are preserved where available.
Original account/profile, surface/location, full turns, outcome, usage and applied
effort remain unknown. Historical resume/shutdown events are not actions performed
by the reader. Imports remain partial conversation evidence. Export/reopen uses the
shared frozen pipeline without another native read, and raw pages never enter the
public report. The [follow-up record](history/CLIENT-FOLLOWUP-2026-11-10.md) owns
native source/build acceptance and remaining limits.
