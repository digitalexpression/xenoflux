# Xenoflux 3.1.1 candidate

## Status

Local patch candidate prepared on 2026-11-09. The latest published release remains
[3.1.0](RELEASE-3.1.0.md). This candidate includes the reviewed report/lifecycle
refactor and all eleven audit corrections. Its public branch starts from public
main, excluding the private knowledge commits throughout the outgoing history.

The generated bundle's `manifest.json` owns its exact `sourceRevision`, package
and dependency SHA-256 values, and detached smoke result. Require
`smoke.status: passed` before using the bundle as verified preparation evidence.
Public CI, merge, publication and changes to an existing installation require
separate applicable authorization.

## Changes

- Bind settings copies to stable source/destination identities and fingerprints
  of selected contents and modes, including rechecks under the transaction lock.
- Resolve committed Git inputs without executing worktree filters, ignore Git
  replacement refs, verify the reviewed tree, and reject escaping or cyclic
  workspace link chains before execution.
- Stop all owned comparisons and reviews despite damaged UI receipts, retaining
  shutdown errors after cleanup and closing the local server reliably.
- Reserve export folders exclusively and serialize Recent updates across
  controllers. Retain exported files and report a warning if indexing fails.
- Use unambiguous setup cache keys. Search session titles and project paths, and
  apply recorded-client filtering before the result limit with bounded memory.
- Keep review attempts visible when captured response bytes are missing,
  unreadable or changed, while retaining access to verified frozen evidence.
- Correct Markdown JSON escaping and isolate report rendering state. Reuse native
  provider eligibility and remove unused internal settings-comparison helpers.
- Make fixture readiness atomic and ensure cancellation/cleanup after failures.
  Evaluation fixtures retain prepared inputs until all subtests finish.
- Keep `docs/knowledge/` local, untracked, ignored and excluded from public source
  and package membership. Preserve the original local notes and private history.

## Compatibility and verification

New comparisons record source worktree cleanliness as unknown, because a Git
worktree status check can invoke configured filters. Dirty, untracked and ignored
files remain excluded from committed inputs. Existing frozen reports retain their
recorded cleanliness values. Report and copy-journal formats remain unchanged.

The full correction-source verification passed on Node 22.15.0 and 24.0.0 with
1,388 tests passed and one opt-in native-opening test skipped per runtime. All 49
browser journeys passed on each runtime, together with JavaScript syntax, native
helper integrity, types, design tokens, documentation and bundled UI parity.
The first Node 24 attempt exposed premature evaluation-fixture cleanup; its
corrected full rerun passed. Earlier failed evidence remains separate.

Those full runs precede this candidate's version, documentation and package-boundary
canary changes. The eight package/documentation regression tests passed on each
runtime, as did syntax, native helper, documentation, type, token and UI build
parity checks. Runtime source, rebuilt UI, remaining tests and tooling match the
validated correction source. Outgoing candidate history excludes knowledge files
and their private commits. Final preparation verifies actual tarball membership
and content, hashes and the detached offline installation; the generated manifest
records that bundle's result.

The bundle contains `xenoflux-3.1.1.tgz`, `smol-toml-1.9.0.tgz`, `manifest.json`
and `install.mjs`. Build and verify it using the [release procedure](LOCAL-RELEASE.md).
The detached smoke uses disposable npm/managed installations, homes and controllers.
Fixture results retain the [3.1.0 native evidence limits](RELEASE-3.1.0.md#remaining-limits).
