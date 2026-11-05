# Xenoflux roadmap

**3.0.1 released. Updated 2026-11-05.** This is the active delivery/status
record. The [goal](AUDIT-GOAL.md#current-release-boundary) owns scope and
[acceptance](AUDIT-GOAL.md#observable-acceptance); the
[review specification](REVIEW-TASK-IMPLEMENTATION.md) owns implementation details.

## Current work and stop condition

**The unpublished 3.1.0 candidate is the active delivery slice.**
The user authorized full diff review, package checks and detached installation
smoke preparation. Publication and updates to installed applications remain
pending explicit approval. The [candidate record](RELEASE-3.1.0.md) owns the
resulting verification and artifact status.
The [goal](AUDIT-GOAL.md#observable-acceptance) and
[review contract](REVIEW-TASK-IMPLEMENTATION.md) define the scope. The
checkout passed the four-job fixture, cross-controller ownership checks and
bundled browser suite. The [native validation record](SAME-PROFILE-NATIVE-VALIDATION.md)
retains the stopped model-selection preflight, partial eight-turn campaign and
successful separately authorized five-turn campaign. Four native model jobs
shared one home with Desktop and reached approval together. Cancelling one
comparison preserved the other three jobs; both sides of the surviving comparison
executed and both reviews completed. Results reopened without new model work.
Owned processes and disposable credentials/profile/workspaces were cleaned up.
The comparison retains partial exhaustive-capture status. A subsequent three-turn
native campaign verified cached-token refresh after an injected expired/invalid
access token and live coordinator SIGKILL recovery for a comparison and review,
while an independent review completed. Reopening preserved live ownership as
uncertain, then recovered stopped work without replay. Natural signed-token
expiry and escaped-descendant proof remain outside the native evidence.
Native-discovered ownership/error-reporting fixes are
implemented. Candidate review corrected the cross-controller Desktop journal
lookup and sanitized the public validation summary while preserving its original
privately. Final candidate verification passed with 1,363 unit tests, one
opt-in native test skipped, and 48 browser tests. The candidate record preserves
the initial environment-dependent failures and the complete passing reruns.
Publication and installed
updates require a separate grant.

The approved 3.0.1 release batch is complete.
The [3.0.1 record](RELEASE-3.0.1.md#published-identity-and-verification) binds
merged source, published npm/GitHub artifacts, passing public CI and isolated
installation verification. It also preserves the original failed CI outcome,
the controlled replay-focus regression and native acceptance limits.

The [3.0.0 record](RELEASE-3.0.0.md#published-identity-and-verification) owns
that release's publication and acceptance evidence. A separately authorized
[managed-installation update](RELEASE-3.0.0.md#separate-managed-installation-verification)
to 3.0.0 and read-only browser verification are complete. The 3.0.1 release batch
did not update an existing installed app or run a new model/profile/client task.
Published tags, assets, earlier failed outcomes and original receipts retain
their source identities.

## Delivery order

The 3.0.0 feature sequence and subsequent 3.0.1 hotfix are complete:

| Slice | Delivered behavior | Evidence owner |
| --- | --- | --- |
| A–B: native execution and durable review tasks/API | Selected-profile settings, native requests, exact session association, single Start, frozen inputs, cancellation and recovery. | [Review contract](REVIEW-TASK-IMPLEMENTATION.md) and [3.0.0 verification](RELEASE-3.0.0.md#integrated-development-verification). |
| C–D: Reviews UI and legacy removal | Report-to-review flow, captured responses and citations, labelled demo and removal of the retired isolated reviewer campaign. | [3.0.0 acceptance and limits](RELEASE-3.0.0.md#retained-verification-and-limits). |
| E: verification and release | Source/package parity, bundled UI, required checks, detached smoke, stable publication and isolated installed-package verification. | [3.0.0 closeout](RELEASE-3.0.0.md#published-identity-and-verification). |
| 3.0.1 hotfix | Managed copier includes bundled UI; replay keyboard-open focus follows the dialog mount lifecycle. | [3.0.1 release record](RELEASE-3.0.1.md). |

Candidate preparation is authorized for 3.1.0. Publication and installed updates
remain pending approval; this checkpoint and historical grants provide no
additional operational authorization.

## Verification and release gates

For future changes, run the affected checks and required final checks from the
[developer guide](README.md#checkout-and-checks). Rebuild bundled UI when its
source changes and run browser suites sequentially. Documentation-only closeout
requires packed-document membership/link checks and review of the public text.

Reuse evidence only where source and behavior still apply. The
[goal's acceptance contract](AUDIT-GOAL.md#observable-acceptance) and
[3.0.0 evidence limits](RELEASE-3.0.0.md#retained-verification-and-limits) remain
applicable; fixtures do not establish unobserved native behavior. Follow the
[release procedure](LOCAL-RELEASE.md) for source/package review, checksums and
detached smoke. New publication, installed updates and live operations require
current authorization covering their effects.

## Branch cleanup and historical records

`main` contains the released application and reconciled public release records.
The private `ui/implementation` history is archived locally as a self-contained
Git bundle with a checksum and verified restore. Its branch name is retired;
private history is not merged into public source. Candidate worktrees retain
their exact detached commits, and release tags and raw evidence are preserved.
The archive manifest records the original development head and restore command.

Historical development plans and operational receipts remain private. The
[2.1.0 roadmap](ROADMAP-2.1.0-HISTORY.md) and
[capability assessment](PROFILE-AUDIT-ASSESSMENT.md) remain historical references.
