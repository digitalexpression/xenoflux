# Xenoflux roadmap

**3.1.1 released. Updated 2026-11-09.** This file owns delivery status; the
[goal](AUDIT-GOAL.md) owns behavior and acceptance, and the
[review contract](REVIEW-TASK-IMPLEMENTATION.md) owns execution and persistence.

## Current work and stop condition

**The authorized 3.1.1 release batch is complete.** The
[release record](history/RELEASE-3.1.1.md#published-identity-and-verification) owns tested
source, publication identities, artifact hashes and isolated installation checks.
No further release batch, installed update or live campaign is active.

The [3.1.0 native validation summary](history/NATIVE-VALIDATION-3.1.0.md) records
the observed same-profile concurrency behavior and its limits. Natural signed-token
expiry, exhaustive skill-use capture and escaped-descendant proof remain outside
the established native evidence. Historical grants authorize no new operations.

## Delivery order

No delivery slice is active. Completed releases and their source-bound evidence
are listed in the [acceptance index](AUDIT-ACCEPTANCE.md). Choose the next scope
against the [goal's release boundary](AUDIT-GOAL.md#current-release-boundary).

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
