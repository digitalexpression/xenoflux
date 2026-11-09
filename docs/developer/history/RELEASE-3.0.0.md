# Xenoflux 3.0.0 release

Published and verified 2026-11-03. Compact historical summary; full originals and failed attempts remain private. Published tags/assets are unchanged.

## Published identity and verification

| Item | Recorded result |
| --- | --- |
| Merged source / tree | `0f56b6d4163e49cd2d0407d5c1115621ea73b1a0` / `07d429a4bd27acb2ef89b50ca94fca7817b61991`; [PR #8](https://github.com/digitalexpression/xenoflux/pull/8) |
| npm | [xenoflux 3.0.0](https://www.npmjs.com/package/xenoflux/v/3.0.0), published with `latest=3.0.0`; downloaded public tarball matches the final tested bytes |
| GitHub | [v3.0.0](https://github.com/digitalexpression/xenoflux/releases/tag/v3.0.0); tag targets merged source and all four downloaded assets match the final bundle |
| Main tarball SHA-256 | `e42ea4995e088835aeb0b62f05783bf6985ad4096e9221a99b3d02208d1c38b7` |
| Public CI | [Run 41591712757](https://github.com/digitalexpression/xenoflux/actions/runs/41591712757): Node 22.15.0 and 24.22.1 each passed 1,350 engine cases / one skip, 47 browser journeys and detached offline smoke; tested and merged trees match |
| Final package | All 170 packed files match merged source; package boundary, packed links, checksums and installer template pass. The merged-source tarball matches the approved proposal bytes. |
| Published installation | Disposable global npm installation on Node 23.11.0 matched all 170 package files; CLI lookup/help, empty explicit controller, uninstall and temporary-prefix cleanup passed |

Prepared source `997971e` and RC PR #7 retain their identities; stable integration used PR #8. npm initially returned 404 after acceptance, then public version/tag/bytes verified without republishing.

### Separate managed-installation verification

A separately authorized 2026-11-03 update matched all 161 installed runtime/dependency/UI files, preserving profiles and protected metadata. Read-only home/profile/saved-report checks passed; no model task ran. The update supplemented UI assets omitted by the stock copier; the first failure, rollback and successful receipt remain private. [3.0.1](RELEASE-3.0.1.md) fixes that copier; published 3.0.0 artifacts were not altered.

## Integrated development verification

The bundled create → compare → ordinary-review journey shipped. The retired reviewer runner/broker/isolation campaign was removed; external review import, report/store formats and copy journals remain. Final public source checks are recorded above; earlier development/RC passes are not relabelled as candidate-native evidence.

## Failed attempts and corrections

| Retained attempt | Result and correction |
| --- | --- |
| [Initial CI](https://github.com/digitalexpression/xenoflux/actions/runs/41520724361) | Replay scrolling/disclosure failures on both runtimes; engine/smoke not reached. Controlled disclosure and test focus ordering corrected. |
| [Publication handoff](https://github.com/digitalexpression/xenoflux/actions/runs/41524087624) | Node 22 fixture rejected a hardlink; exact record unknown. Atomic no-replace publication now removes its temporary name before yielding. Cross-process/crash intervals remain possible. |
| [Runtime matrix](https://github.com/digitalexpression/xenoflux/actions/runs/41528993178) | Child-scan bound and compressed/group fixture failures; smoke not reached. Iterator bounds and fixture assumptions corrected. |
| [State handoff](https://github.com/digitalexpression/xenoflux/actions/runs/41533829094) | Node 24 passed; Node 22 rejected mutable state. A stale-inode control justified bounded revalidation; unsafe replacements remain refused. |
| Stable local approval fixture | One unexplained `uncertain` result. Later passes and a separately reproduced reader defect do not explain that original failure. |
| First live review | Large JSONL response exceeded the 256 KiB line bound; failed/partial. Corrected parsing retained the combined output bound; a fresh review passed. |

## Retained verification and limits

- Retained creation/copy/Undo acceptance applies only to unchanged paths. CLI comparison evidence was partial/inconclusive; no general superiority or consistency was established.
- Corrected development review read frozen inputs, captured/reopened its full response and exact session association. Approval interaction was fixture-only; the result was not a fresh packaged-candidate run or correctness guarantee.
- One live review completed alongside Desktop. A second completed before active quit could be verified. Native cancellation, active-review quit and crash recovery remained fixture-only.
- Release smoke used disposable state. The separate existing-app update above has its own scope; neither proves reboot or universal native behavior.

### Reference-host performance

Apple M1 Max, 64 GiB, macOS 26.6.2; shared browser/GPU processes excluded. These observations are not universal guarantees.

| Measurement | Observation | Accepted limit |
| --- | ---: | ---: |
| Controls | 1,060 ms | 1.2 s |
| 100-session page | 66 ms | 250 ms |
| 20,000-event report | 2,714 ms | 6 s |
| Search p95 | 393 ms | 500 ms |
| Selection p95 | 463 ms | 600 ms |
| Renderer RSS, maximum across five open/leave cycles | 1,674,575,872 bytes | 1.8 GB |
| Server RSS, same cycles | 280,870,912 bytes | 350 MB |
