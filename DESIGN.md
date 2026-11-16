# Xenoflux design reference

**Status:** built UI reference. This reference owns composition, tokens and interaction presentation for the local web app. [Product intent](PRODUCT.md) owns purpose and priorities. The [user guide](docs/GUIDE.md) owns journeys and supported limits; [contracts](docs/CONTRACTS.md) owns invariants. Verification covers the selected screens and states recorded with each change.

Xenoflux combines Inter, compact rounded controls and opaque layered surfaces on a neutral ground. Actions, links, focus and selection are neutral: ink in the light theme, porcelain in the dark theme. Cobalt and orchid identify the two compared sides. Status and measurement colors have separate semantic roles below. Dark mode uses a near-black `#0b0d10` ground with raised charcoal surfaces. Content stays calm and readable.

Show the decision, its evidence and its important limitation first; reveal technical detail on demand. The tokens below define the shared values. Show only supported actions and keep unavailable evidence explicit.

## Composition priorities

Xenoflux is a working tool. Setup and selection screens help people act; reports help them read evidence. Use familiar controls and restrained surfaces. Keep the neutral actions, Inter typography and profile labels consistent across both.

- Lead each page with its title, current profile or comparison scope, and next meaningful action. Give peer workflows equal weight before selection; use one primary action in each active task region.
- Put the result and any limitation that changes its interpretation before supporting detail. Keep the limitation beside the affected evidence, even when technical details are collapsed.
- Use a shared summary strip, labeled rows and dividers for related facts. Add a panel only when it groups a distinct task or evidence set. Do not wrap every section in a card.
- Align paired observations under the same field heading, with persistent Left/Right and profile names. Give both sides equal width and the same type scale. A longer response does not make that side more important.
- Reserve filled comparison badges, larger counts and stronger type for Different. Keep Same readable but quieter; keep Could not compare and its reason visible. Never style missing evidence as zero or an empty successful result. Do not imply an overall winner from a single comparison.
- Put routine metadata after the finding. Disclose paths, identifiers and raw evidence on demand; keep source scope and consequential choices visible.

Use 8px within a label/value or action group, 16px between related groups, and 24–32px between sections. A heading sits closer to its content than to the preceding section. The token tables below define the shared scale. Keep working views free of marketing heroes, permanent terminal decoration, nested cards and glowing outlines.

## Colors

Use semantic roles rather than raw colors in components. Both themes preserve the same meanings and hierarchy. Default to the system theme; use a simple System / Light / Dark override remembered locally. Follow system changes only while System is selected. Do not invert screenshots or evidence assets.

| Name | Light | Dark | Token | Role |
| --- | --- | --- | --- | --- |
| Canvas | `#f6f7f9` | `#0b0d10` | `--color-canvas` | Page background |
| Surface | `#ffffff` | `#14171c` | `--color-surface` | Reports, forms, cards, sidebar and toolbar |
| Raised surface | `#f0f2f5` | `#1b1f26` | `--color-surface-raised` | Conditions, paired evidence, nested panels and menus |
| Primary text | `#15181d` | `#e6e8eb` | `--color-text` | Headings, labels, body |
| Secondary text | `#5a6370` | `#9aa3ad` | `--color-text-muted` | Supporting copy; still readable |
| Decorative divider | `#dfe3e8` | `#262b33` | `--color-divider` | Nonessential grouping |
| Control boundary | `#7a828e` | `#6b7380` | `--color-control-border` | Inputs or controls needing a visible outline |
| Primary action fill | `#15181d` | `#e6e8eb` | `--color-action` | Ink in light, porcelain in dark |
| Primary action text | `#ffffff` | `#0b0d10` | `--color-on-action` | Text on the action fill |
| Primary action boundary | `#15181d` | `#e6e8eb` | `--color-action-border` | Matches the fill |
| Link / focus | `#15181d` | `#e6e8eb` | `--color-link-focus` | Neutral; links are told apart by their underline |
| Selected background | `#e6e9ee` | `#242a34` | `--color-selected` | Selected rows, tabs, controls |
| Selected foreground | `#15181d` | `#ffffff` | `--color-on-selected` | Selected text |
| Checked control fill | `#15181d` | `#e6e8eb` | `--color-checked` | Visible checkbox selection |
| Checked control mark | `#ffffff` | `#0b0d10` | `--color-on-checked` | Checkmark on selected checkbox |
| Informational surface | `#eef1f5` | `#181c23` | `--color-info-surface` | Neutral fill for informational notices |
| First profile (side A) | `#1f5fd0` | `#5aa0ff` | `--color-side-a` | Cobalt; identifies the first or left profile |
| First profile surface | `#eaf2ff` | `#14233a` | `--surface-side-a` | Tint behind side A values and lines only in side A |
| Second profile (side B) | `#a8338f` | `#e68ad6` | `--color-side-b` | Orchid; identifies the second or right profile |
| Second profile surface | `#fbeef8` | `#33202f` | `--surface-side-b` | Tint behind side B values and lines only in side B |
| Uncached input measurement | `#0f8f86` | `#45c4b8` | `--color-measure-input` | Token mix category; never profile identity or status |
| Cached input measurement | `#0b5f5a` | `#1f8a84` | `--color-measure-cached` | Token mix category; included within input |
| Other output measurement | `#c56a12` | `#f2a65a` | `--color-measure-output` | Token mix category; output excluding reasoning |
| Reasoning measurement | `#8f3d0f` | `#c8632c` | `--color-measure-reasoning` | Token mix category; included within output |

The measurement colors are teal for input and amber for output, with the darker shade of each for the included subset; they stay clear of the side and status hues. Use the four together only in the shared token composition legend and bars. Draw disjoint segments for uncached input, cached input, output excluding reasoning, and reasoning. Cached input and reasoning remain subsets of input and output. Keep category names visible and scale every bar across both sides and all actors against the same maximum.

Use the neutral action, link, selection and focus roles in both themes: ink on light surfaces, porcelain on dark ones. No interactive control borrows cobalt or orchid. A link has the same color as body text, so underline every link that is not a button or navigation item and separate focus outlines from controls with a visible offset. Selection also needs a checkmark, indicator or explicit label.

Use solid action fills in both themes. The informational surface is neutral and uses primary/secondary text, a 3px link/focus-colored leading edge and a link-colored info icon; it does not indicate a successful check.

### Status colors

Keep status tokens separate from brand tokens. Use these foreground/background pairs for text and icons in badges or notices; status color is never the only signal.

| Status | Light foreground / background | Dark foreground / background | Meaning |
| --- | --- | --- | --- |
| Success | `#166534` / `#f0fdf4` | `#86efac` / `#13261b` | A named operation or check succeeded within its stated scope |
| Warning | `#854d0e` / `#fffbeb` | `#fcd34d` / `#2a2310` | Attention is needed; explain the consequence |
| Error | `#991b1b` / `#fef2f2` | `#fca5a5` / `#301b1e` | A named operation or check failed |
| Neutral / unknown | `#5a6370` / `#ffffff` | `#9aa3ad` / `#14171c` | Same, Could not compare, unknown, unavailable, not applicable, not reviewed and review verdicts; retain the exact label |

Name status tokens `--color-{success,warning,error,neutral}` and their backgrounds `--surface-{success,warning,error,neutral}`. Neutral badges carry a 1px `--color-control-border` outline unless the comparison label table specifies a quieter treatment for Same.

Supporting interaction and alert tokens:

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--color-action-hover` / `--color-action-pressed` | `#2a2f38` / `#3a404b` | `#ffffff` / `#c5cad2` | Primary action hover and pressed fills (Interaction states) |
| `--color-link-hover` | `#454c58` | `#ffffff` | Link hover text |
| `--border-warning` | `#e3c27a` | `#5e4f1e` | Decorative outline of a warning alert panel |
| `--border-error` | `#e8a3a3` | `#6e353c` | Decorative outline of an error alert panel |

Alert outlines are decorative: the alert's title and text carry its meaning, so they need no 3:1 contrast. Use `--color-error` for field error outlines, which do.

Missing evidence is not automatically an error; a completed run is not automatically verified. Keep completion neutral unless a separate, named check supports a success label.

Do not distinguish the two compared profiles with success/failure colors. Keep their names and side labels visible.

### Profile identity colors

Cobalt (side A) and orchid (side B) say **which profile** something belongs to, never which is better. Use them for profile chips and column headers, and for Different values and lines. Left is always cobalt (side A), and Right is always orchid (side B). Swap sides moves the profiles between those positions and updates every chip, value and diff tint together. The colors identify positions within this comparison, not permanent profile identities.

- Always pair the color with the profile name; the colors never carry meaning alone.
- Keep profile chips and column headers side-colored for orientation. Within result rows, use side colors only on Different values and lines. Same and Could not compare values use secondary text.
- Do not use side colors for status, buttons, links or selection, and do not use them outside a two-profile comparison.
- Do not add more profile colors. Use the two side roles even when the task compares sessions from the same profile. Profile eligibility belongs to the [comparison journeys](docs/GUIDE.md#compare-a-task).
- Show the colors as soon as the two profiles are chosen (for a new task, in the profile pickers and the pre-start review), so the run visibly leads to its report.

### Comparison, review and run labels

Success, warning and error are reserved for named operations and checks. Comparison results and review verdicts describe evidence, not quality, so they never use those colors. Direct attention with fill and weight instead of hue. Among comparison labels, Different is the only filled badge, Same recedes, and Could not compare stays outlined. Show the exact engine state in details and exports.

| Label | Treatment | Covers |
| --- | --- | --- |
| Different | Filled badge (primary-text fill, surface-colored text), 600 weight, ≠ icon. The item name is 600 weight and its two values use the side colors | Changed, added, removed |
| Same | Neutral badge with a divider-colored outline, 400 weight, secondary text, = icon; item name and summary in secondary text | Identical |
| Could not compare | Neutral badge with a dashed outline and ? icon; the reason sits beside it, never only in a tooltip | Partial, unknown, unavailable, redacted |
| Not applicable | Secondary text without a badge | Not applicable |

| Item | Treatment |
| --- | --- |
| Review verdicts (positive, negative, mixed, inconclusive) | Neutral badge with the verdict as text, plus reviewer type (human or AI) and name. Show disagreeing reviews side by side; never color one as winning. |
| Not reviewed | Neutral badge. |
| Verification check passed / failed | Success / error, naming the check. A claim in the session never takes a success label; show it next to the check result. |
| Check not run or not selected | Neutral, with "No verification checks selected" where none were chosen. |
| Run running | Neutral with a named progress label and no percentage unless measured. |
| Run finished | Neutral; finishing is not verification. |
| Run interrupted or cleanup needed | Warning, explaining what was preserved and the next supported step. |
| Report saved, or pre-start checks passed | Success, naming what succeeded ("Saved", "Ready to start" with what was checked). |
| Run failed to start or failed | Error, naming what failed. |
| Run cancelled | Neutral. |

Setup and content diffs use `+` / `−` gutter marks and an "only in [profile]" label. Lines only in side A use the side A surface with a 3px side A leading edge; lines only in side B use side B. Changed-in-place lines use the raised surface. Do not use green/red diff colors; they would read as better/worse.

Token composition bars follow the measurement roles above. Subtract cached input from input and reasoning from output before drawing segments. Keep exact counts and unavailable totals visible beside the bars; a missing quantity is not a zero-length measurement.

## Typography tokens

### Inter · `--font-ui`

Use the bundled **Inter** at weights 400, 500 and 600, with a system sans fallback. Retain its license notices; normal use must not fetch remote fonts. Use the existing/system monospace stack for code, paths and identifiers.

### Type scale

| Role | Size / line height | Weight | Token |
| --- | --- | --- | --- |
| Page title | 32px / 1.2; 28px in narrow layouts | 600 | `--text-title` |
| Section heading | 22px / 1.3 | 600 | `--text-heading` |
| Report prose | 16px / 1.5 | 400 | `--text-body` |
| Controls and table text | 14px / 1.5 | 400–500 | `--text-ui` |
| Supporting metadata | 13px / 1.5 | 400 | `--text-meta` |
| Code and identifiers | 13–14px / 1.5 | 400 | `--text-code` |
| Summary counts | 40px (Different) and 28px (other tiles) / 1.1 | 600 | `--text-count` / `--text-count-secondary` |

Summary counts are the only numerals outside the scale: they appear only in comparison summary tiles, always with tabular numerals and a text label. Use relative sizing in implementation and let text wrap. Keep ordinary text tracking normal; slight negative tracking is optional on large headings only. Do not use tiny mockup text or compressed display line heights. Use tabular numerals for aligned measurements, with units and scope labels.

### Monospace · `--font-mono`

Use `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` for code, paths and identifiers only. Keep ordinary labels and report prose in the sans family.

## Spacing and shape tokens

**Base unit:** 4px

**Density:** comfortable controls with compact, readable data rows.

### Spacing scale

| Name | Value | Token |
| --- | --- | --- |
| Tight | 4px | `--space-4` |
| Related items | 8px | `--space-8` |
| Small group | 12px | `--space-12` |
| Standard gap | 16px | `--space-16` |
| Panel padding | 24px | `--space-24` |
| Section gap | 32px | `--space-32` |
| Major separation | 48px | `--space-48` |

### Border radius

| Element | Value | Token |
| --- | --- | --- |
| Buttons, inputs and controls | 8px | `--radius-control` |
| Panels | 12px | `--radius-panel` |
| Tags and filter pills | 9999px | `--radius-pill` |

### Borders and shadows

Use 1px structural borders. Keep reading panels flat; reserve modest shadows for floating menus and dialogs. Focus rings are separate from decorative borders. See Elevation for surface relationships.

### Layout tokens

| Role | Value | Token |
| --- | --- | --- |
| Content maximum | 1152px | `--content-max` |
| Page gutter / panel padding | 24px; 16px below 800px | `--page-gutter` / `--panel-padding` |
| Control minimum height | 40px | `--control-height` |
| Reading measure | 65–75 characters | — |

Let content determine height. Dense tables may reduce padding, but retain readable text and usable targets; do not add a density switch without a demonstrated need.

## Components

### Comparison hub

The app opens on Comparisons. Keep discovery as a separate introductory action,
then give Compare a task and Compare setups equal panel weight. Within the task
panel, use equal underlined links, descriptions and availability summaries for
Use existing sessions and Run a new task. Separate these choices with ruled
spacing rather than nested cards. Recent work follows as flat rows.

### Primary action button

**Role:** The next meaningful step, such as Compare sessions or Export report.

Use action fill, on-action text and action-border tokens, 8px corners, 40px minimum height and 8px 16px padding. Text is 14px/500. Preserve equal visual weight for equal choices; emphasize a next step only after a workflow is selected.

### Secondary button and text link

**Role:** Browse sessions, View details, Back and supporting navigation.

Use a neutral surface, primary text and control boundary for buttons. Text links use link/focus color; underline links within prose. Keep secondary actions visible without competing with the primary action.

### Destructive button

**Role:** A supported operation with destructive consequences.

Use a specific verb, explain consequences and use the danger colors in Interaction states. Do not borrow primary styling or make ordinary navigation look destructive.

### Form field

**Role:** Search, filters and user input.

Use surface fill, primary text, control boundary and 8px corners. Keep a persistent label and associate help/error text with the field. Placeholder text does not replace a label. Preserve values after validation failures.

### Session picker row

**Role:** Select two recorded sessions for comparison.

Select exactly two sessions with checkboxes, without a select-all control or separate side slots. Keep deselection available at the limit and explain why another selection is unavailable. Show task title, profile, client, project, recorded date and state, with identifiers in details. Use one grouped list with separators, visible checkboxes, selected background/foreground tokens and a 3px link/focus-colored leading edge on selected rows. Preserve keyboard operation and selection across filters and responsive layouts. Inspection and selection never start or resume a session. Show the recorded, user-declared or unknown task-association basis; matching titles never precheck a declaration or establish recorded equivalence.

Below the list, a selection summary names the comparison sides: **Left** and **Right**, each with its profile name and task title, plus a **Swap sides** button. The first ticked session fills Left and the second fills Right; unticking one frees that side for the next tick. The summary reflects the same side assignments as the tray, so the report's column order is visible before Compare.

### Sessions library and comparison tray

**Role:** Find a recorded session, inspect it, or collect two for a comparison.

List sessions in one panel with a count heading. Each row shows title, project, recorded date and turns, then profile and client, the history state badge and its actions: **Inspect**, a **Compare** toggle and the supported resume or report action. Row actions use a 32px height. From 1440px the fields align in columns; below that they wrap onto further lines without dropping any.

The **Compare** toggle adds the session to the comparison tray, a sidebar section that appears once a session is picked and stays across pages and reloads in the same window. The tray names Left and Right with each session's title and profile, a remove control per side, **Swap sides** and, once both are filled, the primary **Compare…** link to the picker. A picked row carries its side surface and shows **Left** or **Right** on its pressed toggle. With two picked, other toggles are disabled and the count heading says why. The tray hides on the picker, which shows the same pair in full, and empties after a comparison is created.

### Session inspector

Use addressable Overview, Activity, Harness, Context, Usage, Outcome and Source
sections. Keep the session identity, comparison/export actions, completion limit
and section navigation visible above the selected evidence. The selected section
uses the neutral selected fill, weight and an underline; links wrap at narrow widths.

Overview leads with scoped measurements, the first retained user message and the
last recorded response. Keep missing-context qualifications beside that message.
Source contains detailed coverage and provenance. Preserve the replay's selected
event and search across section switches; source actions reveal Activity and focus
the existing event inspector. Harness and Context reuse the report's evidence
components without changing their interpretation.

### Comparison report

Use the chosen Counts lead composition at desktop widths of 1280 CSS pixels and
above. Narrow comparison-report layouts are not a support target. Preserve the
other pages' existing reflow behavior.

Keep compact Left/Right identities and recorded session details above section
navigation. Put supporting provenance in each side's native Details disclosure;
keep task status and evidence limits visible. Four tiles lead the report: Different, Same, Could not compare and
Checks selected. The first three count the engine's recorded findings, not condition
rows or quality scores. Use the secondary count size (28px), with a stronger neutral
boundary on Different. An unavailable check count stays unknown.

A paired recorded-activity card follows, then the conditions card. Stops open
their retained source event in the existing inspector. Each lane uses its own
clock. Use recorded order and a dotted line when stop timestamps cannot establish
an ordered scale. Only retained parent relationships identify delegated lanes.
Turn stops remain hollow while per-turn token totals are unavailable; session
totals never imply a per-turn allocation. Keep scoped usage in Time and tokens.

### Profiles and clients

Profiles is a compact inventory grouped by client, with neutral profile names and
counts. Align each profile's identity, observed sign-in and project binding with
its CLI/Desktop state. Label the account with the surface that reports it. Use
one account label for named Codex profiles, where CLI and Desktop share a sign-in.

Separate inspection links from client actions. When Profiles opens, check
available CLI accounts in the background and reconcile confirmed-stopped clients.
Show the normal Open action after reconciliation. Sign-in, opening and closing
clients require explicit actions. Keep registry edits and selected copying in the
named More menu. Creation is the page's primary action. Preserve row identity, open dialogs
and focus across automatic checks. Closing an edit dialog opened from More
returns focus to that profile's More button while it remains present.

Clients on this Mac keeps installation observations and existing setup findings
in flat aligned rows. Group check scope, freshness and automatic-check timing
compactly; failed refreshes retain their previous findings and explanation. Paths
and detailed reasons stay in disclosures. Stock Native apps controls live here,
separate from profile-bound opening, with their existing-setup scope visible.
Stack all inventory columns below 800px without hiding actions or evidence limits.

### Setup inspection and selected copying

Keep the selected setup and optional repository scope above the current read.
Pair source search, category selection and reading coverage with one flat source
inventory. Keep each category's limits visible and disclose values, files and
source facts in place. Refresh is explicit; browsing source evidence does not
reread or mutate the setup. Mixed-client inventories keep independent labels and
coverage under aligned category headings, without equality counts or copy actions.

Use compact count controls for same-client setup comparisons, followed by reading
limits and the searchable list/detail workspace. Group related rows with dividers,
keeping the selected result and its exact state visible.

Selected copying pairs the file preview with a destination and selection summary.
The summary names every checked item and the apply action names the destination.
File-detail controls sit outside checkbox labels. Keep manual setup and never-copied
boundaries below the preview; preserve the result, Undo explanation and drift
refusal. On narrow windows, the summary follows the preview in reading order.

### Task preparation and Activity

Organize preparation as Task and source, Two setups, Checks and limits, then
Review and start. Keep the first three sections mounted and directly addressable;
stage links move within the form without discarding values. Place source exclusions
beside repository selection, model/effort/permission controls beside each profile,
and command effects beside the optional commands. A compact This run summary holds
the review action; it follows the form at narrower widths and never covers fields.

Review leads with the engine's readiness and side order, the no-checks consequence
and the explicit start action. Keep exact task, pinned source, controls and limits
inspectable, with edit links returning to the corresponding preparation section.
Use neutral dividers and paired columns rather than nested colored cards.

Activity separates current jobs from recent comparison records. Job links lead to
their existing progress and native requests; the list does not infer completion or
approval state. Progress keeps Left/Right names and sequential steps visible, using
icons and text for recorded step states. Only measured time gets a progress bar.
Cancellation and recovery remain explicit actions with their preserved-evidence
consequences visible. After terminal states, label side states and steps as retained
history so a recorded wait cannot look like a live unanswered request. Stack paired
columns below 800px in both themes.

### Reviews, export and saved reports

Keep review preparation, external submissions and attached ratings as distinct,
addressable sections. Pair ordinary review profile/workspace, execution fields and
prompt with content and limit choices. Preview receives focus; Edit review returns
to its trigger. Keep the frozen prompt, native effects and exact input files visible
before Start. A retained response leads its task record; requested settings, reported
settings, response capture and process shutdown remain separate observations.
Ratings preserve attribution, citations, disagreement and earlier versions with
neutral verdicts. Use flat topic sections and equal-width peer annotations.
Label a review of the report subject “This comparison”; keep its exact scope
identifier in a disclosure.

Export pairs the retained evidence and opt-in content choices with a save summary.
Name the destination, both files and current inclusion choices. Disable content
changes while saving, focus the result and retain evidence-binding refusals.
Saved reports leads with flat recent entries and a separate JSON opener. Opening
focuses retained facts before secondary transcript import controls. Preserve both
import paths and their effects. Keep previous entries labeled when list refresh
fails, and clear the prior opened result before attempting another location.

### Evidence panel and disclosure

**Role:** A finding with paired observations and inspectable detail.

Use neutral surfaces, 12px corners where a container is needed, and the responsive panel padding token. Prefer headings and dividers over nested cards. Keep profile labels and important limits visible; expand supporting detail with a clearly labeled disclosure that exposes its expanded state.

### Status badge and informational notice

**Role:** Communicate a specific state or evidence limit.

Use the status pairs with text and an optional icon, following the label tables under Status colors and Comparison, review and run labels. Distinguish running, interrupted, failed, unknown, unavailable, not applicable and not reviewed. An informational notice uses info-surface with primary/secondary text, a 3px link/focus-colored leading edge and a link-colored icon. Evidence limits such as **What we could not see** use this notice; it is never styled as success.

### Dialog and inspector

**Role:** Focused decisions or supporting inspection.

Give the surface a clear title and accessible controls. Modal dialogs contain focus and restore it when closed. Nonmodal inspectors do not trap focus. Keep background text out of translucent overlays.

### Empty, loading and interrupted states

**Role:** Explain absence, progress or a failure and the supported next step.

Distinguish No sessions found from Could not read sessions. Show measured progress only when known, prevent duplicate starts and expose cancellation only where supported. Explain what was preserved after interruption and retain useful partial results.

### Interaction states

| State | Treatment in both themes |
| --- | --- |
| Primary hover / pressed | Use the `--color-action-hover` / `--color-action-pressed` fills respectively, retaining the on-action text and the theme's primary boundary. Do not change size or position. |
| Secondary hover / pressed | Use raised / selected surface respectively with primary text and the control boundary. A transient press is not persistent selection. |
| Input default / hover | Surface fill, primary text, secondary placeholder and control boundary. Hover may use raised fill; retain the label and outline. |
| Row hover / selected | Use raised surface on hover. Selected rows use the selected background plus a 3px link/focus-colored leading edge, which takes precedence over hover; retain the checkbox or explicit selected indicator. The two backgrounds are too close to tell apart on their own. |
| Checkbox hover / checked | Strengthen the outline with link/focus color on hover. Use the checked-control fill and mark tokens only when checked. |
| Keyboard focus | A solid 2px link/focus ring with a 2px surface-colored gap. Keep it visible and unclipped; do not rely on a fill change. |
| Disabled | Raised surface, secondary text, decorative divider boundary, no hover/pressed treatment or activation. Use an actual disabled state and explain the reason in adjacent readable text when needed; do not fade the entire group. |
| Busy | Retain the action's styling and width, show a named progress label such as Comparing sessions, and prevent duplicate activation. Announce progress without repeatedly moving focus. |
| Error | Error foreground outline plus a text explanation associated with the field. Keep entered values and labels. If focused, retain the separate focus ring. |

Destructive buttons use white text with light-theme fills `#b91c1c` / `#991b1b` / `#7f1d1d` for default / hover / pressed. Dark-theme fills are `#991b1b` / `#7f1d1d` / `#681717`, with an error-foreground boundary. Use a specific verb and consequence; keep routine primary actions neutral.

Hover must not be the only way to discover an action. Keep links underlined in prose. Use native buttons, inputs and checkboxes or equivalent accessible components. Validation errors must have programmatic associations; for a failed submit, focus an error summary or the first invalid field as appropriate. Do not present an untouched required field as an error. Hide unfinished features rather than presenting inactive promises. Disable an implemented action only when its current prerequisites are unmet, with an understandable reason.

## Surfaces

| Level | Token | Purpose |
| --- | --- | --- |
| Base | `--color-canvas` | Page background |
| Content | `--color-surface` | Forms and reading surfaces |
| Raised | `--color-surface-raised` | Grouped evidence, menus and nested panels |
| Selected | `--color-selected` | Explicitly selected rows or controls |
| Informational | `--color-info-surface` | Evidence-limit notices; not a higher elevation |

## Elevation

Separate surfaces primarily with spacing, neutral fill changes and borders. Ordinary cards and report sections remain flat. Use restrained shadow only where a floating menu or dialog needs separation; it must not substitute for readable boundaries. Keep surfaces opaque behind working content.

## Imagery

Use product evidence and diagrams only when they explain the current task. Avoid decorative mascots, floating screenshots and atmospheric effects in working views. Use one consistent outline icon family from the component stack; icons support labels and icon-only controls need accessible names.

## Layout

Use a sidebar for the destinations (Sessions, Comparisons, Profiles), running activity and the theme choice, and a toolbar above the page for back, forward and the breadcrumb. Sidebar and toolbar sit on the surface color; pages sit on the canvas. The current destination has the selected fill and 600 weight. Below 1100px the sidebar stacks above the content. Keep ordinary reading blocks around 65–75 characters wide; paired evidence and tables can use the wider available space.

The app opens on Comparisons. Breadcrumbs use Comparisons for that destination,
matching its sidebar label. Secondary pages keep their owning destination selected;
export keeps Sessions for a retained session and Comparisons for a comparison.

| Destination | Pages and actions |
| --- | --- |
| Sessions | Session library, choose by profile and retained session inspection |
| Comparisons | Comparison hub, session picker, setup comparison, new-task preparation, reports and reviews |
| Saved reports | Secondary destination under Comparisons for recent locations, JSON reopening and transcript imports |
| Profiles | Registry entries, setup inspection, profile creation and selected copying |
| Clients on this Mac | Secondary destination under Profiles for installation observations, existing setups and stock Native apps |
| Activity | Sidebar link for current jobs, recent records, progress and recovery |

The component sections above own each page's composition. Keep the hub's peer
choices equal in weight, lead reports with Counts lead, and keep verification,
completion and reviewer judgment separate. Setup comparisons use compact count
filters and a list/detail workspace; mixed-client inventories omit equivalence
counts and copying. Skill packages keep one file navigation panel beside a single
ruled file-content panel. Each file keeps its comparison state, exact text and
whole-package copy consequences.

Discovery stays separate from native opening and profile changes. Keep unsupported
profiles visible and label retained findings during refresh or refresh failure.
Automatic checks preserve focus and form input. Keep profile names and task titles
as primary labels, with identifiers in details. The [guide](docs/GUIDE.md) owns
supported journeys and limits; [contracts](docs/CONTRACTS.md) owns evidence and
operation invariants.

Use a fluid layout with a 1152px content maximum, 24px page gutters, and 16px gutters below 800px. Below 800px, stack landing choices, search/filter controls and paired observations; repeat profile labels. Wrap navigation and action groups without changing their reading order or hiding essential actions. Let content pressure trigger stacking earlier when needed.

In a narrow session picker, render each session as a labeled row with its checkbox, task title, profile, client, project, recorded date and state. Keep all fields available; move metadata onto additional lines rather than shrinking text or dropping columns. Preserve selection across layout changes. The selection summary, with its Left/Right sides and Swap sides, and the next action follow the list in normal flow and never cover content. Wrap long names; keep full identifiers accessible in details. Confine necessary horizontal scrolling to code or genuinely two-dimensional data tables, not the whole page. Preserve all meaningful content at zoom; do not hide limitations to simplify a small screen.

## Motion

Keep row selection, filtering and keyboard navigation immediate. Use 120–200ms transitions only when they clarify feedback or a disclosure state. Do not animate every section on arrival, move controls on press or shift evidence while it is being read. Respect reduced motion by removing nonessential movement. Avoid animated ambient backgrounds, pulsing decoration and loading indicators that imply measurable progress when none is known.

## Accessibility

Use WCAG 2.2 AA as the web accessibility target. Check normal text contrast of at least 4.5:1, qualifying large text at least 3:1, and essential control/graphic contrast at least 3:1. Support keyboard operation, visible unobscured focus, accessible names, status announcements and errors that do not rely on color. Outside the desktop comparison report, check reflow at 320 CSS pixels, with appropriate exceptions for genuinely two-dimensional content. AA pointer targets are at least 24×24 CSS pixels or meet a permitted exception; the 40px control height above provides a more comfortable default for pointer use on macOS. These are selected checks, not a complete conformance checklist. Follow the [verification exclusions](CONTRIBUTING.md#checkout-and-checks); excluded checks are not outstanding work. See the [W3C reference](https://www.w3.org/WAI/WCAG22/quickref/).

Use named header/navigation/breadcrumb/main landmarks and labelled supporting asides. Keep one `h1` per page, `h2` sections and `h3` cards; report heading order follows its reading order. Menus support arrows, Home/End and Escape; native controls or equivalent accessible components retain their keyboard semantics.

Focus mounted page headings and export/opened-report summaries; in-page selection retains focus. Nonmodal inspectors receive focus only on explicit open and restore their trigger; delayed callbacks respect newer focus choices. Announce selection/filter/save/progress/apply/undo politely, not per event; alerts identify user-action errors.

Static token checks do not establish rendered accessibility, every state or
image contrast. Verify contrast in the rendered interface.

Selected/hover fills (1.09:1 light, 1.15:1 dark) and canvas/surface (1.07:1 light)
cannot carry meaning alone; retain text, icons, outlines, weight and leading edges.
Link color equals text color, so the underline is required. Test actual composition, focus and disabled/busy
states, including keyboard, long/empty/error/partial states and narrow reflow
in both themes. Record results/limits in release summaries.

## Implementation and review

Keep [tokens.css](web/src/styles/tokens.css) as the single value source. [app.css](web/src/styles/app.css) maps it into Tailwind and shared component styles. Consume semantic tokens in both themes; do not create per-screen palettes or a second report renderer. Text-size tokens hold size only; apply the documented weight and line height separately.

Reuse the existing shadcn/ui components and AI Elements. Preserve the project's configured base, icon family and aliases in [components.json](web/components.json); this reference does not require a preset change, new component package or component installation.

| Component role | Xenoflux token mapping |
| --- | --- |
| Background, foreground | Surface, primary text; page chrome uses canvas |
| Primary action | Action, on-action and action-border; explicit hover and pressed roles |
| Muted content | Raised surface and secondary text |
| Selection | Selected and on-selected, with a persistent indicator |
| Decorative border | Divider; never substitute it for an essential control boundary |
| Input outline, focus | Control-border and link-focus respectively |
| Status, profile identity, measurements | Their dedicated semantic roles; never infer them from a default Badge or chart palette |

Style shared component variants at their owner. Use page classes for layout rather than repeated color, radius or type overrides. Preserve native button, link and checkbox semantics when composing controls.

For a UI change, review the affected screen and states against these questions:

- Can the user identify the scope, result, important limitation and next action without opening technical details?
- Do both themes preserve the action, selection, profile and status meanings? Are essential outlines and focus rings visible on the actual background?
- Do paired evidence and long names remain understandable when stacked below 800px? Can keyboard users reach details and return without losing their place?
- Are loading, empty, unavailable, failed and interrupted states distinct, with useful retained content and a supported next step?

Run the relevant [development checks](CONTRIBUTING.md#checkout-and-checks). Documentation-only changes require `check:docs`; token-table edits also warrant `node scripts/check-design-tokens.mjs`. UI changes need the required build and browser checks. Report which states were inspected and any limitations; a token match or green build alone does not prove visual quality or accessibility.
