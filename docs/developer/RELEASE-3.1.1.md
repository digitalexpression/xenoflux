# Xenoflux 3.1.1 release

## Status

Published on 2026-11-09 after the user authorized public CI, merge and publication.
Public npm/latest, GitHub tag/assets and isolated installation checks are complete.
The original local candidate, failed CI run, corrected source and published
artifacts retain their own identities.
This documentation closeout does not rebuild, retag or replace release artifacts.

## Published identity and verification

| Identity | Verified value |
| --- | --- |
| Release PR | [#12](https://github.com/digitalexpression/xenoflux/pull/12) |
| Tested PR head | `bed664b575a46a0564a83d3886d415f1c3155c56` |
| Merged source / tag target | `b8d558a57848e5a8df49b0097b3e4de2dbf54098` |
| Stable GitHub release | [v3.1.1](https://github.com/digitalexpression/xenoflux/releases/tag/v3.1.1) |
| npm | [xenoflux 3.1.1](https://www.npmjs.com/package/xenoflux/v/3.1.1), public `latest` tag |
| Public CI | [Passing macOS matrix](https://github.com/digitalexpression/xenoflux/actions/runs/42612007212), Node 22.15 and 24 |

Both corrected public jobs passed 1,388 unit tests with zero failures and one
opt-in native test skipped, all 49 browser journeys, syntax, native-helper integrity,
packaged-document links and detached offline npm/managed installation smoke.
The merged source tree matched the tested PR head. The final bundle was rebuilt
and smoke-tested from that merged revision.

| Published asset | SHA-256 |
| --- | --- |
| `xenoflux-3.1.1.tgz` | `7485b4361106e183fcba492db5bc88a7ad829144f3c35583c472fc23a2ba63b6` |
| `smol-toml-1.9.0.tgz` | `cc9e8fca082c67ed05444f5027ff32e8b935e0988663c911843a54d5339af354` |
| `manifest.json` | `127e18f1b176d5e6faffe777837961bbb89cb415d87db2dfc0c3c1d122e6a819` |
| `install.mjs` | `81b851ebc456398c4706345c887dff9088e2acccb2e42b41f9f10c7dfbd95425` |

The tag resolves to the merged source and all four downloaded GitHub assets
match the tested bundle byte for byte. npm returned HTTP 202 for the accepted
upload while public version lookups initially returned 404 and `latest` remained
3.1.0. Later public metadata confirmed version/latest 3.1.1; the downloaded npm
tarball matched the tested bundle, including SHA-1 and SHA-512 registry metadata.
All 174 archive files matched the tagged source, and actual packed-document
membership and links passed. A disposable global npm install verified the CLI
link, help and empty isolated profile list, then uninstalled successfully.
Disposable verification installations were removed.

Knowledge files and their private commits are absent from the public release
history and package. Local notes remain untracked, ignored and preserved.
Existing installations and live Codex state are unchanged. Fixture results retain
the [3.1.0 native evidence limits](RELEASE-3.1.0.md#remaining-limits).

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
parity checks. The original local candidate's runtime source, rebuilt UI, remaining
tests and tooling matched the validated correction source. Outgoing candidate
history excludes knowledge files and their private commits. Final preparation verified actual tarball membership
and content, hashes and the detached offline installation; the generated manifest
records that bundle's result.

The bundle contains `xenoflux-3.1.1.tgz`, `smol-toml-1.9.0.tgz`, `manifest.json`
and `install.mjs`. Build and verify it using the [release procedure](LOCAL-RELEASE.md).
The detached smoke uses disposable npm/managed installations, homes and controllers.
Fixture results retain the [3.1.0 native evidence limits](RELEASE-3.1.0.md#remaining-limits).

## Public CI follow-up

The [first public run](https://github.com/digitalexpression/xenoflux/actions/runs/42610534368)
passed the Node 22 browser journeys but failed one of 49 on Node 24: a queued
inspector-opening animation frame could steal focus after the user moved to
search. Ten ordinary local repetitions passed; a controlled delayed-frame
regression reproduced the focus loss. Deferred event focus now respects a newer
focus choice, and the browser regression explicitly holds and flushes that frame.
The corrected controlled journey passed ten repetitions on Node 22.15.0 and
24.0.0. UI parity passed on both runtimes, and syntax, native-helper integrity,
documentation, type and token checks passed after the correction. The original
failed logs and browser trace remain separate from corrected runs.
