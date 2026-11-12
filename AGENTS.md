# Xenoflux development

Read [CONTRIBUTING.md](CONTRIBUTING.md) for source ownership/checks and the relevant
[contracts](docs/CONTRACTS.md) before changing behavior. The [guide](docs/GUIDE.md)
owns the user journey and supported limits; [DESIGN.md](DESIGN.md) owns UI rules.
Read only task-relevant sections, then begin authorized work. Reopen settled
choices only for conflicting evidence or a scope change.

For maintainer work, read `private/maintainer/instructions.md` if present. It routes
current assignments and release workflows. Public development/checks must work
without private context. Documentation and historical grants authorize no operation.

| Task | Read |
| --- | --- |
| Client execution, API, persistence or recovery | [Execution](docs/CONTRACTS.md#execution-approvals-and-ownership) and [recovery](docs/CONTRACTS.md#persistence-cancellation-and-recovery) contracts; relevant production code/tests |
| Profiles and selected copying | [Copy contract](docs/CONTRACTS.md#profile-creation-copying-and-undo) |
| UI composition | [Guide](docs/GUIDE.md), [DESIGN.md](DESIGN.md), globally installed shadcn skill |
| Checks and packaging | [Contributing](CONTRIBUTING.md#checkout-and-checks) and [release building](CONTRIBUTING.md#build-a-release-candidate) |

Profiles follow the current selected installation/capabilities, never a pinned
CLI/Desktop version. Preserve unrelated edits, user data and original evidence.
Native client/model operations, publication and installed updates need current
user instructions covering their effects; do not re-request existing grants.

Keep six public documents: README, installation, guide, CLI, contributing and
contracts. AGENTS and DESIGN are project instructions. Product context belongs in
the guide/contracts; do not recreate parallel PRODUCT, goal, roadmap or feature
spec documents. Use code/tests for schema fields and private current-work for
assignments. Preserve compressed originals before removing documentation.

Update the owning fact and link to it. Keep private paths, operational receipts,
chat IDs and execution plans out of public source. Inspect outgoing history and
run [public history checks](CONTRIBUTING.md#prepare-public-commits) before pushing.
