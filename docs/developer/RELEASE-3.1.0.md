# Xenoflux 3.1.0 release

## Status

Published on 2026-11-05 after the user authorized public CI, merge and publication.
Updates to existing installations remain pending explicit approval. The original
candidate, failed CI run, corrected source and published artifacts retain their
own identities. This post-publication documentation closeout does not rebuild,
retag or replace the released source or artifacts.

## Published identity and verification

| Identity | Verified value |
| --- | --- |
| Release PR | [#10](https://github.com/digitalexpression/xenoflux/pull/10) |
| Tested PR head | `48127b61ba56182f99d708096d98b30a07f201a6` |
| Merged source / tag target | `b1e3eb28ec7af581460e79570281d863898e76b9` |
| Stable GitHub release | [v3.1.0](https://github.com/digitalexpression/xenoflux/releases/tag/v3.1.0) |
| npm | [xenoflux 3.1.0](https://www.npmjs.com/package/xenoflux/v/3.1.0), public `latest` tag |
| Public CI | [Passing macOS matrix](https://github.com/digitalexpression/xenoflux/actions/runs/41995057810), Node 22.15 and 24 |

Both public jobs passed 1,363 unit tests with zero failures and one opt-in native
test skipped, all 48 browser tests, syntax, native-helper integrity, packaged-doc
links and detached offline npm/managed installation smoke. The merged source tree
matched the tested PR head; the final bundle was built and smoke-tested again from
that merged revision.

| Published asset | SHA-256 |
| --- | --- |
| `xenoflux-3.1.0.tgz` | `61c3a29a428eef70725e9f076699db1b75e7b8dfc9329b236cef6f5a8f4dcb58` |
| `smol-toml-1.9.0.tgz` | `cc9e8fca082c67ed05444f5027ff32e8b935e0988663c911843a54d5339af354` |
| `manifest.json` | `ac4f6bc23a66ef25afe81b13728b1140d28db5935828443ba32debbf4851e3d7` |
| `install.mjs` | `81b851ebc456398c4706345c887dff9088e2acccb2e42b41f9f10c7dfbd95425` |

The public npm tarball and all four downloaded GitHub assets matched the tested
bundle byte for byte. npm SHA-1/SHA-512 metadata also matched, and the public tag
resolved to the merged source. npm initially returned HTTP 202 for the accepted
upload while public version lookups still returned 404 and `latest` remained
3.0.1; later public metadata confirmed version/latest 3.1.0 and its tarball was
downloaded and verified. The archive's 173 files matched source and passed private
metadata exclusion and actual packaged-document link checks. Disposable smoke
installations were removed. No existing installed application was updated.

## Changes

- Run independent comparisons and ordinary report reviews concurrently on the
  same profile. Each comparison side and each review can select a model and
  reasoning effort without editing saved profile settings. Both comparison
  sides may select one profile and retain distinct sessions/results.
- Route native approvals, input, cancellation and progress to their own jobs.
  Display active jobs and preserve frozen review inputs and captured responses.
- Share native execution reservations across controller stores while excluding
  profile mutation and overlapping review workspaces. Preserve uncertain live
  work after a coordinator crash; recover stopped work without replay.
- Open the original signed vendor Desktop app through a named profile shortcut.
  Preserve the vendor signature and record ownership independently of the
  shortcut. The shortcut itself does not establish native task correctness.
- Correct Desktop journal lookup when another controller registers the same
  native home under a different profile ID.
- Preserve focus moved outside the nonmodal replay inspector when it closes,
  so late focus restoration cannot interrupt search input.

Existing report schemas remain version 1. Same-home CLI selections need distinct
`sideId` values. No automatic migration or deletion of old evidence is performed.
Existing native launcher records and reservations remain subject to their
ownership/recovery checks; unsupported or uncertain state is preserved.

## Verification

Local source verification passed:

| Check | Result |
| --- | --- |
| JavaScript syntax | Passed |
| Prebuilt universal native helper | Source/binary hashes, architectures and signature checks passed |
| Packaged documentation | 28 Markdown files; membership and local links passed |
| Full unit suite | 1,363 passed, zero failed, one opt-in native test skipped |
| UI | Types, design tokens and bundled build parity passed; all 48 browser tests passed |
| Dependencies and diff | Installed dependency versions and whitespace checks passed |
| Package boundary | Dry-run membership includes required UI/helper/public docs and excludes private receipts and knowledge files; final archive verification is recorded with the bundle |

The first full runs retained seven unit failures and three browser failures in a
managed environment with its temporary root inside the real account home. Six
unit failures and three browser failures treated displayed home-relative export
paths as literal paths; the remaining CLI fixture exceeded its output buffer
while discovering account ancestors. Browser assertions now expand the displayed
prefix. The complete passing reruns used `TMPDIR=/private/tmp` to isolate fixture
project ancestry. Original failed logs and traces remain separate from the final
passing evidence.

The first [public CI run](https://github.com/digitalexpression/xenoflux/actions/runs/41993264549)
passed every gate on Node 24. Node 22.15 passed 47 browser tests but failed replay
search/selection restoration, preventing its later unit/smoke steps. Investigation
reproduced focus being stolen from search when the nonmodal inspector closed.
The regression failed before the correction and passed five consecutive local
runs afterward. The updated source subsequently passed the complete public matrix linked above.
The original failed run and artifact remain preserved rather than relabelled.

The published bundle manifest records `smoke.status: passed` for the detached
offline npm and managed installation lifecycle. This smoke checks bundled HTML/JavaScript/CSS, refusal of unauthenticated
API calls and a disposable managed installation lifecycle. It does not update a
real installation or exercise live native sign-in/model work.

The [native validation summary](SAME-PROFILE-NATIVE-VALIDATION.md) describes the
source-applicable disposable-profile campaigns using `gpt-6.1-sol` and
`gpt-6-luna`. These native observations predate the final packaged source and do
not assert a new live campaign on the candidate installation. They cover four-job
model execution alongside Desktop, scoped approvals/cancellation, frozen results,
synthetic expired/invalid cached-token refresh and live coordinator SIGKILL
recovery. The later cross-controller journal correction has a regression test.

## Remaining limits

The native comparison retained partial exhaustive skill-use capture. Natural
expiry of an otherwise valid signed token was not observed; the refresh check
used a synthetic expired/invalid cached access token. Escaped descendants remain
outside the process observer's proof. No new VoiceOver or participant study was
performed. Test fixtures and detached smoke do not establish unobserved native
provider behavior or a production installed update.
