# Xenoflux 3.0.1 installer hotfix

**Published stable 3.0.1; verified 2026-11-03.** This patch addresses managed
installation of the bundled browser app. The [3.0.0 record](RELEASE-3.0.0.md)
retains its original evidence; the [roadmap](ROADMAP.md#current-work-and-stop-condition)
owns current delivery status. Artifact identity and detached smoke results
belong to the final merged-source bundle's generated `manifest.json`.

## Published identity and verification

| Item | Recorded result |
| --- | --- |
| Merged source / tree | `d2c336bafdc201ad18f4c9a92454bf4d190f0738` / `39e41917b156c1b0ee336d7601051e74cd802b14`; [PR #9](https://github.com/digitalexpression/xenoflux/pull/9) |
| npm | [xenoflux 3.0.1](https://www.npmjs.com/package/xenoflux/v/3.0.1), `latest=3.0.1`; public tarball matches tested final bytes |
| GitHub | [v3.0.1](https://github.com/digitalexpression/xenoflux/releases/tag/v3.0.1), stable/latest; tag targets merged source and all four downloaded assets match |
| Main tarball SHA-256 | `440738fbb5bb5582622d9f40457e658957797910d7741b670b7c8afebf24131d` |
| Public CI | [Run 41621264629](https://github.com/digitalexpression/xenoflux/actions/runs/41621264629): Node22 and Node24 each passed 1,352 engine cases / one skip, 47 browser journeys and detached offline smoke |
| Final package | All 171 actual packed files match merged source; explicit boundary, packed documentation links, checksums and installer template pass; merged tree equals tested tree |
| Published installation | Disposable npm global install on Node 23.11.0: exact inventory and bytes of 171 package plus 19 dependency files, CLI lookup/help and empty explicit controller passed; uninstall and temporary-prefix cleanup passed |

Private release receipts bind the final merged-source bundle, package
inspection, public-byte verification and disposable-install verification.
The merged-source tarball is byte-identical to the corrected reviewed
candidate. Original source `941c2ff`, its bundle and all earlier receipts retain
their identities; correction source is `27d70f0`.

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
The original run passed Node22 completely but failed one of 47 Node24 browser
cases before that job reached engine/smoke. Its trace and screenshot are retained.
The old UI fails the controlled delayed-frame focus case and the correction
passes; the original CI scheduler timing itself was not instrumented. Fresh CI
passes on the corrected source. No assertion was weakened or arbitrary wait added.

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
run a model task. Profile/native execution paths retain the 3.0.0 evidence and
its explicit limits. The rebuilt UI includes the focus correction above.

## Release status

The user-approved release batch is complete. npm publication, GitHub tag/assets
and public-byte/disposable-install verification are recorded above. Published
3.0.0 tags/assets and historical receipts remain unchanged. This batch did not
update an existing installed app or perform a real model/profile/client/service
operation. Native cancellation, active-review Desktop quit and crash recovery
retain the 3.0.0 fixture-only acceptance limits.
