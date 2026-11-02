# Documentation

Choose a guide based on whether you are using Xenoflux or changing it. User guides
cover commands and operational recovery; the app guide describes the 3.0.0 local
browser UI. Developer guides cover source changes, implementation contracts,
verification and publication. Version and distribution identity are recorded in
the [package manifest](../package.json), [GitHub releases](https://github.com/digitalexpression/xenoflux/releases)
and [npm package](https://www.npmjs.com/package/xenoflux).

## User guides

| Guide | Use it to |
| --- | --- |
| [Installation](user/INSTALLATION.md) | Install, update, remove or use the offline release bundle. |
| [The Xenoflux app](user/APP.md) | Create profiles, run comparisons, read reports and request an ordinary AI review with a selected profile. |
| [Profiles](user/PROFILES.md) | Create, sign in, inspect, launch and manage profiles. |
| [Audit profiles and Codex runs](user/AUDIT.md) | Compare setup sources and inspect selected runs with explicit evidence limits. |
| [Desktop](user/DESKTOP.md) | Open or focus named instances and recover stopped operations. |
| [Selective copying](user/ADVANCED-COPY.md) | Review settings and individual items, apply copies and undo them. |
| [Profile recovery](user/PROFILE-RECOVERY.md) | Recover an interrupted sign-in or CLI run. |
| [RAM logs](user/RAM-LOGS.md) | Enable, disable and recover optional diagnostic-log routing. |

## Developer guides

Start with the roadmap checkpoint and active slice. These guides are references,
not a required reading sequence; use relevant sections as needed.

| Guide | Use it to |
| --- | --- |
| [Development](developer/README.md) | Set up the checkout, run checks and understand evidence boundaries. |
| [Shared product goal](developer/AUDIT-GOAL.md) | Understand the three UI release outcomes and their acceptance/evidence boundaries. |
| [Active roadmap](developer/ROADMAP.md) | Follow implementation verification, evidence binding and release status. |
| [Review implementation](developer/REVIEW-TASK-IMPLEMENTATION.md) | Understand ordinary review execution, task/API/recovery and legacy removal contracts. |
| [Capability assessment](developer/PROFILE-AUDIT-ASSESSMENT.md) | Consult historical capabilities/UX evidence when a specific gap requires it. |
| [Release process](developer/LOCAL-RELEASE.md) | Build, verify and publish a release bundle. |
| [Desktop implementation](developer/DESKTOP-IMPLEMENTATION.md) | Understand signing, ownership, isolation and native acceptance. |
| [Profile copy policy](developer/PROFILE-COPY-POLICY.md) | Review or change creation/copy behavior against its contract. |

## Developer records

[Audit acceptance index](developer/AUDIT-ACCEPTANCE.md) links immutable,
version-specific records, including [3.0.0](developer/RELEASE-3.0.0.md) and
the historical 2.1.0 release and its evidence limits. The previous
[2.0.0 acceptance record](developer/AUDIT-ACCEPTANCE-2.0.0-HISTORY.md) and the
[2.1.0 release-era roadmap](developer/ROADMAP-2.1.0-HISTORY.md) and
[assessment](developer/PROFILE-AUDIT-ASSESSMENT-2.1.0-HISTORY.md) remain available
as explicitly historical records.

Detailed operational handovers and raw receipts remain in private engineering
records; the versioned release pages contain reviewed public summaries.

[Back to Xenoflux](../README.md).
