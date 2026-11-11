# Xenoflux

<!-- impeccable:product-schema 1 -->

Profile manager and task comparison for Codex, Claude Code and GitHub Copilot CLI on macOS.

## Platform

web

The product interface is a locally bundled browser app on macOS,
launched with `xfx ui`. Codex, Claude Code and GitHub Copilot CLI provide task
execution; native desktop apps are part of its operating context.

## Users

Developers using Codex, Claude Code or GitHub Copilot CLI on macOS who want
to compare how different setups perform on a real task. Task comparison is the primary job; independent profiles support
that job by keeping setups separate. This priority was confirmed during init.

## Product Purpose

Help users inspect what happened when a native client tackled a task under
two recorded conditions, understand the results and evidence limits, and optionally request
an attributed AI review of the comparison.

The core journey is create or choose profiles → compare a task → read the report
→ optionally request review → read the response. Success means completing that
journey in the bundled app without authoring JSON, transferring a report manually
to an AI, or reconstructing session identifiers.

## Positioning

Xenoflux connects profile setup, paired task execution or recorded sessions,
inspectable evidence and report-bound reviews in one local workflow. It exposes
the conditions behind a comparison instead of presenting an unexplained score.
One pair does not establish a universal winner, causality or consistency; lower
time or token usage alone does not establish better quality.

## Operating Context

- Users work with local repositories, client-qualified profiles and recorded
  CLI or Desktop sessions. The app runs on the user's Mac; explicitly started model tasks use
  the selected profile's provider connection and normal permissions.
- A new comparison has exactly two sides, which may use the same profile, with
  optional model and reasoning-effort overrides per side. Each side runs from
  its own checkout of the pinned commit, excluding uncommitted, untracked and
  ignored files. Sides execute in recorded order within a comparison.
- Users can also compare existing sessions or inspect current setup differences.
  Current setup and recorded task conditions are distinct.
- Independent comparisons and report reviews can overlap. Each job retains its
  own progress, approvals, cancellation and result; simultaneous reviews need
  separate workspaces. Shared conditions limit timing interpretations.

## Capabilities and Constraints

The [product goal](docs/developer/AUDIT-GOAL.md) owns supported behavior and
acceptance; the [roadmap](docs/developer/ROADMAP.md) owns current scope, status and
delivery order. This record supplies durable product context, not new release
requirements or operational authorization.

- Profiles can start empty or copy selected supported parts of another profile
  of the same client. Creation, authentication and opening a client are separate steps. Credentials,
  generated memory and conversation history are not copied. The
  [profile copy policy](docs/developer/PROFILE-COPY-POLICY.md) owns eligibility,
  preview, preservation and recovery.
- Reports retain paired responses, available changes/artifacts, named check
  results, replay and supported time/token observations. Missing or unsupported
  evidence stays explicit; completion is separate from verification and review.
  Checks are never selected automatically.
- Browsing and preparation start no model task. Starting a comparison or review
  is explicit. Native approval/input requests require the user's response;
  refresh or reconnect must not duplicate model work.
- An ordinary AI review uses a selected profile and workspace, an inspectable
  prompt and frozen report inputs. Its response is an attributed interpretation
  tied to that comparison, not a product verdict. The
  [review contract](docs/developer/REVIEW-TASK-IMPLEMENTATION.md) owns execution,
  persistence and lifecycle details.
- Export and reopen preserve the supplied evidence and its limits. Recorded
  content is excluded by default; explicit inclusion uses redaction and size
  bounds. Private prose and code may remain, so exports need inspection before
  sharing. Evidence bound to a retained review cannot be silently removed.
- The 4.0.0 boundary covers the three local CLI clients and mixed-client pairs.
  Managed Claude/Copilot desktop profiles, cloud execution, generic configuration
  editing and desktop-shell packaging remain outside that boundary. The
  [app guide](docs/user/APP.md#400-scope-and-limits) records qualification limits.

## Brand Commitments

The name is Xenoflux; the CLI command is `xfx`. Use plain language that leads
with the decision, its evidence and its important limitation, with technical
details available for inspection. Preserve the established identity and
interaction rules in [DESIGN.md](DESIGN.md); init does not replace them.

## Evidence on Hand

- [User guide](docs/user/APP.md): supported journeys and user-facing terminology.
- [Product goal](docs/developer/AUDIT-GOAL.md#evidence-and-privacy-contracts):
  evidence, privacy and interpretation contracts.
- [Release records and verification](docs/developer/ROADMAP.md#current-work-and-stop-condition):
  pointers to source-bound results and their limitations. Tests or illustrative
  mockups do not establish unobserved native behavior or user-study outcomes.

Do not invent customers, testimonials, comparative benchmarks or quality claims.

## Product Principles

1. Organize the product around answering a task-comparison question; profiles
   support that work.
2. Keep source observations, verification results and reviewer interpretations
   distinct and inspectable.
3. Make unknowns and evidence limits visible wherever they affect a conclusion.
4. Preserve independent setups, original evidence and unrelated work; make
   consequential execution explicit.
5. Keep the ordinary journey local and direct, with technical detail available
   when it helps the user understand or act.

## Accessibility & Inclusion

Support keyboard operation, visible focus, meaningful labels, focus restoration,
reflow at applicable narrow widths in both themes. Color alone
must not identify a comparison side, status or result. The
[DESIGN.md](DESIGN.md#accessibility) owns detailed interaction and visual requirements;
the [product goal](docs/developer/AUDIT-GOAL.md#observable-acceptance) owns
acceptance, verification exclusions and recorded limits.
