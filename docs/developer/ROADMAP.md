# Xenoflux 3.0 roadmap

This roadmap tracks the **3.0.0** release. The [goal](AUDIT-GOAL.md#current-release-boundary)
owns product scope and [acceptance](AUDIT-GOAL.md#observable-acceptance); the
[review specification](REVIEW-TASK-IMPLEMENTATION.md) owns execution details.

## Current work and stop condition

The three product outcomes are implemented: create profiles, compare two
profiles on a task and inspect the report, then optionally request and read an
ordinary AI review. Reviews use the selected profile's normal configuration and
retain exact inputs, progress and the captured response. Legacy campaign paths
selected for removal are gone. See the [review acceptance record](RELEASE-3.0.0.md#ordinary-review-live-attempt)
and [coexistence evidence](RELEASE-3.0.0.md#reviewerdesktop-coexistence-correction).

| Outcome | Development evidence | Candidate binding |
| --- | --- | --- |
| Empty and selected-parts profile creation | Retained native creation/copy acceptance; current fixture and browser checks. | Core creation/copy source is unchanged; exact package identity belongs to the manifest. |
| Task comparison and report | Retained native CLI/report evidence plus current fixture and browser checks; known scope limits are preserved. | Source applicability reviewed; candidate checks pass within the recorded limits. |
| Ordinary AI review | Fixture and browser coverage; one corrected live review completed and reopened with its response associated to the task. | Unchanged native execution/capture and scoped publication/browser checks supplement retained native evidence. |

Initial candidate source checks passed: syntax, native launcher, packaged documentation
links, 1,347 engine tests (one skipped) and all 47 browser journeys. The 203
application, UI and build-input files matched the initial development source
byte-for-byte. A later replay correction updates disclosure state handling and
its browser focus precondition. The following record publication correction
removes an event-loop scheduling window in one store module, while keeping
native execution/capture and record formats unchanged. The [candidate record](RELEASE-3.0.0.md#candidate-verification)
separates these results from inherited native evidence. The generated release
manifest identifies the packaged revision, artifact hashes and detached smoke
outcome; only a passed smoke result completes the package gate.

After the replay and publication corrections, full local verification passed
1,348 engine tests (one skipped) and all 47 browser journeys, plus syntax,
native launcher, packaged docs and UI types/tokens/build freshness. The initial
failed CI outcomes remain retained; the corrected head must pass fresh CI.
Exact-runtime boundary verification additionally passed complete engine suites
on Node 22.15.0 and Node 24.22.1 (1,348 passes / one skip each), and all 47
browser journeys under Node 24 after enforcing child-discovery bounds in the
calling iterator and correcting compressed/shutdown fixture assumptions.

A subsequent Node 22 fixture failure narrowed the remaining record handoff to
mutable state. An exact-runtime probe demonstrated a stale pre-open snapshot
of an already-unlinked inode while the path held a different safe replacement.
The reader now retries only after independently validating that replacement,
within its existing bound. A deterministic regression passes on both runtimes
and rejects an unsafe replacement; see the
[state snapshot correction](RELEASE-3.0.0.md#state-snapshot-handoff).

After the state snapshot correction, complete local engine suites pass on exact
Node 22.15.0 and 24.22.1 (1,349 passes / one skip each), and all 47 browser
journeys pass under Node 24. Syntax, native launcher, packaged documentation and
UI type/token/build-freshness checks pass.

Stable source preparation aligns the package and lockfile roots to `3.0.0` and
updates current-release documentation. Application, UI and native-build inputs
are unchanged from the verified `3.0.0-rc.1` source. Earlier candidate receipts
retain their original identities; the final manifest and public release metadata
identify the exact stable source and artifacts.

### Delivery order

Slices A–D are complete: selected-profile execution, durable review tasks and
API, Reviews UI and demo, and removal of the retired campaign implementation.
The [implementation contract](REVIEW-TASK-IMPLEMENTATION.md) documents these
behaviors and safeguards.

Slice E completes the candidate. It is done when package and lockfile versions
agree, the bundled UI matches its source, required checks pass, the sanitized
package contents are reviewed, detached offline smoke passes, and the candidate
record binds evidence and artifact hashes to one exact source revision. The
candidate record distinguishes inherited development evidence from the completed
candidate source checks. Exact package identity and smoke results travel with the
generated release manifest.

### Verification and release gates

- Run `npm run check`, `npm run check:native`, `npm run check:docs`, `npm test`
  and `npm run check:ui` for the candidate. Rebuild `dist/ui` after UI changes;
  run browser checks sequentially. The [developer guide](README.md#checkout-and-checks)
  describes these checks.
- Reuse evidence where source and behavior still apply. Reopen a passed case
  when a candidate change affects it or conflicting evidence appears.
- Apply the [observable acceptance](AUDIT-GOAL.md#observable-acceptance),
  including affected keyboard, focus, themes, narrow layouts and 200% zoom.
  Fixtures cover failure paths; they do not establish live native behavior.
- Follow the [local release procedure](LOCAL-RELEASE.md) to review sanitized
  source and package contents, align versions, build the package and run detached
  offline smoke. Record candidate identity, hashes, breaking changes and limits
  in the [candidate record](RELEASE-3.0.0.md#final-candidate-evidence-to-record).

Release readiness does not publish, merge, tag or update an installed app.
