# Xenoflux roadmap

**3.1.1 released. Updated 2026-11-11.** This file owns delivery status; the
[goal](AUDIT-GOAL.md) owns behavior and acceptance, and the
[review contract](REVIEW-TASK-IMPLEMENTATION.md) owns execution and persistence.

## Current work and stop condition

**Active: release 4.0.0 — Codex, Claude Code and Copilot CLI.** The
[goal](AUDIT-GOAL.md#planned-multi-client-scope) owns the product decisions of
2026-11-10; the [plan](CLIENT-SUPPORT-PLAN.md#delivery-sequence-and-acceptance)
owns package contents and checks. 3.1.1 remains the latest release
([record](history/RELEASE-3.1.1.md#published-identity-and-verification)). No
publication or installed update is authorized. Adapter and qualification status
is below; no 4.0.0 candidate is verified.

**Execution resumed, 2026-11-10:** the user lifted the execution hold and
authorized coordination through the candidate boundary below. Recorded grants
apply; merge, publication and installed updates still need separate approval.

**Stop condition:** complete A–G and H's pre-merge candidate
preparation, then await user approval for merge, publication and installed
updates. Handle blocked steps under the recorded instructions below.

| Package | Status / chat | Depends on |
| --- | --- | --- |
| A. Protect the work: back up `local/`; push the branch and open a draft pull request so CI runs | Complete: backup, public review, smoke and both CI jobs passed; package chat (private mapping) | Public-source review before push |
| B. Runtime seam: behaviour lock, then move the Codex app-server transport behind the client runtime interface | Complete: runtime and live approval verified; integrated CI passed; package chat (private mapping) | Native dispatch accounting before regression |
| C. Claude Code: account-scope check, profile binding, runtime, catalog, permission modes, decoder, session listing/import, review and minimal Default-pair UI | Per-root scope and mixed Default journey verified; integrated `e432a2c`; package chat (private mapping) | B runtime checkpoint; account-scope probe first |
| D. Copilot CLI: account-scope check, profile binding, runtime, catalog, permission modes, decoder, session listing/import, review | Shared scope and controller fixtures verified; pre-session shutdown fix `48f9e0b` integrated; package chat (private mapping) | B runtime checkpoint; G stopped capture evidence |
| E1. Profiles: client choice, guided sign-in, account-scope display | Copilot scope verified; managed comparison binding fix `f949407` integrated; Claude sign-in pending; package chat (private mapping) | C/D verified; user-operated per-root account checkpoint |
| E2. Setup readers and setup comparison for Claude Code and Copilot | Reader fixtures and combined CI verified; F owns full setup comparison UI; package chat (private mapping) | — |
| E3. Same-client selected-parts copy | Planner/journal/Undo and E1 product creation verified; F owns full setup application UI; package chat (private mapping) | E2 implementation verified at `fcce9c9` |
| F. Extend C's UI to all clients/managed profiles: supported permission overrides and request queue, mixed pairs, session selection/import, `--surface` rename, notices | Six pairs and combined checks passed at `35e8c35`; workspace fix `743f8e9` passed affected checks; CI fixture correction `dfb3729`; package chat (private mapping) | C, D, E1–E3 implementation; E1 Claude live gate stays open |
| G. Native qualification through the product path | Copilot shared account, Auto catalogs and managed list passed; first capture stopped before send and retains both owners. Codex offline probe unavailable; zero G prompts; package chat (private mapping) | C–F; safe capture recovery/readiness and separate Claude gate |
| H. Release 4.0.0: product statement, install-size check, user documentation, release procedure | Not started | G; separate approval for merge, publication and installed updates |

Package chats use `gpt-6.1-sol` with medium reasoning on host `local`.
At most three workers including helpers. G's metadata fixture helper slots
were released after handoff.
The coordinator owns this status, accounting,
integration, commits, pushes, draft PR and CI. Browser/build output has one writer.
B evidence: `local/4.0.0/package-b/HANDOFF.md`; 1,602 Node tests passed,
one opt-in skip, and 69 browser journeys on the integrated B public source
(`923f5e0`; `local/4.0.0/coordinator/public-b-browser.log`). The first native turn
used Codex automatic review; no user approval RPC reached Xenoflux. A corrected
user-review comparison then passed two exact approvals and stale-answer 409s,
with unchanged live registry and zero remaining owners. A pre-dispatch settings
proof refusal consumed zero. Raw receipts stay in `native/` and
`native-user-reviewer/` under that evidence directory.
C and D use isolated worktrees at `04dfdb7`. Their zero-prompt account checks
observed Claude per-root (stock signed in; empty and stock-identical explicit
roots signed out) and Copilot shared `gh-cli` (same account in stock/empty roots).
Evidence: `local/4.0.0/package-c/account-scope.receipt.json` and
`local/4.0.0/package-d/account-scope-retry.json`; D's first guard refusal remains
retained. Second-root and distinct-account checks are separate.
C checkpoint: `local/4.0.0/package-c/report.md`; 119 focused and five
rebuilt-browser checks passed, including Codex versus Claude Default through
preview, Start and retained report; 12 additional combined-source checks
passed. The combined Node 22.15 suite on `e432a2c` passed 1,626 tests with
one opt-in skip (`local/4.0.0/coordinator/combined-c-node22.log`).
Managed comparison binding/reservation is
a combined integration gate. D checkpoint: `local/4.0.0/package-d/integration-report.md`; 170 final
source-bound tests and five independent combined controller checks passed.
Earlier client-specific results remain in `package-d/report.md`. Persistent
profile creation/current account scope go to E1, full UI to F, live to G.
E1 fixture handoff: `local/4.0.0/package-e1/report.md`; 187 Node checks, 10
Chromium journeys and two independent Store/API checks passed. E1 prepared
two disposable Claude profiles through the product. Stock was
signed in and both managed roots signed out; zero model prompts. The user
operates native sign-in and target-only sign-out/re-sign-in. Private stage
commands and receipts: `local/4.0.0/package-e1/`. Copilot creation first
refused the installed version banner; the parser fix is `85c0ad1`. The first
post-fix status read reported shared gh-cli scope with confirmed shutdown,
then the empty-root state-creation guard stopped before the second check. A
separate bounded second-root initialization passed. A fresh product controller
verified the same shared gh-cli account for both managed roots and stock,
with four joined processes, unchanged guarded state and zero model prompts.
Receipts: `copilot-initialize-second-receipt.json` and
`copilot-verify-both-receipt.json` under `package-e1/`; both earlier refusals
remain private. Separate-account independence is unverified.
Package evidence: private `local/4.0.0/`; no candidate is verified yet.
E2 handoff: `local/4.0.0/package-e2/report.md`; independent focused check passed
65/65. Its in-flight broad run failed (1,550 pass, 26 fail, one skip); both CI
versions passed the stable combined source at `a905b04`.
E3 handoff: `local/4.0.0/package-e3/report.md`; 190 affected fixture tests and
61 independent copy checks passed. Managed product binding remains with E1/F.
F handoff: `local/4.0.0/package-f/report.md`; 49 final focused Node checks and
nine Chromium journeys passed. All six pairs ran pinned checks and reopened
with distinct provenance. Broad runs preserved a catalog promise identity
failure (269 passed) and a browser refusal-heading failure (39 passed); the
final focused runs covered both corrections. The verified 42-path handoff is
integrated at `35e8c35`; syntax, native launcher, docs and combined Node 22.15
passed (1,645 pass, one opt-in skip). All 73 local Chromium journeys passed;
the browser step passed on both CI versions at `0b41549`. Combined evidence:
`local/4.0.0/coordinator/combined-f-35e8c35.log`. No native prompts were used.
G's offline replay refused 13 forbidden frames. The first bounded catalog
attempt lacked `gh` on the private PATH. The pinned helper retry reached the
expected response size but the paired stock check returned 422 before launch.
Inert SDK workers reproduced the private wrapper's duplicate directory creation
refusal. A corrected private guard verified the same empty read-only directory
for the paired launches. Both initialized roots then reported the shared gh-cli
account and Auto `balance` with no explicit models, with six joined launches,
unchanged protected metadata and zero prompts. Original and passing receipts
are `copilot-catalog-{1,2,3}-live-receipt.json` under `local/4.0.0/package-g/`.
The managed Copilot list guard initially refused the native user home as cwd.
F's canonical workspace fix passed 25 combined Node and five Chromium checks
at `743f8e9`, including changed, foreign and missing binding refusals. G then
listed both owned roots at `dfb3729` (empty lists, six joined launches, no
prompt or state change). Evidence: `local/4.0.0/package-g/managed-list-helper/`.
The first P1 Start reached a legitimate reservation refusal: the managed
comparison path inherited metadata-only routing and supplied the native home
instead of the bound repository. No capture or model prompt started and both
profile locks were absent. E1's `f949407` fix sets execution mode explicitly;
95 focused fixtures passed, including exact owned reservations through the
real controller and an unbound repository refusal. The re-pinned G comparison
reserved the exact repository and started one capture. The worker joined,
but the product retained both reservations after a pre-session assertion.
The first root gained opaque native metadata; the preservation guard failed.
Zero prompts were sent. D reproduced the missing-session callback losing the
joined result, then fixed it for future runs. The 100-test suite proved joined
failures release their own reservation and unjoined failures preserve it.
Keep both original reservations and their evidence intact: the native cause
is still unknown. The retry's receipt and derived evidence are under
`local/4.0.0/package-g/copilot-p1-route-1-failure-source/` and
`copilot-p1-route-live-1.json`; D's fixture evidence is
`local/4.0.0/package-d/shutdown-followup.md`.
Evidence: `local/4.0.0/package-g/copilot-p1-1-failure-source/` and
`local/4.0.0/package-e1/managed-execution-route/`. The separate Codex catalog
probe exited after initialize under verified host write confinement. The
owned process joined; zero prompts, no account or model response. The cause
is unverified, so that route remains stopped. Receipt:
`local/4.0.0/package-g/codex-logging-helper/codex-owned-catalog-live-1.json`.
Node 22.15 CI at `0b41549` timed out waiting for four approvals;
Node 24 passed. The fixture correction observes each startup before asserting
all four are live with distinct approvals, keeping the original guards and
timeout. Focused tests and both new CI jobs passed. Evidence:
`local/4.0.0/package-f/node22-overlap/`.
Public checkpoint: `6cc19ca` on `codex/release-4.0.0`, [draft PR #13](https://github.com/digitalexpression/xenoflux/pull/13). The resolver fix passed 29 combined Node checks, three Chromium journeys, detached smoke and review of all 22 outgoing commits and both archives; [CI](https://github.com/digitalexpression/xenoflux/actions/runs/42941910324) is running. The preceding workspace and overlap corrections at `30dea07` passed smoke, boundary review and [both CI versions](https://github.com/digitalexpression/xenoflux/actions/runs/42938481538). The F checkpoint `0b41549` passed smoke and public review; [Node 24 CI passed](https://github.com/digitalexpression/xenoflux/actions/runs/42935031540) and the Node 22.15 overlap timeout is recorded above. The Copilot version fix `4012ab6` passed five focused checks, detached smoke, public review and [both CI versions](https://github.com/digitalexpression/xenoflux/actions/runs/42932990396). Both initial CI Node versions failed because the offline SDK dependency archive was missing; the fix passed the clean local smoke and reviewed tarballs. Node 24 CI passed. Node 22.15 exposed a dependency `prepare` invocation
under npm pack and a review cleanup test race. Both fixes passed focused tests
on Node 22.15. The combined clean smoke passed, both tarballs and eight
outgoing commits passed review, and [CI on `d48cf23`](https://github.com/digitalexpression/xenoflux/actions/runs/42922350523)
passed on Node 22.15.0 and 24, including detached smoke. The reviewed `3ae28bc`
adds Claude Default and Copilot client-specific code; its clean smoke and
[both CI jobs](https://github.com/digitalexpression/xenoflux/actions/runs/42925288706)
passed. The Copilot controller checkpoint `271bfb9` passed clean smoke and
public-source review and [both CI jobs](https://github.com/digitalexpression/xenoflux/actions/runs/42927049945).
The E1 implementation checkpoint `a905b04` passed source review and detached
smoke and [both CI jobs](https://github.com/digitalexpression/xenoflux/actions/runs/42930217327).
Its user-operated native account gate remains open.
A preserved private evidence and outgoing history, sanitized five historical
summaries and verified source/package privacy. The isolated public worktree
contains no development history or private chat IDs. Never push the development
branch history; integrate only reviewed snapshots onto the public branch.
A evidence: `local/4.0.0/package-a-review/PACKAGE-A-REPORT.md`; public baseline
review under `local/4.0.0/package-a-review/public-baseline/corrected/`. The
source-bound Node 22 smoke manifests are under
`local/4.0.0/coordinator/public-smoke-d48cf23/`, `public-smoke-3ae28bc/`
`public-smoke-271bfb9/`, `public-smoke-a905b04/`, `public-smoke-4012ab6/`
`public-smoke-0b41549/`, `public-smoke-30dea07/` and `public-smoke-6cc19ca/`.
Boundary reviews: `local/4.0.0/package-a-review/{0b41549,30dea07,6cc19ca}/`.

B's extraction, E2 and the fixture-driven parts of C and D need no account,
sign-in or prompt; B's native regression uses its recorded allowance.
The account-scope checks are zero-prompt and run before each adapter is built.
First demo point: after C, a Codex versus Claude Default comparison runs end to
end through the UI in fixtures.

### Current-account evidence

Private harness results on the existing accounts; they inform the adapters and
do not qualify the product path. The [follow-up record](history/CLIENT-FOLLOWUP-2026-11-10.md)
and [route record](history/CLIENT-ROUTES-2026-11-10.md) own outcomes, failed
controls and limits; the [development record](history/MULTI-CLIENT-2026-11-10.md)
owns the product checks for what is already built.

| Capability | Claude Code CLI 2.1.319, SDK 0.3.322 | Copilot CLI 1.0.107, SDK 1.0.29 |
| --- | --- | --- |
| Zero-prompt initialization and sign-in status | Passed; Pro | Passed; implicit `gh-cli`, plan unknown |
| Model catalog | 13 entries, sparse effort metadata | Auto routing only; no explicit models offered |
| Task with exact approval | Passed | Passed; two native handles (path, commands) per action |
| Cancel while a permission is pending | Passed | Passed |
| Cancel a running tool while a companion survives and completes | Passed | Passed after one scoped retry |
| Concurrent jobs with different settings | Two models ran together; applied effort unknown | Not selectable on an Auto-only catalog (inferred, untested) |
| Restart leaves the job interrupted | Not run | Not run |
| Account scope on an empty managed root | Not run; per-root expected | Not run; shared `gh-cli` login expected |
| Second profile root signed into the same account | Not run | Not run |
| Stored conversation import, export and reopen | Built; passed | Built; passed |

### Recorded user instructions, 2026-11-10

The user's instruction is the authority and can be withdrawn; this file only
records it. The user lifted the hold on 2026-11-10; these standing grants
now apply within the stated boundaries.

- **Development and checkpoints:** execute the current 4.0.0 plan through a
  verified release candidate: implement, fix regressions, update documentation
  and pinned dependencies, run required checks, build packages and commit
  completed checkpoints without a new grant for each package.
- **GitHub and CI:** push reviewed public-safe branches to
  `digitalexpression/xenoflux`, create/update the draft pull request, monitor CI,
  fix failures and rerun affected checks. Review the entire outgoing history
  under the [public-source procedure](LOCAL-RELEASE.md#public-source-and-package-boundary)
  before pushing; preserve private evidence and existing shared history.
- **Private backups:** back up `local/` and `docs/knowledge/` with a verified
  hash manifest into the sibling `../xenoflux-private/4.0.0/` directory outside
  this checkout. Keep the backup private and preserve source evidence.
- **Qualification resources:** create named disposable profiles/workspaces,
  seed harmless setup, exercise copy/Undo, launch and restart owned controllers,
  cancel owned jobs and remove owned scratch data after preserving evidence.
  Preserve unrelated clients and user data; native authentication remains
  governed by the account checkpoint below.
- **Delegation:** use up to three subagents for independent implementation and
  review with explicit file ownership and the same authorization boundaries.
  All native qualification prompts consume the shared allowances below.
- **Blocked steps:** stop the affected operation and retain evidence when a
  safety guard trips, a recorded allowance is exhausted or a step needs an
  uncovered effect or user participation. Continue independent authorized work
  while the affected step waits. Fix and verify a guard failure's cause before
  a new bounded attempt; never weaken the guard or release uncertain ownership
  to proceed. Necessary prompt-cap increases follow the rule below.

- **Claude and Copilot allowance:** 40 combined initial prompts for the updated
  package G checks, at most four per batch, without a fresh grant per batch.
  **Used: 0.**
  Each task keeps 180 seconds and 8 MiB combined native output, a disposable
  repository, exact approve-once answers, Claude Haiku or Sonnet at low effort
  and Copilot Auto. Zero-prompt catalog refresh, sign-in status, session listing
  and selected-session reads/imports are covered.
- **Codex allowance:** a separate 10 initial prompts with the same per-batch and
  per-task limits and the lowest-cost model and effort, for the native regression
  after package B, the Codex sides of mixed pairs and the Codex-only pair with
  different permission modes. **Used: 3.** B reported 113,056 tokens, including 88,576
  cached input, across the stopped control and passing two-side follow-up.
- **Permission tests:** temporary per-job non-bypass overrides are covered,
  including Codex read-only/workspace-write and Claude accept-edits on disposable
  test files. The selected native mode may allow edits without individual
  approval prompts; Xenoflux never answers a native request automatically.
  Persistent policy changes remain excluded.
- **Account checkpoint:** the user signs into additional per-root profiles in
  the native client. After a zero-prompt probe establishes a per-root route, the
  user also performs native sign-out/re-sign-in on a disposable qualification
  root. Check stock and companion sign-in state before and after; their
  independence is the test's outcome, not a prerequisite assumed to have passed.
  Never deliberately sign out a shared route. Other account changes remain
  excluded; E1/G wait for the user-operated step when it is due.
- **Necessary prompt-cap increases:** the user authorizes increases if needed
  to complete these B/G checks. Retain the current caps while the allocation
  below fits. Before dispatch beyond either recorded cap, document the remaining
  checks, observed shortfall and a finite revised cap here, preserving used
  counts and receipts. Keep every other limit and the same acceptance scope;
  this does not reopen exhausted historical cohorts or authorize new campaigns.
- **Separate user approval required:** merge; publication; installed updates.

Count every dispatched initial prompt, including failed and cancelled attempts.
Each comparison side and each review consumes one; native turns within that
submission are not additional initial prompts. Prompt counts bound neither tokens
nor billed cost. Each batch adds the usage its client reported next to the used
count above.

### Qualification prompt allocation

This includes B and G together. The current caps cover the planned checks with
remaining allowance; no increase is needed at this checkpoint.

| Work | Claude + Copilot | Codex |
| --- | ---: | ---: |
| B: native runtime regression | 0 | 4 |
| G: same-client comparisons | 4 | 0 |
| G: pending cancellation with surviving comparison | 8 | 0 |
| G: running cancellation with surviving comparison | 8 | 0 |
| G: completed reviews and controller-interrupted reviews | 4 | 0 |
| G: second-root and copied-setup loading checks | 4 | 0 |
| G: three mixed-client pairs | 4 | 2 |
| G: Codex permission-mode pair | 0 | 2 |
| **Planned total** | **32** | **8** |
| **Remaining allowance** | **8** | **2** |
| **Current cap** | **40** | **10** |

Reuse these tasks for exact approvals, queued requests, supported permission
overrides and harmless setup markers. Catalog/session discovery and import/export
checks submit no prompts. This is an allocation, not evidence that checks passed;
any necessary additional attempts count against the remaining or revised cap.

## Delivery order

Run B and the backup/review in A first. Push and open the draft pull request
after the outgoing public-source review. Run each client's
zero-prompt account-scope check before C and D, which follow B in either order
and are built against sanitized captured native streams before spending prompts.
E2 can proceed alongside B. E1, E3 and F complete the journey, G qualifies it
natively and H prepares the release candidate. Merge, publication and installed
updates wait for separate user approval. The four earlier stopped-cohort
allowances stay exhausted and their receipts unchanged.

Later scope, in no committed order: the detached job host for reattaching after
a restart (planned for 4.1); distinct-account isolation; cross-client copy;
managed desktop profiles, exact-session handoff and automation; Claude Chat and
Cowork import, which still lack a supported conversation source; API keys and
custom connections; ACP as a Copilot transport. Prepared, non-executable
proposals for these remain private under `local/` and grant nothing.

Previous Codex [capture](history/CODEX-QUALIFICATION-2026-11-09.md) and
[approval-stop](history/CODEX-APPROVAL-QUALIFICATION-2026-11-09.md) records are
historical observations. Completed releases remain in the
[acceptance index](AUDIT-ACCEPTANCE.md).

## Verification and release gates

Run affected and required final checks from the [developer guide](README.md#checkout-and-checks).
Rebuild bundled UI after source changes and run browser suites sequentially.
Documentation changes require packed-document membership, local-link checks and
public-text review. Follow the [release procedure](LOCAL-RELEASE.md) for packaging.

Reuse evidence only where source and behavior still apply; fixtures do not prove
unobserved native behavior. Publication, installed updates and live operations
require current authorization covering their effects.

## Historical records

Published records, tags, artifacts and original receipts retain their identities.
Private history, branch-cleanup manifests and recovery bundles remain preserved
outside public source. The [historical assessments and plans](../README.md#historical-references)
are references, not current work or additional release gates.
