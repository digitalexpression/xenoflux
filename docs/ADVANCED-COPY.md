# Inspect and selectively copy profile contents

Use `xfx profile inspect Default` or `xfx profile inspect Research --json` to inspect a profile. The inventory reports discovered contents and their origin. It does not prove that Codex loaded every item into a particular task.

Full profile inspection considers known project locations automatically. The advanced copy selector excludes project-owned resources and does not scan project folders. Project-local resources remain associated with their projects: inspecting them does not copy repositories, grant trust, or change project files. Missing paths, unsupported formats and scan limits are reported rather than treated as empty inventories.

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

Advanced mode starts with nothing selected. Use arrow keys to navigate, left/right to collapse or expand categories, Space to select, `/` to search, and `d` to inspect details. Enter reviews the selection; cancellation leaves copying unapplied. Final application still needs an explicit confirmation.

Supported selections are individual configuration keys, global instruction files, supported agent definitions, standalone skill packages, and rule files. Skills include their resources and scripts, not just their `SKILL.md`. Project, plugin and system resources retain their origin and are not silently promoted into profile-owned copies. A package with unsupported or unsafe contents is refused rather than partially copied.

For a selected destination conflict, type `replace` to replace that item or enter another response to skip it. Destination-only items and unselected configuration keys are preserved. Selecting a skill preserves destination files not present in the source; inspect the final preview because the resulting destination package can contain additional files.

The established `--include config,instructions,agents` category-copy workflow is unchanged: it replaces the selected supported categories and can remove instruction or agent files absent from the source. Use `--advanced` for item selection and preservation of unselected entries. These options cannot be combined.

## Limits and dependencies

Plugins, hooks, MCP connections, project references, conversations and memories are inventory-only in this version. Their visibility is not a promise of transfer support. The selector shows only recognized main conversations, excluding subagent, guardian/review, side-chat and linked child threads; unknown classifications are omitted. Full profile inspection retains the broader inventory. Conversations represent native thread records, identified first by their desktop name (falling back to the stored title), followed by a short ID; details show the full ID, project directory and update time when available. Session/index storage files are not listed as additional conversations in the selector. Credentials, plugin sign-in, hook trust and project trust are not copied. Runtime caches, locks, databases and RAM-log links are not copied.

Instructions and skill scripts may reference external commands, files or integrations. Copying the selected files does not install those dependencies or rewrite arbitrary references. Review their requirements before using the destination. For config-key copying, credential checks apply to the selected values, so unrelated private integrations in the source configuration do not block copying safe keys. Unknown configuration is visible but not freely copyable; destination storage and authentication routing are preserved.

CLI and desktop discovery can differ because their user environments differ. Machine-level resources shown as shared or desktop-dependent may not be available to an isolated named CLI profile. Test the destination through the interface you intend to use.

## Undo and interrupted setup

A successful copy returns its ID:

```sh
xfx copy undo COPY_ID
xfx copy undo COPY_ID --apply --close-clients
```

Undo refuses to overwrite intervening edits. Preserve the controller's copy records and payloads until the operation is no longer needed. Interrupted copies report a recovery action; follow that action before beginning another copy.

New-profile setup consists of separate preparation, copy, sign-in and desktop integration steps. Cancelling after preparation leaves the profile prepared. Continue copying with `xfx copy SOURCE TARGET --advanced --apply` or sign in using `xfx profile signin NAME --apply`. Cancelling or failing sign-in does not erase a successful settings copy.

Before applying or undoing, restore the desktop to Default. The `--close-clients` option permits the existing graceful shutdown workflow; standalone terminal sessions must be closed manually when requested. Inspection and preview never close applications.
