# Inspect and selectively copy profile contents

Use [Profiles](PROFILES.md) to create a profile. The app supports same-client
copying for Codex, Claude Code and GitHub Copilot CLI; the commands below show
Codex. Cross-client copying is unsupported, and copied-setup native loading
remains unverified in the current beta scope.

`xfx profile inspect NAME` shows discovered contents and origin. Missing paths,
unsupported formats and scan limits remain explicit. Inspection can discover
project/plugin/system resources that are not eligible for copying; it does not
prove that the native client loaded an item. Project discovery neither copies
repositories nor grants project trust. Filesystem metadata such as `.DS_Store`,
`.git` and `.tmp` is omitted; legitimate hidden resources remain discoverable.

## Select individual items

Run from an external interactive terminal:

```sh
xfx copy Default Research --advanced
xfx copy Default Research --advanced --apply --close-clients
xfx profile create Research --from Default --advanced --apply --close-clients
```

The first command previews without applying. Advanced selection starts empty:
arrow keys navigate, left/right collapse or expand, Space selects, `/` searches,
`d` opens details and Enter reviews. Cancellation applies nothing; an empty copy
selection can still include optional manual setup guidance. Application requires
explicit confirmation. For a selected conflict, type `replace` or skip the item.

Supported selections are configuration keys, global instructions, supported agent
definitions, standalone skill packages and rules. Skills include resources and
scripts. Unsafe/unsupported packages are refused rather than partially copied.
Review origin, scope and source path when names coincide.

Unselected/destination-only content is preserved. Missing source items do not
imply deletion. Replacing a selected skill is exact: the preview lists obsolete
files/directories removed inside that package. Other packages stay untouched;
Undo restores prior files and supported directory shape/modes. Unsafe transitions
are refused before mutation. Identical selections return unchanged without client
preparation or a copy journal.

`--include config,instructions,agents` selects supported source items under the
same preservation policy. Use `--advanced` for individual selections and optional
setup guidance; these options cannot be combined. Created profiles subsequently
evolve independently; later copies are reviewed changes, not synchronization.

## Limits and dependencies

| Content | Treatment |
| --- | --- |
| Plugins, hooks and MCP connections | Optional native/manual setup guidance only. No installation, enablement, connection, trust or authentication changes. Known plugin components stay with their parent plugin. |
| Credentials, sign-in, permissions and trust | Never copied. Selected configuration values are checked for credentials; unrelated private integrations do not block safe keys. Native storage/authentication routing is preserved. |
| Conversations, generated memory, project references, caches, databases and RAM-log links | Not copy selections. Resume history in its owning profile or start a fresh task with a reviewed handover. |
| External requirements referenced by instructions/scripts | Not installed or rewritten. Check required commands, files and integrations yourself. |

Manual guidance is regenerated from current bounded metadata and has no saved
completion state. Matching definitions avoid redundant changes; unknown installed
versions/connections require checking the destination. Source/cache contents do
not prove installation. For a plugin, verify its exact marketplace identity before
installing anything; for MCP, check the native connection rather than adding a
duplicate definition. Manual setup is outside Undo.

The `compare` command retains its core settings scope. Use copy preview for
package changes and the optional guide for integration differences. Unknown
configuration may be visible without being copyable. CLI/Desktop environments can
expose different shared or machine resources. Test copied setup in a fresh task
through the intended interface; discovery does not establish use or adherence.

## Undo and interrupted setup

A successful copy returns its ID:

```sh
xfx copy undo COPY_ID
xfx copy undo COPY_ID --apply --close-clients
```

Undo refuses intervening edits. Preserve the current v3 journal and payload while
Undo is needed. Follow a reported recovery action before starting another copy.

Profile preparation, copy, sign-in and desktop integration are separate steps.
Cancelling after preparation leaves the profile prepared. Continue with
`xfx copy SOURCE TARGET --advanced --apply` or `xfx profile signin NAME --apply`.
Failed/cancelled sign-in does not erase a successful copy.

Before applying or undoing, affected native homes must be idle. `--close-clients`
allows graceful shutdown; close standalone terminal sessions manually when asked.
Inspection and preview never close applications. Desktop ownership may be
unobservable even when the selected target seems idle; that case stays blocked.
Xenoflux refuses to close an app hosting its own invocation. See the
[copy policy](../developer/PROFILE-COPY-POLICY.md) for the implementation contract.
