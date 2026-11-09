# Profile comparison and audit: 2.1.0 capability assessment

Assessment dated 2026-10-23, based on the retained merged-release and installed-
update acceptance receipts. The shared [product goal](AUDIT-GOAL.md) remains the
contract; the [roadmap](ROADMAP.md) records current scope and stop condition.
This page describes the released 2.1.0 evidence, not a claim that every possible
profile state or historical run is fully observable.

**Historical assessment notice (2026-11-01):** the dated observations and earlier
proposals below are preserved as evidence, not current implementation status or
authorization. The [roadmap](ROADMAP.md#current-work-and-stop-condition) supersedes
old checkpoints. VoiceOver and uncoached participant acceptance are no longer
required; the [shared goal](AUDIT-GOAL.md#evolution-and-provider-version-policy)
owns the preference for beneficial breaking changes and recorded, unpinned
provider/client versions. Earlier unmet acceptance proposals below are not gates.

## Xenoflux 3.0.0 implementation context

The [3.0.0 release record](RELEASE-3.0.0.md) describes the new local
UI, replay and ordinary AI review and their acceptance limits. Empty/from-source
profile creation, task comparison/report, and in-app review launch/result display
are implemented. The record distinguishes retained native evidence,
development live review results and source verification. The three-outcome
goal and roadmap supersede all broader proposed release gates below. This record
does not replace the released 2.1.0 observations or turn older profile acceptance
into proof of the review flow.

The [3.1.1 release](RELEASE-3.1.1.md) records subsequent reliability and privacy
corrections. Its fixture evidence remains separate from the historical native
observations below.

## Capabilities evidenced for 2.1.0

- Profile setup comparison covers supported configuration, instructions,
  skills, tools, MCP/plugin definitions and memory settings. The output retains
  partial or unknown evidence when discovery cannot establish a value.
- Audits accept xfx-started work and selected existing Codex CLI or Desktop
  sessions. Saved comparisons support optional human or AI review, repeated
  behavior and outcome comparison, and frozen export/reopen without the original
  session stores.
- The published bundle was built from the merged revision and matched the
  verified source and package manifest. The retained package and installed
  receipts establish the exact release and installed executable identities.

## Evidence limits

Publication reused retained product-workflow evidence without new model tasks
or candidate acceptance checks; CI and merged-bundle smoke are recorded separately.
Repeated behavioral acceptance includes two xfx-started pairs
and two direct CLI pairs. The retained Desktop pair is historical:
initial task text matches, later follow-ups differ, task-end checks are unknown,
and one pair leaves consistency unmeasured. Seven direct behavioral rules and
direct token totals remain unmeasured or unknown. Static definitions cannot
prove runtime availability or effective settings. No profile superiority or
causal effect is established.

The installed update verified profile comparisons and source-free reopening of
retained reports while preserving profile registrations, protected state, RAM
log status, the launcher, and observed running clients. This is evidence for
that dated installation, not a general installation, sign-in, restart, or reboot
acceptance recipe.

The release requires Node.js 22.15.0+ in the 22.x line or 23.8.0+ for its
built-in compressed-history support. No Codex version pin or compatibility
matrix is asserted. Additional providers remain deferred. The UI workflow
assessment below is separate from the retained release acceptance.

## UI workflow assessment — 2026-10-23

**The engine covers the main goal, but the interface still asks the user to
assemble the journey.** The shipped UI is a command-line interface with a small
interactive profile picker. There is no separate graphical Xenoflux application
in the inspected source. Profile management and launch are discoverable; setup
comparison, session comparison, review and repeated comparisons require separate
commands, identifiers and sometimes authored JSON files. This is a workflow
assessment, not a completed visual or accessibility audit or a human usability
study.

### Evidence and limits

The installed 2.1.0 entrypoint was exercised with two disposable synthetic
profiles, synthetic CLI/Desktop session records, and existing synthetic report
fixtures. A real interactive PTY captured the picker; ordinary command output
captured the remaining paths. No model task, AI review, native login, client
launch, installation or live profile mutation was performed. Desktop-origin
fixtures do not establish live Desktop UI usability. The release acceptance
above remains the source for previously retained live-client evidence.

Terminal screenshot access was blocked by the computer-use tool. Consequently,
rendered layout, contrast, focus behavior, screen-reader support and visual
hierarchy remain unverified. Retained design images are illustrative and were
not used as evidence of the current interface. Raw captures remain in private
engineering records, outside the package; the observations below are sanitized.
Line counts describe these fixtures and paths, not universal output sizes.

Initial review/cohort checks rejected noncanonical temporary paths; the review
store also required private permissions. Canonical paths and a private store
allowed both checks to complete with explicit partial evidence. These fixture
setup failures are retained in the captures and are not counted as product bugs.
Exit 2 in the successful audit captures means partial evidence, not command
failure. Export/reopen succeeded with the same limitation; this check did not
remove original sources or rerun source-free release acceptance.

### Findings against the goal

| Priority | Observed path and evidence | Consequence and proposed response |
| --- | --- | --- |
| High | Picker `c 1 2` rendered roughly 7,500 lines of JSON for two small profiles. The separate `audit profiles` command rendered 113 lines with useful before/after values. `src/picker.js` directly serializes the comparison callback. | A user cannot readily inspect a full setup diff from the primary chooser. Reuse the existing comparison result and present changed values/content first, with source/scope, explicit gaps, and expandable identical/absent details. Keep raw JSON as an export. |
| High | Picker history lists tasks and offers resume; there is no select-two-sessions comparison action. Direct-session comparison worked through profile names, UUID flags and an explicit task declaration. | Both audit entry paths exist, but the client-started path requires reconstruction. Provide searchable session selection by owning profile/client and a comparison preview that states the basis of task association. Selection must not resume or launch a task. |
| High | `--help` listed 55 lines of commands. Profile creation preview returned JSON; `audit run` without a spec requested `EXPERIMENT.json`. | The full create/change/compare/run journey has no guided entry. Provide task-oriented navigation and reuse existing preview/apply operations; native configuration remains a supported way to change a profile. A generic settings editor is unnecessary. |
| High | The synthetic paired report used the required section order and preserved unknowns, but printed 152 lines with long fingerprints, evidence IDs and repeated technical qualifiers. One material scope difference competed with many unmeasured findings. | Preserve report semantics while making material findings readable first within each section. Keep coverage beside claims, and reveal paired evidence/references on demand. Do not hide unknowns or move code diff ahead of behavior. |
| Medium | Review packet creation worked and explicitly said not reviewed. Review submission is a separate structured-file operation. A one-pair cohort worked through a spec file and printed 287 lines, correctly marking consistency unmeasured. | Add optional review entry/import and a selected-session cohort builder. Retain attributed revisions, disagreements, sample states and unknown denominators. Do not add an automatic judge or new evaluation campaign. |
| Medium | Picker inspect with an unbound repository displayed only a generic failure; the equivalent launch preview explained that the repository must be bound. Launch dry-run without that repository succeeded. | Show the safe actionable reason and a deliberate recovery action. Preserve selection and make cancel/back available; do not silently bind or modify a profile. |
| Preserve | Markdown export reported its frozen JSON sidecar; reopening that sidecar worked. Setup diffs included real content, and reports distinguished original checks, optional review, current setup and recorded conditions. | Surface these existing capabilities in one journey. Reuse discovery, comparison, review and persistence; no replacement audit engine or report schema is justified by this assessment. |

### Recommendation

This dated recommendation is retained as assessment history. The selected
[UI/UX direction](#selected-uiux-direction--2026-10-26) below supersedes its
navigation and host-selection proposals; the underlying observations remain.

Propose a compact local visual workspace with **Profiles**, **Sessions**, and
**Comparisons** as its primary navigation. Keep create/change and CLI/Desktop
controls readily accessible from Profiles. Both existing-session selection and
xfx task setup should arrive at the same comparison report. Review, repetitions
and frozen export/reopen belong to that report, rather than separate engineering
workflows. The CLI remains supported.

This interface direction is a proposal inferred from the workflow friction,
not a measured preference or an approved implementation. Validate its interaction
design before selecting a native or browser shell. The old Evidence Workbench
proposal is not automatically accepted. The [roadmap](ROADMAP.md) gives bounded
delivery slices, dependencies and observable acceptance without changing the
shared goal or copy policy.

JSON export remains subject to the existing privacy boundary: setup source text
is omitted by default, and a deliberate content choice does not authorize raw
transcript, credential or bulk memory export. Public sharing requires sanitization.

## UX proposal review — 2026-10-26

Status: **review observations retained; direction subsequently selected below**.
The initial review recommendations were proposals. The subsequent user decisions
are recorded under [selected direction](#selected-uiux-direction--2026-10-26);
they do not establish design validation or implementation acceptance. This review
compares two sets of synthetic U0 material with the shared goal and the user's
simplicity-first brief: three static concepts shown in the conversation, which are
not retained in the repository or `output/design/`, and a private interactive
canvas of twelve boards covering U1–U4. It supplements, rather than replaces, the
2026-10-23 assessment. Neither set is evidence of implemented behavior or
live-client usability.

### Findings from the three concepts

All three put today's setup inspection before selection of historical sessions.
That can help prepare new work, but adds friction for existing work and risks
confusing today's settings with the setup recorded during a run. Propose starting
at **Compare a task**, with equal **Use existing sessions** and **Run a new task**
entry paths. Setup inspection remains independently accessible, not a mandatory
step before reviewing past work.

| Concept | Useful elements | Friction and proposed refinement |
| --- | --- | --- |
| 1 — Guided journey | Clear progression, readable before/after values, explicit unknowns and both task entry paths. | Setup inspection gates session selection; duplicate Create profile links distract. Retain guidance, but choose existing/new work first and make current setup inspection optional for historical work. |
| 2 — Inspector workspace | Source visibility, readable changed instructions, accessible profile/client controls. | The persistent inspector and category navigation resemble an expert tool. The Changed filter also shows identical/unknown rows. Make the inspector on demand and give filters accurate labels. |
| 3 — Comparison draft | Task-focused structure, both entry paths, unresolved task association stated explicitly. | The summary rail repeats information and explains the report before a result exists. Save draft adds another action. Propose a simpler comparison entry, locally retained progress and no permanent summary rail. |

Concept 3's task focus, concept 1's guidance and an optional inspector from concept
2 are a proposed direction to validate, not an approved combination or final
visual design. The missing session-picker, result, copy-preview and export states
matter more than further setup-screen variations.

### Findings from the interactive canvas

The canvas drew the states the concepts lacked: setup diff with a skill-package
view and gap/error states; session selection with task association and intended
variables; a goal-ordered report with paired evidence; task setup, pre-start
review, progress, interruption and recovery; attributed review revisions and
disagreement; a repeated-pair view with an unknown planned total; and an export
content boundary with source-free reopen.

It illustrates how existing report fields could support the journey; this is
not a verified mapping of every displayed field to an actual report. Every
evidence distinction appeared on the default path. The setup detail stacked three
tables; nine evidence states competed at the top level; the report expanded all
six sections with four tables; the task form mirrored the experiment
specification; and the review form exposed scopes and evidence identifiers.
Engineering terms such as eligibility, denominator, fingerprint and cohort
appeared outside advanced screens. It still lacks a Profiles screen, copy preview
and undo, a home or first-run state, a consolidated missing-evidence summary and
dark-mode treatment.

Canvas provenance remains incomplete in this record: its recoverable private
location and version have not been recorded here. Retain that reference with the
private design evidence before using the board counts and observations as a
reproducible audit. The description above is retained review context, not a fresh
independent inspection of the canvas.

### Selected UI/UX direction — 2026-10-26

The user revised the host decision for this release to a **simple local web app**:
an existing-engine-backed Node.js server serves a **React/TypeScript frontend
(shadcn/ui + Tailwind CSS) on localhost**, opened in the user's browser.
**Electron is deferred**; the earlier Electron selection is superseded. This
keeps the first release focused on the guided workflows without desktop-shell
packaging or integration work. It does not reduce the agreed U1–U3 scope.
The CLI remains first-class. This is a direction and scope decision, not permission
to implement, a validated visual design or a new release acceptance.

The first UI release must combine profile creation, supported selective copy,
undo and explicit CLI/Desktop controls with setup comparison, existing-session
comparison and new-task execution. U1–U3 remain internal delivery slices; U1 or
U2 alone does not meet this release scope. U0 validates the journey. The
[roadmap](ROADMAP.md) owns delivery dependencies and acceptance gates.

Display and preserve retained reviews, including their attribution and limits.
Adding reviews and constructing repeated comparisons in the UI remain deferred
to U4; existing CLI support remains available. Do not show an inactive Add review
button. The user will determine the walkthrough participant and reference Mac
for this release; those validation prerequisites are not yet satisfied.

### Information architecture and flows

- **Landing**: give **Compare a task** and **Compare setups** equal prominence.
  Under task comparison, give **Use existing sessions** and **Run a new task**
  equal prominence once functional. Hide unfinished actions in interim builds;
  both task paths must work before the first UI release. Keep recent comparisons
  and **Open saved report** readily accessible.
- **Profiles**: profile names, concise setup descriptions, readiness and
  create/inspect actions. Full sources, selective copy, undo and explicit
  CLI/Desktop controls remain accessible on demand.
- **Sessions**: searchable recent work through the comparison picker and Browse
  sessions. A permanent three-destination sidebar is not required; validate the
  compact navigation before adding navigation weight.

For **existing work**, select two sessions by task title, owning profile,
CLI/Desktop, project, date and completion state; UUIDs stay in details. A
hypothesis to test: suggest pairs of recent sessions from different profiles
whose recorded initial task input matches, reducing selection effort when useful.
Label the suggestion's reason **Matching opening task**, not confirmed equivalent
sessions: later follow-ups, attachments and project state may differ. This would
reuse native history and recorded input identity, but scanning history across
profiles has an unmeasured cost and needs local-only wording. The manual picker
must be sufficient without suggestions or a comprehensive history scan. Explain
whether same-task association rests on recorded input evidence, a user declaration
or unknown evidence. Matching titles alone do not prove equivalent inputs. Open
the readable comparison, then offer export and display any retained review. Do not require
retyping the task, inspecting today's settings, launching/resuming a client or
creating a new experiment.

For **new work**, choose exactly two profiles (the first becomes the report's
left side), enter the task and choose a project; keep
limits, sandbox, executable, output cap and setup commands under
advanced settings with the existing defaults. Their consequences remain visible
in the pre-start preview, including relevant setup differences, checks and limits.
Verification is optional and visible before start. Reuse supported checks and
defaults without inventing commands or success criteria. When none are selected,
say **No verification checks selected** in both the final preview and report;
no additional confirmation dialog is required. Completion does not establish
verification. Repetition construction remains deferred to U4. For audit
experiments, Xenoflux creates a separate working copy of
the selected commit for each profile. Uncommitted edits and untracked files,
including ignored files, are not included in the starting snapshot. Xenoflux's
snapshot/preparation operations preserve the source worktree and index; this is
not a guarantee that executed commands cannot affect external resources. Scope
the separate-checkout description to audit experiments, not every xfx launch.
Show progress, a completion notice
and interrupted/partial states, then open the same report as the existing-session
path. Directly started sessions, by contrast, may have edited the same project
files; independent profiles do not imply independent project files. Do not promise
a new automated Desktop runner; directly started Desktop work can enter through
session selection.

For **setup inspection and selective copy**, open a profile, inspect or compare
its setup, then optionally choose Copy selected setup. Preview the exact source,
destination and selected changes before apply; expose the result and undo.
Inspection never activates or modifies a profile. Preserve the existing
[copy policy](PROFILE-COPY-POLICY.md), including excluded sensitive/runtime state,
native/manual integration setup and refusal of unsafe or incomplete operations.

### Minimum comparison result and disclosure

Use one readable page in the goal's order, with details expanding in place:

| Section | Shown by default | On demand |
| --- | --- | --- |
| Conditions | Task, profiles, clients, association basis and relevant recorded setup differences or explicit missingness. | Full recorded conditions and sources; today's setup as a separately labeled snapshot. |
| Behavioral findings | Material plain-language differences and similarities, each with its important limit and short labeled observations from both sessions, or an explicit missing side. | Other findings and their supporting evidence or derivation. |
| Paired action evidence | Short left/right observations supporting the main findings. | Additional actions, ownership and within-source sequence; no forced alignment of unrelated events. |
| Verification | Recorded check results, distinguishing agent claims, original checks, supplemental checks and optional reviews. | Check detail and attributed review revisions/disagreement. |
| Time and tokens | Comparable observations with scope labels, or unavailable/not-comparable states. | Accounting details, without invented cost or productivity conclusions. |
| Outcome and code | What was produced, relevant artifacts and review status. | File changes and code diff. |

Keep claim-specific limits beside the finding and a visible **What we could not
see** summary immediately after Conditions. A generic partial badge does not
explain the consequence of a gap. One pair should say that consistency is
unmeasured. Keep **Export report** discoverable; display retained reviews and
otherwise say **Not reviewed**. Adding reviews and constructing repeated
comparisons are deferred UI flows. Present reviewer judgments as attributed
judgments, never an application-declared overall winner or causal conclusion.

Do not require JSON specifications, scorers, AI judges or an additional model call
to understand the report. Avoid dense default audit tables, permanent expert
panels, badge overload and automatic reruns for unknown evidence. Collapse
exhaustive inventories, not the evidence needed to understand a material claim.
Use one short plain-language block per section as an editorial target and roughly
three initial findings, with View all findings and an indication of further or
conflicting evidence. These are not hard caps: never hide a material failure,
contradiction or limitation to meet them. Pair only supported observations; do
not force alignment. Keep the full paired-evidence section for deeper inspection.
Use ordinary language such as Repeated comparisons and Not recorded, with the
technical explanation underneath. Preserve original failures when later checks
or reviews are added.

Generate plain-language summaries and finding text deterministically from the
structured findings, with each sentence linked to the finding it states. An
optional AI-written narrative must not become the default explanation. Reduce
badge overload while keeping the observed result separate from evidence coverage.
Different, Same within the inspected scope and Could not compare can summarize
an individual, well-defined item; they must not become one overall status that
hides supported findings. For example, **Instructions differ** can coexist with
**We could not establish which instructions were loaded**. Fully read and equal
files do not establish equal effective runtime behavior. Not applicable is not
Could not compare. Added, removed, changed, partial, unknown, unavailable, redacted
and not-applicable remain distinct in details and exports, with material limits
also visible beside their claims. Reuse this deterministic wording in the CLI,
app and Markdown presentation rather than adding UI-only conclusions or a
second report pipeline. A future review entry may prefill existing evidence
references; it is outside the first UI release.

Standalone export is part of the minimum journey and needs two distinct
properties: **readable** without the app, remote assets or the original machine,
and **reopenable** by xfx after the original sources disappear. Current Markdown
exports reopen through their separate JSON sidecar. The selected first-release
format is **Markdown plus frozen JSON**, saved together in a clearly named folder
with the engine's filenames preserved. Show the saved folder location and explain that the
files must stay together. If the companion is missing, distinguish a readable
report from unavailable frozen reopen and allow locating the companion; do not
reconstruct evidence from current sources. Finder Quick Look behavior has not been
verified in this review and is not a platform-wide premise for choosing a format.
Self-contained offline HTML is a later enhancement. It could embed the same frozen JSON and reuse the
existing report model, but embedding alone does not make xfx able to reopen it:
HTML rendering and validated import are new format work.

During U0, validate that users can save, locate, read and understand the selected
export without viewer installation or command/JSON coaching. Plain-text reading
is acceptable; test it rather than assuming it is usable. Improve the shared
Markdown presentation if needed. If it still fails, surface the failed criterion
and revisit format scope before declaring export complete. Demonstrate reopening through existing
supported evidence or clearly label a simulation; do not require a new importer
to complete design validation. U2 must implement and verify actual basic
export/reopen for the selected format after disposable original sources are
removed, through both the app and CLI. Already retained review evidence must
survive display, export and reopen in the first release. U4 adds UI review
attachment and repeated-comparison construction, not permission to discard
existing evidence. Identify reopened reports as frozen, with recorded dates;
never substitute today's setup or project files.
Preserve privacy defaults and make included content reviewable; any embedded
payload must obey the same content choices as the visible report. Public sharing
still requires sanitization. Retain CLI/Desktop distinctions and unavailable
artifact states in both the readable view and the reopenable evidence.

### Local web architecture and density safeguards

- Keep existing Node.js discovery, comparison, accounting, review and persistence
  logic authoritative behind a narrow local API. The Node.js process serves the
  built frontend and API from the same origin. React presents structured
  results; it must not independently derive eligibility or task equivalence, or
  parse human-readable CLI output. No second audit pipeline or automatic judge.
- Keep history scans, report construction and large parsing work off the
  interactive path. Defer heavy inventories and code diffs until requested;
  collapsing already-loaded content is not a memory optimization by itself.
- Measure server start to usable browser controls, first session-list readiness
  and report opening. Record Node.js memory and the app tab's attributable memory
  separately, with the browser and measurement method identified; do not count
  unrelated browser tabs as application memory. Check idle and post-report usage.
  Set numerical budgets from the thin local app on the user's reference Mac
  before U1 acceptance; no performance result or threshold is established yet.
- Use a small shared set of components, text sizes, spacing and status labels.
  No permanent expert panels or always-expanded inventory tables in U1–U2.
  Small paired tables are allowed when useful. Stack paired observations at
  narrow widths with profile labels preserved.
- Bind only to loopback; no LAN/public hosting, remote account system or cloud
  service is part of this release. Validate allowed Host and request origins,
  restrict API access to the launched local app session and protect mutations
  against cross-site requests. CORS alone is not authorization. Choose a small
  local session/token mechanism during implementation, without user login setup.
- Render session/report content as untrusted inert data. Expose only validated
  operations over existing engine capabilities, not arbitrary filesystem or shell
  access. Bundle frontend assets locally; ordinary UI/report reading must not
  require a CDN or remote service. Explicit model runs retain provider needs.
- Provide one documented launch action that starts the local server and opens
  the browser; normal use must not require separate frontend/backend development
  commands. Make server-unavailable/port-conflict states actionable. Browser
  refresh, tab close, server stop and explicit task cancellation are distinct;
  show task state after reconnect and never duplicate work on reload. Preserve
  engine interruption/recovery semantics and unrelated running clients.
- Keep export/reopen usable through supported browser and local-server controls.
  The backend may save the Markdown/JSON pair together and show its location;
  do not assume unrestricted browser filesystem access, native dialogs or Finder
  integration. Validate the actual save/locate/read/reopen path without commands.
- Defer Electron packaging, IPC/preload code, bundled Chromium and native desktop
  integration. Do not add a speculative wrapper abstraction for future Electron.

These are implementation requirements for the selected host, not completed
checks. Apply [OWASP's CSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
and distinguish it from [browser CORS controls](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).
shadcn provides [editable component code](https://ui.shadcn.com/docs); customization
does not establish application accessibility or remove maintenance responsibility.

### Remaining validation questions and limits

- Can a non-engineer choose sessions, interpret their association, explain a
  supported finding and its limits, and export without command/JSON coaching?
  This requires a walkthrough; it has not been demonstrated by the mockups.
- Does the selected landing keep task and setup comparison equally discoverable,
  with profile/client controls easy to reach? Exact layout and optional-inspector
  interactions still need validation.
- Does progressive disclosure preserve enough evidence to understand each claim
  without opening every detail? Test partial, unavailable, empty, error and
  unreviewed states as well as a complete synthetic example.
- Can users read and preserve the Markdown/JSON pair without coaching? Host and
  format are selected, but usability and actual export/reopen remain unverified.
- Do suggested same-input pairs find the user's intended comparison often enough
  to justify the history scan? Suggestions remain outside the U0–U2 critical path;
  the manual picker must work when suggestions are absent or discovery is partial.
- Which macOS behaviors does the chosen host need? Prioritize readable/larger
  text, keyboard access, clear client ownership, source-access refusals and
  interruption/quit behavior in U0, with simulated states where appropriate.
  Keep-awake behavior, notifications and theme treatment are candidates to
  evaluate, not automatic U0 blockers. Verify browser file interactions, keyboard
  conventions, focus restoration, zoom and VoiceOver in the actual local app.
  Test refresh/reconnect, tab close and server interruption separately from task
  cancellation; a static browser prototype does not establish these behaviors.

Static images and the canvas's simulated interactions do not establish real
interaction, keyboard navigation, focus order,
screen-reader support, contrast compliance or live CLI/Desktop usability. Small
secondary text and wide comparisons are readability risks to check at narrower
window sizes and larger text settings. Test around 800 pixels wide and at 200%
zoom, with keyboard access and labeled stacked observations. The user will name
the walkthrough participant and reference Mac for the release; record coaching
and misinterpretations rather than equating developer checks with usability.
Test explicit client-operation labels,
source-access errors and offline exports in the eventual prototype; profile
selection must not operate a client. U0 uses synthetic data and simulated actions.
The [roadmap](ROADMAP.md) defines its observable acceptance. No UI implementation,
model task, live profile/client operation, publication or installation change is
authorized by this review. Other providers remain deferred.

## Historical assessment

The exact assessment from the published v2.1.0 source is preserved in
[PROFILE-AUDIT-ASSESSMENT-2.1.0-HISTORY.md](PROFILE-AUDIT-ASSESSMENT-2.1.0-HISTORY.md).
Its release-era implementation checkpoints and proposals are historical, not
active plans.
