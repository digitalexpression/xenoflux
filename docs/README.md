# Documentation

Use the user guides for normal operations and developer guides for source changes.
Version identity is recorded in the [package manifest](../package.json),
[GitHub releases](https://github.com/digitalexpression/xenoflux/releases) and
[npm package](https://www.npmjs.com/package/xenoflux).

For this beta line, follow the explicit channel instructions in
[Installation](user/INSTALLATION.md). Stable promotion uses the
[beta-exit checklist](developer/AUDIT-ACCEPTANCE.md#beta-exit-checklist).

## User guides

| Guide | Use it to |
| --- | --- |
| [Installation](user/INSTALLATION.md) | Install, update, remove or use the offline bundle. |
| [The Xenoflux app](user/APP.md) | Create profiles, compare tasks, read reports and request AI review. |
| [Profiles](user/PROFILES.md) | Create, sign in, inspect, launch and manage profiles. |
| [Audit profiles and native client runs](user/AUDIT.md) | Inspect setups and sessions, compare results and export evidence. |
| [Controlled experiments](user/AUDIT-EXPERIMENTS.md) | Author CLI experiments, run, recover and clean them. |
| [Evidence and capture](user/AUDIT-EVIDENCE.md) | Understand replay, provenance, telemetry and capture limits. |
| [Repeated trials and external reviews](user/AUDIT-REVIEWS.md) | Run series/cohorts and attach external review or check records. |
| [Desktop](user/DESKTOP.md) | Open, focus, observe and recover named instances. |
| [Selective copying](user/ADVANCED-COPY.md) | Preview selected copies, apply them and undo them. |
| [Profile recovery](user/PROFILE-RECOVERY.md) | Recover interrupted sign-in or CLI work. |
| [RAM logs](user/RAM-LOGS.md) | Configure and recover optional diagnostic-log routing. |

## Developer guides

Start release work at the [roadmap checkpoint](developer/ROADMAP.md#current-work-and-stop-condition).
Read other references only as needed.

| Guide | Use it to |
| --- | --- |
| [Development](developer/README.md) | Set up the checkout and run checks. |
| [Product goal](developer/AUDIT-GOAL.md) | Check supported behavior, acceptance and evidence boundaries. |
| [Client and review implementation](developer/REVIEW-TASK-IMPLEMENTATION.md) | Change client identity, catalogs, execution, persistence and recovery. |
| [Desktop implementation](developer/DESKTOP-IMPLEMENTATION.md) | Understand signing, ownership, isolation and native verification. |
| [Profile copy policy](developer/PROFILE-COPY-POLICY.md) | Change creation/copy behavior against its contract. |

## Acceptance

Use the [acceptance criteria](developer/AUDIT-ACCEPTANCE.md) to verify observable
behavior and understand fixture/native evidence limits. These are reusable
requirements, not a history of completed checks or authority for operations.

[Back to Xenoflux](../README.md).
