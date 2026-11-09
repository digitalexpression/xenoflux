# Audit profiles and Codex runs

`profiles`, `show`, `diff` and `export` inspect evidence without starting model tasks. `run` executes an explicitly started experiment. For the browser workflow, use [the app guide](APP.md).

## Compare profile setup for a repository

```sh
xfx audit profiles Default Research --repo /path/to/repository --client cli
xfx audit profiles Default Research --repo /path/to/repository --client desktop
```

Compare settings, instructions, agents, skills/package resources, rules, integrations and memory settings with origin, readable differences and explicit gaps. Client applicability may be unknown. Discovery is independent of copy eligibility; it proves neither native loading nor runtime availability.

Setup snapshots can contain source text/paths. Exports omit source text unless explicitly selected:

```sh
xfx audit export profiles Default Research --include-content --output setup.json
```

Known-secret redaction and private permissions do not make arbitrary prose, code or metadata safe to publish. Review exported files before sharing.

## Inspect and compare existing sessions

```sh
xfx audit show --profile Default --id NATIVE_UUID
xfx audit diff --left-profile Default --left-id LEFT_UUID \
  --right-profile Research --right-id RIGHT_UUID
xfx audit show /path/to/run.audit.json
xfx audit diff /path/to/left.audit.json /path/to/right.audit.json
```

Profile plus UUID identifies a session; lookup never borrows another profile. Exact-UUID fallback requires one safe rollout with a matching header; ambiguity stays unavailable. Each side retains usable evidence if the other fails. Direct CLI/Desktop tasks need not have been launched by xfx. Compressed reads use the exact `.jsonl.zst` sibling only when the indexed plain file is absent, with stored/decoded bounds and no extraction or source rewrite.

Declare known task association explicitly; titles alone are insufficient:

```sh
xfx audit diff --left-profile Default --left-id LEFT_UUID \
  --right-profile Research --right-id RIGHT_UUID \
  --same-task "booking ledger" --variables "model,reasoning effort"
```

Labels are declarations, not proof. Recorded task fingerprints take precedence; conflicts remain conflicts. Omit `--same-task` when unknown. Current setup/files never fill missing historical state.

For recorded-control checks, add `--expect-model MODEL --expect-effort EFFORT` to `audit diff`. These check observations without changing settings; missing values remain unknown.

### Read a same-task comparison

Inspect recorded conditions, responses/actions, checks, changes and scoped time/tokens. Completion, verification, capture coverage and reviewer judgment are separate. Compatible named checks require matching recipes; code deltas need a common baseline; scores need matching rubrics. A setup difference does not erase unrelated supported observations. One pair proves neither consistency, causality nor a universal winner.

File-scope/read-before-edit findings describe only attributed actions and frozen `taskContract` boundaries, not all edits or understanding. Missing action/actor/source coverage keeps absence unknown. See the [synthetic comparison](../examples/audit-booking-ledger-comparison.md) for illustrative wording, not measured results.

### Reopen a saved audit run

Frozen JSON reopens without native histories and retains its original omissions. Current files, missing aliases, absent artifacts and later session activity are not reconstructed. A new historical import is a new derivation, not an edit to frozen evidence. Agent claims and multi-command exits do not prove each underlying check passed.

## Understand skill evidence

Discovery, selection, invocation, successful read and instruction adherence are distinct. Match evidence to the owning actor/catalog; same names and path aliases can remain ambiguous. Model mentions are self-report unless corroborated. No observed event is not proof of no use, and missing values are not zero.

Detailed contracts: [replay/provenance/telemetry and accounting](AUDIT-EVIDENCE.md).

## Export a frozen report

```sh
xfx audit export RUN_OR_COMPARISON_UUID --output report.json
xfx audit export RUN_OR_COMPARISON_UUID --format markdown --output report.md
xfx audit export --profile Default --id NATIVE_UUID \
  --include-replay-content --format markdown --output replay.md
```

Markdown is readable text; its `.audit.json` sidecar is the reopenable evidence. Keep them together. Export format selects JSON/Markdown; `--json` selects structured command output. Exported normalized evidence preserves selected identities, attribution, references and limits.

Choose unused output and sidecar paths; export never overwrites existing files.

Replay/patch/check bodies are omitted by default. `--include-replay-content` opts into available redacted bodies; truncated structured bodies are omitted. Known-secret redaction is incomplete protection for private text. Export refuses changes that would strip or rebind evidence used by an attached review, before writing files.

## Read results carefully

- Historical outcomes/checks require recorded evidence; today's checkout is not task-end code.
- Checks passed/failed, checks unrun and no checks are different; no declared checks means unverified.
- Token subsets and overlapping agent spans are not additive. Unsupported scope/ownership stays unknown; time/tokens are not quality or billing.
- Receipt IDs identify received observations, including retransmissions. Replaying the same receipt is idempotent; counts do not measure unique or exhaustive skill executions.

## Exit status

| Code | Meaning |
| --- | --- |
| 0 | Complete requested evidence. |
| 1 | Invalid input or missing selection; takes precedence over another side's partial evidence. |
| 2 | Partial/unavailable evidence; useful output and successful file export can still return this. |
| 3 | Recorded-control expectation mismatch, with complete required evidence. |

## Session replay

[Replay semantics and limits](AUDIT-EVIDENCE.md#session-replay).

## Compare consistency across repeated runs

[Series and selected cohorts](AUDIT-REVIEWS.md#compare-consistency-across-repeated-runs).

## Review either audit entry path

[External review packets and evidence attachments](AUDIT-REVIEWS.md#review-either-audit-entry-path). For ordinary AI review, use the [app workflow](APP.md#review-a-comparison).

Execution specifications, safety and recovery: [controlled experiments](AUDIT-EXPERIMENTS.md).
