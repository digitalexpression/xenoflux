# Substantive evaluation fixtures

These are authored coding tasks and offline preparation tools, not completed model
evaluations. See the [frozen evaluation plan](../../docs/developer/REPEATED-SUBSTANTIVE-EVALUATION.md).

`prepare.mjs --output NEW_ABSOLUTE_DIRECTORY` creates three pinned disposable Git
repositories, blocked fake profiles in a private store, acceptance/checker copies,
balanced series specs and unfilled human-review templates. It refuses an existing
output and never launches a real Codex model. `check-candidate.mjs` is a host-side
checker; only task `workspace/` content goes into model input.

The booking ledger tests state transitions, the retry queue tests promise-driven
control flow, and configuration overlay tests recursive data and a real stdin CLI.
Their reference implementations are controls for the checkers. They are not fed to
the evaluated task. Published oracle/reference files are outside the workspace by
protocol, not secret from arbitrary same-user access. No personal data is included.

Verify the known controls with `node --test test/audit-substantive-evaluation.test.js`.
Paid candidate checks remain blocked until their host execution has an approved
isolation boundary; the native model task sandbox does not apply to host checks.
