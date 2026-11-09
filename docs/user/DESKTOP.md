# Desktop profiles

Audience: users. Run desktop controls from an external interactive terminal.

## Open or focus

```sh
xfx desktop open Research
xfx desktop open OtherProfile
xfx desktop list --observe
```

`open` launches the original OpenAI-signed Desktop app with that profile's routes,
preparing controller-managed launcher files automatically. Opening a
running profile focuses that same instance. Named operations keep Default's
normal paths and leave other clients running. Different profiles can run
concurrently. Standalone CLI launch/resume requires Desktop closed; comparisons
and reviews can join a verified running instance.

Each profile uses fixed Codex, SQLite, UI-data and temporary paths. Desktop keeps
the account HOME for login-keychain access; account-wide resources can remain
shared. Xenoflux does not copy credentials, reset keychains or change their search
lists. Filesystem separation does not guarantee all native resources are isolated.

Use `xfx desktop open NAME` for profile-specific opening/focus and
`xfx desktop close NAME` for graceful quit. The running app keeps the vendor's
identity; ownership records associate its process with the selected profile.

## Observe, focus or close

```sh
xfx desktop list --observe
xfx desktop focus Research
xfx desktop close Research
```

In observed output, `observed.status` and its process list show what the process
check found. You may quit Codex normally. Observed listing and review Start
reconcile a confirmed-stopped Desktop reservation automatically; `open` also
reconciles it before reopening. Uncertain helpers or file holders preserve the
reservation. A concurrent ordinary review keeps its own reservation when Desktop
quits; review cancellation does not close Desktop. New Desktop launch while a
comparison or review owns the profile remains blocked.

`close` requests graceful quit of the verified target only. It refuses to control
an instance hosting the invoking command. A failed or incomplete identity/resource
check preserves the reservation; Xenoflux never force-kills arbitrary processes.

## Recover an interrupted desktop operation

```sh
xfx desktop recover Research --dry-run
xfx desktop recover Research
```

Recover only after that instance has stopped. Recovery verifies its journal,
reservation and remaining writers, and releases only its own stopped reservation.
It does not close or launch an app. For interrupted sign-in or a CLI run, use the
separate [profile recovery guide](PROFILE-RECOVERY.md).

## Explicit cache maintenance

Normal use needs only `desktop open`. For diagnostics or maintenance of a stopped
profile, `xfx desktop prepare NAME` creates or refreshes managed launcher files;
`xfx desktop refresh NAME` is an alias. These commands refuse running profiles.
`--dry-run` previews routing without preparing or launching.

For implementation details and the recorded native-test boundaries, see the
[developer desktop reference](../developer/DESKTOP-IMPLEMENTATION.md).
