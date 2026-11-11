# Xenoflux development

## Start with the active work

Read the [roadmap](docs/developer/ROADMAP.md#current-work-and-stop-condition)
for product direction, the [goal](docs/developer/AUDIT-GOAL.md#current-release-boundary)
for supported behavior, and [acceptance](docs/developer/AUDIT-ACCEPTANCE.md) for
verification criteria. Read relevant sections rather than every linked document.
Once the outcome, affected code and verification are clear, begin authorized
implementation. Reopen decisions only for conflicting evidence or a scope change.
Documentation grants no operational authorization.

## References by task

| Work | Read when relevant |
| --- | --- |
| Client runtime, ordinary review, persistence or recovery | [Implementation contract](docs/developer/REVIEW-TASK-IMPLEMENTATION.md). |
| UI composition | [App guide](docs/user/APP.md), [DESIGN.md](DESIGN.md), and the globally installed shadcn skill. |
| Profile creation, copying or setup comparison | [Profile copy policy](docs/developer/PROFILE-COPY-POLICY.md). Implementation gaps are not exceptions to preserve. |
| Checks and browser verification | [Developer guide](docs/developer/README.md#checkout-and-checks). |

## Preserve boundaries

Profiles must not be pinned to CLI or Desktop versions. Resolve the current
selected installation and observed capabilities; retain versions as provenance
and validate executable/root identity for each prepared operation. Follow the
[provider version policy](docs/developer/AUDIT-GOAL.md#evolution-and-provider-version-policy).

Preserve original data and others' edits. Live profile/client operations, model
runs, publication and installed updates need current authorization covering their
effects. Do not re-request steps already covered by an explicit grant.

## Keep documentation useful

The goal owns behavior, the roadmap owns direction, and feature contracts own
implementation rules. Keep one owner per fact and link to it. Prefer concise
rules and supported limitations over duplicated narratives. Keep private paths,
identifiers, operational grants and execution records outside public source.
Preserve full originals privately before shortening or removing them; do not
alter raw evidence, published tags or artifacts.
