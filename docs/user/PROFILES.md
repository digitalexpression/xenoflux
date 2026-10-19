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
xfx history --profile Research --id TASK_ID
xfx history --profile Research --id TASK_ID --json
xfx resume Research TASK_ID
xfx pick
```

Replace `TASK_ID` with a task from that profile's history. Different profiles can run
concurrently, but one profile cannot run in the managed CLI and desktop together.

Exact history lookup requires `--profile` and a UUID task ID. It reads metadata only
from that profile's native home, including archived tasks, and reports the
task ID, workspace, profile provenance and archive state. `Default` selects the
standard `~/.codex` home without registering a profile. Without `--turns`, lookup
reads index metadata and validates the rollout path without scanning its contents.
It never falls back to another profile, launches a
client or resumes a task.
`--id` cannot be combined with `--search`, `--limit` or `--archived`.

Lookup exits with 0 when found, 1 when a readable index contains no matching task,
and 2 when lookup cannot establish an answer (unbound home, absent index,
unavailable database or malformed matching metadata). JSON includes `status`,
the requested `id`, `entry` (or null), and the `home` evidence with its own status
and reason. Invalid arguments use the usual CLI error output and exit code 1.
Ordinary history listing and title search retain their existing options.

Add `--turns` to inspect the selected task's native turn metadata:

```sh
xfx history --profile Default --id TASK_ID --turns
xfx history --profile "Research" --id TASK_ID --turns --json > research-turns.json
```

The reader verifies the rollout's session ID and reports each `turn_context`
observation: turn ID, recorded timestamp, working directory, workspace roots,
model and reasoning effort, with the source file and line. Differing observations
for the same turn remain visible. Turn-start records without a context produce
unknown fields. Missing or invalid fields are null with a reason; saved settings,
the index's latest task settings and session-level defaults never fill them in.

JSON adds `turns` and `turnMetadata`, whose status is `ready`, `partial` or
`unavailable`. A found task with partial or unavailable turn metadata exits with 2;
the task lookup status remains `found`. The reader takes a bounded snapshot of
the selected rollout: 32 MiB, 1 MiB per line and 10,000 turn metadata records.
Malformed or oversized lines, unterminated records, concurrent changes and limits
are reported as incomplete evidence. It rejects unsafe paths and mismatched IDs.

Rollouts contain conversations alongside metadata. This opt-in scan emits only
the metadata whitelist, without exporting messages, instructions or tool outputs.
Saved profile settings, registry and native task contents are unchanged; read-only
SQLite access may create coordination sidecars. The output records native-reported
turn context, not proof of backend routing or each tool's working directory.
Compatibility depends on the native rollout format; unavailable metadata stays
explicit rather than being reconstructed.

For a selected child task, the reader verifies its parent against the same native
index and matching rollout headers. It returns only turns positively linked to
that child by native ownership identifiers. Inherited or otherwise unattributed
turns are excluded; `turnMetadata.parentTaskId` and `unattributedTurnCount` explain
the relationship and completeness limit. The count is distinct turn IDs observed
in the bounded snapshot, not a full-history total. Retained evidence is partial
when attribution is missing, and unavailable when no child turns are safely
attributed or identities conflict. Shared session/root IDs, timestamps, models
and inherited-history ordinals never establish ownership. Repeated observations
and attributed start-only turns retain the existing conflict/null semantics.
Ownership records provide identifiers only; token amounts are not reported.
Parent rollouts are not scanned and children are not automatically discovered.

## Audit and compare profile setups or runs

Use the consolidated audit commands to compare profile resources for a repository
or inspect selected CLI/Desktop sessions. Audit includes discoverable skills and
other setup sources even when they cannot be copied into a profile. It also reports
the limits of historical skill and agent evidence. See [Audit profiles and Codex
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
delete and unbind change registry metadata while preserving native files. Delete
and native unbind refuse an active desktop or unfinished operation. Use
`xfx --help` for the full command list and options.
