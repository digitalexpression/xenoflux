# Profile creation and copy policy

Current transfer contract; [user commands](../user/ADVANCED-COPY.md). The [goal](AUDIT-GOAL.md#evolution-and-provider-version-policy) owns compatibility policy. Discovery may inspect more than copying supports; observation never authorizes transfer or activation.

## Purpose

The [client scope](AUDIT-GOAL.md#client-scope) defines profile and account
boundaries. The allowlists below define transfer eligibility within them.

Create fresh profiles or seed explicitly selected parts; profiles then evolve independently. Later copies are reviewed updates, not synchronization, effective-state clones, shared storage or a migration framework. Default is a source only.

## Rules

1. **Preserve unselected state.** All entry points share one planner/policy. Category selection cannot delete source-absent destination settings/items. Identical selections are no-ops.
2. **Preview exact effects.** Identify stable source/destination, origin, additions/changes/removals/identical/kept items, before/after supported values and file changes without secrets. Show unknowns, exclusions, dependencies and manual setup. Refuse unsupported/unsafe/ambiguous effects rather than guessing.
3. **Replace selected standalone skills exactly.** Include supported resources/scripts/modes; explicit keep/skip/replace on conflict. Preview obsolete destination files inside that package, preserve everything outside it, and support exact Undo. Never use partial overlays. Refuse unsupported packages, unsafe contents/type transitions or directories without required owner permissions before mutation.
4. **Integrations stay native/manual.** No copy/install/enable/connect/migration of plugin/hook/MCP definitions, grants or internal state, including broad config copies. Group plugin components under the parent. Only selected integrations receive guidance; name actual marketplace/identity/version when known and distinguish installation/enablement/trust/dependencies/account connection. Cache presence is not installation; check first and avoid duplicate actions. Automation requires a policy change.
5. **Respect ownership.** Project resources and built-ins remain with their owner; native sharing requires supported roots/scope and may differ by CLI/Desktop environment. No cross-profile symlinks or transferred credentials, permissions, cached authorization, project/hook trust, generated memory, conversations, databases or caches. Preserve authentication/storage routing. Supported selected policy/rule definitions are not migrated grants; preview their effects. Use reviewed durable guidance/fresh conversations instead of bulk memory/history transfer.
6. **Bound claims.** Presence/configuration/installation/enablement/discovery/use differ. Paths/manifests/publishers do not prove ownership; partial discovery stays explicit. Copying installs no external dependencies and rewrites no arbitrary references. Resume/fork does not erase old instruction context.
7. **Keep transactions and recovery exact.** Bind preview to source/destination client/root-mode identity and selected before/after content/mode fingerprints; recheck under the copy lock and refuse active or unresolved execution owners. Define field ownership before each live write; a stored selection does not prove the effective route. Reuse journal/conflict/Undo/recovery mechanisms. Restore replacements/deletions/modes, refuse intervening edits, and preserve original recovery records. Failed compensation retains an explicit uncertain journal and conflicting reservations. Current v3 journals only; reject unsupported older formats unchanged, without guessing/migrations. Manual setup is outside Undo. Preparation/copy/sign-in/opening remain separate; later setup failure cannot discard a successful copy.
8. **Verify behavior.** Fixtures cover preservation, exact replacement, conflicts, interruption and Undo; meaningful native loading/execution needs client-specific evidence. Keep required checks and add uncovered behavior tests, not implementation mirrors. Documentation/fixtures grant no live or publication authority.

## Action boundary

| Item | Allowed action |
| --- | --- |
| Supported config/global instructions/agents/rules | Selected changes with diff, explicit conflicts and Undo; no arbitrary whole-config migration. |
| Standalone skills | Add/no-op/skip/exact replacement under rule 3. |
| Plugins/hooks/MCP | Conditional native/manual guidance only; parent owns plugin components. |
| Project/built-in resources | Keep existing ownership; do not assume shared runtime availability. |
| Memory/history/credentials/trust/caches/runtime/unknown state | No automatic transfer; explain unknowns without disclosing private contents. |

## Claude Code and Copilot CLI allowlists

Copy requires a same-client local CLI route. Default is a source only. A named
endpoint requires its validated profile and environment binding; the configuration
root must be inside that profile’s reservation root. Preview binds the client,
root mode, directory identity and selected content and modes. The operation
checks both reservations and refuses active owners. It does not close either
client on the user’s behalf.

| Client | Keys in root `settings.json` | Standalone content inside the configuration root |
| --- | --- | --- |
| Claude Code | `model`, `effortLevel`, `theme`, `autoUpdatesChannel` | `CLAUDE.md`, Markdown under `agents/` and `rules/`, `skills/<name>/SKILL.md` and its package |
| Copilot CLI | `model`, `reasoningEffort`, `theme`, `stream`, `banner`, `beep` | `copilot-instructions.md`, Markdown under `agents/` and `instructions/`, `skills/<name>/SKILL.md` and its package |

`stream`, `banner` and `beep` require booleans; other listed keys require bounded
plain identifiers. The planner changes only selected top-level values and keeps
all other settings bytes. It refuses duplicate fields, unsupported selected
values, JSONC and malformed settings. Undo restores the original file and mode
or removes a file created by the copy. A changed destination file or mode blocks
Undo. This covers the selected file, without claiming effective precedence or
native loading.

Definitions must have known standalone ownership and safe paths. Supported
frontmatter is limited to simple single-line `name`, `description`, `model`,
`color`, `argument-hint`, `user-invocable` and `disable-model-invocation` fields.
Unsupported frontmatter, links and embedded integration definitions are refused
on either side of replacement. Skill packages may include ordinary resources
and scripts; recognized native state and integration files are excluded.

Only root `settings.json` is a settings source. Account stores such as Claude’s
`.claude.json` and `.credentials.json` and Copilot’s `config.json` are excluded,
as are history, project resources, runtime data, permission grants, hook trust
and plugin-owned files. Selected manual integration guidance stays outside the
transaction; a package cache or partial metadata cannot establish installation,
enablement or the need to reinstall.

## Concrete acceptance cases

- Preview/cancel creates nothing, closes no clients and activates no integration.
- Selected-key copy preserves other settings and source-absent destination agents across all entry points.
- Exact skill replacement removes a previewed obsolete script; Undo restores it and its mode. Another package stays untouched; an intervening edit refuses Undo.
- Plugin/MCP differences yield necessary conditional instructions, not config writes or duplicate component tasks. Memory/conversations cannot be selected.
- Failure after an owned settings write but before pointer/marker publication restores the exact pre-state; failed compensation remains uncertain and blocks conflicting mutation. Crash recovery cannot silently publish success.
- Destination edits before Undo are refused; concurrent execution blocks mutation. Effective profile-level overrides cannot be reported as the copied route without resolution/native evidence. Credentials, unrelated fields and original evidence survive every failure path.

## Implementation and evidence boundary

Selected and category copying use the shared planner. Copy never scans project, history or memory stores. Claude Code and Copilot inventory uses bounded setup discovery to identify native integrations and their ownership; only allowlisted standalone files can enter the transaction. Empty/identical selections create no transaction or client preparation. Metadata versions describe sources, not installed/runtime state.

The [acceptance criteria](AUDIT-ACCEPTANCE.md) define observable copy/Undo checks.
Copy success alone does not establish that a native client loaded the setup.
