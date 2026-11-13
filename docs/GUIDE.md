# Use Xenoflux

Start with [installation](INSTALLATION.md), then run `xfx ui`. Open the printed
launch link and keep the terminal open. The server listens on `127.0.0.1` and
requires that link to establish a browser session. Running `xfx ui` again reopens
the app; Ctrl+C stops its server. `xfx ui --demo` uses marked synthetic data and
simulated actions without reading/changing profiles or clients.

## Find installed clients and existing profiles

The app opens **Setup** before profile creation. Review CLI and desktop findings
for Codex, Claude Code and GitHub Copilot, then review existing profiles.
Setup and Profiles recheck automatically every five seconds while visible and when
you return to the window. Use **Check again** for an explicit fresh check.

Discovery checks the selected PATH, standard client folders, the profile registry
and direct folders in Xenoflux's managed profile directory. It does not search
your whole home directory. Finding a client or folder does not prove sign-in,
runtime compatibility or account isolation. CLI versions are not checked by
running the clients.

An updated or removed installation changes its discovery finding. Removing a
profile from Xenoflux removes its registry entry; manually deleting its folder
leaves the entry visible as unavailable. Automatic checks do not delete or repair
profiles. Failed checks retain the previous findings with a stale-state notice
and retry automatically. Background checks preserve your current form and selection.

Older readable records remain supported. A profile without a native folder needs
setup; an unsupported record or registry format needs attention. Discovery leaves
the original files unchanged and offers no automatic migration. An invalid or
unsupported registry blocks profile operations without hiding installation findings.
Continue to **Profiles** when you are ready to create a profile or copy settings.

## Create and compare profiles

In Profiles, choose **Create profile**, select the client and choose **Empty** or
**Selected parts of another profile**. Review selected same-client copies before
creation. Empty means minimal management files, not authenticated or model-ready.
Creation, native sign-in and opening a client are separate steps; follow the setup
guidance before starting work. Credentials, conversations and generated memory
are never copied. Profiles subsequently evolve independently.

| Profile client | CLI | Desktop with the selected profile |
| --- | --- | --- |
| Codex | Open in Terminal | Open Codex Desktop, including to sign in |
| Claude Code | Open in Terminal; native sign-in guidance on the card | Separate Desktop startup and storage; authenticated session/model use unverified |
| GitHub Copilot | Open in Terminal; shared account scope remains explicit | Profile-bound local startup and storage; authenticated session/model use unverified |

**Open in Terminal** launches the current selected CLI through Xenoflux with the
profile's configuration root and an exclusive reservation. A bound project is
used when present; otherwise it opens the profile's private workspace. Launching
a CLI starts no task automatically. Close its Terminal session before changing
or copying that profile. A native startup can still write its own state or run
configured hooks.

For Copilot, choose **Open GitHub Copilot Desktop** on the profile card. The
signed installed app opens with that profile's storage. Xenoflux refuses an
already-running Copilot app or a profile reserved by other work; it never closes
those clients for you. Desktop sign-in remains inside the vendor app, separate
from the CLI's shared-account check.

For Claude, choose **Open Claude Desktop** on the profile card. Each profile has
its own Desktop data folder alongside its Claude Code configuration folder.
Other Claude Desktop instances can stay open. Xenoflux starts a new instance
and verifies its selected storage without focusing, closing or changing the
other instances. Desktop sign-in and its use of Claude Code settings remain
unverified. The CLI sign-in check does not check Desktop sign-in.

Claude and Copilot Desktop keep their profile reservations when the Xenoflux UI stops.
After you quit the app, choose **Release closed Desktop reservation** before
reusing the profile in the CLI, copying settings or editing its registry entry.
Xenoflux releases only confirmed-stopped ownership with no remaining profile
holders. Uncertain state stays reserved. A missing CLI does not prevent opening
an otherwise readable Desktop profile.

Copy preview lists additions, replacements, removals and kept items. Unselected
and destination-only state is preserved. Selected standalone skills are replaced
exactly, including resources/scripts; unsafe or ambiguous packages are refused.
Undo refuses intervening edits. Plugins/hooks/MCP receive optional native/manual
setup guidance, outside Undo; Xenoflux does not install, enable, connect or trust
them. A cache or matching definition is not proof of installation or availability.
Affected clients must be idle; the app reports blockers for you to close manually.
Other profiles can stay open while you copy. The app checks both copy profiles
for active reservations and file holders and never closes their clients.
See [terminal copying and recovery](CLI.md#profiles-copy-and-recovery).

Rename, repository binding and removal affect registry metadata; removing a profile
leaves its files on disk. Native Open controls submit no task. The separate **Native apps** controls open
stock Claude/Copilot with the app's existing setup; they do not select a managed
profile. A Copilot session link dispatch does not prove that the target session exists.

## Inspect and compare setups

From Setup or Profiles, choose **Inspect setup** to read one profile's settings,
instructions, agents, skills, hooks, plugins, MCP and memory settings. Inspect
values, file previews, source locations and reading limits. These are current
local setup sources, not proof of effective precedence, native loading or session use.
An absent CLI or sign-in does not prevent inspection of a safely readable profile.

Optionally choose a repository to include its project instructions and settings.
Use **Refresh setup** to reread the selected scope. Invalid repository paths fail
explicitly; they do not fall back to a comparison without project context.

Choose **Compare with…** to select another profile from the same or a different
vendor. Same-vendor comparisons retain **Same**, **Different**, **Could not compare**
and **Not applicable** within the sources read. Different-vendor comparisons align
categories for inspection while keeping each vendor's observations separate.
Matching names or values do not establish equivalent behavior. Missing or unreadable
evidence remains explicit, and copying between vendors is unavailable.
Inspection and comparison read files without opening, signing in or activating clients.

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

Claude and Copilot Desktop qualification covers local startup and selected-root storage.
Desktop authentication, effective session settings, model use and account
independence remain unverified. Cloud execution,
generic configuration editing and cross-client setup copying are outside the
supported scope. Xenoflux never transfers credentials or grants native trust
through inspection/copying.
