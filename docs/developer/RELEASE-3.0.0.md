# Xenoflux 3.0.0-rc.1 candidate record

This record tracks the **unpublished 3.0.0-rc.1 candidate**. It does not assert
publication or installation. The [goal](AUDIT-GOAL.md#observable-acceptance)
owns product acceptance; the [roadmap](ROADMAP.md#current-work-and-stop-condition)
owns delivery status; [local release procedure](LOCAL-RELEASE.md) owns package
preparation. Candidate source and artifact identities are recorded in the
release manifest after packaging.

## Integrated development verification

Slices A–D and the slice E parser and reviewer/Desktop corrections are present
in the candidate source. Development checks on the integrated changes passed:
`npm run check`, `npm run check:native`, `npm run check:docs`, `npm test`
(1,346 passed, one skipped), and `npm run check:ui` (47 browser journeys).
Focused lifecycle and UI-engine checks passed 68 cases after the final local
adjustments. These results describe development verification; the candidate
verification below records the subsequent source checks separately.

Fixtures cover selected-profile settings, native requests, cancellation,
partial output, uncertain recovery, single-start behavior, frozen review inputs,
and reopening saved responses and citations. Browser journeys cover the review
flow and retained profile, comparison, export and import paths. They do not prove
live behavior for every native failure case.

Retained native profile creation and selected-copy acceptance remains applicable
to the unchanged creation paths. Retained native comparison evidence is limited
to its recorded CLI/report scope. Neither is a fresh native run on this candidate.

The package, lockfile and lockfile-root versions are aligned to
`3.0.0-rc.1` for this candidate. Exact source revision, package version and
artifact hashes belong to the generated release manifest.

## Candidate verification

The initial candidate source checks on 2026-11-02 passed: `npm run check`, `npm run check:native`,
`npm run check:docs` (25 packaged Markdown files), `npm test` (1,347 passed,
one skipped), and `npm run check:ui` (47 browser journeys, including types,
design tokens and bundled-build freshness). The sanitized export assertion's
focused nine-test file also passed. The later replay correction below changes
one UI component and its regression coverage; retained engine results are scoped
to unchanged engine code.

Before the replay correction, all 203 application, UI and build-input files
matched the integrated development source byte-for-byte. The correction changes
the replay component and rebuilt script/entry assets only; engine source remains
unchanged. Core creation/copy modules also match the retained native
acceptance source; comparison workspace/setup/check behavior continues to use
audit mode. Source applicability was reviewed separately from these checks.
Existing installed build/test dependencies were reused; the package smoke
separately exercises offline runtime dependency installation.

Public-source review removed private operational metadata and corrected stale
implementation-status text. Package membership remains an explicit allowlist.
Inspect the generated manifest for the exact candidate revision, artifact
hashes and detached offline smoke outcome. A passed source suite alone does
not establish a passed package smoke or an installed application. No new live
model run or real profile/client operation was performed for this candidate.

## Replay verification correction

The first [public PR CI run](https://github.com/digitalexpression/xenoflux/actions/runs/41520724361)
failed browser verification on both Node versions. Both jobs reported a replay
scroll assertion; Node 22 also reported a Turn disclosure remaining open after
search was cleared. Engine tests and package smoke were not reached. Original
failed artifacts remain retained; local passing results do not relabel this run.

Turn disclosures now record the user's open/closed choice synchronously through
the summary action. Programmatic event reveal uses that same controlled state,
so a queued native toggle cannot overwrite the choice after search filtering.
Keyboard toggling and reopening a closed Turn through a summary citation are
covered by existing browser journeys with additional assertions.

The independent-scroll test now waits for the delegated event's scheduled focus
before manually resetting Left's scroll position, matching the earlier identical
navigation sequence. Its viewport-preservation assertion remains unchanged; no
production scrolling policy was changed. Focused verification against the rebuilt
UI passed five repetitions each of search restoration, programmatic reveal and
independent scrolling. The full corrected browser suite then passed all 47
journeys, including types, design tokens and bundled-build freshness. Syntax,
native-launcher and packaged-doc checks passed; unchanged engine source retains
the earlier local engine result. Exact final source/package and CI identities
are recorded in the generated manifest and the PR checks.

## Ordinary review live attempt

### Initial attempt and local correction

An initial live review on the development source did not pass acceptance. The
native response exceeded a 256 KiB per-line parser limit, so the UI retained a
partial result and reported failure. The original failed outcome remains part of
the evidence. The parser was corrected to retain the combined output bound while
handling large JSONL records; a split-frame regression and large-response
fixtures cover the correction.

### Approved fresh review after correction

A new live review on the corrected development source **passed**. It read the
two frozen report inputs, captured the complete native response, and reopened
the completed result with the same task and session association. The answer
included evidence citations, counterevidence and limitations. This is attributed
model output, not an independent correctness judgment or evidence that either
profile is generally superior. Native approval was not requested during this
run; approval interaction remains fixture-tested.

This live result verifies the ordinary review path on development source. It
does not by itself bind the behavior to the final candidate package.

## Reviewer/Desktop coexistence correction

The correction allows an ordinary CLI review to share the selected profile's
existing Desktop reservation, recognizes verified late Desktop helpers, and
reconciles normal-quit state. It keeps review and Desktop ownership separate
and uses the existing lifecycle guard for cleanup.

Development verification passed the full fixture suite (1,346 passed, one
skipped), all 47 browser journeys, and 68 focused lifecycle/UI-engine cases.
Fixtures cover contention, cleanup recovery, cancellation and active-review
quit behavior.

A live CLI review completed with Desktop open; its response reopened and review
ownership was released. A second live review completed before a Desktop quit
could be confirmed. Therefore quit during an active review and native
cancellation did not receive a live pass. Crash recovery is also fixture-tested
only. No live evidence establishes those cases on the candidate; preserve this
limit when describing acceptance.

## Retained verification and limits

- Native profile creation, preview/cancel, selected copy, Undo and owned
  shutdown passed in retained earlier acceptance. Applicability is limited to
  unchanged creation/copy behavior; it is not a fresh candidate check.
- Retained comparison evidence includes xfx-started and direct CLI pairs with partial coverage
  and inconclusive results. It establishes neither general profile superiority
  nor consistency across repeated comparisons.
- Review fixtures and browser journeys cover failure states and UI behavior.
  They do not establish native cancellation, active-review quit or crash
  recovery beyond the live cases stated above.
- The selected ordinary review captured a complete response after the parser
  correction. This does not make an attributed review a correctness guarantee.

### Reference-host performance

These measurements and limits apply to the recorded Apple M1 Max / 64 GiB /
macOS 26.6.2 reference host and are not universal guarantees.

| Measurement | Observation | Accepted limit |
| --- | ---: | ---: |
| Controls | 1,060 ms | 1.2 s |
| 100-session page | 66 ms | 250 ms |
| 20,000-event report | 2,714 ms | 6 s |
| Search p95 | 393 ms | 500 ms |
| Selection p95 | 463 ms | 600 ms |
| Renderer RSS, maximum across five open/leave cycles | 1,674,575,872 bytes | 1.8 GB |
| Server RSS, same cycles | 280,870,912 bytes | 350 MB |

Shared browser and GPU processes were excluded. Recheck affected loading or
navigation paths when candidate changes or unresolved risks warrant it.

## Final candidate evidence to record

The [roadmap gates](ROADMAP.md#verification-and-release-gates) define the
sequence; [local release procedure](LOCAL-RELEASE.md) defines package checks.

| Evidence | Candidate result |
| --- | --- |
| Source revision, version and artifact hashes | Recorded in the generated release manifest. |
| Evidence for profile creation, comparison and ordinary review | Retained/development evidence and source applicability are summarized above. Engine source equality and immutable receipt identities are retained separately against the candidate manifest; the replay UI correction has separate browser coverage. |
| Required checks and affected regressions | Candidate source checks passed: 1,347 engine passes, one skip, 47 browser journeys, syntax/native/docs and focused export verification. |
| Real review access, response and UI association | Passed on corrected development source; unchanged engine source preserves applicability without claiming a fresh native candidate run. |
| Bundled UI freshness and detached offline package smoke | Rebuilt bundled UI matches source. The generated manifest records the detached smoke outcome for its exact source and tarball. |
| Breaking changes, fresh-start guidance and remaining limits | The checkout-only export-review runner, broker, isolated transport/probe and campaign stages were removed. Ordinary Reviews is the supported execution path; external review import remains supported. No report/store schema or copy journal was retired, and no migration was added. Unsupported old data remains untouched. |

Review the actual packed file list and content, including packaged Markdown
links. Keep private operational receipts outside the candidate. No result here
asserts CI on merged source, a published npm/GitHub artifact, or an installed
application update.
