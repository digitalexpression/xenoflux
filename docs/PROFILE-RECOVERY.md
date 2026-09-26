# Recover an interrupted profile run

After a hard interruption, Xenoflux retains the native home's `.run-lock` so a
second login, launch, or resume cannot race a child process that may still be
writing. Inspect the candidate first:

```sh
xfx profile recover NAME
```

The preview is read-only and does not yet check desktop or native writers. It
identifies the bound profile, native root, run ID, and owner kind; apply performs
the final writer checks. Recovery is available only for a same-host private
lock owned by the current user, with a recognized owner, a definitely absent
owner PID, and matching profile metadata. For standalone CLI runs, the report under
`launches/<runId>/report.json` must match the profile ID, environment ID, and
home. A live or reused PID, malformed or foreign owner, missing/mismatched
report, or changed profile binding blocks recovery and preserves all state.

Before applying, close Codex and any other clients that may use the native home.
Then run recovery from an external interactive Terminal:

```sh
xfx profile recover NAME --apply
```

Apply takes the desktop operation guard and store writer lock, verifies there is
no active desktop selection or pending paired activation, and uses Xenoflux's
desktop and CLI process checks plus exact handle checks for the native root,
home, workspace, desktop data, configuration, credentials, and SQLite files. It
rechecks that the owner PID is absent and that the lock owner is unchanged before
changing metadata, then checks ownership again before releasing the lock.
Failed checks preserve the lock. If release is interrupted after the marker is
updated, rerun recovery; the already reconciled marker stays unchanged.
Recovery never shuts down clients automatically.

For an interrupted native sign-in, recovery changes only the matching setup
marker phase from `login-running` to `login-cancelled`, then releases the stale
run lock. If the marker already records a completed, failed, or cancelled login,
it leaves that phase unchanged and releases the lock. A `registered` marker means
login had not started; recovery also leaves it unchanged. It preserves credentials,
configuration, and other native-home data. If the phase is already
`login-completed`, sign-in finished; continue with the next setup step instead
of signing in again. For an interrupted standalone launch or resume, recovery
requires the matching run report and releases only the stale run lock; the
report stays as historical evidence. After recovery of a running, failed, or
cancelled sign-in, retry with `xfx profile signin NAME --apply`.

## Desktop selection recovery

Profile-run recovery refuses active or unfinished desktop selections and
pending paired activation state. Preserve their journals and reservations, then
use the desktop recovery flow:

```sh
xfx desktop current --observe
xfx desktop recover --no-open
```

No-open desktop recovery also requires clients and writers to be stopped first.
If paired paths, ownership, or journal agreement remain ambiguous, stop and
preserve the recovery state for inspection.
