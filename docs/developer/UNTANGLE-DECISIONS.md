# Codebase untangling decisions

Scope: behavior-preserving local refactor requested on 2026-11-08, including
restating-comment cleanup and behavior-based test cleanup. No live profile,
model, installation, publication or native acceptance operations are included.

## Inventory and redesign

- Give report rendering its own mode context, rather than mutable module state.
  - `src/audit-report.js` helpers `clean`, `shown` and `prose` implicitly depend
    on `markdownRendering`, which `renderAudit` temporarily changes.
  - `markdownEscapeReport` is an identity wrapper with no independent purpose.
  - Independent review caught a missed rendering-mode dependency in `safeJson`.
    Checking that path also exposed an existing escape-order bug: escaping JSON
    fields before serialization doubles Markdown backslashes. Sanitize/bound
    fields first and escape serialized JSON once, preserving literal output.
- Represent review completion directly as a promise owned by each running task.
  - `src/ui-review-tasks.js` cancellation and provider shutdown independently
    poll the same mutable completion flag every 20 ms.
- Put native provider eligibility beside the native configuration contract.
  - `src/native-copy.js`, `src/advanced-copy.js` and `src/profile-inventory.js`
    independently encode default OpenAI versus custom provider support; their
    error messages differ appropriately, but eligibility must change together.
  - Inventory and copy duplicate config, agent and role key lists. Keep these
    ordered support vocabularies in `src/native-config.js` as well.
- Share the test-only RAM-log storage fixture.
  - `test-support/ram-logs-test-loader.mjs` and
    `test-support/profile-cli-fixture-loader.mjs` duplicate the same fake
    `createLogStorage` implementation and ready-state contract.
- Distinguish absent run history from an unsafe or inaccessible history root.
  - `src/ui-runs.js` catches every directory failure as an empty history, hiding
    unexpected errors. Only a missing directory represents no saved runs.

## Investigated boundaries retained

- Process liveness checks use several fallback policies. Consolidate only where
  the semantics agree; changing error handling is not automatically a refactor.
  Their few lines remain local because a common helper would require policy
  switches or change conservative ownership decisions.
- The desktop operation gate must tolerate acquire/release races and bounded
  waits. Malformed metadata must remain fail-closed; investigate before changing
  its retry classification.
- Audit protocol fallbacks, strict no-follow/size/hash checks, unavailable or
  partial evidence, and privacy projections represent external requirements.
- Report comparison/rendering, session parsing/discovery, and UI composition
  have possible larger seams. File size alone does not justify extraction.
- UI route/type generation and speculative service layers would add machinery
  without evidence of a concrete contract problem.
- The Runs repository selector uses `HEAD` as an editable fallback when a saved
  repository is unavailable; actual preview resolves and validates it before
  Start, so retaining that symbolic default does not invent commit evidence.
- Platform/tool/native-gated tests are meaningful coverage, not disabled debt.
  No tautological or unconditional-success tests were identified in the initial
  review; preserve meaningful security, persistence and behavior coverage.
- Scripts and fixtures mostly document external constraints and operational
  boundaries. Remove only comments demonstrably restating their implementation.
- Controlled evaluation workspaces/oracles are preserved as evidence fixtures.
- Static source-import inspection found existing cycles in profile lifecycle,
  copy/inventory and audit review/evidence. Review found no initialization or
  ownership failure justifying separate extraction; this change adds no cycle.

## Working result and verification

Implemented all five redesigns above following four bounded inventory reviews.
Independent review found no remaining actionable issues in the final semantic
diff; a follow-up scripts/fixtures/test review found nothing further worth
changing. Removed the redundant renderer wrapper and its restating comment;
retained meaningful tests rather than deleting coverage without a reason.

- `npm run check`, `npm run check:docs`, `npm run check:native`: passed.
- `TMPDIR=/private/tmp npm test`: 1,365 passed, zero failed, one opt-in native
  profile test skipped. Disposable fixture checks required execution outside
  the enclosing sandbox for loopback listeners and nested macOS sandboxes.
- `TMPDIR=/private/tmp npm run check:ui`: passed type/token/build checks and
  all 48 Chromium journeys.
- Targeted configuration/copy suites: 60 passed; shared-loader consumers:
  12 passed; report suite: 46 passed.
- Final render/export consumer recheck after the escape-order refinement:
  all 434 tests passed.
- Source-before/after comparison: four representative terminal reports and the
  comparison projection matched. Markdown JSON escaping intentionally changed
  to one escape after serialization; object keys and values have regression
  assertions. An earlier eight-output parity check passed before that fix.
- `git diff --check`: passed.

The initial restricted full-suite attempt was not a pristine baseline: sandbox
restrictions caused failures, and some files loaded while implementation was
changing. The permitted full-suite result above supersedes it; the final
render/export consumer run verifies the subsequent escape-order refinement.

Fixture checks do not establish live Codex behavior. No live profiles, client
processes, model runs, installations or published releases were changed.
