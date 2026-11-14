# Xenoflux development

Read [CONTRIBUTING.md](CONTRIBUTING.md) for source ownership/checks and the relevant
[contracts](docs/CONTRACTS.md) before changing behavior. [PRODUCT.md](PRODUCT.md)
owns product intent and priorities. The [guide](docs/GUIDE.md) owns the user journey
and supported limits; [DESIGN.md](DESIGN.md) owns UI rules.
Read only task-relevant sections, then begin authorized work. Reopen settled
choices only for conflicting evidence or a scope change.
Use existing patterns and tools for routine edits. Additional design, delegation
or review workflows must address a concrete task need, not run after every change.
Development and fix requests cover necessary local investigation, source edits and
relevant development checks within task scope; no separate approval is needed.

Maintainer work covers release or installed-state operations and explicitly assigned
private maintenance. For that work, read `private/maintainer/instructions.md` if
present. Ordinary source edits and public checks must work without private context.
Documentation and historical grants authorize no operation.

| Task | Read |
| --- | --- |
| Client execution, API, persistence or recovery | [Execution](docs/CONTRACTS.md#execution-approvals-and-ownership) and [recovery](docs/CONTRACTS.md#persistence-cancellation-and-recovery) contracts; relevant production code/tests |
| Profiles and selected copying | [Copy contract](docs/CONTRACTS.md#profile-creation-copying-and-undo) |
| UI composition and redesign | [Product intent](PRODUCT.md), [guide](docs/GUIDE.md), [DESIGN.md](DESIGN.md), globally installed shadcn skill |
| Development checks | [Contributing](CONTRIBUTING.md#checkout-and-checks) |
| Release packaging | [Release building](CONTRIBUTING.md#build-a-release-candidate) |

Profiles follow the current selected installation/capabilities, never a pinned
CLI/Desktop version. Preserve unrelated edits, user data and original evidence.
Native client/model operations, publication and installed updates need current
user instructions covering their effects. Current-task grants remain valid across
continuation and compaction within their original effects, conditions and limits,
unless revoked. Do not re-request covered steps or import grants from unrelated
tasks or archived receipts.

Keep seven public document owners: README, PRODUCT, installation, guide, CLI,
contributing and contracts. PRODUCT owns product intent; the guide owns journeys
and supported limits; contracts owns invariants. PRODUCT stays repository-only.
AGENTS and DESIGN are project instructions. Do not recreate parallel product,
goal, roadmap or feature spec documents. Use code/tests for schema fields and
private current-work for necessary assignment tracking. Follow the [backup, archive and traceability policy](CONTRIBUTING.md#keep-documentation-small):
working notes, debugging evidence and recovery state directly needed for an authorized
task need no separate approval. Backups, archives and optional historical records
require an explicit user request. A skill checklist alone does not establish a need
for process records.

Update the owning fact and link to it. Keep private paths, operational receipts,
chat IDs and execution plans out of public source. Inspect outgoing history and
run [public history checks](CONTRIBUTING.md#prepare-public-commits) before pushing.
