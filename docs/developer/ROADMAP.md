# Xenoflux roadmap

Updated 2026-10-23. The shared [product goal](AUDIT-GOAL.md) owns the stable
outcome and acceptance contract. The [capability assessment](PROFILE-AUDIT-ASSESSMENT.md)
records current versioned evidence and limits. This file is the only active roadmap.

## Current release

Xenoflux 2.1.0 is published and verified from merged source revision
`9c28bb138f104683344780bebde09ad275df1d81`; the existing managed installation
was updated and verified on 2026-10-23. The [2.1.0 acceptance record](RELEASE-2.1.0.md)
links the public release identities and summarizes the retained release and
installation receipts.

2.1.0 delivers the Codex CLI and Desktop on macOS scope in the shared goal,
including profile setup comparison, xfx-started and direct-session audits,
optional reviews, repeated comparisons, and frozen report export/reopen. The
release record and assessment state the evidence limits; partial historical data
does not become complete evidence through release acceptance.

## Current work and stop condition

Repository and documentation cleanup is complete as of 2026-10-23. Its scope was to
reconcile the checkout with the released source, preserve original working files
and history, retain illustrative design material, keep one active roadmap, and
maintain release records and package-boundary/local-link checks. Work stops here.
Do not proceed to UI assessment or
implementation, or assessment of Claude, Copilot, or other providers, in this
workstream. Those topics remain deferred until separately requested.

The source, published package, and installed application identities are distinct
and must be stated separately in release records. Historical release plans and
receipts remain evidence; their old instructions do not renew authorization.

## Cleanup disposition

- Development is based on the released source. The old candidate branch history
  and working files are preserved in private recovery records; public names stay
  sanitized. No runtime behavior is changed by this cleanup.
- Design images and prompts remain in `output/design/`, narrowly ignored and
  excluded from packages. They are illustrative references, not accepted UI work.
- The dormant isolation harness and substantive evaluation fixtures remain:
  current tests still reference them. Legacy series review input and profile/client
  protection remain supported. No production deletion was justified.
- Current docs describe 2.1.0; completed checkpoints remain dated history.
  CI checks local inline links against npm's actual package file list.

Verification passed for syntax, native-helper integrity, packaged documentation
and package boundaries. The full fixture run had environment-blocked failures;
all affected test files passed when rerun with their required local permissions.
One existing opt-in Desktop test remains skipped. History and protected user
state checks passed. No publication, live reinstallation, new model evaluations,
or UI/provider assessment occurred. The shared goal and copy contract remain
unchanged.

## Historical release plan

The exact 2.1.0-era roadmap is preserved in
[ROADMAP-2.1.0-HISTORY.md](ROADMAP-2.1.0-HISTORY.md). It is retained for context
and does not govern current work.
