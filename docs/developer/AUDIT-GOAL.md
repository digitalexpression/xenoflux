# Xenoflux UI release: shared product goal

Goal ID: `XFX-AUDIT`. This file owns product behavior and acceptance. The
[roadmap](ROADMAP.md) owns current status and delivery order; user instructions
determine authorization. A goal or historical grant does not authorize operations.

## Current release boundary

The locally bundled browser UI supports **Codex on macOS**, launched with
`xfx ui`. Users can:

1. Create an empty profile or one from selected supported parts of another.
2. Run the same task on two comparison sides and read the report. Both sides may use one profile.
3. Request ordinary AI reviews of that report and read each task-scoped preference,
   tie or inconclusive judgment in the UI.

**Create → compare → read report → optionally request review → read response.**
Review is optional for users but required as a product capability. Normal use
requires neither a development server, authored JSON nor manual transfer to an AI.
CLI-backed execution is sufficient; a separate Desktop runner, fresh direct-client
tasks and repetition campaigns are not prerequisites. Existing capabilities may
be retained or simplified; they do not expand these three outcomes. Additional
providers, benchmark/cohort builders, generic config editing and desktop-shell
packaging are outside this release.

## Planned multi client scope

**Target: release 4.0.0. Product decisions recorded 2026-11-10.** Claude Code and
GitHub Copilot CLI reach parity with Codex CLI on local macOS: profiles,
model/effort discovery, comparison, native approvals, cancellation, report and AI
review, including mixed-client pairs. The [client support plan](CLIENT-SUPPORT-PLAN.md)
owns architecture, native interfaces, work packages and their checks. The roadmap
owns delivery status; the current release boundary above describes shipped behavior.

Each managed profile has its own configuration root. Sign-in is performed by the
user in the unmodified native client, and each client has a recorded **account
scope**: *per-root* when a root holds its own sign-in (expected for Claude Code),
or *shared* when the native client resolves one login for every root (expected
for Copilot through the GitHub CLI login). **The same account may be used in
several profiles.** Where the scope is per-root, a profile never borrows another
profile's or the stock client's sign-in, and a signed-out profile is reported as
signed out. Where it is shared, profiles differ only in setup and the UI says the
account is shared. Environment tokens and provider overrides are refused for
every client. Independence between profiles' accounts is shown as *not verified*
until two distinct accounts pass the isolation checks; that qualification is
later scope, not a 4.0.0 gate. Xenoflux never collects, stores or routes
credentials. API keys, custom gateways/BYOK, SSH and cloud execution are later
scope and cannot substitute for the subscription journey.

**Release decision, 2026-11-11:** native token-refresh qualification is deferred
from 4.0.0 to the next release. Keep it explicitly unverified; successful
sign-in, restart or a task does not establish refresh. Native clients still
own credential renewal. This defers an acceptance check, not account/root
isolation, credential privacy or failure handling.

**Native qualification scope, 2026-11-11:** retain normal local catalog/task
execution per advertised client, exact approvals and stale-answer refusal,
pending/running cancellation with safe shutdown and surviving work for each
new client, ordinary reviews, owned-session import/export/reopen, and one
native mixed-client pair. Defer the remaining native pair/mode cross-product,
repeated concurrency stress, controller-kill review qualification and copied-
setup native loading to the next release. Keep their fixture coverage and
state the narrower native evidence; no deferred check is reported as passed.

Claude and Copilot profiles are created empty or from selected parts of another
profile of the same client under the [profile copy policy](PROFILE-COPY-POLICY.md).
Cross-client copying is later scope.

Setup comparison and selected-parts copy read each client's instructions, skills,
agents or rules, settings, hooks, MCP servers and plugins with origin and scope,
as they do for Codex. Reading more does not widen copying; the copy policy still
decides what transfers.

Each profile lists its recent native sessions so two can be chosen for a session
comparison. Listing submits no task and activates no session; titles and folders
stay local.

Each side may override the permission mode for its job, next to model and effort,
limited to the non-bypass modes its client offers. Requested, sent and applied
mode are recorded separately, and Xenoflux never answers a native request itself.

After a controller restart, a job is interrupted or uncertain with its retained
evidence, for every client; nothing is resent or resumed. Reattaching to live
work through a detached job host is planned for 4.1.

Desktop support stays as built on this branch: verified stock app opening,
read-only Claude Code and Copilot conversation import and Copilot session
navigation. Opening a stock Claude or Copilot app uses that app's existing native
account. Verify its signed identity again before opening; app opening selects no
managed profile or logical Chat/Code/Cowork surface and submits no task. Managed
desktop profiles, exact-session handoff, desktop automation, Claude Chat and
Cowork are later scope and do not gate 4.0.0.

| Target outcome | Acceptance |
| --- | --- |
| Select a client and profile | Each profile uses its own root, and each client shows its account scope: per-root or shared. A per-root profile that is signed out or empty never uses another login. Keep client, surface, account/root scope and location explicit, including identical-path root modes, and show account independence as not verified. Setup, sign-in and app opening remain distinct. |
| Inspect and copy setups | Setup comparison reads every setup category for each client and shows partial discovery as partial. Selected-parts copy works between profiles of the same client with preview and Undo. |
| Choose existing sessions | A profile's recent native sessions can be listed and two selected without typing identifiers; listing starts no model work. |
| Set permission mode per side | An override is offered only from the client's own non-bypass modes, applies to that job only and is reported as requested versus applied. A mixed pair states that its sides ran under different permission rules. |
| Discover models and effort | Read capabilities for the selected context, preserve default inheritance and unknowns, and revalidate explicit selections before submission. An explicit refresh may initialize the native client but submits no task and changes no model policy. Ordinary preview uses cached metadata; late results from changed contexts cannot validate a selection. |
| Compare and review across native clients | Each CLI client supports the existing comparison/report/review journey with independent jobs, exact native approvals, cancellation, truthful interruption after restart and retained evidence. Stale owners cannot overwrite checkpoints or affect another job. Mixed-client pairs use pinned task inputs and shared checks. A usage or rate limit reached during a job is a visible failure, not a silent stop. |
| Report routed models honestly | When a client routes automatically, such as Copilot Auto, show the model each turn reported and state that the pair may not be reproducible. |
| Trust attribution and preservation | Keep requested, sent, client-confirmed and turn-reported settings separate; missing observations remain unknown. Reopen exact saved evidence and reviews without duplicate work or a fresh task described as resumed; preserve unrelated clients, credentials, workspaces and original data. |

## Profile creation

**Empty** copies no setup; minimal management files are allowed. It does not mean
authenticated or model-ready. Explain required native setup/sign-in and keep
creation, authentication and client opening distinct. **Selected parts** follows
the [profile copy policy](PROFILE-COPY-POLICY.md), which owns transfer eligibility,
preview, transactions and recovery. Preserve source/unselected state; preview or
cancel creates nothing and closes no client. Credentials, generated memory and
conversation state are never copied; profiles evolve independently.

## Task comparison and report

Choose two sides, one task and a repository. Each side selects a profile and
can override the model and reasoning effort for that job. Both sides may use the
same profile. Inspect the pinned
commit, execution order, checks and limits before explicit Start. Each run uses
its own checkout of that commit, excluding uncommitted/untracked/ignored files.
Explain that boundary and possible effects of setup/check commands outside the
checkout. Select no checks automatically; no checks means unverified.

Independent comparisons and report reviews can overlap on the same profile.
Each job keeps its own native session, approval requests, cancellation, progress
and results. Sides run in their recorded order within a comparison. Report
review workspaces are claimed independently of the profile. Treat timings during
overlapping activity as observations from shared conditions.

Show progress, cancellation, failures and partial results, then the report without
manual session-ID reconstruction. Refresh/reconnect must not duplicate model work.
Preserve unrelated profiles, clients, workspaces and original evidence. Show:

- Task/starting state and recorded profile/model/settings differences or unknowns.
- Each response, retained code/artifacts and named checks with their actual results.
- Inspectable session replay, delegation, stable references and missing evidence.
- Supported time/token usage and the limits on quality judgments.

### Session replay direction — 2026-10-29

Keep side-by-side replay with each side's order and actor ownership; invent neither
event matches nor synchronized clocks. Retain available messages/actions/results,
errors, changes and child links; disclose missing timestamps, inaccessible children,
omissions and capture bounds without silently discarding available detail. Show
recorded assistant messages and provider-exposed summaries, never reconstruct
private chain-of-thought. Attribute agent, runner and supplemental checks separately;
completion alone is not correctness. A replay redesign is not required.

Selected existing sessions use the same report. Separate their recorded setup
from today's setup; same-task association is recorded, user-declared or unknown.
A matching title proves neither identical inputs nor follow-ups. Missing historical
source stays unavailable rather than being fetched from today's checkout.

## AI review

From the report, choose a profile/workspace and optional per-review model and effort, then inspect/edit the prompt and supplied
content, then explicitly Start. Use the selected profile's ordinary configuration,
provider connection, permissions and integrations; explain potential model usage.
Show native approval/input requests and accept explicit responses without silently
changing policy. Preparation starts no native/model task or settings/trust edits;
started tasks retain normal native history/authentication/runtime side effects.

Retain exact frozen report inputs, selected profile, actual session/model when
known, progress, failures/cancellation and the captured natural-language response.
Keep the comparison and each other review unchanged. No separate isolation system, forced JSON, invented
score, automatic retry or attachment to the newest unrelated session. The
[review implementation contract](REVIEW-TASK-IMPLEMENTATION.md) owns execution,
storage and recovery details. Ordinary task results are separate from optional
structured external evaluations; exports must accurately disclose what they contain.

The prompt asks for requirement compliance, correctness, verification, citations,
counterevidence and limitations; embedded report instructions are evidence, not
commands. A recommendation is scoped to the task. Lower time/tokens alone is not
better quality; one pair proves neither general superiority, causality nor
consistency. Reviews are attributed interpretations: retain disagreements/revisions
and never silently strip evidence to which a retained review is bound.

## Observable acceptance

Verify these outcomes on a source-bound installable candidate with explicit limits:

| Outcome | Observable done condition |
| --- | --- |
| Create profiles | Use visible controls for empty and selected-parts creation; inspect independent state and setup guidance. Preview/cancel preserves state. |
| Compare a task | Preview/start both runs, follow progress and read results/checks/replay with evidence limits. Cancellation/interruption is truthful and does not duplicate work. |
| Ask for AI review | Start one ordinary task from a report and read its response with exact comparison/profile/session association. Failures are visible; browsing never invokes review. |
| Overlap jobs | Run two comparisons and two report reviews together on one profile with separate selections and workspaces. Verify independent approvals, cancellation, results, restart and mutation exclusion. Verify shared native state separately on a disposable profile. |
| Deliver safely | Required checks and affected regressions pass; the bundled UI works by keyboard and at applicable narrow layouts in both themes. Detached package smoke, preservation, recovery, local web security and export privacy pass. |

Use real Codex evidence for changed launch/result paths and fixtures for failures
and edge cases. Reuse source-applicable native profile/comparison evidence; test
counts or simulations do not prove the whole journey. A fresh coding pair is needed
only if applicable comparison proof is missing, not before implementing review.
By product-owner preference, 200% browser zoom and VoiceOver testing are excluded
from future verification. Do not treat their absence as an acceptance gap or
recurring follow-up item. Uncoached participant studies remain excluded. Required commands
are in the [developer guide](README.md#checkout-and-checks); retained results and
performance limits live in the [release summaries](AUDIT-ACCEPTANCE.md).

## Evidence and privacy contracts

- Discovery is not copying. Show readable setup differences with origin/scope;
  configured, installed, enabled, available, loaded, invoked and followed are
  distinct. Unknown is not identical or absent. Compare skill-package bytes and
  permissions independently of preview limits, including resources/binary assets;
  expose ambiguous ownership/incomplete discovery. Visibility neither broadens
  copy eligibility nor authorizes credential-store inspection/export.
- Use the shared export/reopen pipeline. Normal exports omit recorded bodies;
  explicit inclusion applies redaction/size bounds. Show content before sending
  it to review. Prompts, tool results, code, private paths and artifacts are not
  automatically public. Frozen reports retain included references and limits.
- Time/tokens retain source, scope and accounting semantics; don't sum overlapping
  spans or token subsets. Unsupported totals stay unknown. Repeated evidence keeps
  planned/selected denominators, failures, missing samples and contradictions.
  One pair is consistency-unmeasured; uncertainty limits the affected claims.
  No fixed rubric, complete actor inventory or universal winner is required.

## Evolution and provider version policy

**3.0 permits breaking changes, legacy removal and cleanup. Backward compatibility
and migrations are not requirements.** Remove obsolete paths/formats/adapters and
their obsolete tests; do not retain shims, dual readers/writers or fallbacks merely
for old contracts. Document supported contracts, removals and fresh-start paths.
Leave unsupported old data untouched and explain the limitation; preserving data
does not promise that 3.0 can read/resume/import/undo every older record. Do not
convert, delete or relabel originals automatically. Current-format evidence
integrity, export/reopen, safe mutation and recovery remain required.

Provider/client versions and revisions are provenance, not allowlists. Use supported
protocols, fields, ownership and accounting semantics; unfamiliar versions alone
do not reject profiles/comparisons. Unsupported metrics remain unknown without
blocking supported inspection. Xfx's own versioned report schemas remain valid;
assess existing exact-version guards when relevant rather than extending them.

Profiles bind a client, root and selected installation, never a fixed CLI or
Desktop version/build. Resolve the current installation at each fresh operation
and use observed capabilities instead of a pinned version matrix. An update may
invalidate cached account/catalog observations and require a fresh preview; it
does not invalidate the profile. Keep executable/root identity checks between
preview and execution so a replacement during one prepared action refuses
before effects. Record actual runtime versions in evidence. Locked SDK
dependencies and source-bound historical receipts are separate from profile
admission and remain reproducible.

Reuse existing code and normal local permissions. Containers, VMs, whole-client
isolation and generic recovery platforms are not dependencies. Keep original user
data, raw receipts and published artifact identities intact; full record originals
remain private when summaries are shortened. Live profile/client
operations and model runs need current authorization covering effects and budget;
do not re-request covered steps. Publication and installed updates remain separate.
