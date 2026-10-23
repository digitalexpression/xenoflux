# Historical isolation test support

Status: archived on 2026-10-22. This is a campaign-specific historical record,
not an active execution plan or a product/release prerequisite. Follow the
[shared goal](../../docs/developer/AUDIT-GOAL.md) and [active roadmap](../../docs/developer/ROADMAP.md):
Codex CLI/Desktop on macOS first, directly in the user's normal environment.

The old VM/whole-client isolation, exact-version envelope, mandatory human reviewer
and fixed campaign gates below describe that experiment only. They do not govern
ordinary profile comparison, audit entry paths or the next release. No campaign
is scheduled for resumption. Preserve original evidence, blocked launchers and
helper safety constraints; this archival change neither activates nor bypasses them.
Do not run guest probes on the host or remove production preservation controls.

<details>
<summary>Archived specification and observations (preserved verbatim)</summary>

# Offline Apple Container controls

Read [the isolation runbook](../../docs/developer/EVALUATION-ISOLATION.md) for the
boundary, private runtime/cache prerequisites, command and remaining paid-run gate.

`verify-apple.mjs` runs known fixture controls only. It creates/inspects each stopped
VM before starting it, validates all required guest observations and checks the
actual acceptance suites. `guest-probes.mjs` executes only inside the disposable
Linux guest. Neither file is an entry point for a paid evaluation.

Do not run guest probes directly on the host. Do not replace the frozen campaign's
check command or launchers. No daemon startup, software installation, registry
login, credential copying or existing-client operation is performed by the verifier.

`prepare-envelope.mjs` freezes a separate pending 12-slot envelope; optional
`--runtime RUNTIME.json` binds the retained offline worker. It does not change the
original campaign. `check-isolated.mjs ENVELOPE.json TASK_ID` validates that pending
envelope and checks the current disposable candidate in the VM, including the
existing eight safety controls. It cannot launch a model or approve paid work.

`snapshot-candidate.py` uses the installed macOS `/usr/bin/python3` for bounded,
descriptor-relative no-follow file acquisition; it never imports candidate code.
`native-policy.mjs` generates a restricted whole-client policy. Actual native
startup is blocked by managed-preference synchronization; this is not a working
native isolation claim. See the runbook for the retained failure and execution
gates, including abrupt-controller/VM recovery.

</details>
