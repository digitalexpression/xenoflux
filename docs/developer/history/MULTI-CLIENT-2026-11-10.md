# Claude/Copilot development qualification — 2026-11-10

Local development against the eleven-slice [plan](../CLIENT-SUPPORT-PLAN.md),
following the instruction to stop Codex qualification batches. The
[roadmap](../ROADMAP.md) owns current status and remaining gates. This batch made no policy,
sign-in or account changes, submitted no native model tasks, installed no updates
and published nothing.

## Source and evidence

Implementation source: `c65b7dca202c4094ab06a974d83f3402e94da4f8` on `codex/multi-client-autonomous`, based on
`97ef0e2`. This record follows the implementation commit. Private original
documents, SDK source/effects probes, raw transcripts, source hashes and native
receipts remain ignored under `local/client-support-plan-2026-11-10/`.
No conversation bodies or account identifiers are included here.

## Established boundaries

| Area | Result and limit |
| --- | --- |
| Identity | Explicit profile client validation rejects unsupported execution clients. Captured and frozen-report attribution is checked before publication/read; missing observations remain unknown. Model effort capability follows available metadata. |
| Claude file import | Pinned official SDK `0.3.322` file readers imported an existing 1,425,430-byte native transcript into 109 SDK-selected user/assistant message records. Original source bytes remained unchanged; 97 non-text blocks, 97 bodies and four system messages were omitted. Source/projection hashes matched retained artifacts; exported evidence reopened with the same identity and default body omission. No native agent or authentication operation ran. |
| Import lifecycle | Explicit two-file UI/API admission uses private bounded snapshots and publishes only after both reads succeed. Malformed input, source loss, privacy canaries, second-read failure, replacement-directory preservation, shared capacity and shutdown joins have disposable controls. Reopening frozen evidence does not reinitialize the reader. This selects no Claude execution transport. |
| Claude native | CLI 2.1.319 reported existing implicit Claude.ai Pro authentication. The exact-session `--desktop --resume` attempt supplied no prompt and exited 1 because redirected output is unsupported. No PTY workaround or replacement task was attempted. Signed Desktop 4.23118.1 was inspected; handoff/control remains unqualified. |
| Copilot native | CLI 1.0.107/protocol 3 answered only status/auth/model-list: gh-cli authentication, empty model list, zero tasks or policy writes. Owned process/group shutdown was confirmed; escaped descendants remain unverified. This does not establish independent subscription bindings or transport parity. |
| Copilot navigation | Signed app 1.1.35 registered the documented app-local session scheme. One deliberately missing local-session link reached the native missing-link screen; no session/task was created. The app had no existing sessions, so positive association remains unverified. New-task and GitHub-task links are not exposed. |
| Chat/Cowork | Official account/task export paths were investigated; no supported immutable conversation/task schema with required attribution was established. No private-format decoder or invented location/account evidence was added. |

The importer retains only public text in frozen evidence, with unknown profile,
model, usage, original surface and location. Raw originals remain private. SDK
updates require fresh reader/effects and privacy qualification. Existing
[export redaction and opt-in content rules](../../user/APP.md) still apply.

## Verification

| Check | Result |
| --- | --- |
| Syntax, packaged native helper and documentation links | Passed; 39 packaged Markdown files. |
| Full Node regression suite | 1,544 passed, zero failed, one opt-in skipped. |
| Final import/lifecycle/replay regression | 20 passed after the last shutdown/ownership fix; includes four new API/lifecycle controls. |
| UI tokens, types, generated bundle parity | Passed; 40 source files matched the bundled UI. |
| Detached unpublished package | Installed with scripts disabled in a temporary home; CLI, bundled assets, packaged reader/record, pinned SDK file read and source-free export/reopen passed. Package identity remains in the private receipt. |
| Chromium | All 66 journeys passed, run sequentially. New import/navigation forms inspected at 320 px in both themes; the focused rerun also passed all nine journeys. |

The complete Node run precedes the final import shutdown/cleanup changes; the
20 final affected checks establish those changes without relabeling the earlier
run. Browser fixtures use disposable native-style data and executables, not
signed-in clients or native model tasks.

Earlier failed browser controls are preserved privately: an overlong session ID
was silently truncated by the input; the input now retains and rejects it. A
restart/reopen fixture reused an expired launch session; it now uses the fresh
launch link. A replacement-directory regression also reproduced deletion of
foreign data during failed-import cleanup; cleanup now checks the original
creation identity. Passing reruns do not erase those failed controls.

## Remaining gates

Claude/Copilot execution and managed profiles still require two independent native
subscription bindings plus qualified authentication/transport behavior. Mixed
native execution/copy depends on those gates. Claude interactive exact handoff,
Copilot positive association and immutable app evidence, Chat attribution and
Cowork task/location imports need their own supported sources and receipts.
The current instruction excludes obtaining these by changing accounts/policies
or running another Codex batch; no such batch is prepared as the next step.
