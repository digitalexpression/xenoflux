# Xenoflux product intent

<!-- impeccable:product-schema 1 -->

This reference owns Xenoflux's product purpose and priorities. It guides the
whole-UI redesign using established intent; open decisions below remain unconfirmed.

## Platform

web

Xenoflux is a local browser app for working with coding clients on the same Mac.
The [supported clients and known limits](docs/GUIDE.md#supported-clients-and-known-limits)
own the current platform and capability boundary.

## Users

Xenoflux serves people who want to understand and improve the coding-agent harness
that works for their tasks. A narrower audience segment and an assumed level of
technical expertise have not been established.

## Product purpose

Xenoflux helps people improve their own harness through session inspection and
comparisons of the same task. Here, harness means the settings, instructions,
tools, skills, and workflows surrounding a model in a coding client.

People use evidence from their own work to judge which model and harness choices
serve their tasks. The product makes available setup, session, outcome, time,
token, and context evidence inspectable, with its limitations visible.

## Pains to solve

| Pain | Question Xenoflux helps the user investigate |
| --- | --- |
| Keeping up with a changing AI environment | Which harness choices work best for my tasks as clients, models, and integrations change? |
| Rapid model releases | How does a new model perform on my current harness when I change only the model? |
| Constant additions of tools, skills, and workflows | Which combination helps my work, and which additions are unnecessary? |
| Alternatives that promise the same benefits | Which tool, skill, or workflow works better for me on the same task? |
| Wasted tokens and time | What consumes my tokens and time, and how does that work contribute to the result? |
| Context clutter and repeated compaction | What context was available, where did compaction occur, and is there evidence that the session lost its goal or scope? |

These questions express product intent. The evidence available for a particular
client and session determines how far Xenoflux can answer them.

## Core jobs

- Create and manage multiple Codex, Claude Code, and Copilot profiles to organize
  candidate settings and harness setups within the supported client boundaries.
- Inspect a session and its recorded harness evidence to understand what happened,
  what resources it consumed, and what remains unknown. Inspection has standalone
  value; it does not require another session or a comparison.
- Run the same task with different profiles, harness setups, or model choices,
  then compare the evidence side by side. Existing recorded sessions also support
  comparison without requiring another model task.

Profile management, inspection, and comparison support the same goal of improving
the user's harness. Normal use requires no authored JSON, manual report transfer,
or session-ID reconstruction.

## Product principles

- Improvement is specific to the user's tasks. Results help people judge their
  choices rather than establish a universal best model or harness.
- Session inspection and same-task comparison are complementary ways to
  investigate. Neither requires the other to provide useful evidence.
- Trust depends on keeping observations, verification, and reviewer judgment
  distinct. Missing evidence must limit the conclusions people draw.
- Recorded work remains useful. Existing sessions and frozen reports matter
  alongside newly executed tasks.
- People control consequential actions. Reading evidence and preparing a choice
  remain separate from starting native clients, model tasks, or profile changes.

## Evidence limits

The goal is all observable evidence within the capture scope, with omissions made
explicit. It is not a promise of complete access to native state or hidden
reasoning. A configured tool or skill is not proof that a session used it.
Today's setup cannot fill gaps in the harness recorded for a past session.

A model-only request describes the intended variation. It does not prove that
every other runtime condition stayed fixed. A single pair does not establish
repeatability or causality. Time and token consumption do not by themselves prove
waste, quality, or complete attribution. Available compaction markers and summaries
do not expose the entire effective context or automatically prove scope loss.

The [evidence contract](docs/CONTRACTS.md#evidence-privacy-and-accounting) owns the
precise interpretation rules. The [guide](docs/GUIDE.md) owns current journeys,
supported evidence, and client limits. These boundaries qualify the product goal;
they do not turn unavailable evidence into a result.

## Redesign success

These qualitative criteria follow the established product intent. They are design
goals, not claims that the current UI has passed user validation.

- People can investigate the six pains through a session inspection or a
  same-task comparison without assembling reports outside the local app.
- People can distinguish the candidate setup, recorded use, intended variation,
  observed differences, results, and evidence gaps.
- People can inspect available time, token, context, and compaction evidence
  without mistaking consumption for waste or missing data for zero.
- People can use the evidence to decide what to keep, change, or test next in
  their harness, while understanding which conclusions remain unsupported.
- People can move between profiles, inspection, and comparison without confusing
  reading evidence with executing a task or changing a setup.

The redesign preserves supported journeys and behavioral guarantees. It does not
expand product scope by changing presentation. [DESIGN.md](DESIGN.md) owns the
visual system and interaction presentation; [development checks](CONTRIBUTING.md#checkout-and-checks)
own verification requirements and exclusions.

## Open decisions for the redesign

- Which audience and level of expertise should the redesigned UI serve first?
- Which representative tasks and observable outcomes will establish that the new
  UI helps people make better harness decisions and complete their investigations?
  No quantitative targets or user research findings have been established here.

## Document ownership

This file owns durable product intent and the unresolved product choices above.
Other documents retain their existing detail:

| Owner | Content |
| --- | --- |
| [User guide](docs/GUIDE.md) | Supported journeys, effects, and known limits |
| [Contracts](docs/CONTRACTS.md) | Implementation invariants and evidence guarantees |
| [Design reference](DESIGN.md) | Composition, tokens, and interaction presentation |
| [Contributing](CONTRIBUTING.md) | Source ownership, development checks, and documentation policy |

PRODUCT.md stays in the repository. README provides the installed user's brief
orientation and routes readers to the user documentation. Product intent changes
here; changes to journeys, guarantees, or visual rules belong with their owners.
