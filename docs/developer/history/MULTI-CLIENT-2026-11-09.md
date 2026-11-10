# Multi-client development qualification — 2026-11-09

This is a local development result, not a release or general native acceptance.
The [roadmap](../ROADMAP.md) owns the eleven-slice status and remaining order;
the [plan](../CLIENT-SUPPORT-PLAN.md) owns interfaces and qualification operations.
No installed update, push, merge or publication occurred.

## Source and evidence

Implementation: `21a447f` on `codex/multi-client-autonomous`, based on `1c33dce`.
Documentation/qualification changes follow in a separate local commit.
Private raw receipts, failed controls, source hashes and the prepared qualification
manifest remain ignored under `local/client-support-autonomous/`; they are not
package inputs. Native catalog probe receipts also remain in the private controller
`catalog-probes` store. No credentials or credential hashes were collected.

## Established observations

| Check | Result and limit |
| --- | --- |
| Existing Codex roots | Three idle existing roots each advertised ten models through bounded initialization/account-read/model-list only. Native account metadata grouped them as one account, not distinct-account isolation. One busy root was refused and preserved. |
| Discovery scope | Two initial native probes changed settings scope, so their results were discarded. Separate repeat refreshes succeeded. All five started probes recorded confirmed owned-group shutdown and released their own claims; escaped descendants remain unverified. |
| Claude Code | Native 2.1.319 auth status showed a Claude.ai Pro login under the implicit default root. Explicit `CLAUDE_CONFIG_DIR` pointing to the identical path showed no login. No fallback, new sign-in or account change was attempted. |
| Copilot CLI | Native 1.0.107/protocol 3 answered status/auth/model-list with zero task submissions. Authentication was attributed to gh-cli; the model list was empty. This establishes neither profile-bound subscription isolation nor transport parity. Owned probe process/group shutdown was confirmed. |
| Stock desktop apps | Signed Claude 4.23118.0 and GitHub Copilot 1.1.35 passed fixed-path/bundle/executable/signature inspection. Ordinary open/focus succeeded and both native windows were observed. No prompt, connector/settings change, logical-surface selection, profile isolation, handoff/import or automation was qualified. |
| Model work | Xenoflux submitted no native inference/review/comparison turn or continuation. Initialization and configured-hook effects are separate; no zero-cost claim is made. Task-local implementation workers were explicitly authorized separately. |

The new stock opener additionally pins the observed vendor signing teams and
rechecks the exact build/executable immediately before opening. This tighter
identity check preserves applicability of the observed same-vendor opening;
fixture controls cover replacement/team changes and refusal before effects.

## Verification

| Check | Final result |
| --- | --- |
| JavaScript syntax, native helper, packaged documentation | Passed; 36 packaged Markdown files. |
| Full Node regression suite | 1,460 passed, zero failed, one opt-in skipped. |
| Final affected storage/runtime/catalog/app checks | 135 passed after the last opaque-ID storage change; complements the full regression run. |
| Opt-in native LaunchServices synthetic fixture | One passed separately; its own disposable app only. |
| Bundled UI types/tokens/parity and Chromium | Passed; all 60 journeys, run sequentially. New picker/app controls inspected at 320 px in both themes. |
| Detached unpublished package | CLI help, empty disposable registry, bundled HTML/JS serving and new-module/document membership passed. Artifact/source hashes remain in the private package receipt. |

The final affected checks establish applicability of the last storage change;
the complete browser and engine runs exercise the combined ordinary entry points.
There were no SDK dependencies, new authentication flows or installed updates.
Focused fixtures cover qualified opaque IDs and collisions; checkpoint/owner
races; duplicate Start; stale approvals with changed arguments/resources;
independent cancellation and shutdown; source-loss export/reopen; catalog
pagination, sparse efforts, revocation, account/context changes, late generations
and probe cleanup; plus signed-app replacement and explicit opening. Existing
copy/compensation/Undo and privacy controls remain in the full regression suite.

Failed controls are retained separately: the managed sandbox could not nest
`sandbox-exec` (EPERM/exit 71), and Chromium's Mach-port bootstrap was denied.
The first full native-fixture rerun then exposed three fixtures lacking the new
explicit catalog-refresh flow; the fixtures were corrected without relaxing
production validation. Later passing runs do not relabel those earlier failures.

## Remaining qualification

The [prepared batches](../CLIENT-SUPPORT-PLAN.md#next-bounded-qualification-batches)
state exact effects, prerequisites and proposed attempt/time bounds. The private
`qualification-batch.json` pins the next Codex model/effort choices, prompts,
checks and operations. It proposes at most six initial turns with no automatic
retry; it has not run and imposes no inferred token or credit budget.

Claude/Copilot execution adapters remain gated by independently signed-in
bindings and a qualified subscription-compatible native transport. Desktop
logical surfaces additionally need exact supported session/export sources,
account/project/policy/location attribution and separate native-control evidence.
Logout/account-switch/refresh lifecycle controls need their own effects grant.
Custom connections/BYOK, SSH and cloud execution remain deferred.

## Agent assignments

Only the coordinator spawned workers and performed signed-in profile/app
operations, integration, generated UI builds and commits. `gpt-6.1-sol` with
medium effort handled identity/contracts and catalogs; ownership, runtime
regressions and signed-app guards; and desktop boundaries/pickers/browser fixtures.
`gpt-6-luna` with medium effort extracted bounded supporting-source feasibility.
At most three workers ran concurrently. Workers used disposable/synthetic tests,
preserved concurrent edits, and made no commits or native-profile operations.
