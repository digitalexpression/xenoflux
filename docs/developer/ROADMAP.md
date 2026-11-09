# Xenoflux roadmap

**3.1.1 released. Updated 2026-11-09.** This is the active delivery/status
record. The [goal](AUDIT-GOAL.md#current-release-boundary) owns scope and
[acceptance](AUDIT-GOAL.md#observable-acceptance); the
[review specification](REVIEW-TASK-IMPLEMENTATION.md) owns implementation details.

## Current work and stop condition

**The authorized 3.1.1 release batch is complete.** The
[release record](RELEASE-3.1.1.md#published-identity-and-verification) owns the
CI-tested head, merged source, npm/latest and stable GitHub release, asset hashes,
public artifact verification and isolated install/uninstall result. All eleven
audit corrections and the CI-discovered replay focus correction are included.
Both public macOS jobs passed on Node 22.15 and 24. The record preserves the first
failed CI run and controlled focus regression separately from the passing runs.

Public source history starts from public main. Knowledge files and private
commits remain excluded; local notes are untracked, ignored and preserved.
Source, tags and assets retain their original identities. No existing installed
application or live Codex state was changed.

**The authorized 3.1.0 release batch is complete.** The
[3.1.0 record](RELEASE-3.1.0.md#published-identity-and-verification) binds the
CI-tested head, merged source, npm/latest and stable GitHub release, artifact
checksums and detached installation smoke. It preserves the first public replay
focus failure and the full passing rerun on Node 22.15 and 24. Publication and
public artifact verification are complete; existing installed updates remain
pending explicit user approval.

The [goal](AUDIT-GOAL.md#observable-acceptance) and
[review contract](REVIEW-TASK-IMPLEMENTATION.md) own the delivered same-profile
multi-job behavior. The [native validation summary](SAME-PROFILE-NATIVE-VALIDATION.md)
owns its source-applicable native observations and limits. Natural signed-token
expiry, exhaustive skill-use capture and escaped-descendant proof remain outside
the established native evidence. No additional release or live campaign is active.

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

The UI release sequence, 3.0.1 hotfix and 3.1.0 concurrency batch are complete:

| Slice | Delivered behavior | Evidence owner |
| --- | --- | --- |
| A–B: native execution and durable review tasks/API | Selected-profile settings, native requests, exact session association, single Start, frozen inputs, cancellation and recovery. | [Review contract](REVIEW-TASK-IMPLEMENTATION.md) and [3.0.0 verification](RELEASE-3.0.0.md#integrated-development-verification). |
| C–D: Reviews UI and legacy removal | Report-to-review flow, captured responses and citations, labelled demo and removal of the retired isolated reviewer campaign. | [3.0.0 acceptance and limits](RELEASE-3.0.0.md#retained-verification-and-limits). |
| E: verification and release | Source/package parity, bundled UI, required checks, detached smoke, stable publication and isolated installed-package verification. | [3.0.0 closeout](RELEASE-3.0.0.md#published-identity-and-verification). |
| 3.1.1 | Audit reliability/privacy corrections, regression coverage and deferred replay focus repair. | [3.1.1 release record](RELEASE-3.1.1.md). |
| 3.1.0 | Concurrent same-profile comparisons/reviews, per-job execution settings, independent native controls, signed-vendor shortcuts and guarded recovery. | [3.1.0 release record](RELEASE-3.1.0.md). |
| 3.0.1 hotfix | Managed copier includes bundled UI; replay keyboard-open focus follows the dialog mount lifecycle. | [3.0.1 release record](RELEASE-3.0.1.md). |

The 3.1.1 publication and verification are complete. No further release batch or
installed update is active; this checkpoint and historical grants provide no
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
