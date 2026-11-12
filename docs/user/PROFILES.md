# Create and use profiles

Audience: users. Start with [Installation](INSTALLATION.md) if `xfx` is not available.

Profile manager and task comparison for Codex, Claude Code and GitHub Copilot CLI on macOS.

Use `xfx ui` to choose a client when creating an empty profile or copying selected
parts of a same-client profile. Follow the native client’s sign-in guidance.
Claude’s observed route is per-root with the same account; Copilot’s qualified
GitHub CLI login is shared. Separate setup roots do not prove account independence.
See [scope and limits](APP.md#400-scope-and-limits), including unverified credential
refresh and current-installation handling.

The commands and native-history details below describe Codex profiles.

## Create and sign in

Preview a profile before applying setup:

```sh
xfx profile create Research
xfx profile create Research --apply --close-clients
xfx profile list
xfx profile inspect Research
```

Applying guided setup prepares a named native home and guides sign-in. It may
request graceful client shutdown before changes. If setup or sign-in was interrupted,
continue with `xfx profile signin Research --apply --close-clients`. A failed sign-in
does not erase completed setup or a successful settings copy. See
[profile recovery](PROFILE-RECOVERY.md) after a hard interruption.

Create a fresh profile, or seed one from explicitly selected source items:

```sh
xfx profile create Research --from Default --advanced --apply --close-clients
```

Profiles then evolve independently. Later copies are reviewed updates, not
synchronization. Credentials, conversations and generated memory are not copied.
The [copy guide](ADVANCED-COPY.md) covers supported selections and undo.

`Default` refers to Codex's normal paths, including `~/.codex`, and is a settings
source rather than a copy destination. Named profiles use separate native storage,
under `~/.xfx/profiles` by default. Resource discovery can differ between CLI and
desktop; inspection shows discovered contents, not proof of runtime availability.

## Open the desktop or CLI

```sh
xfx desktop open Research
xfx desktop list --observe
```

Repeated `open` focuses the running instance. See [Desktop profiles](DESKTOP.md)
for cache behavior and recovery. For the CLI:

```sh
xfx launch Research
xfx history --profile Research
xfx history --profile Research --id TASK_ID
xfx history --profile Research --id TASK_ID --json
xfx resume Research TASK_ID
xfx pick
```

Replace `TASK_ID` with a task from that profile's history. Different profiles can run
concurrently. Standalone `launch`/`resume` require exclusive use of the profile;
in-app comparisons and reviews use [shared execution](APP.md#review-a-comparison).

Exact lookup requires `--profile` and a UUID task ID. `Default` selects the normal
`~/.codex` home without registering a profile. Lookup never borrows another
profile, launches a client or resumes a task. `--id` cannot be combined with
`--search`, `--limit` or `--archived`.

| Exit | Meaning |
| --- | --- |
| 0 | Task found with the requested evidence. |
| 1 | No matching task in a readable index, or invalid arguments. |
| 2 | Lookup cannot establish an answer, or requested turn metadata is partial/unavailable. |

Without `--turns`, exact lookup reads index metadata and validates the rollout path
without scanning conversations. Add it to inspect recorded native turn context:

```sh
xfx history --profile Default --id TASK_ID --turns
xfx history --profile Research --id TASK_ID --turns --json > research-turns.json
```

JSON retains task lookup status separately from `turnMetadata.status`
(`ready`, `partial` or `unavailable`). Missing or conflicting context remains
explicit; current settings never fill historical gaps. The reader emits whitelisted
metadata, not conversation bodies, and does not change saved settings or task
contents. Read-only SQLite access can create coordination sidecars. For ownership,
child-task filtering and capture bounds, see
[history turn metadata](AUDIT-EVIDENCE.md#history-turn-metadata).

## Audit and compare profile setups or runs

Use the consolidated audit commands to compare profile resources for a repository
or inspect selected CLI/Desktop sessions. Audit includes discoverable skills and
other setup sources even when they cannot be copied into a profile. It also reports
the limits of historical skill and agent evidence. See [Audit profiles and native client
runs](AUDIT.md) for selectors, examples, exports, and evidence semantics.

## Copy selected settings

```sh
xfx copy Default Research --include instructions,agents
xfx copy Default Research --include instructions,agents --apply --close-clients
```

Copy preview is read-only. Applying preserves unselected and destination-only
settings. For individual configuration keys, agents, standalone skills and rules,
use `xfx copy Default Research --advanced`. Applying or undoing from an external
terminal can request graceful shutdown; audit inspection and copy preview never
close clients.

## Register and manage

Register an existing validated native directory with its CLI executable and version:

```sh
xfx profile register NAME ROOT --codex EXECUTABLE --codex-version VERSION
xfx profile rename NAME NEW_NAME
xfx profile bind NAME REPOSITORY
xfx profile unbind NAME REPOSITORY
xfx profile unbind NAME
xfx profile delete NAME
```

Replace the uppercase placeholders with real values. `unbind NAME REPOSITORY`
removes that repository binding; `unbind NAME` removes the native binding. Rename,
delete and unbind change registry metadata while preserving native files. Registry
changes refuse active native work or unfinished setup/copy operations. Use
`xfx --help` for the full command list and options.
