# Inspect and selectively copy profile contents

This guide describes this checkout's
[profile creation and copy policy](PROFILE-COPY-POLICY.md). Published rc.6 differs:
it overlays skill packages and its category-copy mode can remove destination-only
settings. The updated behavior below requires this implementation's candidate.

Use `xfx profile inspect Default` or `xfx profile inspect Research --json` to inspect a profile. The inventory reports discovered contents and their origin. It does not prove that Codex loaded every item into a particular task.

Full profile inspection considers known project locations automatically. Copy selection reads supported settings and standalone resources without scanning project folders, conversation history, memories or plugin caches. Project-local resources remain associated with their projects: inspecting them does not copy repositories, grant trust, or change project files. Filesystem metadata entries `.DS_Store`, `.git`, and `.tmp` are omitted from inventory and counts without changing files on disk. Legitimate hidden resources such as `.system` remain discoverable. Missing paths, unsupported formats and scan limits are reported rather than treated as empty inventories.

## Select individual items

Run these commands in an external interactive terminal:

```sh
# Select and preview without applying changes.
xfx copy Default Research --advanced

# Review, then apply selected changes.
xfx copy Default Research --advanced --apply --close-clients

# Prepare a new profile with selected contents.
xfx profile create Research --from Default --advanced --apply --close-clients
```

Creation is the primary workflow: start fresh or seed a new profile with selected
contents. Profiles then evolve independently. Later copies show current differences;
they do not synchronize profiles or infer deletions from missing source items.

Advanced mode starts with nothing selected. Use arrow keys to navigate, left/right to collapse or expand categories, Space to select, `/` to search, and `d` to inspect details. Enter reviews the selection; cancellation leaves copying unapplied. An empty selection means no copied items and is distinct from cancellation. Optional manual setup guidance does not copy integration state. Final application still needs an explicit confirmation.

Supported selections are individual configuration keys, global instruction files, supported agent definitions, standalone skill packages, and rule files. Skills include their resources and scripts, not just their `SKILL.md`. Project, plugin and system resources retain their origin and are not silently promoted into profile-owned copies. A package with unsupported or unsafe contents is refused rather than partially copied.

For a selected destination conflict, type `replace` to replace that item or enter another response to skip it. Review each item's origin, scope and source path, especially when names coincide. Unselected items and configuration keys are preserved.

Replacing a selected skill is exact: the preview includes obsolete files and
directories that will be removed inside that package. Other skill packages remain
untouched. Undo restores the package's prior files and supported directory shape
and modes. Unsafe contents and unsupported file/directory transitions are refused
before mutation. Xenoflux never falls back to a partial package overlay.

`--include config,instructions,agents` now selects supported source items under the
same preservation policy. It no longer removes destination-only keys, instructions
or agents merely because the source lacks them. Use `--advanced` for individual
selection and optional setup guidance. These options cannot be combined.

Identical selections return unchanged without preparing clients or creating a copy
journal. Diff output distinguishes changes from items kept at the destination;
native instruction precedence is not inferred from the selected file alone.

## Limits and dependencies

Plugins, hooks and MCP connections are native/manual setup only. Select wanted
guidance separately from copied files. Steps identify known source/marketplace
identity, definition differences and verification needs; when installation or
availability cannot be established, check the destination first. Cache contents do
not establish installation. A plugin's known components stay with the parent plugin.
Xenoflux does not install, enable, connect, trust or configure these integrations.
Manual setup is outside copy undo and does not create a persistent checklist.

For example, selecting guidance for `formatter@personal` and MCP entry `docs`
may report that the plugin is configured in the source but its installed version
is unknown, while the destination already has the same MCP definition. The necessary
actions are to check the exact plugin and marketplace in the destination, install
only if absent, then review enablement and any sign-in/trust requirements. For `docs`,
verify its connection in Codex settings; do not add a duplicate definition. A version
read from a local plugin source describes that source, not the installed package.

The guide is regenerated from bounded current metadata whenever selected. It has no
saved completion state. Matching definitions suppress redundant definition changes;
unknown installation or connection state remains an explicit check. The existing
`compare` command retains its core settings scope; use the selected-copy preview for
package changes and the optional guide for integration setup differences.

Conversations, generated memory, project references and runtime artifacts are not
copy selections. Full diagnostic inspection retains its broader read-only scope.
Resume tasks in their owning profile, or use a fresh destination task with a reviewed
handover; copied or resumed history cannot promise a clean destination instruction
context. Credentials, sign-in, granted permissions, project/hook trust, caches,
databases and RAM-log links are not copied.

Instructions and skill scripts may reference external commands, files or integrations. Copying the selected files does not install those dependencies or rewrite arbitrary references. Review their requirements before using the destination. For config-key copying, credential checks apply to the selected values, so unrelated private integrations in the source configuration do not block copying safe keys. Unknown configuration is visible but not freely copyable; destination storage and authentication routing are preserved.

CLI and desktop discovery can differ because their user environments differ. Machine-level resources shown as shared or desktop-dependent may not be available to an isolated named CLI profile. Test the destination through the interface you intend to use.

## Undo and interrupted setup

A successful copy returns its ID:

```sh
xfx copy undo COPY_ID
xfx copy undo COPY_ID --apply --close-clients
```

Undo refuses to overwrite intervening edits. Preserve the controller's copy records and payloads until the operation is no longer needed. Interrupted copies report a recovery action; follow that action before beginning another copy.

The updated reader accepts earlier copy journals. Exact-package transactions record
deletions and directory state as well as file contents; do not downgrade the tool
while such a transaction needs recovery.

New-profile setup consists of separate preparation, copy, sign-in and desktop integration steps. Cancelling after preparation leaves the profile prepared. Continue copying with `xfx copy SOURCE TARGET --advanced --apply` or sign in using `xfx profile signin NAME --apply`. Cancelling or failing sign-in does not erase a successful settings copy.

Before applying or undoing, restore the desktop to Default. The `--close-clients` option permits the existing graceful shutdown workflow; standalone terminal sessions must be closed manually when requested. Inspection and preview never close applications.

Native skill execution and automatic rule enforcement require separate acceptance
for the client/interface used. Fixture checks and native discovery alone are not
proof of those behaviors.
