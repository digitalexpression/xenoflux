# Profile creation and copy policy

Current transfer contract; [user commands](../user/ADVANCED-COPY.md). The [goal](AUDIT-GOAL.md#evolution-and-provider-version-policy) owns compatibility policy. Discovery may inspect more than copying supports; observation never authorizes transfer or activation.

## Purpose

Create fresh profiles or seed explicitly selected parts; profiles then evolve independently. Later copies are reviewed updates, not synchronization, effective-state clones, shared storage or a migration framework. Default is a source only.

## Rules

1. **Preserve unselected state.** All entry points share one planner/policy. Category selection cannot delete source-absent destination settings/items. Identical selections are no-ops.
2. **Preview exact effects.** Identify stable source/destination, origin, additions/changes/removals/identical/kept items, before/after supported values and file changes without secrets. Show unknowns, exclusions, dependencies and manual setup. Refuse unsupported/unsafe/ambiguous effects rather than guessing.
3. **Replace selected standalone skills exactly.** Include supported resources/scripts/modes; explicit keep/skip/replace on conflict. Preview obsolete destination files inside that package, preserve everything outside it, and support exact Undo. Never use partial overlays. Refuse unsupported packages, unsafe contents/type transitions or directories without required owner permissions before mutation.
4. **Integrations stay native/manual.** No copy/install/enable/connect/migration of plugin/hook/MCP definitions, grants or internal state, including broad config copies. Group plugin components under the parent. Only selected integrations receive guidance; name actual marketplace/identity/version when known and distinguish installation/enablement/trust/dependencies/account connection. Cache presence is not installation; check first and avoid duplicate actions. Automation requires a policy change.
5. **Respect ownership.** Project resources and built-ins remain with their owner; native sharing requires supported roots/scope and may differ by CLI/Desktop environment. No cross-profile symlinks or transferred credentials, permissions, cached authorization, project/hook trust, generated memory, conversations, databases or caches. Preserve authentication/storage routing. Supported selected policy/rule definitions are not migrated grants; preview their effects. Use reviewed durable guidance/fresh conversations instead of bulk memory/history transfer.
6. **Bound claims.** Presence/configuration/installation/enablement/discovery/use differ. Paths/manifests/publishers do not prove ownership; partial discovery stays explicit. Copying installs no external dependencies and rewrites no arbitrary references. Resume/fork does not erase old instruction context.
7. **Keep transactions and recovery exact.** Bind preview to source/destination identity and selected before/after content/mode fingerprints; recheck under the copy lock. Reuse journal/conflict/Undo/recovery mechanisms. Restore replacements/deletions/modes, refuse intervening edits, and preserve original recovery records. Current v3 journals only; reject unsupported older formats unchanged, without guessing/migrations. Manual setup is outside Undo. Preparation/copy/sign-in/opening remain separate; later setup failure cannot discard a successful copy.
8. **Verify behavior.** Fixtures cover preservation, exact replacement, conflicts, interruption and Undo; meaningful native loading/execution needs client-specific evidence. Keep required checks and add uncovered behavior tests, not implementation mirrors. Documentation/fixtures grant no live or publication authority.

## Action boundary

| Item | Allowed action |
| --- | --- |
| Supported config/global instructions/agents/rules | Selected changes with diff, explicit conflicts and Undo; no arbitrary whole-config migration. |
| Standalone skills | Add/no-op/skip/exact replacement under rule 3. |
| Plugins/hooks/MCP | Conditional native/manual guidance only; parent owns plugin components. |
| Project/built-in resources | Keep existing ownership; do not assume shared runtime availability. |
| Memory/history/credentials/trust/caches/runtime/unknown state | No automatic transfer; explain unknowns without disclosing private contents. |

## Concrete acceptance cases

- Preview/cancel creates nothing, closes no clients and activates no integration.
- Selected-key copy preserves other settings and source-absent destination agents across all entry points.
- Exact skill replacement removes a previewed obsolete script; Undo restores it and its mode. Another package stays untouched; an intervening edit refuses Undo.
- Plugin/MCP differences yield necessary conditional instructions, not config writes or duplicate component tasks. Memory/conversations cannot be selected.

## Implementation and evidence boundary

Selected and category copying use the shared planner; bounded selection avoids project/history/memory/plugin-cache scans, while diagnostic inventory remains broader. Empty/identical selections create no transaction or client preparation. Metadata versions describe sources, not installed/runtime state.

[Historical copy/loading controls](history/README.md#profile-transfer-controls) and
[release summaries](AUDIT-ACCEPTANCE.md) retain source-bound results and limits.
