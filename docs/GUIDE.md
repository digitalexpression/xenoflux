# Use Xenoflux

Start with [installation](INSTALLATION.md), then run `xfx ui`. Open the printed
launch link and keep the terminal open. The server listens on `127.0.0.1` and
requires that link to establish a browser session. Running `xfx ui` again reopens
the app; Ctrl+C stops its server. `xfx ui --demo` uses marked synthetic data and
simulated actions without reading/changing profiles or clients.

## Create and compare profiles

In Profiles, choose **Create profile**, select the client and choose **Empty** or
**Selected parts of another profile**. Review selected same-client copies before
creation. Empty means minimal management files, not authenticated or model-ready.
Creation, native sign-in and opening a client are separate steps; follow the setup
guidance before starting work. Credentials, conversations and generated memory
are never copied. Profiles subsequently evolve independently.

Compare two setups to inspect current settings, instructions, agents, skills,
hooks, plugins, MCP and memory settings. **Same**, **Different**, **Could not
compare** and **Not applicable** describe discovery, not native loading or use.
Comparing reads files; it copies nothing and does not sign in or activate anything.

Copy preview lists additions, replacements, removals and kept items. Unselected
and destination-only state is preserved. Selected standalone skills are replaced
exactly, including resources/scripts; unsafe or ambiguous packages are refused.
Undo refuses intervening edits. Plugins/hooks/MCP receive optional native/manual
setup guidance, outside Undo; Xenoflux does not install, enable, connect or trust
them. A cache or matching definition is not proof of installation or availability.
Affected clients must be idle; the app reports blockers for you to close manually.
See [terminal copying and recovery](CLI.md#profiles-copy-and-recovery).

Rename, repository binding and removal affect registry metadata; removing a profile
leaves its files on disk. Native Open controls submit no task. Managed desktop
profiles are Codex-only. Signed stock Claude/Copilot opening uses the app's existing
account and establishes no managed isolation or logical surface. A Copilot session
link dispatch does not prove that the target session exists.

## Compare a task

Choose a profile for each side and a repository, then describe one task. Both
sides may use the same profile or different supported clients. Review the pinned
commit, model/effort, permissions, limits and any setup/check commands before
**Start 2 model runs**. Sides run sequentially in separate copies of committed
source; dirty, untracked and ignored files are excluded.

No checks are selected automatically. Setup/check programs run outside the Codex
sandbox and can affect external files/services; select trusted commands. Codex
comparisons default to workspace-write with networking disabled and offer read-only.
Other clients use their supported permission modes. Ordinary review inherits native
permissions. Matching effort labels across clients do not imply equal computation.

**Refresh models** initializes the client without submitting a task. It can use
sign-in, write native state or run configured startup hooks. Browsing/preview uses
cached metadata; changing the model clears explicit effort. Start rechecks explicit
choices. Advertised choices do not prove account entitlement or applied settings.
Copilot Auto may route each turn differently.

Independent comparisons/reviews can overlap, including on one profile, with separate
progress, approvals, cancellation and results. Simultaneous review workspaces must
not overlap. Profile mutations and new Desktop startup are blocked by execution
reservations. The controller's default capacity is eight jobs. Shared activity
limits timing comparisons.

## Compare existing sessions

Select two sessions; the first is the left side and **Swap sides** reverses them.
For different profiles/clients, use **Choose recent sessions by profile**, select
each profile and **List recent sessions**. Changed context needs a fresh selection.
Managed Copilot listing uses its first bound repository; bind one before listing.
History inspection starts no model task. Titles alone do not prove the same task.

On **Open saved report**, you can also select two UTF-8 UUID-named Claude `.jsonl`
files, up to 8 MiB each, or enter two existing Copilot CLI/app session UUIDs.
Copilot needs its native CLI on PATH and implicit sign-in; token/custom-root
overrides are refused. These readers retain selected public user/assistant text
as partial evidence, omitting tools, reasoning and system content. Original account,
surface/location, completion and usage remain unknown. Export freezes the projection
so native histories are no longer needed. Raw transcripts remain private.

## Read and export a report

| View | Meaning |
| --- | --- |
| Responses and replay | Recorded text, events, owned delegations, references and explicit gaps. Each side has its own order and elapsed-time origin. |
| Assessment | Named check recipes, status, timing and retained output. Matching names alone do not establish equivalent checks; Inspect never reruns them. |
| Time and tokens | Scoped counters, not billing or quality. Cached input is part of input, reasoning part of output, and overlapping spans are not summed. Missing totals stay unknown. |
| Outcome and code | Captured source-baseline-to-task-end changes, which may include setup. Ignored/unchanged/binary/oversized contents and fallback timing remain explicit. |

In replay, **Open delegated session** follows a child; **Return to calling event**
restores that side's event/search/scroll. Select an event for the inspector;
**F6** switches focus and **Escape** closes it. **Source and event details** shows
recorded references. Reopening never adds later activity or reconstructs missing
history from today's files.

Completion, verification and reviewer judgment are separate. No checks means
unverified. Discovery, selection, invocation, successful read and adherence are
different observations. A validated captured-session token sum does not prove
complete workflow discovery. One pair proves neither consistency, causality nor
a universal winner. [CLI evidence rules](CLI.md#read-and-export-evidence) cover
strict capture, historical metadata and comparison exit codes.

Export writes Markdown and its `.md.audit.json` companion to a new folder under
`~/Xenoflux reports/`; keep both together. **Open saved report** reads the JSON
exactly as saved. Event/check/patch bodies are omitted unless **Include recorded
messages and tool content** is selected. Known-secret redaction cannot remove all
private prose/code; inspect both files before sharing. A review's bound evidence
cannot be silently stripped while retaining that review.

## Request a review

From a comparison, choose **Review**, select a profile and its ordinary workspace,
edit the prompt and choose the included content. **Preview review** shows frozen
inputs, executable, prompt and limits without starting a session. Editing invalidates
preview. **Start review** submits one ordinary task through the selected client's
CLI, using its sign-in, instructions, integrations and permissions. Prompting it to
reason from the report is not enforced isolation; native history/runtime effects apply.

Blank model/effort fields inherit defaults. Explicit choices are rechecked and
reported as applied only when native evidence confirms them. Review duration is
uncapped by default with an optional time cap, no token/dollar cap and bounded
process output. Exact native approval/input requests require your response once;
nothing is answered automatically. Cancel stops only owned work and retains partial
output. An already-running managed Codex Desktop can stay open during review.

Read the captured response and use **Open its comparison and evidence** to return
to frozen inputs. Inputs/responses survive source loss; partial text is not completed
review. Ordinary responses are attributed text, separate from structured ratings,
and are not included in comparison exports. Optional external review uses **Reviews**
> **Prepare packet for external review** and imports a submission for that exact
packet without calling an AI service; [CLI recipes](CLI.md#external-reviews) explain it.

## Recover interrupted work

Refreshing or closing a tab leaves started work running. Stopping the server
interrupts owned work and preserves records; reopening never reattaches, resends,
resumes or starts model work automatically. Open the task under Recent and preview
**Tidy up and keep the record** if recovery is offered. Only confirmed-stopped owned
resources are reconciled; uncertain/live ownership stays blocked. Failures remain
visible after a successful later attempt. Separate terminal recovery commands are
in [CLI recovery](CLI.md#profiles-copy-and-recovery).

If the launch-link warning appears, run `xfx ui` again and use its printed link.
If the server is unreachable, restart it and inspect the recorded task state.
For denied history access, grant the terminal relevant Files and Folders access
in macOS Privacy & Security settings. Omit `--port` to select a free port.

## Supported clients and known limits

The supported platform is local Apple Silicon macOS with Codex, Claude Code and
GitHub Copilot CLI. Profiles follow current selected installations and capabilities;
a replaced executable/root after preview requires a new preview, not a version pin.
Claude's observed account route is per-root/same-account; Copilot's qualified
`gh-cli` route is shared. Separate roots do not prove separate accounts.

Credential refresh, distinct-account independence and shared sign-out isolation
are unverified. Some native pair/mode combinations, repeated overlap stress,
controller-kill reviews and copied-setup loading remain deferred. Real Codex
stale-callback recovery is unobserved; synthetic Desktop fixtures do not establish
real sign-in, Dock behavior or account isolation. Unreported effort/usage stays
unknown, and sampled ancestry does not prove escaped descendants stopped.

Managed Claude/Copilot desktop profiles, cloud execution, generic configuration
editing and cross-client setup copying are outside the supported scope. Xenoflux
never transfers credentials or grants native trust through inspection/copying.
