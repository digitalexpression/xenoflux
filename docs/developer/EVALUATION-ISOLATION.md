# Historical offline isolation experiment

Status: archived on 2026-10-22. This is a campaign-specific historical record,
not an active execution plan or a product/release prerequisite. Follow the
[shared goal](AUDIT-GOAL.md) and [active roadmap](ROADMAP.md):
Codex CLI/Desktop on macOS first, directly in the user's normal environment.

The old VM/whole-client isolation, exact-version envelope, mandatory human reviewer
and fixed campaign gates below describe that experiment only. They do not govern
ordinary profile comparison, audit entry paths or the next release. No campaign
is scheduled for resumption. Preserve original evidence, blocked launchers and
helper safety constraints; this archival change neither activates nor bypasses them.
Do not run guest probes on the host or remove production preservation controls.

<details>
<summary>Archived specification and observations (preserved verbatim)</summary>

# Offline evaluation worker isolation

The acceptance-worker boundary is prepared and verified on macOS 26 / Apple
silicon using Apple Container 1.6.0. This is offline fixture evidence. No model
task, paid evaluation, account sign-in or human rating is part of this preparation.
The original evaluation specs still use blocked fixture launchers and are not an
approved execution envelope. See the [evaluation plan](REPEATED-SUBSTANTIVE-EVALUATION.md).

## Boundary

Each acceptance command gets a separate Linux VM. The checked configuration is:

- `--network none --no-dns`: no guest NIC, published ports, published sockets or
  forwarded SSH agent. Guest loopback remains available inside its own VM.
- A read-only guest root filesystem and exactly one read-only host share at
  `/fixture`, containing disposable copies of fixture/checker/oracle inputs only.
  No real home, profile, repository, client store, runtime socket or credential is
  mounted. `/tmp` is a 64 MiB tmpfs; no host directory is writable from the guest.
- UID/GID 65532, all Linux capabilities dropped, two CPUs and 768 MiB memory.
  Rosetta and nested virtualization are disabled.
- The explicit guest environment contains runtime metadata and disposable paths.
  Host authentication, proxy, SSH and Node-injection variables are not forwarded.
- The whole existing acceptance checker, both test subprocesses and their Node
  descendants run inside the VM. Candidate modules never execute on the host.

The verifier creates a stopped container, inspects its configuration and selected
kernel/init filesystem, then starts it. A parse error, unavailable inspection,
unexpected mount/environment, incomplete probe report, timeout or ambiguous result
fails the gate. It never falls back to an unrestricted host command.

## Runtime preparation and offline acquisition

The verified runtime was extracted privately from Apple's signed 1.6.0 package;
its published SHA-256, Apple installer signature and notarization were checked.
No system-wide installer or Docker startup was used. Executables, application
data, configuration snapshot, logs and cached images live in a task-owned private
root. Existing user configuration and registry credentials are not copied.

Apple's per-user launchd services are singletons. Before preparation or reuse,
verify no other Apple Container service owns those labels and check required host
ports are free. Never stop another installation to obtain this environment.
Require `system status --format json` to report the exact private app/install/log
roots, and verify the registered API/image-helper jobs and their environments.

Ordinary `container system start` can automatically fetch the init image and
consult the user's Keychain. This preparation instead registered the signed API
server directly with a private task-owned launchd plist, skipping that CLI pull
path. Public runtime assets were acquired separately through anonymous HTTPS,
with no personal registry authentication; OCI manifests and every referenced blob
were digest-verified before local `image load`.

The pinned worker platform manifest is
`sha256:85cdd100016a2e09927c0776bb7ebebcfefce5cd0af49893ada91cbc4d78ee22`
(linux/arm64, Node 22.23.3). The Apple vminit 0.52.1 platform manifest is
`sha256:fb07a2aa554e056347a6f18d286f73f3cd0e6840b1fc91a97b6006523d4f40a1`.
The kernel is the 6.18.35-197 image pinned by Apple Container 1.6.0; its archive
hash and extracted kernel hash are retained privately. Imported wrapper-index
descriptors are recorded separately from the original platform-manifest digests.

For offline checks, both image references use an owned loopback registry alias,
with a matching synthetic registry override in the actual image-helper job.
This avoids personal Keychain lookup if a local fetch path is reached. A listener
counts TCP connections, including failed TLS handshakes; any connection fails the
offline gate. Exact local image/platform content is checked before creation.
The configured vminit image is intentionally hidden by `image inspect`; its private
store descriptor is joined to the separately inspectable source alias and the
server-selected init snapshot. A missing cache is an error, not permission to pull.

Starting the API server also creates a host NAT vmnet service and binds loopback
DNS listeners, even when a guest has no network attachment. This is a runtime
startup side effect, not a guest egress allowance. No host DNS resolver file or
existing profile setting is installed or changed. Shut down only the task-owned
services after verification; retained files permit a later explicit restart.

## Verification and reuse

The reusable harness is in `test-support/evaluation-isolation/`:

```sh
node test-support/evaluation-isolation/verify-apple.mjs \
  /absolute/private/root/RUNTIME.json \
  /absolute/private/campaign/campaign.json \
  /absolute/private/root/NEW_ATTEMPT
```

It requires an already prepared private service and local cache. It never installs
software or starts services. `RUNTIME.json` binds canonical private paths, exact
kernel and image digests, loopback aliases and the strict synthetic control
environment; the verifier rejects additional environment keys. Its implementation
defines that task-local schema. The input campaign must be the frozen, explicitly
unpaid three-task fixture campaign. Output must be new; failed attempts and their
receipts are not overwritten. Runtime paths, raw output and receipts stay private.

The offline acceptance requires all 18 named safety observations, not merely a
nonzero exit. Positive controls establish that JavaScript ran, fixture reads and
tmpfs writes work, and the owned host TCP/Unix listeners really accept host-side
connections. Negative controls check host-file access, symlink access, writes
through the read-only share, host sockets, IPv4/IPv6 TCP and IPv4 UDP reachability,
environment leakage and inherited child boundaries. The guest must expose only
`lo`, zero effective capabilities and the expected read-only mounts.

All three reference implementations must pass both existing suites inside this
boundary (29 checks total); all three incomplete starters must fail both suites.
A known imported candidate also attempts synthetic host-canary reads/writes and
spawns a nested probe from both test subprocesses. Expected checker-owned empty
home/workspace variables are validated before the strict standalone child probe.
The host sentinel and fixture hashes must remain unchanged, no unexpected network
connection may occur, and every owned VM must be removed. Only generated VM names
are stopped/deleted; no global prune or cleanup of other containers is permitted.

## Execution envelope preparation

The next preparation layer is `prepare-envelope.mjs`. It reads the retained frozen
campaign without replacing its blocked launcher, homes, store, specs or checks:

```sh
node test-support/evaluation-isolation/prepare-envelope.mjs \
  --campaign /absolute/private/campaign/campaign.json \
  --runtime /absolute/private/runtime/RUNTIME.json \
  --output /absolute/private/NEW_ENVELOPE
```

The output is a new private directory with a read-only `envelope.json` and a
preparation receipt. Existing output is refused. The envelope fixes the 12 balanced
slots, original task commits/trees, support-file maps, oracle/checker/skill hashes,
working observer sources, runtime descriptor, original quality fingerprints and
new isolated-check commands/fingerprints. Model, effort, account, currency budget,
provider enforcement and reviewer remain null; execution and paid approval stay
false. Editing an approval boolean does not turn this into a paid executor.
The runtime argument can be omitted for a structurally prepared envelope, but its
offline acceptance command then refuses to run.

`check-isolated.mjs ENVELOPE.json TASK_ID` runs from the disposable candidate
workspace. It validates the envelope and frozen sources before any VM operation.
It uses the same checked runtime boundary and runs the eight existing controls,
then a ninth VM for the candidate. The proposed command timeout is 10 minutes to
include those controls and VM startup/cleanup; the old spec's 40-second command is
unchanged. All this time counts within the proposed existing trial/series limits.
These changed commands and fingerprints require a new execution approval.

Candidate acquisition uses `/usr/bin/python3 -I -B` (isolated mode, no bytecode
cache writes) and descriptor-relative, no-follow
opens for every directory and file. Only bounded, owned, regular, single-link files
are accepted; symlinks, hardlinks, FIFOs, devices, oversized or changing inputs are
refused. The controller copies bytes without importing candidate modules. Only
allowed editable files may differ from the frozen workspace map; support files
must match. Acquisition fingerprints are rechecked after transfer and checking.
Candidate Git metadata is excluded and is not independently verified. The frozen
source repository's commit/tree is checked separately. Stop and drain the owned
native client before acquisition; isolation from malicious same-user host mutation
is not claimed.

Both suites import the candidate only inside the no-network guest. Ordinary return
requires checked cleanup and an empty owned-VM inventory. Abrupt controller death
and cancellation across the VM daemon are not yet accepted recovery evidence;
process-group shutdown alone cannot establish that a daemon-owned VM stopped.
Those cases remain a paid-execution gate. Keep all failed attempts and raw output
private, and never use a direct host check as a fallback.

## Native-client preparation: blocked

`native-policy.mjs` prepares a deny-default profile for the entire pinned macOS
native executable and descendants, fresh private homes/runtime/workspace and one
loopback TCP provider port. System runtime reads and filesystem metadata remain
explicit allowances; credential services, preference IPC and unrelated host
contents are denied. It performs no launch, sign-in or profile registration.

The pinned native `0.163.0-alpha.10.2` version probe works under the outer sandbox.
Five direct synthetic JavaScript/filesystem/environment controls pass. Actual
app-server initialization then fails with **Failed to synchronize managed
preferences**, before any provider request or native tool execution. Read-only
access to the exact native preference domain and its IPC, and a disposable
process-local preference home, did not resolve that failure in retained
countercontrols. No broad preference/host-service grant was accepted. A copied
native binary was killed before startup; the unchanged original was used only for
the bounded version and blocked initialization probes.

This is a prepared policy and a reproduced blocker, **not verified native-client
isolation**. Native exit zero did not satisfy acceptance: the thread/configuration
request was denied and capture remained partial. Machine-wide policy is not proven
absent. A disposable macOS VM/test account, or a narrowly justified policy with
successful native/tool/child safety controls, is needed before paid execution.
No credential or account-backed provider was used for these controls.

## Remaining execution gate

These are bounded controls of the pinned worker configuration, not proof against
every VM/kernel escape, malicious same-user host mutation or resource-exhaustion
attack. Oracle separation is a review protocol, not secrecy from imported code.
Runtime acquisition used the network; the verification phase used local assets.

The Linux worker is not a completed Linux port of xfx or a native Codex campaign.
The prepared offline envelope binds the candidate file mapping, check argv and
new fingerprint; native model-client isolation remains blocked. Do not reuse the old direct
host check command or silently replace its blocked launcher. Model/effort/native
binary/account route, budget enforcement and reviewer are still unapproved.
Paid execution, commit, push, publication and installed xfx updates require their
own authorization.

Native platform reference: [official Codex permissions](https://learn.chatgpt.com/docs/permissions#how-enforcement-works). The retained probes above establish this preparation’s actual result.

Sources: [Apple Container 1.6.0 command reference](https://github.com/apple/container/blob/1.6.0/docs/command-reference.md),
[private-root and service constraints](https://github.com/apple/container/blob/1.6.0/BUILDING.md),
[pinned service startup](https://github.com/apple/container/blob/ca4884f8f3a13b62c90ea2fb3834f214d61fb91c/Sources/APIServer/APIServer%2BStart.swift),
[image authentication](https://github.com/apple/container/blob/ca4884f8f3a13b62c90ea2fb3834f214d61fb91c/Sources/Services/ContainerImagesService/Server/ImagesService.swift).

</details>
