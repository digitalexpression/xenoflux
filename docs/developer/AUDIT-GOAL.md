# Xenoflux UI release: shared product goal

Goal ID: `XFX-AUDIT`. This file owns product behavior and acceptance. The
[roadmap](ROADMAP.md) owns current status and delivery order; user instructions
determine authorization. A goal or historical grant does not authorize operations.

## Current release boundary

Deliver **3.0.0**, a major release of the locally bundled browser UI for **Codex
on macOS**, launched with `xfx ui`. Users can:

1. Create an empty profile or one from selected supported parts of another.
2. Run the same task on two profiles and read the comparison report.
3. Request an ordinary AI review of that report and read a task-scoped preference,
   tie or inconclusive judgment in the UI.

**Create → compare → read report → optionally request review → read response.**
Review is optional for users but required as a product capability. Normal use
requires neither a development server, authored JSON nor manual transfer to an AI.
CLI-backed execution is sufficient; a separate Desktop runner, fresh direct-client
tasks and repetition campaigns are not prerequisites. Existing capabilities may
be retained or simplified; they do not expand these three outcomes. Additional
providers, benchmark/cohort builders, generic config editing and desktop-shell
packaging are outside this release.

## Profile creation

**Empty** copies no setup; minimal management files are allowed. It does not mean
authenticated or model-ready. Explain required native setup/sign-in and keep
creation, authentication and client opening distinct. **Selected parts** follows
the [profile copy policy](PROFILE-COPY-POLICY.md), which owns transfer eligibility,
preview, transactions and recovery. Preserve source/unselected state; preview or
cancel creates nothing and closes no client. Credentials, generated memory and
conversation state are never copied; profiles evolve independently.

## Task comparison and report

Choose two distinct profiles, one task and a repository; inspect the pinned
commit, execution order, checks and limits before explicit Start. Each run uses
its own checkout of that commit, excluding uncommitted/untracked/ignored files.
Explain that boundary and possible effects of setup/check commands outside the
checkout. Select no checks automatically; no checks means unverified.

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

From the report, choose a profile/workspace, inspect/edit the prompt and supplied
content, then explicitly Start. Use the selected profile's ordinary configuration,
provider connection, permissions and integrations; explain potential model usage.
Show native approval/input requests and accept explicit responses without silently
changing policy. Preparation starts no native/model task or settings/trust edits;
started tasks retain normal native history/authentication/runtime side effects.

Retain exact frozen report inputs, selected profile, actual session/model when
known, progress, failures/cancellation and the captured natural-language response.
Keep the comparison unchanged. No separate isolation system, forced JSON, invented
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
| Deliver safely | Required checks and affected regressions pass; the bundled UI works by keyboard, at applicable narrow layouts and 200% zoom in both themes. Detached package smoke, preservation, recovery, local web security and export privacy pass. |

Use real Codex evidence for changed launch/result paths and fixtures for failures
and edge cases. Reuse source-applicable native profile/comparison evidence; test
counts or simulations do not prove the whole journey. A fresh coding pair is needed
only if applicable comparison proof is missing, not before implementing review.
VoiceOver and uncoached participant studies remain excluded. Required commands
are in the [developer guide](README.md#checkout-and-checks); retained results and
performance limits live in the [candidate record](RELEASE-3.0.0.md).

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

Reuse existing code and normal local permissions. Containers, VMs, whole-client
isolation and generic recovery platforms are not dependencies. Keep original user
data, published records and old artifact identities intact. Live profile/client
operations and model runs need current authorization covering effects and budget;
do not re-request covered steps. Publication and installed updates remain separate.
