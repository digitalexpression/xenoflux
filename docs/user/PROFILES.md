# Create and use profiles

Audience: users. Start with [Installation](INSTALLATION.md) if `xfx` is not available.

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
xfx resume Research TASK_ID
xfx pick
```

Replace `TASK_ID` with a task from that profile's history. Different profiles can run
concurrently, but one profile cannot run in the managed CLI and desktop together.

## Compare and copy selected settings

```sh
xfx compare Default Research --include config,instructions,agents
xfx copy Default Research --include instructions,agents
xfx copy Default Research --include instructions,agents --apply --close-clients
```

Preview is read-only. Applying preserves unselected and destination-only settings.
For individual configuration keys, agents, standalone skills and rules, use
`xfx copy Default Research --advanced`. Applying or undoing from an external
terminal can request graceful shutdown; inspection and preview never close clients.

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
delete and unbind change registry metadata while preserving native files. Delete
and native unbind refuse an active desktop or unfinished operation. Use
`xfx --help` for the full command list and options.
