# The Xenoflux app

Use the local browser app to create profiles, compare tasks, inspect saved sessions
and request AI reviews with Codex, Claude Code or GitHub Copilot CLI on macOS.

```sh
xfx ui
```

The server listens on `127.0.0.1`. Open its launch link to establish a browser
session and keep the terminal open while using the app. Running `xfx ui` again
reopens the same app; Ctrl+C stops the server.

## What you can do

### Create and manage profiles

In Profiles, choose **Create profile**, select the client, then choose **Empty**
or **Selected parts of another profile**. Empty profiles contain the minimal
management files. Selected-parts creation previews supported same-client copies;
cross-client copying is unsupported. Follow the native sign-in guidance before
starting model work. Creation itself does not open a native client or sign in.

Profiles can be renamed, bound to a project, inspected or removed from Xenoflux.
Removal leaves their files on disk. Copying settings requires a preview and
supports Undo; affected clients must be idle. See [profiles](PROFILES.md) and
[selective copying](ADVANCED-COPY.md) for commands and recovery.

Choose two profiles to compare current settings, instructions, skills, MCP servers,
plugins, hooks and memory settings. Items show **Different**, **Same**,
**Could not compare** with a reason, or **Not applicable**. Inspection reads files;
it neither copies them nor proves the native client loaded them.

When signed Claude or GitHub Copilot apps are installed, separate **Open** buttons
use their existing accounts without submitting a task or creating managed desktop
profiles. A Copilot session link dispatch does not prove that the session exists;
the native app reports missing sessions.

### Compare existing sessions

Tick two sessions; the first selected is the left side. **Swap sides** reverses
them. For different profiles or clients, choose **Choose recent sessions by
profile**, select each profile and choose **List recent sessions**. Changing the
profile context requires a fresh list and selection. Managed Copilot profiles use
their first bound repository as the native working directory; bind one in Profiles
before listing. Listing and importing read history without starting model tasks.

On **Open saved report**, you can also:

- Select two native UTF-8 UUID-named Claude Code `.jsonl` files, up to 8 MiB each,
  and choose **Compare stored conversations**.
- Enter two existing Copilot CLI/app session UUIDs and choose **Compare Copilot
  conversations**. The native `copilot` CLI must be on PATH; this reader uses
  implicit sign-in and refuses token/custom-root overrides.

These imports retain selected user/assistant text as partial evidence. Tools,
reasoning and system content are omitted; original account, execution surface,
location, usage and completion remain unknown. Raw transcripts stay private.
Export to reopen the report independently of native history. See the
[import contracts](AUDIT-EVIDENCE.md#read-only-client-conversation-imports).

### Run a new task

Describe the task, choose a profile for each side and select the repository.
Review the pinned commit, limits, model, effort, permissions and any setup/check
commands. Same-client and mixed-client pairs use each client's permission rules.
Codex comparisons default to workspace-write with networking disabled and also
offer read-only. Claude Code and Copilot CLI can inherit profile permissions.
Copilot Auto may route each turn differently.

**Refresh models** initializes the native client without submitting a task. It may
use sign-in, write native state or run configured startup hooks. Browsing uses
cached metadata. Changing the model clears explicit effort; Start rechecks explicit
choices. An advertised model does not prove account entitlement or applied settings.

Choose **Start 2 model runs** to begin. Sides run sequentially in separate copies
of the committed source; dirty, untracked and ignored files are excluded. Setup
and check commands run outside the Codex sandbox and may affect external files
or services. Choose trusted commands. No check is selected automatically, and
completion alone is not verification. CLI specifications and process limits are
in [controlled experiments](AUDIT-EXPERIMENTS.md).

### Read the report

Read the last recorded responses side by side, then inspect these views:

| View | Use it to |
| --- | --- |
| Replay | Browse independently scrolling conversations, expand turns/delegated sessions and select events for the side inspector. **Open delegated session** follows a delegation; **Return to calling event** restores that side's event, search and scroll. |
| Assessment | Compare recorded checks. **Inspect** opens a panel with the recipe, timeout, exit status, timing and retained output. Matching names alone do not prove matching checks; viewing never reruns one. |
| Time and tokens | Expand Workflow, Main session or delegated-agent rows for exact counters and scope. Cached input is part of input; reasoning is part of output. Overlapping spans are not added. Missing usage stays unknown. |
| Outcome and code | Inspect captured changes and the snapshot's distinction between tracked changes and ignored artifacts. Older reports may expose only observed edit paths with a coverage limit. |

**F6** switches focus between conversation and inspector. **Escape** closes the
inspector and returns to the selected event. **Source and event details** shows
recorded references. Each side uses its own root session's elapsed-time origin.

Saved replay does not acquire later activity. Missing histories, content and check
output cannot be reconstructed on reopen. A validated captured-session token sum
can coexist with **Whole workflow not validated**: accounting does not prove every
native session was captured. See [evidence and capture](AUDIT-EVIDENCE.md) for
bounds, attribution and accounting rules.

### Export and reopen

Export creates a Markdown report and its `.md.audit.json` companion in a new folder
under `~/Xenoflux reports/`. Keep both files together. **Open saved report** reads
the JSON as saved, even after original sessions disappear. Same-task declaration
links work while the server runs; export preserves the declaration afterwards.

Event bodies, check commands/output and patch text are omitted unless you select
**Include recorded messages and tool content**. Known-secret redaction does not
remove all private prose or code; inspect both files before sharing. An attached
review cannot retain its evidence binding while that evidence is silently removed.
Preserve the reviewed content or request a review of a separate sanitized export.

## 4.0.0 scope and limits

**4.0.0-beta.1 is an opt-in public beta.** Use the
[installation guide](INSTALLATION.md) to opt in. The
[beta-exit checklist](../developer/AUDIT-ACCEPTANCE.md#beta-exit-checklist) governs
stable promotion; passing fixtures does not prove every native journey.

- Profiles follow the current selected installation and observed capabilities,
  never a fixed CLI/Desktop version. A changed executable or root after preview
  requires a fresh preview. SDK dependencies are separately locked.
- Claude Code has an observed per-root, same-account route. Copilot's qualified
  `gh-cli` route is shared. Separate setup roots do not prove independent accounts;
  distinct-account independence and shared sign-out isolation remain unverified.
- Native credential refresh is unverified. Clients own sign-in and renewal;
  Xenoflux does not transfer credentials. Successful tasks do not prove refresh.
- Native qualification covers adopted core paths and one mixed-client pair.
  Remaining pair/mode combinations, repeated overlap stress, controller-kill native
  reviews and copied-setup native loading are deferred. Copy success does not
  establish that the client loaded the setup.
- Unreported effort, turn attribution, timing and usage stay unknown. Sampled
  ancestry does not prove escaped descendants stopped. Real Codex stale-callback
  recovery remains unobserved; synthetic Desktop fixtures prove neither sign-in,
  Dock behavior nor account isolation.
- CLI setup inspection uses `--surface cli|desktop`; the old `--client cli|desktop`
  option is removed. See the [audit guide](AUDIT.md).

## What the app never does

- Close Codex or Terminal sessions to make copying possible; it reports blockers
  for you to close manually.
- Sign in for you, transfer credentials/history/memory between profiles, or install,
  enable or connect plugins and MCP servers.
- Start or resume a model task merely because you browse or compare evidence.
- Send browsing/setup comparisons to an external service. Explicit model tasks
  use the selected profile's provider connection and sign-in.

## Review a comparison

Choose **Review**, select a profile and its normal workspace, edit the prompt and
choose whether to include recorded content. **Preview review** shows the frozen
inputs, prompt, executable, workspace and limits without starting a session.
Editing the form invalidates that preview. Choose **Start review** to submit once.

Blank model/effort fields inherit profile settings; overrides apply only to this
task. Start rechecks explicit choices. Applied settings and session IDs appear only
when reported by the native session. The selected client's CLI supplies its normal
instructions, integrations, permissions and provider connection. Xenoflux does not
change sign-in, trust or configuration. Reasoning from the report is a prompt
instruction, not enforced isolation; normal native history/runtime effects apply.
Duration is uncapped by default with an optional time cap, no token/dollar cap,
and an 8 MiB native process-output bound.

An already-running Xfx-managed Codex Desktop instance can stay open during review;
cancelling the review leaves it running. A confirmed-stopped instance is reconciled
by observed profile listing or the next review Start. Uncertain helpers/file holders
still block conflicting work. New Desktop launch while a comparison/review owns
the profile remains blocked.

Comparisons and reviews can overlap on one profile, up to eight active jobs per
controller by default. The header links to each job, with independent approvals,
progress, cancellation and results. Simultaneous reviews need non-overlapping
workspaces. Profile mutation is blocked by execution reservations, and overlapping
work shares machine/profile conditions.

Native approval/input requests appear on the review page; nothing is answered
automatically. **Cancel review** stops owned work and retains partial output.
Refreshing follows the same task; closing the tab leaves it running. Restart never
resubmits or resumes it. Unknown ownership remains visible and blocks conflicts.

Read the captured response and use **Open its comparison and evidence** to return
to the frozen report. Inputs/responses remain after source-session loss. A partial
response is not a completed review. Ordinary responses are attributed text, separate
from structured ratings, and are not included in report exports.

For optional external review, open **Reviews** on an engine-backed comparison and
choose **Prepare packet for external review**. Review the frozen Markdown/JSON files
before sharing. Import a submission for that exact packet to validate its references
and save a new evaluation without calling an AI service. Revisions supersede prior
entries without deleting history. Export the evaluation to retain it. Submission
formats and evidence rules are in [external reviews](AUDIT-REVIEWS.md#review-either-audit-entry-path).

## Inspect captured code changes

In **Outcome and code**, choose **Inspect [profile] patch**. Patches compare the
captured workspace to its source baseline and may include setup changes. They do
not include unchanged source or ignored-file contents. Fallback timing, verified
snapshot enrichment and absent/binary/oversized content are labelled explicitly.
Historical reports are never filled from today's workspace.

Patch text uses the same **Include recorded messages and tool content** export
choice as replay/check bodies. Limits and completeness rules are in
[captured task-end patches](AUDIT-EVIDENCE.md#captured-task-end-patch-content).

## CLI workflows

Use [series/cohort commands](AUDIT-REVIEWS.md) for repeated comparisons.

## Progress, cancellation and interruption

Refreshing or closing the browser tab leaves started work running. Reopen the app
to follow it. **Cancel the run** stops only the experiment's owned work and retains
a partial report; existing Codex/Terminal clients stay open. Stopping the server
interrupts its work and preserves records. Reopening never reattaches, resumes or
starts a model task automatically.

After interruption, open the task under Recent. Preview recovery before choosing
**Tidy up and keep the record**. Only confirmed-stopped owned resources are
reconciled; live or uncertain resources stay untouched. Failures and unavailable
evidence remain in the report and exports.

## Try it with example data

```sh
xfx ui --demo
```

Demo mode marks synthetic examples and simulated actions. External review import
is not simulated. It never reads or changes your profiles, sessions or clients.

## If something goes wrong

- **"Open Xenoflux from its launch link"**: run `xfx ui` again and use its link.
- **"Xenoflux isn't running"**: restart the server and inspect the recorded state;
  no task restarts automatically.
- **A profile's history couldn't be read**: allow the terminal to access the relevant
  Documents/Desktop/Downloads folder in System Settings > Privacy & Security >
  Files and Folders.
- **Port in use** with `--port`: omit `--port` to select a free one.
