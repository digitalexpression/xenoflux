# Use Xenoflux

Start with [installation](INSTALLATION.md), then run `xfx ui`. Open the printed
launch link and keep the terminal open. The server listens on `127.0.0.1` and
requires that link to establish a browser session. Running `xfx ui` again reopens
the app; Ctrl+C stops its server. `xfx ui --demo` uses marked synthetic data and
simulated actions without reading/changing profiles or clients.

The app opens **Profiles**. The sidebar also opens **Sessions** and **Comparisons**.
In Comparisons, choose **Use existing sessions**, **Run a new task** or
**Choose two profiles**, or open **Saved reports** from the sidebar.
**Activity** opens current jobs and recent comparison records. The toolbar keeps
Back, Forward and the current page's breadcrumb available across these journeys.
Use the toolbar’s sidebar toggle to switch between icons and full navigation.
Use **Theme** for System, Light or Dark. The choice is remembered in this browser.

## Find installed clients and existing profiles

**Profiles** lists the standard setups and registered profiles Xenoflux can read.
Expand **Client discovery** at the bottom for CLI and Desktop installation findings,
known folders that need attention, and stock app controls. Discovery rechecks
every five seconds while expanded and visible, and when you return to the window.
Use **Check again** for an explicit fresh check.

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

## Create and compare profiles

In the Profiles toolbar, open **Add a profile** and choose **Create profile**. Select the client
and choose **Empty** or **Selected parts of another profile**. Review selected
same-client copies before creation. Empty means minimal management files, not
authenticated or model-ready.
Creation, native sign-in and opening a client are separate steps; follow the setup
guidance before starting work. Credentials, conversations and generated memory
are never copied. Profiles subsequently evolve independently.

Use **Add existing profile folder** in the same menu to register a Codex folder.

| Profile client | CLI | Desktop with the selected profile |
| --- | --- | --- |
| Codex | Open in Terminal | Open Codex Desktop with the same profile sign-in |
| Claude Code | Sign in through the browser; Open in Terminal for interactive work | Open Claude Desktop with its own sign-in |
| GitHub Copilot | Sign in with GitHub for this profile; Open in Terminal for interactive work | Open GitHub Copilot Desktop with its own sign-in |

Profiles groups entries by client. **Details** highlights the selected card and
replaces the inspector’s guide with that profile’s information. Each entry
keeps inspection links separate from sign-in and opening actions. **More** contains
the available registry edits and selected-copy actions. Profiles shows the email
or GitHub username reported by the profile’s CLI. A named Codex profile uses the
same account in CLI and Desktop. Check the account menu in Claude Desktop or
Copilot Desktop for their separate sign-ins.

If Xenoflux finds a vendor’s standard setup, it shows a **Default** card in that
client’s group. **Open in Terminal** uses the vendor’s normal CLI and existing
setup. Opening the regular Desktop app and opening the Default CLI are independent
actions. Xenoflux reports **Unknown** when it cannot attribute a stock process.

Profiles checks managed CLI and Desktop state while it refreshes. **Unknown**
means the process could not be verified. **Unavailable** means the client or its
profile binding was unavailable. Open **Details** for the observation that led to
the label. The account line describes sign-in separately. **Sign in required**
appears when no usable sign-in is established, with the exact finding in **Details**.

Each profile offers the sign-in action that matches its status. For a named Codex
profile, use **Sign in via Terminal** when sign-in is required, or open Codex Desktop
to sign in there. Each named Codex profile has its own native
account store. Its CLI and Desktop use the same sign-in, and you can choose a
different account on another profile. **Sign-in saved** means Xenoflux found the
profile's `auth.json` file.

After signing in, you can open CLI and Desktop on the same named Codex profile
in either order. Closing one leaves the other running. Concurrent use requires a
Codex CLI that supports `--no-daemon` and an existing log storage route both
clients can use. Close both clients before changing or copying the profile.

When you open Profiles, Xenoflux checks the CLI sign-in status for available
standard and managed Claude Code and Copilot profiles. It checks again when a
finding expires or its verification is cleared while Profiles is open. The card
retains the last checked account while a check is pending. If a managed profile
is signed out or its sign-in route can’t be verified, choose **Sign in** or
**Sign in with GitHub** and finish in your browser. GitHub may ask for the device
code shown in Xenoflux.
Xenoflux verifies sign-in automatically and hides the sign-in action while the
result is current. After five minutes, Xenoflux marks the previous result **last
checked**. Checking again can renew Copilot account qualification for tasks.

Claude Code and Copilot CLI sign in to the selected profile. For existing managed
Copilot profiles that used the shared GitHub CLI login, choose **Sign in with
GitHub** to set up a native Copilot CLI account for that profile.

You can cancel a pending sign-in. Cancellation stops Xenoflux's login process;
it does not undo authorization already completed in your browser. Closing the
Xenoflux server cancels pending sign-ins. If browser authorization cannot finish,
retry from Xenoflux. Xenoflux never asks you to paste a credential or Claude
authorization code. CLI sign-in does not verify Desktop sign-in.

**Open in Terminal** launches the current selected CLI through Xenoflux with the
profile's configuration root and a profile reservation. A bound project is
used when present; otherwise it opens the profile's private workspace. Launching
a CLI starts no task automatically. Close its Terminal session before changing
or copying that profile. A native startup can still write its own state or run
configured hooks.

For Copilot, choose **Open GitHub Copilot Desktop** on the profile entry. The
signed installed app opens with that profile's storage. Xenoflux refuses an
already-running Copilot app or a profile reserved by other work; it never closes
those clients for you. Sign in to Desktop separately. Different profiles can use
different GitHub accounts.

For Claude, choose **Open Claude Desktop** on the profile entry. Each profile has
its own Desktop data folder alongside its Claude Code configuration folder.
Xenoflux opens and verifies the profile's own instance. Claude Desktop has a
separate sign-in from the CLI. Keep only the target Desktop instance running
during sign-in so macOS delivers the browser's sign-in link to that instance.

1. Quit regular Claude Desktop and any other Claude Desktop profiles.
2. In Xenoflux, choose **Open Claude Desktop** for the profile you want to sign
   in to. Complete sign-in and check the account menu in that window.
3. Quit the profile's Desktop. Open regular Claude Desktop first, then reopen
   the profile from Xenoflux. Both instances can stay open once signed in.

Run `/app` in a managed Claude Code Terminal session to move the conversation to
that profile's Claude Desktop. Xenoflux starts the matching Desktop if needed.
If Desktop asks you to sign in, follow the steps above, then retry `/app` in
the same Terminal session. Claude Code exits and Xenoflux releases its Terminal
reservation after it verifies Desktop opened the conversation. If Xenoflux
cannot confirm the handoff, the conversation stays open in Terminal. If you
can see the conversation in Desktop, you can close Terminal yourself.

For a Claude Code or Copilot profile, you can start one managed CLI and one
managed Desktop in either order. Use **Show Desktop** or **Close Desktop** on
an open managed profile’s card. Use **Close CLI** to stop a terminal session
launched by the current Xenoflux version. You can also exit the CLI in Terminal
or quit Desktop normally. Closing either client leaves the other running.
Finish both clients before changing or copying the profile.

The CLI launcher clears its own reservation after verified shutdown. Xenoflux
checks for closed Desktop clients in the background while the local app is
running, even with the Profiles tab closed. Profiles also checks on refresh
and before profile actions. If the local app was stopped when you quit Desktop,
the next refresh or profile action clears its verified reservation. Xenoflux
preserves active or uncertain reservations.

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

Use the profile’s **More** menu to rename it, add or remove project bindings,
or remove the profile from Xenoflux. Removing a profile or project binding
keeps its files on disk. Native Open controls submit no task. Under **Client
discovery**, **Native apps** opens stock Claude or Copilot using the app’s existing
setup. A Copilot session link dispatch does not prove that the target session exists.

## Inspect and compare setups

In a profile’s **Details**, choose **Inspect setup** to read its
profile's settings, instructions, agents, skills, hooks, plugins, MCP and memory settings. Inspect
values, file previews, source locations and reading limits. These are current
local setup sources, not proof of effective precedence, native loading or session use.
An absent CLI or sign-in does not prevent inspection of a safely readable profile.

Use **Change setup…** to select a profile and optionally include project
instructions and settings from a repository. Expand the source groups or use
**Find a source** to search them. Select any source to see its evidence in the
Inspector, which stays beside the list on wide screens and above it on narrow
screens. **Reading limits** shows what the current read covered. **Refresh setup**
rereads the selected scope. Invalid repository paths show an error.

Choose **Compare with…** to select another profile from the same or a different
vendor. Setup comparisons use side-by-side columns, search and collapsible
categories. Use **Reading limits**, **Change profiles**, or **Refresh setups**
from the comparison toolbar.
Same-vendor comparisons retain **Same**, **Different**, **Could not compare**
and **Not applicable** within the sources read. Choose a row to see its full
content diff, source evidence and available copy actions. In different-vendor
comparisons, each exact skill name gets a row with source counts for both profiles.
Use **Name matches** to see names observed in both profiles or **One side observed**
to focus on items observed on one side. **Not observed** describes the available read.
The inspector stays beside the results as you scroll. On narrow screens, selecting
a row opens the inspector in a bottom sheet. Closing it returns focus to the row.
Matching names or values do not establish equivalent behavior. Missing or unreadable
evidence remains explicit, and copying between vendors is unavailable.
Inspection and comparison read files without opening, signing in or activating clients.

## Compare a task

Choose a profile for each side and a repository, then describe one task. Both
sides may use the same profile or different supported clients. Review the pinned
commit, model/effort, permissions, limits and any setup/check commands before
**Start 2 model runs**. Both sides run in parallel in separate copies of committed
source; dirty, untracked and ignored files are excluded.

Preparation groups **Task and source**, **Two setups**, and **Checks and limits**
on one page. Use the stage links to move between them without losing entered
values. Compare each side’s requested settings in the aligned rows. **Review before
starting** checks the preparation and shows the pinned source and setup differences.
Use **Hide matches** to focus on differences and unresolved values. Edit links
return to the relevant section before requesting a fresh preview.

No checks are selected automatically. Setup/check programs run outside the Codex
sandbox and can affect external files/services; select trusted commands. Network
access is on by default for Codex and Copilot CLI comparison sandboxes. Use
**Allow network access** to change that setting. Claude Code follows the profile's
network and tool rules. Copilot enables its task sandbox when outbound access is
off or the run is autonomous. Managed restrictions still apply.

**Approvals** applies to both sides. Choose **Profile default**, **Ask me**,
**Automatic review**, or **Autonomous**. Automatic review uses the client's native
reviewer. Autonomous runs use the client's unattended permissions. Copilot CLI
uses assisted review in Autonomous mode and declines decisions that still require
a person. Answer requests from either side in Comparison progress.
**Allow for this session** appears when
the native request offers a session-scoped grant. Choose each side's permission
mode separately, and use the profile default there when it conflicts with the
comparison's approval choice. Ordinary review inherits native permissions.
Matching effort labels across clients do not imply equal computation.

Fresh model catalogs load automatically for the selected profile and repository.
Select any accessible Git repository, including one the profiles have never used.
Saved project bindings provide shortcuts. Review lists the profiles where **Start**
will add the selected repository to native trusted projects. The entries persist
after the run. A profile with active work must finish before Xenoflux can add trust.
If the native client explicitly distrusts the project, change that decision in the
native client before starting the comparison.
Both sides share a catalog when they use the same profile. **Load models automatically
in this tab** is on by default. Turn it off to keep discovery manual in that tab.
You can choose **Refresh models** in **Catalog details** for either side. Discovery
initializes the client without submitting a task.
It can use sign-in, write native state, or run configured startup hooks. Changing the
model clears explicit effort. Start rechecks explicit choices. Advertised choices do not
prove account entitlement or applied settings. Copilot Auto may route each turn
differently.

Under **Files it may change**, enter one repository-relative path or wildcard per
line. `*` matches within a directory, `?` matches one character, and a whole `**`
segment spans directories, as in `src/**/*.ts`. Reports flag recorded edits outside
these rules. The client sandbox applies its own permissions independently.

Verified managed Codex Desktop and managed Codex, Claude Code, and Copilot CLI
sessions can stay open during model discovery and comparisons. Each Codex catalog
probe uses separate SQLite, log, and temporary directories. Exclusive operations
such as sign-in and managed Claude or Copilot Desktop sessions still block model
discovery and comparisons for that profile. For an interrupted reservation, see
[profile recovery](CLI.md#profiles-copy-and-recovery).

Independent comparisons/reviews can overlap, including on one profile, with separate
progress, approvals, cancellation and results. Simultaneous review workspaces must
not overlap. Profile mutations and new Desktop startup are blocked by execution
reservations. The controller's default capacity is eight jobs. Concurrent sides
and other activity can contend for shared resources, which limits timing comparisons.

Open **Activity** in the sidebar for current comparisons and reviews and recent
comparison records. Open a job to see its current state, answer its native requests
or cancel that job. The list updates automatically; **Refresh activity** rereads
the list and recent records. Opening a record never resumes or retries model work.

## Inspect a session

From **Sessions**, choose **Inspect** beside a Codex session, or choose
**Choose a session by profile** for Codex, Claude Code or GitHub Copilot.
Profiles also offers **Inspect sessions** with that profile selected. Listing
Copilot history uses its CLI and existing sign-in. Inspection submits no model
task and never resumes the session.

The inspector shows coverage, the last recorded response, model and permission
observations, turn settings, skills, time, tokens and recorded activity. Open an
event for its retained content and source reference. Available compaction markers
and summaries link to their events; absent summaries do not prove scope loss.
Today's setup is a separate snapshot, never a substitute for historical context.

Use **Overview**, **Activity**, **Harness**, **Context**, **Usage**, **Outcome**
and **Source** to read one kind of evidence at a time. The selected section stays
in the address for reload and Back. Activity keeps its event selection and search
when you switch sections. Source holds the detailed coverage, identity and limits.
Overview and Context show the first retained user message where available; earlier
messages may be missing. Its source link opens the recorded event in Activity.

On a comparison report, choose **Inspect session** on either side to inspect its
retained capture. Owned captures and historical imports keep their own coverage
limits. The inspector does not add later native activity. **Export session** saves
one session using the [report export choices](#read-and-export-a-report), and its
JSON companion reopens without the original history.

Owned captures show skill catalog coverage, observed invocation telemetry and
declared capture requirements separately. A captured catalog does not prove
invocation. Skill observations identify structured selection, definition-read
source lines and telemetry receipt references. Observed receipts and passed
requirements do not establish exhaustive skill use. Frozen reports keep their
original capture status. **No checks selected** means no independent task verification
was requested; native completion is shown separately.

Choose **Compare with another session** to keep this inspected evidence as the
left side while selecting a right session by profile. The left history is not
reread. Reopen an expired inspection before comparing; the same native session
cannot fill both sides.

## Compare existing sessions

On **Sessions**, choose **Compare** beside two sessions. The sidebar keeps the pair
while you search or open other pages; **Compare…** continues to the picker, where
you can also select both. The first is the left side and **Swap sides** reverses them.
For different profiles/clients, use **Choose recent sessions by profile**, select
each profile and **List recent sessions**. Changed context needs a fresh selection.
Managed Copilot listing uses its first saved project or the profile's private workspace.
History inspection starts no model task. Titles alone do not prove the same task.

On **Open saved report**, you can also select two UTF-8 UUID-named Claude `.jsonl`
files, up to 8 MiB each, or enter two existing Copilot CLI/app session UUIDs.
Copilot needs its native CLI on PATH and implicit sign-in; token/custom-root
overrides are refused. These readers retain selected public user/assistant text
as partial evidence, omitting tools, reasoning and system content. Original account,
surface/location, completion and usage remain unknown. Export freezes the projection
so native histories are no longer needed. Raw transcripts remain private.

## Read and export a report

Comparison reports are designed for desktop windows at least 1280 CSS pixels wide.
**Grouped evidence** leads with Run facts. Expand **Time and tokens**, **Outcome**,
or **Conditions and coverage** for more detail. **Review** and **Export report**
remain above the evidence. Technical session details stay in each side's **Details**.

**Session replay** stacks the profiles' event maps and gives each retained
subagent a lane beneath its recorded parent. Choose **Elapsed time** or **Event
order** for the map. Choose a stop to open its event. **Compact** lists the events
as rows, and **Chat** shows the messages as conversation bubbles. Both views keep
the selected event and search.

**Session and harness comparison** separates requested variation from recorded
differences. **Model-only request** means only the model differs among the listed
recorded requests. It does not establish that the complete harness stayed fixed.
Read the separate recorded assessment for changes in effort, permission mode,
client, version, original surface or task inputs.

Expand **Inspect recorded controls** for each setting's requested, sent, confirmed
and response-reported values. Expand each session's harness evidence for its own
turn observations, skills and compaction links. The two timelines remain independent.
Cross-client effort and permission labels do not establish equivalent behavior.
Unknown context, integrations and cache state remain explicit.

Setup fingerprints cover setup recipes and native overrides, which can include
the model. A different fingerprint alone cannot identify a harness change, and
matching fingerprints do not establish full historical equality. Export and reopen
use the same interpretation of the retained evidence, without reading today's files.

| View | Meaning |
| --- | --- |
| Run facts | Recorded main-session models, runner time, retained tool calls and tracked file changes. Runner time includes startup and shutdown. A retained tool count gives the evidence available for that side. |
| Responses and replay | Recorded text, events, owned delegations, references and explicit gaps. Each side has its own order and elapsed-time origin. |
| Assessment | Named check recipes, status, timing and retained output. Matching names alone do not establish equivalent checks; Inspect never reruns them. |
| Time and tokens | Side-by-side counters with each client's measurement scope. Codex includes cached input in input and reasoning in output. Claude reports uncached input, cache reads and cache creation separately for the task submission. Its submission total adds those input counters and output when all four values are available. |
| Outcome and code | Captured source-baseline-to-task-end changes, which may include setup. Ignored/unchanged/binary/oversized contents and fallback timing remain explicit. |

In replay, **Open delegated session** follows a child; **Return to calling event**
restores that side's event/search/scroll. Select an event for the inspector;
**F6** switches focus and **Escape** closes it. **Source and event details** shows
recorded references. Replay identifies timestamps supplied by the client and times
observed by Xenoflux. Untimed events remain selectable in recorded order. Reopening
never adds later activity or reconstructs missing history from today's files.

Select an agent name for its assignment, result and parent use. When the native
assignment is encrypted, readable parent assignment statements and child task
acknowledgements remain separate recorded claims. They do not reveal the exact
encrypted payload. Parent actions link a completed child file change to a later
recorded parent command after a matching result delivery. Inspect the source links
and full command; its exit code applies to the whole recorded command.

Completion, verification and reviewer judgment are separate. No checks means
unverified. Discovery, selection, invocation, successful read and adherence are
different observations. A validated captured-session token sum does not prove
complete workflow discovery. One pair proves neither consistency, causality nor
a universal winner. [CLI evidence rules](CLI.md#read-and-export-evidence) cover
strict capture, historical metadata and comparison exit codes.

Export writes Markdown and its `.md.audit.json` companion to a new folder under
`~/Xenoflux reports/`; keep both together. **Open saved report** reads the JSON
exactly as saved. **Recently saved** lists earlier export locations. **Refresh list**
updates that list; selecting an entry reads its saved report. Event/check/patch
bodies are omitted unless **Include recorded
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

**Review task**, **External review** and **Attached ratings** separate ordinary
task work from imported ratings. Preview moves focus to the exact inputs;
**Edit review** returns to the preparation action. A review of the report subject
is labeled **This comparison**, with its exact identifier under **Show review scope**.

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

If **Open Desktop** fails, select **See details** on the profile card. When
processes hold profile files, the inspector lists their names and PIDs. Save your
work, quit those apps or exit those sessions, then try **Open Desktop** again.
Use Activity Monitor to look up a PID. If a Xenoflux operation holds the shared
desktop lock, follow the inspector’s instructions for waiting or recovering the
recorded profile. A PID recorded for a lock does not verify the running process.

If the launch-link warning appears, run `xfx ui` again and use its printed link.
If the server is unreachable, restart it and inspect the recorded task state.
For denied history access, grant the terminal relevant Files and Folders access
in macOS Privacy & Security settings. Omit `--port` to select a free port.

## Supported clients and known limits

The supported platform is local Apple Silicon macOS with Codex, Claude Code and
GitHub Copilot CLI. Profiles follow current selected installations and capabilities;
a replaced executable/root after preview requires a new preview, not a version pin.
Managed Claude and Copilot use a native CLI sign-in for each profile.
Copilot Default can use the stock GitHub CLI account.

Credential refresh and sign-out during concurrent use remain unverified.
Claude and Copilot sign in separately in CLI and Desktop.
An interrupted shared-account metadata operation keeps its
reservation for maintainer recovery. Some native pair/mode combinations, repeated overlap stress,
controller-kill reviews and copied-setup loading remain deferred. Real Codex
stale-callback recovery is unobserved; synthetic Desktop fixtures do not establish
real sign-in, Dock behavior or account isolation. Unreported effort/usage stays
unknown, and sampled ancestry does not prove escaped descendants stopped.

Claude and Copilot Desktop qualification covers local startup and selected-root
storage. Xenoflux does not inspect Desktop accounts. Effective Desktop session
settings and model use remain unverified. Cloud execution,
generic configuration editing and cross-client setup copying are outside the
supported scope. Xenoflux never transfers credentials or grants native trust
through inspection/copying.
