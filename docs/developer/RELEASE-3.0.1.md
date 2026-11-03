# Xenoflux 3.0.1 installer hotfix

**Unpublished release candidate, 2026-11-03.** This patch addresses managed
installation of the bundled browser app. The [3.0.0 record](RELEASE-3.0.0.md)
retains its original evidence; the [roadmap](ROADMAP.md#current-work-and-stop-condition)
owns current preparation status. Artifact identity and detached smoke results
belong to the candidate bundle's generated `manifest.json`.

## Problem and correction

The 3.0.0 npm package includes `dist/ui`, but `xfx install` omitted that directory
when staging the managed app. Managed installation could therefore report
success while `xfx ui` could not start. The offline release installer invokes the
same managed copier and is affected too. Direct npm-package UI use is unaffected.

The installer now includes `dist/ui` in the staged app before replacing the
existing managed copy. A source package missing the UI fails during staging,
preserving the prior app and launcher. No data migration is required. Desktop
reservation, client shutdown, external-terminal and ownership safeguards remain.

Public CI also exposed an existing keyboard-focus failure when F6 reopened the
replay inspector. Keyboard-open focus now follows the dialog's mount lifecycle
instead of a single animation-frame callback; pointer-open focus behavior stays
unchanged. A delayed-frame regression keeps the strict heading-focus assertion.

## Regression and release checks

- Install into a disposable home and serve HTML, JavaScript and CSS from the
  managed app; asset responses must match source bytes.
- Attempt an upgrade from a source missing `dist/ui`; preserve the existing app,
  launcher and controller sentinel without new service/settings changes.
- Detached offline release smoke launches both the npm entry and the managed
  shell entry, from outside the source tree. Each must serve its bundled page,
  script and stylesheet and refuse an unauthenticated API request.
- Retain required syntax, native-helper, documentation, engine and browser checks,
  package-boundary inspection and artifact checksum verification.

The smoke uses disposable homes/controllers and mocked native service callbacks.
It does not close real clients, mount RAM storage, modify a real installation or
run a model task. Product behavior and UI assets are unchanged from 3.0.0;
its native evidence and explicit limits remain applicable.

## Release status

Preparation does not publish a package, create a public tag or update an existing
installation. Release publication needs an authorized batch and green CI for the
exact outgoing source. Keep published 3.0.0 tags/assets and historical receipts
unchanged; publish this correction only as 3.0.1.
