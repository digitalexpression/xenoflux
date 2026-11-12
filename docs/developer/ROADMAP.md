# Xenoflux roadmap

## Current work and stop condition

The 4.0.0 line is an opt-in public beta. Complete the
[beta-exit review](AUDIT-ACCEPTANCE.md#beta-exit-checklist) before stable promotion.

Xenoflux supports local Apple Silicon macOS profile management and task comparison for Codex,
Claude Code and GitHub Copilot CLI. The core journey is create a profile, compare
a task, inspect its report and optionally request an ordinary AI review.

Prioritize reliable ownership, exact user approvals, truthful evidence and safe
recovery across these clients. Complete changes against the [product goal](AUDIT-GOAL.md)
and [acceptance criteria](AUDIT-ACCEPTANCE.md). Development completion does not
authorize publication or installed updates; those require current user instructions.

## Product direction

- Keep profile creation, same-client selected-parts copy and Undo explicit and
  reversible. Discovery and copying remain separate capabilities.
- Follow the current selected native installation. Validate capabilities and
  prepared-operation identity without pinning profiles to CLI/Desktop versions.
- Preserve client-qualified sessions, independent job ownership and captured
  responses across same-client and mixed-client comparisons.
- Improve inspection and recovery without automatic reattach, resend or resume.
  Saved evidence must remain readable without starting model work.
- Keep capture gaps, account scope, routed models and uncertain shutdown visible.

## Supported boundaries

The [client scope](AUDIT-GOAL.md#client-scope) and
[app guide](../user/APP.md#400-scope-and-limits) describe supported surfaces and
qualification limits. Credential refresh and distinct-account independence remain
unverified. The remaining native pair/mode combinations, repeated overlap stress,
controller-kill reviews and copied-setup native loading are deferred qualification.
Fixture coverage does not turn those checks into native passes.

Managed Claude/Copilot desktop profiles, cloud execution, cross-client setup copy
and generic configuration editing are outside the current boundary. An app-open
or import capability does not imply managed isolation or automated execution.

## Contributor references

Use the [developer guide](README.md) for checks, the
[client and review contract](REVIEW-TASK-IMPLEMENTATION.md) for execution and
persistence, and the [profile copy policy](PROFILE-COPY-POLICY.md) for transfer
rules. Keep verification results and operational records outside public source.
