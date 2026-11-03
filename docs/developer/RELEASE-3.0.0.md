# Xenoflux 3.0.0 release record

This record describes **Xenoflux 3.0.0** source and acceptance evidence. The
[goal](AUDIT-GOAL.md#observable-acceptance) owns product acceptance; the
[roadmap](ROADMAP.md#current-work-and-stop-condition) owns delivery status;
[local release procedure](LOCAL-RELEASE.md) owns package preparation. The
generated release manifest binds exact source and artifact hashes. npm version/
tag, GitHub release/assets and installed verification are separate identities;
source checks alone do not establish publication or installation.

## Published identity and verification

**Stable 3.0.0 was published and verified on 2026-11-03.** This closeout records
the final results; the preparation evidence below retains its original scope.
The subsequent [3.0.1 hotfix](RELEASE-3.0.1.md) supersedes 3.0.0 for distribution.

| Item | Recorded result |
| --- | --- |
| Merged source / tree | `0f56b6d4163e49cd2d0407d5c1115621ea73b1a0` / `07d429a4bd27acb2ef89b50ca94fca7817b61991`; [PR #8](https://github.com/digitalexpression/xenoflux/pull/8) |
| npm | [xenoflux 3.0.0](https://www.npmjs.com/package/xenoflux/v/3.0.0), published with `latest=3.0.0`; downloaded public tarball matches the final tested bytes |
| GitHub | [v3.0.0](https://github.com/digitalexpression/xenoflux/releases/tag/v3.0.0); tag targets merged source and all four downloaded assets match the final bundle |
| Main tarball SHA-256 | `e42ea4995e088835aeb0b62f05783bf6985ad4096e9221a99b3d02208d1c38b7` |
| Public CI | [Run 41591712757](https://github.com/digitalexpression/xenoflux/actions/runs/41591712757): Node 22.15.0 and 24.22.1 each passed 1,350 engine cases / one skip, 47 browser journeys and detached offline smoke; tested and merged trees match |
| Final package | All 170 packed files match merged source; package boundary, packed links, checksums and installer template pass. The merged-source tarball matches the approved proposal bytes. |
| Published installation | Disposable global npm installation on Node 23.11.0 matched all 170 package files; CLI lookup/help, empty explicit controller, uninstall and temporary-prefix cleanup passed |

Private release receipts bind prepared source `997971e`, merged source, CI,
artifact hashes and public/disposable-install verification. RC PR #7 closed as
merged through stable integration. Earlier candidates, failures and artifacts
retain their original identities. Initial npm propagation returned 404 after
publication was accepted; later public version/tag and exact bytes were verified
without republishing or replacing the release.

The release batch used a disposable prefix, home and controller. It performed
no managed installation, existing installed-app update or real profile/client/
model operation. Native cancellation, active-review Desktop quit and crash
recovery retain the fixture-only limits below. The original local approval
fixture failure remains unattributed despite the separately proven reader fix.

### Separate managed-installation verification

A separately authorized existing-app update to **3.0.0** completed on
2026-11-03. All 161 installed runtime/dependency/UI files matched the published
package, with no extra runtime files. Registered profiles, protected
configuration and authentication-file metadata were preserved. Read-only browser
verification covered the installed app's home, profiles and an existing saved
comparison report; no new model task ran.

The updater supplemented the exact published `dist/ui` assets omitted by the
stock 3.0.0 managed copier. The first failed attempt, successful receipt,
verification and rollback copy remain preserved privately. Published source and
artifacts were unchanged; [3.0.1](RELEASE-3.0.1.md) fixes the managed copier.
This installed-app observation establishes version 3.0.0, not an update to 3.0.1.

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

The final package, lockfile and lockfile-root versions are aligned to `3.0.0`.
Earlier `3.0.0-rc.1` source, bundles and receipts retain their original identities.
Exact stable source revision, package version and artifact hashes belong to the
generated release manifest.

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
the replay component and rebuilt script/entry assets. The later publication
handoff correction changes one engine store module, with its own regression
and source checks; native execution/capture transport and record formats are unchanged; the
later supported-runtime correction enforces child-discovery bounds in the
calling iterator. Core creation/copy modules also match the retained native
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

## Record publication handoff

The [next CI run](https://github.com/digitalexpression/xenoflux/actions/runs/41524087624)
passed the replay cases on Node 22, then failed while preparing a review browser
fixture: the safe record reader rejected a file at its hardlink-count check. That
job reached 46 browser passes; engine tests and package smoke did not run. The
error did not identify the exact record path, so the specific publication is
unknown. This remains a failed outcome, independently of local passing checks.

Exclusive record publication retains atomic no-replace linking and now removes
the temporary name before yielding to the UI event loop. Previously the awaited
link/unlink pair allowed an event-loop observer to see a record with two names.
A bounded direct experiment observed that state on the old writer and not on the
new pair; the one-publication regression fails on old source and passes with the
change. Existing transient-link handling and permanent-hardlink rejection still
pass. A nondiscriminating concurrency test was discarded.

Reader permissions, path, size and hardlink checks are unchanged, as are record
formats, fsync/directory sync and immutability rules. The filesystem still has a
brief interval between the two syscalls; cross-process/native-thread observers
and a crash can encounter it. Existing bounded fail-closed reader handling stays
in effect. This is a demonstrated event-loop scheduling fix, not proof of which
record failed in CI or a guarantee against every publication race. Fresh CI must
verify the integrated source.

After this correction, full local verification passed: 1,348 engine tests and
one skip, all 47 browser journeys, syntax, native launcher, packaged documentation,
UI types/tokens and bundled-build freshness. Independent review found no material
correctness or safety issue in the bounded publication change. These local
results remain separate from the required fresh public CI result.

## Supported-runtime boundary verification

A later [matrix run](https://github.com/digitalexpression/xenoflux/actions/runs/41528993178)
passed all browser journeys on both runtimes but failed engine boundaries:
Node 22 reported a scan-limited history as ready; Node 24 rejected two fixture
expectations involving compressed frames and group shutdown. Those failed
outcomes remain retained; package smoke was not reached in that run.

A minimal exact-runtime probe showed Node 22.15.0 continuing SQLite iteration
after the JavaScript callback threw at its scan budget. Child discovery now
checks global row/time bounds directly in the calling iterator and stops there.
Parent matching, metadata limits, child/depth caps and rollout ownership checks
remain. Large unrelated histories still do not consume the matching-child quota.
The old boundary test fails on Node 22; the corrected session-reader file passes
38 tests on both exact runtimes.

The compressed trailing-data fixture now appends undecodable bytes. Its former
two valid Zstandard frames are fully decoded on newer Node 24 and therefore do
not demonstrate ignored trailing data. Production decoding, stored/decoded/window
bounds and unsafe-path rejection are unchanged; no single-frame-only format rule
or runtime version allowlist was added.

The disposable group test now waits through inconclusive EPERM probes after
SIGKILL, requiring definite ESRCH before its existing three-second deadline.
It fails closed on timeout and does not repeat the group signal after the explicit
attempt. Production recovery's treatment of uncertainty is unchanged.

Complete local suites passed on exact Node 22.15.0 and Node 24.22.1: 1,348 engine
passes and one skip each. All 47 browser journeys passed under Node 24. The final
fixture teardown guard also passed its focused case under both runtimes. These
results supplement prior scoped native evidence; they are not fresh native model
or client operations. Fresh public CI must verify the integrated head.

## State snapshot handoff

The [following matrix run](https://github.com/digitalexpression/xenoflux/actions/runs/41533829094)
passed the full Node 24 job, including package smoke. Node 22 passed all browser
journeys but failed engine fixture setup while reading mutable `state.json` at
the pre-open link-count guard. The CI output did not record the link count.
A bounded probe on both exact runtimes captured `lstat` returning an old inode
with zero links after atomic rename, while the path held a different safe inode.

The reader now retries that stale snapshot only after the existing replacement
check independently validates the current inode and confirms a different file
identity. It uses the existing retry bound; unsafe files are never accepted.
A deterministic regression fails on the prior source and passes on both runtimes;
it also rejects a real non-private replacement. The complete focused store file
passes 18 cases on each runtime. Independent read-only review found no material
correctness or safety issue in the two-file change. Original failed CI outcomes
remain failed; the integrated head requires fresh CI and source-bound packaging.

After the state snapshot correction, complete local engine suites pass on exact
Node 22.15.0 and 24.22.1 (1,349 passes / one skip each), and all 47 browser
journeys pass under Node 24. Syntax, native launcher, packaged documentation and
UI type/token/build-freshness checks pass.

## Stable source preparation

Stable preparation aligns version roots to `3.0.0` and updates current-release
documentation. A metadata-only proposal's full engine run reported one approval
fixture as `uncertain` after its answer; its exact cause was not captured. Four
focused runs and one full diagnostic suite then passed. These later passes do
not explain or relabel the original failure.

A controlled probe on Node 22.15.0 and 24.22.1 reproduced a concrete false-
incomplete path: an old zero-link `lstat` snapshot after atomic replacement made
the task unavailable, although the current record was valid and private. A fresh
read returned its waiting state; Start and capture each remained one. This
establishes that mechanism, not its occurrence in the original failed run.

The shared metadata reader now permits at most three stat attempts, retrying
only after a fresh, different inode satisfies its existing regular-file,
current-user, private-mode, one-link and 1 MiB limits. Other unsafe metadata,
read errors and invalid JSON are not retried. The new regression fails the prior
reader and passes on both runtimes; a non-private replacement stays uncertain.
Independent read-only review found no material correctness/safety issue.

Only the metadata reader changes application code from verified RC1; UI/native
capture, formats and conservative recovery policy are unchanged. The RC matrix
passed on both runtimes: 1,349 engine cases / one skip, 47 browser journeys and
offline smoke each. Stable verification separately binds its affected checks,
actual package bytes/links and detached smoke. Publication uses a tested bundle
from merged source; retained RC results do not imply stable publication.

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

This table retains preparation results from before publication. Final merged
source, public CI, artifacts and installed verification are recorded above.

The [roadmap gates](ROADMAP.md#verification-and-release-gates) define the
sequence; [local release procedure](LOCAL-RELEASE.md) defines package checks.

| Evidence | Candidate result |
| --- | --- |
| Source revision, version and artifact hashes | Recorded in the generated release manifest. |
| Evidence for profile creation, comparison and ordinary review | Retained/development evidence and source applicability are summarized above. Engine source equality and immutable receipt identities are retained separately against the candidate manifest; the replay UI correction has separate browser coverage. |
| Required checks and affected regressions | Latest local suites passed on both exact CI runtimes: 1,348 engine passes / one skip each, 47 browser journeys under Node 24, syntax/native/docs/UI freshness and focused boundary checks. Fresh public CI is separate. |
| Real review access, response and UI association | Passed on corrected development source; unchanged native execution/capture and record formats preserve scoped applicability without claiming a fresh native candidate run. |
| Bundled UI freshness and detached offline package smoke | Rebuilt bundled UI matches source. The generated manifest records the detached smoke outcome for its exact source and tarball. |
| Breaking changes, fresh-start guidance and remaining limits | The checkout-only export-review runner, broker, isolated transport/probe and campaign stages were removed. Ordinary Reviews is the supported execution path; external review import remains supported. No report/store schema or copy journal was retired, and no migration was added. Unsupported old data remains untouched. |

Review the actual packed file list and content, including packaged Markdown
links. Keep private operational receipts outside the candidate. These preparation
results alone do not establish merged-source CI, publication or an installed
application update; the separate closeout above binds those observations.
