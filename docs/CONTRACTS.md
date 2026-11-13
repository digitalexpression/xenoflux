# Implementation contracts

Xenoflux's primary job is task comparison: create/select profiles, compare a task,
inspect its evidence and optionally request an attributed review in the bundled
local app. Normal use requires no authored JSON, manual report transfer or session-ID
reconstruction. [The guide](GUIDE.md) owns user-facing support/limits;
[contributing](../CONTRIBUTING.md) owns checks and source entry points.

## Identity and selected installations

Discovery is read-only and separates installation observations, profile
structure and operational eligibility. Inspect bounded known locations without
native client execution, account checks, Desktop reconciliation or registry writes.
An inspection-only registry projection may describe unsupported records. Operational
profile reads and mutations retain strict registry validation. Missing client
attribution on a supported older Codex record does not require migration. An unbound
record is not proof of an obsolete format. Discovery never authorizes creation,
copying or launch.

Automatic discovery reads are serialized and reject superseded responses. Current
filesystem metadata invalidates cached installation and profile observations;
failed refreshes cannot turn previous findings into fresh or empty evidence.
Cached discovery never replaces an operation's current identity validation.

Each prepared operation binds client, surface, profile/root mode, canonical roots,
selected executable/SDK identity, workspace/settings fingerprint and job/side owner.
Client identity is independent of model vendor. Implicit Default and explicit roots
remain distinct even for identical paths. Native IDs are bounded client/job-qualified
opaque values; missing IDs stay null rather than becoming invented local identities.

Profiles are never pinned to CLI/Desktop versions. Resolve the current selected
installation and capabilities for each fresh operation. Revalidate identity across
preview/launch, invalidate changed catalogs and refuse replacements during a prepared
action. Versions describe provenance; an unfamiliar version alone is not rejection.
Protocol shape, supported fields, ownership and capabilities determine admission.
SDK dependencies remain locked by package metadata.

Sign-in belongs to the unmodified native client. Record shared/per-root account scope;
separate roots do not prove separate accounts. A signed-out per-root profile cannot
borrow another login. Do not collect/copy credentials or use credential hashes as
identity. Refuse unsupported ambient token/provider/root overrides, including empty
values where the native override contract treats them as present. Native HOME/USER/
LOGNAME must stay consistent; use client-qualified configuration roots explicitly.
Custom endpoints, BYOK and SSH/cloud execution are outside
the supported boundary. Claude and Copilot Desktop admission covers local selected-root
startup/storage only; authenticated sessions, model operation and account
independence are not qualified by that admission.

## Profile creation, copying and Undo

Empty creation copies no setup beyond required management files. Selected-parts
creation and later copying use one same-client planner. Preparation, copying,
sign-in and opening remain separate; later failure cannot erase prior successful
steps. Default is a source only. Profiles evolve independently, not by synchronization.

Preview binds source/destination/root mode and selected before/after bytes/modes,
showing additions, changes, removals, kept items, origin, conflicts and unknowns.
Recheck under the copy lock and refuse active/unresolved owners. Preview/cancel
creates nothing and closes no client. Identical/empty changes create no transaction.
Preserve unselected and source-absent destination state across every entry point.

Standalone skill replacement is exact, including supported resources/scripts,
obsolete package members, directory shape and modes. Explicit conflicts support
keep/skip/replace. Refuse unsafe paths, ambiguous ownership, unsupported content/type
transitions or insufficient owner permissions before mutation; never partially overlay.
Project, plugin and built-in resources retain their ownership. Discovery can be wider
than copying, without making visible unknown configuration freely copyable.

Copy eligibility/field types are owned by the production planners and tests. Only
allowlisted standalone content enters transactions. Selected native `settings.json`
keys preserve all other bytes; malformed/duplicate fields, JSONC or unsupported selected
values are refused. Account stores, including Claude account/credential files and
Copilot `config.json`, are not settings sources. Preserve authentication/storage routing.
No transfer of credentials, granted permissions/trust, conversations, generated memory,
databases, caches, runtime state or cross-profile links. Supported rule definitions
are not migrated authorization grants.

Plugins/hooks/MCP receive selected conditional native/manual guidance only, never
automatic install/enable/connect/trust/config migration. Keep plugin components with
their parent. Cache/version metadata is not proof of installed state; avoid redundant
instructions and duplicate definitions. Manual setup has no persistent checklist and
is outside Undo. External file/script dependencies are not installed or rewritten.

Journal selected writes/deletions/modes, define field ownership before mutation and
compensate exact before-state on failure. Failed compensation retains an uncertain
journal and conflicting reservations. Undo refuses intervening edits and preserves
original recovery records. Current v3 copy journals are supported; older unsupported
formats remain unchanged. Copy success does not prove native loading or adherence.

## Execution, approvals and ownership

The coordinator owns admission/lifecycle/durable publication; adapters own client
protocol/account/event interpretation. Reuse capture, report projection, atomic private
metadata and `.run-lock` memberships across controllers. Independent jobs have separate
sessions, requests, workspaces and cancellation; canonical writable review workspaces
cannot overlap active/unresolved claims. Capacity defaults to eight per controller.
Profile mutations and new Desktop startup remain exclusive. Verified managed Codex Desktop
can participate in comparison/review execution without losing its own reservation.

Ordinary review uses the selected profile's normal cwd, sign-in, settings, instructions,
integrations and permissions, with explicit process-local model/effort overrides only.
Preparation reads metadata and starts no native version probe/task, edits no trust or
settings, closes no client, borrows no account and provisions no extra isolation.
Inputs use fixed private absolute paths in the exact hashed/saved effective prompt.
Embedded report instructions are evidence, not commands. Report-only reasoning is a
prompt instruction, not enforced isolation; normal native runtime/history effects apply.

Comparisons freeze one commit and separate workspaces, preserving the source worktree/
index and excluding dirty/untracked/ignored inputs. Sides run in recorded order. Setup/
check commands execute outside the model sandbox and may affect external state. No
checks are auto-selected; no checks means unverified. Changed trust/cwd/native startup
or saved settings drift stops affected work without rolling back external changes.

Persist spawn intent and initialized process/session ownership before submitting once.
Checkpoint native session before turn/input release; checkpoint failure sends no turn.
Recheck PID/start/host/executable across initialization. Every callback/checkpoint/drop/
terminal cleanup needs the current owner and generation under the mutation gate.
Serialize publication/release so stale owners cannot overwrite or free another job.
Missing attached native state never creates a replacement session.

A native reply consumes the exact stored live request/action once. Wrong-task, stale,
duplicate, regenerated or terminal requests never inherit approval. Cancel, completion,
connection loss and owner changes invalidate pending replies. Show the actual proposed
action and native choices; never auto-approve, synthesize denial, lower native policy,
hang on unsupported methods or retry silently. Distinguish JSON-RPC requests from
responses/notifications by shape. Keep provider-specific handle/reply codecs exact.

Catalog identity includes client/profile/root mode, installation, account/connection
generation and effective workspace settings. Ordinary preview uses cached metadata;
explicit refresh owns bounded initialization without task/login fallback/model-policy
mutation. Startup hooks/state effects are disclosed. Reap owned probes and admit late
results only for the current scope/generation. Five-minute freshness does not survive
setup/authentication changes. Failure is unavailable, not an empty successful catalog.

Model/effort defaults inherit independently. Native IDs/effort strings are opaque;
changing model invalidates explicit effort until rechecked. Start validates explicit
advertised choices and required native confirmation without substitution/downgrade.
Keep requested, sent, confirmed and turn-reported settings separate. Catalog membership
is neither account entitlement nor execution proof. Codex interactive user-reviewer
requests require a live handler plus native `user`/`on-request` confirmation; ordinary
reviews retain their normal native reviewer and permissions.

Codex review thread creation inherits the process cwd; verify it before a turn. Avoid
thread cwd that persists project trust, audit sandbox/config injection, no-op startup
probes, private comparison SQLite/log/TMP routes or forced policies in ordinary review.
Claude uses its public SDK custom-process route and native init/session binding; only
validated skill-sync freshness metadata is exempt from settings identity. Copilot uses
the selected CLI/public SDK root option, native cwd checks and exact owned permission
handles. SDK lifecycle/idle receipts are bookkeeping, not authority or completion by
themselves; keep their exact producer guards and regression controls in the adapters.

## Persistence, cancellation and recovery

Prepared review input IDs are UUID preview tokens; save frozen report/projection/prompt
hashes, profile/workspace identity and inclusion choice with private 0600 task files.
Inputs remain authoritative after live reference/source loss. Revalidate their hashes
before dispatch/after completion. Altered/unreadable inputs or response bytes remain
explicit, never silently accepted or reconstructed from current history.

Durable idempotency lookup precedes volatile preview/report requirements. Exclusive
staging and one Start promise prevent duplicate dispatch after clicks/retries/restart.
Corrupt/incomplete staging is preserved, never reused for another launch. Reopen the
fixed task-local frozen report through UUID/owner/hash validation, not volatile refs,
arbitrary paths or live historical recomputation. Keep the originating comparison and
other reviews unchanged; ordinary response text is not a structured rating/exported
verdict unless the exported format actually contains it.

Lifecycle is prepared → starting → running/waiting-for-user → completed, with failed,
cancelled, interrupted and uncertain alternatives. Completion needs the matching native
completed turn plus retained assistant response, not exit 0 or commentary. No usable
response stays response-unavailable even if native completion occurred. Preserve native
completion, response capture, coverage, interrupt acknowledgement and physical shutdown
as separate observations. Review defaults are uncapped duration with optional user cap,
8 MiB bounded process output and no claimed token/dollar cap; startup/shutdown stay bounded.

Tab closure leaves work and unanswered requests running. Cancel/normal server shutdown
stops only owned work. Join exposed streams, iterators, input and process close, and
inspect observed ancestry/handles. A stopped main process/group does not prove escaped
descendants stopped. Uncertain shutdown retains claims even when terminal text survives.
After crash, read identity only: stopped work becomes interrupted; live/unknown stays
uncertain. Never blindly signal saved PIDs, replay approval, reattach, resend, resume
or retry. A deliberate new attempt has a fresh preview/record.

## Desktop and native helpers

Claude and Copilot Desktop own one durable, exclusive reservation per profile independent of
the UI server. Before startup, bind the current signed installation, canonical
profile roots and their identities, persist intent and refuse a conflicting reservation.
Copilot also refuses an existing vendor app. Claude uses a distinct Desktop data
folder and allows other instances without controlling them. Require a new exact native process identity and
positive selected-root storage evidence before reporting profile-bound startup.
For Claude, that evidence can come from an exact owned descendant holding the
selected Desktop storage. A configuration environment variable alone is insufficient.
Do not pass prompts, authentication choices or account overrides. Readonly status
never releases the reservation. Explicit recovery rechecks the exact stopped
owner, roots and complete holder observations; uncertain startup, reused process
identities and incomplete scans retain ownership. Other Claude instances alone
do not block recovery of a confirmed-stopped profile. Never broaden shared task
participant admission to bypass this exclusive claim.

Open/focus/quit verifies the signed vendor app, selected profile routes and exact
PID/kernel start identity. Preserve signatures/entitlements; never re-sign vendor
executables/helpers. Stock opening sends no prompt or account/surface selection and
establishes no managed isolation or historical session identity. Refuse control from
the target's own invocation ancestry or mismatched/unrelated processes.

Ship the prebuilt universal helper with source/binary identities and private binary-keyed
caches. No install/pack compilation or fallback; damaged helpers need a corrected package.
Running instances retain pinned helpers. Desktop keeps account HOME for keychain access;
CLI isolates user-home. Do not reset/create keychains or change search lists. Filesystem
routes do not isolate every account/group resource.

Graceful quit waits for owned/new/reparented descendants and profile handles; zombies
may count as stopped. Timeouts, reused identities and incomplete handle scans preserve
records. Observed listing, review Start and open can reconcile confirmed normal quits;
other execution participants retain their own reservations. Recovery changes only exact
stopped owned metadata without launching/quitting apps. Plugin-cache cwd or a mapping
of the verified executable alone need not block idle checks; descriptors, other mappings
and database/WAL/SHM handles still do. Warnings/incomplete observation remain refusals.

## Evidence, privacy and accounting

Store observations with client-qualified actor/turn/source ownership, references,
coverage and omissions. Discovery, installed/enabled/available, selected, loaded,
invoked, successful read and adherence are distinct. Hashes/paths/publishers do not
resolve ambiguous ownership or establish identical loaded bytes. Current catalogs/files
never fill historical gaps. Same-task declarations/titles do not override conflicting
recorded inputs. Imports freeze a new derivation; originals remain unchanged.

Single-profile inspection and mixed-client inventories share one bounded source
projection. Category alignment provides navigation, not semantic equivalence or
cross-client copy eligibility. Static inspection of known safe roots requires no
native executable or sign-in. Repository scope is validated before discovery and
belongs in snapshot cache identity; an invalid scope cannot silently become global.
Explicit refresh rereads current sources without upgrading them to historical or
effective harness evidence.

Replay retains each side's independent order, stable references and owned child links,
with explicit absent clocks/content/children. Do not invent synchronized matches or
reconstruct private chain-of-thought. Attribute agent commands, runner checks, external
checks and reviewer claims separately. Hook/MCP/plugin readiness is not use. Native
failures remain failures despite successful outer transport; reclassification creates
a new import. Exact receipt identity supports idempotent journal replay, not unique
or exhaustive execution counts. Acknowledge telemetry only after the required synced,
hash-bound journal checkpoint; storage failure latches rejection. Recovery replays
committed prefixes; interrupted tails remain uncertain. Durability and sender
acknowledgement are different facts.

Token subsets and overlapping spans are not additive. Whole-turn/workflow totals need
verified baselines, continuity, identity and accounting; missing fields, regressions,
resets, invalid subsets and incomplete lineage block affected totals. Captured-session
sums do not prove complete workflow discovery. Billing and opaque external model work
remain outside scope. Clock units/time padding establish neither precision nor ordering.
Repeated evidence retains planned/selected denominators, missing samples, contradictions
and task/rubric/recipe compatibility. One pair proves no consistency, causality or winner.
Do not invent customers, testimonials, benchmark results or native qualification.

Exports omit recorded bodies by default. Explicit inclusion uses bounded redaction,
never a promise that arbitrary prose/code/metadata is public-safe. Preserve evidence
bound to reviews; a disclosure change requires another packet/review rather than
silently stripping inputs. Freeze all supported evidence/limits for source-free reopen.
Preserve whole structured bodies or omit with a limit; never label truncated patches
complete. Current check output is bounded to 64 KiB per stream and text patches to
256 KiB per side; baseline patches may include setup and exclude ignored content.

Claude imports use only the public stored-session reader in an isolated bounded helper
with credentials and write/network/subprocess effects guarded before SDK load. Raw JSONL
stays private; only public user/assistant projection enters replay. Copilot imports use
public persisted-event reads with one pinned journal generation and bounded sequential
pages, without creating/resuming/activating a session or a model/tool prompt. Changed
scope/cursors/unsupported reads fail without replacement. Both sides pass admission
before publication; rollback removes newly owned files only. Reader shutdown is not
historical task completion. Preserve projection origins and unknown account/surface/
usage rather than borrowing execution claims from historical events.

Keep local web access on loopback with session/Host/Origin validation. Render native
content as untrusted text. No arbitrary command/configuration API or authorizing code
from embedded report instructions. Public packages use an explicit allowlist, preserve
native/dependency licenses and exact source/artifact identities. SDK schemas/limits and
route fields are owned by production code/tests, not a second prose schema.

## Evolution

Breaking changes can remove obsolete paths/formats/adapters; do not add shims or dual
readers/writers merely for retired contracts. Unsupported older data remains untouched;
preservation does not promise conversion/import/resume/Undo. Current-format integrity,
export/reopen, mutation safety and recovery remain required. Operational instructions
and old evidence grant no authority for native runs, publication or installed updates.
