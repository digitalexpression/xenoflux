# The Xenoflux app

This guide describes the local browser app in **Xenoflux 3.0.0**. It supports
ordinary AI review from a comparison report, alongside optional external review
import. Consult the versioned release record and package manifest for the exact
source and supported formats; older commands, workflows or saved formats may not
be compatible.

`xfx ui` opens a local web app for comparing Codex profiles and sessions. It runs
on this Mac only: the server listens on `127.0.0.1`, opens your default browser,
and answers only the page it opened.

```sh
xfx ui
```

Keep the terminal window open while you use the app. Press Ctrl+C there to stop
it. Running `xfx ui` again while it is running reopens the same app.

## What you can do

- **Create a profile.** Open Profiles and choose **Create profile**. Choose
  **Empty** to create a profile without copying another profile’s setup, or
  **Selected parts of another profile** to select supported settings/content
  and review the copy before creating it. Empty profiles still have the minimal
  files Xenoflux needs to manage them. Creation does not open Codex or complete
  sign-in; follow the native setup guidance before running model tasks.
- **Compare setups.** Choose two profiles to see how their settings, instructions,
  skills, MCP servers, plugins, hooks and memory settings differ today. Each item
  is labelled **Different**, **Same**, **Could not compare** (with the reason) or
  **Not applicable**. Comparing only reads files; it never copies, activates or
  signs in anything.
- **Compare a task from existing sessions.** Tick two sessions you ran in Codex CLI
  or Desktop. The first one you tick is the left side of the report; **Swap sides**
  changes that. Choosing sessions only reads their recorded history.
- **Run a new task.** Describe one task, choose a profile for each side and a
  repository, then review the pinned commit, limits and any commands you add.
  Both sides can use the same profile. Each side can select its own model ID and
  reasoning effort; blank fields inherit saved profile settings. Nothing starts
  until **Start 2 model runs**. The sides run sequentially in
  separate copies of the committed source; uncommitted, untracked and ignored
  files are excluded. Setup and check commands are ordinary programs outside
  the Codex sandbox and may affect files beyond those copies. No check command
  is selected automatically, and finishing is not verification.
- **Read the report.** Inspect each recorded session in the replay timeline,
  browse the two independently scrolling conversations, and expand turns or
  delegated sessions. Select a message or activity to read it in the side inspector;
  the inspector stays open as you select other events. **Open delegated session** follows the
  selected delegation; **Return to calling event** restores that side's originating event,
  search and scroll position, including nested visits. **Source and event details**
  shows its recorded references. **F6** switches focus between the conversation
  and inspector; **Escape** closes the inspector and returns to the selected event.
  Each side uses
  its own root session's elapsed-time origin. Missing histories, timestamps and
  omitted content remain explicit. New xfx runs keep the replay captured at
  completion; reopening does not add later session activity. Replay content that
  was never saved cannot be recovered from a saved report. The last recorded
  responses appear side by side above replay, with full text and source-event
  links. **Assessment** shows selected checks in one compact comparison table,
  separately from completion and reviews. **Inspect** opens a persistent side
  panel: switch profiles or checks, inspect the recorded command, timeout, exit
  code and timing, and search retained output. Different or unknown check
  definitions remain explicit; matching names alone do not establish equivalence.
  Viewing a check never reruns it. Older reports may retain only results, with
  command text and output marked unavailable; content that was never saved cannot
  be recovered when opening the report. Exports include check commands and output
  only when recorded-content inclusion is selected, subject to redaction and size
  limits; omitted and unavailable content remains identified as such.
  **Time and tokens** compares Workflow, Main session and delegated agents in two
  compact columns. All bars share one scale and legend: uncached input, cached
  input, other output and reasoning. Expand a row for exact counters and scope.
  Cached input is already part of input; reasoning is already part of output.
  Workflow time spans the earliest to latest retained event; overlapping agent
  durations are not added. Runner task time is shown separately in workflow details.
  A validated captured-session token sum can be shown while **Whole workflow not
  validated** remains visible: verified accounting does not prove every native
  session was captured. Missing usage stays unknown. File counts and rows share one retained snapshot
  inventory, separating tracked changes from ignored artifacts. Reports without
  that inventory show observed edit paths with an explicit coverage limit.
- **Export and reopen.** Export saves a Markdown report and its `.md.audit.json`
  companion together in a new folder under `~/Xenoflux reports/`. Keep the two
  files together. **Open saved report** reopens the JSON file exactly as saved,
  even after the original sessions are gone.
  Event bodies, check commands and check output are excluded unless you select
  **Include recorded messages and tool content**. New runner captures retain up
  to 64 KiB per check output stream, with truncation stated explicitly. The
  task-end workspace reference is a baseline; earlier checks may change files.
  Known secret patterns are redacted, but private prose and code
  can remain; inspect both files before sharing.
  If an attached review is bound to recorded content, export cannot silently
  remove that evidence and keep the same review. Preserve the reviewed content,
  or obtain a review of the sanitized export instead.
- **Manage profiles.** See each profile's client state, open Codex CLI in Terminal
  or Codex Desktop, create a profile (empty or from selected parts of another),
  copy selected settings with a preview and undo, rename, change the project
  binding, or remove a profile from Xenoflux (its files stay on disk).

Reports with your same-task declaration have private links that work while the
server is running. Export the report to keep the declaration after stopping it.

## What the app never does

- Close Codex or Terminal sessions. Copying and undoing need the destination
  profile's Codex closed; the app tells you and waits for you to close it.
- Sign in for you, transfer credentials, conversation history or memory between profiles, or install,
  enable or connect plugins and MCP servers.
- Start or resume a session when you only browse or compare.
- Send report browsing or setup comparisons to an external service. An explicitly
  started model task uses the selected profile's provider connection and sign-in.

## Review a comparison

From a comparison report, choose **Review**. Select a profile and its normal
workspace, edit the review prompt and choose whether to include recorded report
content. **Preview review** shows the exact frozen inputs and prompt, workspace,
executable and limits; it starts no native session. Editing the form invalidates
that preview. Choose **Start review** to start one ordinary model task.

You can select a model ID and reasoning effort for each review. Blank fields
inherit the profile settings; overrides apply only to that task. The native
session must confirm explicit selections before a model turn starts.

The selected profile supplies its normal provider connection, default model settings,
instructions, integrations and permissions. Xenoflux does not change sign-in,
trust or configuration to prepare a review. The task has the profile's normal
native history and runtime effects; the request to reason from the report is a
prompt instruction, not enforced isolation. Effective settings and session IDs
are shown only when reported by the native session. Model duration is uncapped
by default; you can choose a time cap. There is no token or dollar cap, and native
process output is bounded to 8 MiB.

Reviews run through the profile's Codex CLI, independently of Desktop. An
already-running Xfx-managed Desktop instance can remain open on that profile;
other Desktop profiles are unaffected. Cancelling the review leaves Desktop
running. You can quit Desktop normally: observed profile listing or the next
review Start reconciles its stopped reservation automatically. Remaining helpers
or uncertain file holders still block cleanup.

Independent comparisons and reviews can overlap on the same profile, up to eight
active jobs per controller by default. The header links to each active job. Each
keeps its own approvals, progress, cancellation and results. Choose a separate
workspace for each simultaneous review; overlapping directories are refused.
Profile changes are blocked while its execution reservations remain. Timings
during overlapping work reflect shared machine and profile conditions.

When Codex needs approval or input, the review page shows its requested action
and choices. Nothing is answered automatically. **Cancel review** stops owned
work and retains partial output. Refreshing follows the same task; closing the
tab leaves it running. A server restart never resumes or retries it. Live or
unknown process ownership stays uncertain and blocks conflicting work.

Read the captured response on the review page and use **Open its comparison and
evidence** to return to the frozen report. The task retains its inputs and
response even if original sessions disappear. A partial or missing response is
not a completed review. Ordinary responses are attributed text, separate from
structured review ratings; one pair does not prove general superiority or
consistency. Report exports do not include the separate ordinary task response.

External review preparation and import remain optional:

On an engine-backed two-session comparison, open **Reviews** and choose
**Prepare packet for external review** to save a frozen Markdown/JSON review
packet. Choose whether recorded message and tool content should be included;
review references and evidence metadata remain in the packet either way. Read
the files before sharing, since included content can contain private information.
After an external reviewer prepares a submission for that exact packet, return
to its Reviews page and choose the review submission JSON file. Xenoflux validates
it against the report's frozen evidence, shows who wrote it, what it concludes and which
evidence it cites, then saves it as a new evaluation. This import does not call
an AI service. To revise a review, open the saved evaluation and import a new
submission that supersedes the earlier review. Export the report after saving
to retain and share the evaluation; inspect recorded content before sharing.
Xenoflux still does not automatically judge a result.

## Inspect captured code changes

In **Outcome and code**, each side shows whether task-end patch text was retained.
Choose **Inspect [profile] patch** to read it. A patch compares the captured
workspace against its original source baseline, so it may include setup changes.
It is not necessarily a task-only delta and does not include unchanged source or
ignored-file contents. After-process fallback captures are labelled separately.
Reports enriched from verified retained snapshot artifacts identify that origin.

New xfx captures retain a complete redacted text patch up to 256 KiB per side.
Binary, oversized, unreadable or absent content stays explicit; no truncated patch
is represented as complete. Historical reports are not modified or populated from
today's workspace. Known-secret redaction is not a guarantee that every private
value is removed; inspect the packet before sharing it.

Patch text is excluded from ordinary exports. Select **Include recorded messages
and tool content** to include available patch text together with the selected
replay/check content. The Markdown and JSON use the same choice. Changing this
choice cannot silently strip evidence from an existing review: prepare a separate
packet from the original unreviewed comparison when a different disclosure is
needed.

## Not in this version yet

Constructing repeated comparisons remains a CLI workflow and is outside this
release’s required UI outcomes.

## Progress, cancellation and interruption

Refreshing or closing the browser tab leaves an explicitly started task running.
Reopen the app to see progress. **Cancel the run** stops only that experiment's
owned work and retains a partial report; existing Codex and Terminal clients stay
open. Stopping the local Xenoflux server interrupts its owned experiment and
preserves the records. Reopening never restarts a model task automatically.

After an interruption, open the task under Recent. If recovery is needed, inspect
the preview before choosing **Tidy up and keep the record**. Recovery only
reconciles stopped resources owned by that experiment; live or uncertain resources
stay untouched. The report and its exports keep failures and unavailable evidence.

## Try it with example data

```sh
xfx ui --demo
```

Demo mode shows synthetic examples for every screen and simulates every action.
It never reads or changes your profiles, sessions or clients.

## If something goes wrong

- **"Open Xenoflux from its launch link"**: the page was opened without the link
  `xfx ui` prints. Run `xfx ui` again.
- **"Xenoflux isn't running"**: the page cannot reach the server. Run `xfx ui`
  again and inspect the last recorded run state; no task restarts automatically.
- **A profile's history couldn't be read**: macOS may need permission for the
  terminal that runs `xfx ui` to read folders in Documents, Desktop or Downloads.
  Allow it in System Settings › Privacy & Security › Files and Folders.
- **Port in use** with `--port`: run `xfx ui` without `--port` to pick a free one.
