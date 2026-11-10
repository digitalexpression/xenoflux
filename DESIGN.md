# Xenoflux — Style Reference

> A precise technical workspace: cobalt actions and soft mint accents on clear light surfaces or an Obsidian canvas.

**Theme:** light + dark, following the system preference.

**Status:** adopted design direction, 2026-10-27. This standalone guide covers Xenoflux's local web app. The [roadmap](docs/developer/ROADMAP.md#current-work-and-stop-condition) owns current implementation and built-app verification status; this design specification is not proof that its behavior has been verified.

Xenoflux combines IBM Plex Sans, compact rounded controls and opaque layered surfaces. Cobalt identifies actions and links; Soft Mint supports the identity without implying success. Dark mode uses Obsidian `#0a0d16`, raised navy surfaces and lighter cobalt interaction cues. Content stays calm and readable, with technical character concentrated in typography and small header accents.

Show the decision, its evidence and its important limitation first; reveal technical detail on demand. Generated mockups illustrate this direction, but the tokens below define the intended values. Show only supported actions and keep unavailable evidence explicit.

## Tokens — Colors

Use semantic roles rather than raw colors in components. Both themes preserve the same meanings and hierarchy. Default to the system theme; use a simple System / Light / Dark override remembered locally. Follow system changes only while System is selected. Do not invert screenshots or evidence assets.

| Name | Light | Dark | Token | Role |
| --- | --- | --- | --- | --- |
| Canvas | `#fcfdff` | `#0a0d16` | `--color-canvas` | Page background; Obsidian in dark mode |
| Surface | `#ffffff` | `#121a2c` | `--color-surface` | Reports, forms, cards |
| Raised surface | `#f0f4ff` | `#19243a` | `--color-surface-raised` | Conditions, paired evidence, nested panels and menus |
| Primary text | `#18233b` | `#f1f5ff` | `--color-text` | Headings, labels, body |
| Secondary text | `#4d5970` | `#b0bdd3` | `--color-text-muted` | Supporting copy; still readable |
| Decorative divider | `#d2dcf0` | `#34415c` | `--color-divider` | Nonessential grouping |
| Control boundary | `#6b6d72` | `#7d8ba7` | `--color-control-border` | Inputs or controls needing a visible outline |
| Primary action fill | `#2447c6` | `#2447c6` | `--color-action` | Cobalt in both themes |
| Primary action text | `#dcfff1` | `#dcfff1` | `--color-on-action` | Pale mint on cobalt |
| Primary action boundary | `#2447c6` | `#668cff` | `--color-action-border` | Visible edge against surrounding surfaces |
| Supporting accent | `#9de7cc` | `#9de7cc` | `--color-accent` | Soft Mint; small header accents only |
| Link / focus | `#2447c6` | `#8cabff` | `--color-link-focus` | Cobalt; lighter variant for dark-mode text and focus |
| Selected background | `#eaf0ff` | `#1c3155` | `--color-selected` | Selected rows, tabs, controls |
| Selected foreground | `#2447c6` | `#f1f5ff` | `--color-on-selected` | Selected text |
| Checked control fill | `#2447c6` | `#8cabff` | `--color-checked` | Visible checkbox selection |
| Checked control mark | `#ffffff` | `#0a0d16` | `--color-on-checked` | Checkmark on selected checkbox |
| Informational surface | `#edf2ff` | `#172241` | `--color-info-surface` | Subtle cobalt tint for informational notices |
| First profile (side A) | `#6d28d9` | `#c4b5fd` | `--color-side-a` | Violet; identifies the first or left profile |
| First profile surface | `#f5f3ff` | `#262046` | `--surface-side-a` | Tint behind side A values and lines only in side A |
| Second profile (side B) | `#0e7490` | `#67e8f9` | `--color-side-b` | Teal; identifies the second or right profile |
| Uncached input measurement | #2f80ed | #5aa2ff | --color-measure-input | Token mix category; never profile identity or status |
| Cached input measurement | #087d92 | #39c8dd | --color-measure-cached | Token mix category; included within input |
| Other output measurement | #635bff | #a29aff | --color-measure-output | Token mix category; output excluding reasoning |
| Reasoning measurement | #c94f00 | #ff9857 | --color-measure-reasoning | Token mix category; included within output |
| Second profile surface | `#ecfeff` | `#10323b` | `--surface-side-b` | Tint behind side B values and lines only in side B |

Use the four measurement category colors together only in the shared token
composition legend and bars. They identify non-overlapping quantities: cached
input and reasoning are subsets of input and output. Keep category names visible,
and scale every bar in one comparison against the same maximum.

Use cobalt for actions, links, selection and focus in both themes. Soft Mint is a supporting accent, not small text on a white background. In dark mode, keep cobalt primary actions with pale mint text; use lighter cobalt for links, focus, checkboxes and selection marks, with navy-blue selection surfaces. Keep the primary action's visible boundary against dark surrounding surfaces. Underline links within prose and separate focus outlines from controls with a visible offset. Selection also needs a checkmark, indicator or explicit label.

Use solid action fills in both themes. Keep Soft Mint to the pale mint action text and small header accents; do not use it for notices, checkboxes, selection or any surface near evidence, because its hue is too close to the success colors. The informational surface is cobalt-tinted and uses primary/secondary text, a 3px link/focus-colored leading edge and a link-colored info icon; its tint does not indicate a successful check.

### Status colors

Keep status tokens separate from brand tokens. Use these foreground/background pairs for text and icons in badges or notices; status color is never the only signal.

| Status | Light foreground / background | Dark foreground / background | Meaning |
| --- | --- | --- | --- |
| Success | `#166534` / `#f0fdf4` | `#86efac` / `#142b20` | A named operation or check succeeded within its stated scope |
| Warning | `#854d0e` / `#fffbeb` | `#fcd34d` / `#302711` | Attention is needed; explain the consequence |
| Error | `#991b1b` / `#fef2f2` | `#fca5a5` / `#341c24` | A named operation or check failed |
| Neutral / unknown | `#4d5970` / `#ffffff` | `#b0bdd3` / `#121a2c` | Same, Could not compare, unknown, unavailable, not applicable, not reviewed and review verdicts; retain the exact label |

Name status tokens `--color-{success,warning,error,neutral}` and their backgrounds `--surface-{success,warning,error,neutral}`. Neutral badges also carry a 1px `--color-control-border` outline so they stay visible on content and raised surfaces alike.

Supporting interaction and alert tokens:

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--color-action-hover` / `--color-action-pressed` | `#1e3aaf` / `#1e328f` | `#1e3aaf` / `#1e328f` | Primary action hover and pressed fills (Interaction States) |
| `--color-link-hover` | `#1e3aaf` | `#b3c7ff` | Link hover text |
| `--border-warning` | `#e3c27a` | `#6b5a22` | Decorative outline of a warning alert panel |
| `--border-error` | `#e8a3a3` | `#7a3a44` | Decorative outline of an error alert panel |

Alert outlines are decorative: the alert's title and text carry its meaning, so they need no 3:1 contrast. Use `--color-error` for field error outlines, which do.

Missing evidence is not automatically an error; a completed run is not automatically verified. Keep completion neutral unless a separate, named check supports a success label.

Do not distinguish the two compared profiles with success/failure colors. Keep their names and side labels visible.

### Profile identity colors

Violet (side A) and teal (side B) say **which profile** something belongs to, never which is better. Use them for the profile chip, column headers, each profile's value in a detail view, and diff lines that exist only on one side. Apply them consistently: the first or left profile is always side A, on every screen of one comparison, and Swap sides swaps the colors with the profiles.

- Always pair the color with the profile name; the colors are close for some color-vision deficiencies, so they never carry meaning alone.
- Use side colors only on Different items. Same and Could not compare items keep secondary text so the differences stand out.
- Do not use side colors for status, buttons, links or selection, and do not use them outside a two-profile comparison.
- Do not add more profile colors. Each UI task comparison has two sides, which may select the same profile; setup comparisons require two distinct profiles.
- Show the colors as soon as the two profiles are chosen (for a new task, in the profile pickers and the pre-start review), so the run visibly leads to its report.

### Comparison, review and run labels

Success, warning and error are reserved for named operations and checks. Comparison results and review verdicts describe evidence, not quality, so they never use those colors. Direct attention with fill and weight instead of hue: Different is the only filled badge, Same recedes, Could not compare stays outlined. Show the exact engine state in details and exports.

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

Token composition bars use dedicated uncached-input, cached-input, other-output
and reasoning measurement tokens. Keep one textual legend and a common scale
across both sides and all actors. Cached input is part of input, and reasoning
is part of output: subtract these subsets before drawing disjoint bar segments.
Exact counts remain available beside the bars.

## Tokens — Typography

### IBM Plex Sans · `--font-ui`

Use the bundled **IBM Plex Sans** at weights 400, 500 and 600, with a system sans fallback. Retain its license notices; normal use must not fetch remote fonts. Use the existing/system monospace stack for code, paths and identifiers.

### Type Scale

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

## Tokens — Spacing & Shapes

**Base unit:** 4px

**Density:** comfortable controls with compact, readable data rows.

### Spacing Scale

| Name | Value | Token |
| --- | --- | --- |
| Tight | 4px | `--space-4` |
| Related items | 8px | `--space-8` |
| Small group | 12px | `--space-12` |
| Standard gap | 16px | `--space-16` |
| Panel padding | 24px | `--space-24` |
| Section gap | 32px | `--space-32` |
| Major separation | 48px | `--space-48` |

### Border Radius

| Element | Value | Token |
| --- | --- | --- |
| Buttons, inputs and controls | 8px | `--radius-control` |
| Panels | 12px | `--radius-panel` |
| Tags and filter pills | 9999px | `--radius-pill` |

### Borders & Shadows

Use 1px structural borders. Keep reading panels flat; reserve modest shadows for floating menus and dialogs. Focus rings are separate from decorative borders. See Elevation for surface relationships.

### Layout Tokens

| Role | Value | Token |
| --- | --- | --- |
| Content maximum | 1152px | `--content-max` |
| Page gutter / panel padding | 24px; 16px below 800px | `--page-gutter` / `--panel-padding` |
| Control minimum height | 40px | `--control-height` |
| Reading measure | 65–75 characters | — |

Let content determine height. Dense tables may reduce padding, but retain readable text and usable targets; do not add a density switch without a demonstrated need.

## Components

### Primary Action Button

**Role:** The next meaningful step, such as Compare sessions or Export report.

Use action fill, on-action text and action-border tokens, 8px corners, 40px minimum height and 8px 16px padding. Text is 14px/500. Preserve equal visual weight for equal choices; emphasize a next step only after a workflow is selected.

### Secondary Button & Text Link

**Role:** Browse sessions, View details, Back and supporting navigation.

Use a neutral surface, primary text and control boundary for buttons. Text links use link/focus color; underline links within prose. Keep secondary actions visible without competing with the primary action.

### Destructive Button

**Role:** A supported operation with destructive consequences.

Use a specific verb, explain consequences and use the danger colors in Interaction States. Do not borrow cobalt primary styling or make ordinary navigation look destructive.

### Form Field

**Role:** Search, filters and user input.

Use surface fill, primary text, control boundary and 8px corners. Keep a persistent label and associate help/error text with the field. Placeholder text does not replace a label. Preserve values after validation failures.

### Session Picker Row

**Role:** Select two recorded sessions for comparison.

Show task title, profile, client, project, recorded date and state, with identifiers in details. Use one grouped list with separators, visible checkboxes, selected background/foreground tokens and a 3px link/focus-colored leading edge on selected rows. Preserve keyboard operation and selection across filters and responsive layouts. Selection never starts or resumes a session; same-task declarations are never prechecked.

Below the list, a selection summary names the comparison sides: **Left** and **Right**, each with its profile name and task title, plus a **Swap sides** button. The first ticked session fills Left and the second fills Right; unticking one frees that side for the next tick. The summary is the only place sides are assigned, so the report's column order is always visible before Compare.

### Evidence Panel & Disclosure

**Role:** A finding with paired observations and inspectable detail.

Use neutral surfaces, 12px corners where a container is needed, and 24px padding. Prefer headings and dividers over nested cards. Keep profile labels and important limits visible; expand supporting detail with a clearly labeled disclosure that exposes its expanded state.

### Status Badge & Informational Notice

**Role:** Communicate a specific state or evidence limit.

Use the status pairs with text and an optional icon, following the label tables under Status colors. Distinguish running, interrupted, failed, unknown, unavailable, not applicable and not reviewed. An informational notice uses info-surface with primary/secondary text, a 3px link/focus-colored leading edge and a link-colored icon. Evidence limits such as **What we could not see** use this notice; it is never styled as success.

### Dialog & Inspector

**Role:** Focused decisions or supporting inspection.

Give the surface a clear title and accessible controls. Modal dialogs contain focus and restore it when closed. Nonmodal inspectors do not trap focus. Keep background text out of translucent overlays.

### Empty, Loading & Interrupted States

**Role:** Explain absence, progress or a failure and the supported next step.

Distinguish No sessions found from Could not read sessions. Show measured progress only when known, prevent duplicate starts and expose cancellation only where supported. Explain what was preserved after interruption and retain useful partial results.

### Interaction States

| State | Treatment in both themes |
| --- | --- |
| Primary hover / pressed | Use `#1e3aaf` / `#1e328f` fills respectively, retaining pale mint text and the theme's primary boundary. Do not change size or position. |
| Secondary hover / pressed | Use raised / selected surface respectively with primary text and the control boundary. A transient press is not persistent selection. |
| Input default / hover | Surface fill, primary text, secondary placeholder and control boundary. Hover may use raised fill; retain the label and outline. |
| Row hover / selected | Use raised surface on hover. Selected rows use the selected background plus a 3px link/focus-colored leading edge, which takes precedence over hover; retain the checkbox or explicit selected indicator. The two backgrounds are too close to tell apart on their own. |
| Checkbox hover / checked | Strengthen the outline with link/focus color on hover. Use the checked-control fill and mark tokens only when checked. |
| Keyboard focus | A solid 2px link/focus ring with a 2px surface-colored gap. Keep it visible and unclipped; do not rely on a fill change. |
| Disabled | Raised surface, secondary text, decorative divider boundary, no hover/pressed treatment or activation. Use an actual disabled state and explain the reason in adjacent readable text when needed; do not fade the entire group. |
| Busy | Retain the action's styling and width, show a named progress label such as Comparing sessions, and prevent duplicate activation. Announce progress without repeatedly moving focus. |
| Error | Error foreground outline plus a text explanation associated with the field. Keep entered values and labels. If focused, retain the separate focus ring. |

Destructive buttons use white text with light-theme fills `#b91c1c` / `#991b1b` / `#7f1d1d` for default / hover / pressed. Dark-theme fills are `#991b1b` / `#7f1d1d` / `#681717`, with an error-foreground boundary. Use a specific verb and consequence; keep routine primary actions cobalt.

Hover must not be the only way to discover an action. Keep links underlined in prose. Use native buttons, inputs and checkboxes or equivalent accessible components. Validation errors must have programmatic associations; for a failed submit, focus an error summary or the first invalid field as appropriate. Do not present an untouched required field as an error. Hide unfinished features rather than presenting inactive promises. Disable an implemented action only when its current prerequisites are unmet, with an understandable reason.

The paired-session picker selects exactly two sessions with checkboxes and has no select-all control or separate side slots. Keep deselection available at the limit; explain why another selection is unavailable. Assign Left and Right only in the selection summary, with Swap sides. Show the recorded, user-declared or unknown task-association basis. Never precheck a user declaration merely because titles match, and never invent recorded equivalence. Inspection and selection do not start or resume sessions.

## Do's and Don'ts

### Do

- Use semantic tokens consistently in both themes, with system-following appearance and a local override.
- Keep primary actions cobalt, text readable, and Soft Mint separate from success semantics.
- Use IBM Plex Sans, the 4px spacing scale, 8px controls and 12px panels.
- Preserve labels, evidence limits, keyboard access and explicit selection indicators.
- Use whitespace, grouping and dividers before adding tinted containers or elevation.
- Keep one token source and reuse the existing shadcn/ui + Tailwind component stack.

### Don't

- Do not use Soft Mint as small text on white, color alone for meaning, or success/failure colors to identify compared profiles.
- Do not add marketing heroes, permanent terminal panels, nested cards or glowing outlines everywhere.
- Do not hide limitations, shrink type to fit, or require hover to discover an action.
- Do not invent evidence, capabilities, progress percentages, overall winners or task equivalence.
- Do not introduce a second report renderer, a separate design-system package or per-screen token variants without an intentional design decision.

## Surfaces

| Level | Token | Purpose |
| --- | --- | --- |
| Base | `--color-canvas` | Page background; Obsidian in dark mode |
| Content | `--color-surface` | Forms and reading surfaces |
| Raised | `--color-surface-raised` | Grouped evidence, menus and nested panels |
| Selected | `--color-selected` | Explicitly selected rows or controls |
| Informational | `--color-info-surface` | Evidence-limit notices; not a higher elevation |

## Elevation

Separate surfaces primarily with spacing, neutral fill changes and borders. Ordinary cards and report sections remain flat. Use restrained shadow only where a floating menu or dialog needs separation; it must not substitute for readable boundaries. Keep surfaces opaque behind working content.

## Imagery

Use product evidence and diagrams only when they explain the current task. A faint technical grid and small cobalt/mint accents may appear in the header; never place them behind evidence text, status badges or inputs. Avoid decorative mascots, floating screenshots and atmospheric effects in working views. Use one consistent outline icon family from the component stack; icons support labels and icon-only controls need accessible names.

## Layout

Use a compact header with direct access to Profiles and saved reports. Add navigation structure only when the workflows justify it; do not assume a permanent sidebar. Keep ordinary reading blocks around 65–75 characters wide; paired evidence and tables can use the wider available space.

Use this navigation and report structure:

- Confirmation screens such as the pre-start review lead with a ready summary (a success badge naming what was checked, the two profiles, the run size) plus the primary action and any consequential choice, such as no verification checks, as an informational notice. Details follow below.
- Lead setup comparisons with a summary strip of Different / Same / Could not compare counts, with Different largest. The counts filter the list. Show the compared profiles as one compact line of side-colored chips with Swap and Change once both are chosen. Put any reading limit in an informational notice right below the summary.
- Filtering setup items selects the first matching result. A summary status filter names its scope beside the result count and leaves both list presets unselected. When list and detail stack, offer **View details** at the selected row and **Back to selected item** in the detail; selecting a row keeps keyboard focus there until the user follows a link.
- Give **Compare a task** and **Compare setups** equal prominence. Equal choices use equal visual weight; do not make one a filled primary action and the other a faint link.
- Within task comparison, give **Use existing sessions** and **Run a new task** equal prominence. Once a path is chosen, emphasize its next meaningful action.
- Task comparison leads with conditions/coverage, closing responses and checks, then side-by-side timeline and compact conversations using shadcn/ui AI Elements. Keep expandable session/turn lineage, independent order and a persistent nonmodal event inspector. Preserve delegation, supported timing and missing evidence; the shared goal owns the replay contract.
- Keep Export report discoverable and technical inspection available on demand. Use profile names and task titles as primary labels; identifiers remain in details.

Use a fluid layout with a 1152px content maximum, 24px page gutters, and 16px gutters below 800px. Below 800px, stack landing choices, search/filter controls and paired observations; repeat profile labels. Wrap navigation and action groups without changing their reading order or hiding essential actions. Let content pressure trigger stacking earlier when needed.

In a narrow session picker, render each session as a labeled row with its checkbox, task title, profile, client, project, recorded date and state. Keep all fields available; move metadata onto additional lines rather than shrinking text or dropping columns. Preserve selection across layout changes. The selection summary, with its Left/Right sides and Swap sides, and the next action follow the list in normal flow and never cover content. Wrap long names; keep full identifiers accessible in details. Confine necessary horizontal scrolling to code or genuinely two-dimensional data tables, not the whole page. Preserve all meaningful content at zoom; do not hide limitations to simplify a small screen.

## Motion Philosophy

Use brief 120–200ms transitions to explain state changes, without moving controls or shifting surrounding content. Respect reduced motion by removing nonessential movement. Avoid animated ambient backgrounds, pulsing decoration and loading indicators that imply measurable progress when none is known.

## Accessibility

Use WCAG 2.2 AA as the web accessibility target. Check normal text contrast of at least 4.5:1, qualifying large text at least 3:1, and essential control/graphic contrast at least 3:1. Support keyboard operation, visible unobscured focus, accessible names, status announcements and errors that do not rely on color. Check reflow at 320 CSS pixels, with appropriate exceptions for genuinely two-dimensional content. AA pointer targets are at least 24×24 CSS pixels or meet a permitted exception; the 40px control height above provides a more comfortable default for pointer use on macOS. These are selected checks, not a complete conformance checklist. Follow the [product goal's verification exclusions](docs/developer/AUDIT-GOAL.md#observable-acceptance); excluded checks are not outstanding work. See the [W3C reference](https://www.w3.org/WAI/WCAG22/quickref/).

Use named header/navigation/breadcrumb/main landmarks and labelled supporting asides. Keep one `h1` per page, `h2` sections and `h3` cards; report heading order follows its reading order. Menus support arrows, Home/End and Escape; native controls or equivalent accessible components retain their keyboard semantics.

Focus mounted page headings and export/opened-report summaries; in-page selection retains focus. Nonmodal inspectors receive focus only on explicit open and restore their trigger; delayed callbacks respect newer focus choices. Announce selection/filter/save/progress/apply/undo politely, not per event; alerts identify user-action errors.

Static opaque-token checks (2026-10-27) met the selected text/status/action
contrast thresholds and checked control/focus boundaries. They do not establish
rendered accessibility, every state or image contrast. Full calculations remain
in the private original.

Selected/hover fills (1.04:1 light) and canvas/surface (1.02:1 light) cannot carry
meaning alone; retain text, icons, outlines and leading edges. Dark action fill
is only 2.31:1 against its surface: its lighter boundary is required. Soft Mint
is not a light-theme text link. Test actual composition, focus and disabled/busy
states, including keyboard, long/empty/error/partial states and narrow reflow
in both themes. Record results/limits in release summaries.

## Quick Start

Declare each semantic token once per theme and map that same source into CSS and
Tailwind. System preference is default; explicit Light/Dark overrides it. Text-size
tokens hold size only; apply documented weight/line-height separately. Use relative
font sizes, the documented font stacks and layout breakpoint. Consume the existing
components/tokens instead of maintaining another palette or stylesheet example.
