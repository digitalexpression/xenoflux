# Xenoflux 3.0.1 installer hotfix

Published and verified 2026-11-03. Labels below describe that release, not current distribution. Full receipts/text remain private; artifacts are unchanged.

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

## Changes and failures

- Managed installation now stages `dist/ui`; missing UI refuses replacement and preserves the previous app/launcher. Direct npm UI use was unaffected; no migration was needed.
- F6 inspector focus follows dialog mount. The first CI passed Node 22 but failed one of 47 Node 24 browser cases before engine/smoke. The old UI failed the delayed-frame control; corrected source passed. Original trace/screenshot remain retained; CI scheduler timing was not measured.
- Original source `941c2ff` and correction `27d70f0` keep their own bundle/receipt identities. The merged tarball matches the corrected candidate.

## Limits

Detached smoke exercised bundled HTML/JS/CSS, unauthenticated API refusal and failed-upgrade preservation using disposable state and mocked native callbacks. No real installation, client, RAM storage or model task changed. Native cancellation, active-review Desktop quit and crash recovery retain [3.0.0 limits](RELEASE-3.0.0.md#retained-verification-and-limits).
