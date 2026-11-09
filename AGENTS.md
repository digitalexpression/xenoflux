# Xenoflux development

## Start with the active work

For release work, read the [roadmap checkpoint](docs/developer/ROADMAP.md#current-work-and-stop-condition)
and active delivery slice. Consult the [goal](docs/developer/AUDIT-GOAL.md#current-release-boundary)
for scope, [acceptance](docs/developer/AUDIT-GOAL.md#observable-acceptance) for done,
and [evolution policy](docs/developer/AUDIT-GOAL.md#evolution-and-provider-version-policy)
for breaking changes. Read relevant sections, not every linked document.
Once the outcome, affected code and verification are clear, begin authorized
implementation; reopen settled decisions only for conflicting evidence or a
scope change. Historical chats, handovers and campaign runbooks are not startup
prerequisites. The goal and roadmap grant no operational authorization.

## References by task

| Work | Read when relevant |
| --- | --- |
| Ordinary review execution, API/persistence or recovery | Corresponding section of the [review implementation contract](docs/developer/REVIEW-TASK-IMPLEMENTATION.md). |
| UI composition | [App guide](docs/user/APP.md) for supported workflows, [DESIGN.md](DESIGN.md) for visual/interaction rules and the repository [shadcn skill](.agents/skills/shadcn/SKILL.md). |
| Profile creation, copying or setup comparison | [Profile copy policy](docs/developer/PROFILE-COPY-POLICY.md); its implementation gaps are not exceptions to preserve. |
| Checks/build/browser verification | [Developer guide](docs/developer/README.md#checkout-and-checks). |
| Candidate evidence or packaging | Current release record linked from the [roadmap checkpoint](docs/developer/ROADMAP.md#current-work-and-stop-condition) and relevant [release procedure](docs/developer/LOCAL-RELEASE.md) section. |

## Keep context current

The goal owns behavior/acceptance; the roadmap owns status/order; feature specs
own implementation contracts; release records own source-bound results. Update
the owning document and link from others instead of repeating the narrative.
Replace stale checkpoint text rather than appending a turn log. A handover needs
only recovery information and pointers not already in the roadmap.
Search before loading whole files or chats. Filter bulky tool results to relevant
decisions, source ranges or failures; inspect raw evidence only for a specific gap.
Preserve original data/evidence and others' edits. Live profile/client operations,
model runs, publication and installed updates need current authorization covering
their effects; do not re-request steps already covered by an explicit grant.

## Documentation budget

Keep one owner per fact. Prefer a short rule or lookup table over repeated narrative.
Release summaries retain date, outcome, source/artifact identities, final checks,
failed controls and material limits. Historical summaries belong in `docs/developer/history/` and retain outcome/limit
and an evidence locator, not old plans or turn logs. Preserve full originals privately
before shortening them; do not alter raw receipts, tags or published artifacts.
