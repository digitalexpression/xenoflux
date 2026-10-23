# Xenoflux 2.1.0 release acceptance

Version-specific historical record. Preserve this content after release; later
corrections belong in a separate dated addendum.

Xenoflux **2.1.0** was published on **2026-10-23** and verified as npm's
`latest` package and GitHub's stable `v2.1.0` release. The merged source revision
is `9c28bb138f104683344780bebde09ad275df1d81`. The public npm tarball and all
four GitHub bundle assets match the retained approved bundle. The Xenoflux tarball SHA-256 is
`7f4429af0dbfe8e32a6e44380a4947109052206f849cb10a135222ebebe06f39`.

The release was merged through [PR #5](https://github.com/digitalexpression/xenoflux/pull/5).
The retained private merged-release receipt records the clean bundle rebuilt from that revision. The
[macOS CI run](https://github.com/digitalexpression/xenoflux/actions/runs/39972653666)
passed on Node 22.15.0 and 24; the merged source tree matched the tested PR tree.
The [GitHub release](https://github.com/digitalexpression/xenoflux/releases/tag/v2.1.0)
and [npm package](https://www.npmjs.com/package/xenoflux/v/2.1.0) were verified
against that bundle.

## Product acceptance and limits

The retained release checkpoint records 1,057 full-suite passes, zero failures
and one existing opt-in Desktop skip on Node 23.11.0; the focused Node 22.15.0
suite passed 56 checks with no failures or skips. Native helper integrity, the
opt-in synthetic Desktop lifecycle fixture, detached package smoke, packaged
CLI workflows, source-free reopening, and retained CLI/Desktop comparison
workflows passed. Existing evidence was reused where source and package identity
were unchanged. Publication did not rerun model tasks or candidate acceptance checks;
the merged bundle received a fresh detached smoke check.

Acceptance covers Codex CLI and Desktop on macOS within the shared
[product goal](AUDIT-GOAL.md). Repeated behavioral evidence includes two
xfx-started pairs and two direct CLI pairs. The retained Desktop pair is
historical, with differing later follow-ups and unknown task-end checks; a
single Desktop pair leaves consistency unmeasured. Seven direct behavioral rules
and direct token totals remain unmeasured or unknown. Static definitions do not
establish runtime availability or effective settings. No profile superiority
or causal effect is claimed. See the [versioned capability assessment](PROFILE-AUDIT-ASSESSMENT.md).

UI and other-provider work remain deferred. The supported runtime floor is
Node.js 22.15.0+ in the 22.x line or 23.8.0+.

## Existing installation

The existing managed installation was updated to 2.1.0 on 2026-10-23 from
checksum-verified public release files for the same source revision. All 104
installed files matched the staged application and dependency. The existing
launcher, profile list, RAM-log status, retained review state and source-free
report reopen behavior were verified. All 15 protected paths were unchanged, and all
11 observed client process identities were preserved. No new evaluations,
client launches, or restarts occurred. This is dated evidence for that
installation, not a general installation or reboot guarantee.

## Historical acceptance

The original 2.0.0 acceptance record is preserved verbatim in
[AUDIT-ACCEPTANCE-2.0.0-HISTORY.md](AUDIT-ACCEPTANCE-2.0.0-HISTORY.md). Its
contents remain historical and are not the current release record.
