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
publication, installed update or Claude/Copilot execution adapter exists yet.

**Execution resumed, 2026-11-10:** the user lifted the execution hold and
authorized coordination through the candidate boundary below. Recorded grants
apply; merge, publication and installed updates still need separate approval.

**Stop condition:** complete A–G and H's pre-merge candidate
preparation, then await user approval for merge, publication and installed
updates. Handle blocked steps under the recorded instructions below.

| Package | Status / chat | Depends on |
| --- | --- | --- |
| A. Protect the work: back up `local/`; push the branch and open a draft pull request so CI runs | Backup, public review and clean smoke passed; both Node 22.15 fixes verified locally; CI rerun pending; package chat (private mapping) | Public-source review before push |
| B. Runtime seam: behaviour lock, then move the Codex app-server transport behind the client runtime interface | Runtime and live approval verified at `04dfdb7`; combined CI pending; package chat (private mapping) | Native dispatch accounting before regression |
| C. Claude Code: account-scope check, profile binding, runtime, catalog, permission modes, decoder, session listing/import, review and minimal Default-pair UI | Per-root scope observed; adapter active; package chat (private mapping) | B runtime checkpoint; account-scope probe first |
| D. Copilot CLI: account-scope check, profile binding, runtime, catalog, permission modes, decoder, session listing/import, review | Shared gh-cli scope observed; adapter active; package chat (private mapping) | B runtime checkpoint; account-scope probe first |
| E1. Profiles: client choice, guided sign-in, account-scope display | Not started | C, D; user-operated per-root account checkpoint |
| E2. Setup readers and setup comparison for Claude Code and Copilot | Implementation verified (65 focused tests); combined-suite gate open; package chat (private mapping) | — |
| E3. Same-client selected-parts copy | Planner/journal/Undo fixture verified; product wiring E1/F; package chat (private mapping) | E2 implementation verified at `fcce9c9`; combined gate open |
| F. Extend C's UI to all clients/managed profiles: supported permission overrides and request queue, mixed pairs, session selection/import, `--surface` rename, notices | Not started | C, D, E1–E3 |
| G. Native qualification through the product path | Not started | C–F; allowances below |
| H. Release 4.0.0: product statement, install-size check, user documentation, release procedure | Not started | G; separate approval for merge, publication and installed updates |

Package chats use `gpt-6.1-sol` with medium reasoning on host `local`.
At most three workers including helpers; C and D hold slots,
with no helper slots assigned. The coordinator owns this status, accounting,
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
Package evidence and chat mapping: private `local/4.0.0/`; no candidate is verified yet.
E2 handoff: `local/4.0.0/package-e2/report.md`; independent focused check passed
65/65. Its in-flight broad run failed (1,550 pass, 26 fail, one skip); stable
combined-source verification remains required.
E3 handoff: `local/4.0.0/package-e3/report.md`; 190 affected fixture tests and
61 independent copy checks passed. Managed product binding remains with E1/F.
Public checkpoint: `c0a793d` on `codex/release-4.0.0`, [draft PR #13](https://github.com/digitalexpression/xenoflux/pull/13). Both initial CI Node versions failed because the offline SDK dependency archive was missing; the fix passed the clean local smoke and reviewed tarballs. Node 24 CI passed. Node 22.15 exposed a dependency `prepare` invocation
under npm pack and a review cleanup test race. Both fixes passed focused tests
on Node 22.15, then integrated with B for the next clean smoke and CI run.
A preserved private evidence and outgoing history, sanitized five historical
summaries and verified source/package privacy. The isolated public worktree
contains no development history or private chat IDs. Never push the development
branch history; integrate only reviewed snapshots onto the public branch.
A evidence: `local/4.0.0/package-a-review/PACKAGE-A-REPORT.md`; public baseline
review under `local/4.0.0/package-a-review/public-baseline/corrected/`. The
source-bound packaging smoke/manifest is in `local/4.0.0/coordinator/public-smoke-c0a793d/`.

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

B and the backup/review in A are active; push and open the
draft pull request after the outgoing public-source review. Run each client's
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
