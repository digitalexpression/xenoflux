# Xenoflux 3.1.0 release candidate

## Status

Unpublished candidate. Preparation, package checks and a detached installation
smoke test are authorized. Publication, merging, release tags and updates to an
existing installation remain pending approval. The bundle manifest binds the
exact committed source revision, tarball checksums and detached smoke result.

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
runs afterward. The updated source requires a fresh full public matrix; the
original failed run and artifact remain preserved rather than relabelled.

The bundle manifest records the detached offline npm and managed installation
lifecycle smoke outcome. Require `smoke.status: passed` before publication
approval. This smoke checks bundled HTML/JavaScript/CSS, refusal of unauthenticated
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
