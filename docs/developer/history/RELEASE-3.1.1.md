# Xenoflux 3.1.1 release

Published 2026-11-09. Compact historical summary; original receipts and full text are retained privately. Tags and artifacts are unchanged; npm/GitHub labels below describe publication-time verification.

## Published identity and verification

| Identity | Verified value |
| --- | --- |
| Release PR | [#12](https://github.com/digitalexpression/xenoflux/pull/12) |
| Tested PR head | `bed664b575a46a0564a83d3886d415f1c3155c56` |
| Merged source / tag target | `b8d558a57848e5a8df49b0097b3e4de2dbf54098` |
| Stable GitHub release | [v3.1.1](https://github.com/digitalexpression/xenoflux/releases/tag/v3.1.1) |
| npm | [xenoflux 3.1.1](https://www.npmjs.com/package/xenoflux/v/3.1.1), public `latest` tag |
| Public CI | [Passing macOS matrix](https://github.com/digitalexpression/xenoflux/actions/runs/42612007212), Node 22.15 and 24 |

| Published asset | SHA-256 |
| --- | --- |
| `xenoflux-3.1.1.tgz` | `7485b4361106e183fcba492db5bc88a7ad829144f3c35583c472fc23a2ba63b6` |
| `smol-toml-1.9.0.tgz` | `cc9e8fca082c67ed05444f5027ff32e8b935e0988663c911843a54d5339af354` |
| `manifest.json` | `127e18f1b176d5e6faffe777837961bbb89cb415d87db2dfc0c3c1d122e6a819` |
| `install.mjs` | `81b851ebc456398c4706345c887dff9088e2acccb2e42b41f9f10c7dfbd95425` |

Both public macOS jobs: 1,388 unit passes, zero failures, one native skip; 49 browser journeys; syntax, native helper, docs and detached npm/managed smoke. Merged and tested trees matched. All 174 packed files and public asset/npm bytes matched; isolated global install/help/list/uninstall passed.

## Changes

Copy identity/content rechecks; committed-input and symlink safety; reliable shutdown; exclusive exports and Recent updates; session filtering; visible missing review responses; report escaping; fixture cleanup; private knowledge exclusion. Report/copy-journal formats are unchanged. New runs leave worktree cleanliness unknown to avoid invoking Git filters.

## Failed attempts

[First public CI](https://github.com/digitalexpression/xenoflux/actions/runs/42610534368): Node 24 failed one deferred-focus case; Node 22 browsers passed. A controlled delayed-frame regression reproduced it and passed ten times per runtime after repair. Earlier fixture-cleanup and local failures remain separate. npm initially returned 202/404 before metadata propagated; no republishing occurred.

## Remaining limits

No existing installation or live Codex state changed. Native limits remain those of [3.1.0](RELEASE-3.1.0.md#remaining-limits).
