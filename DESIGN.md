# Xenoflux — Style Reference

> A precise technical workspace: cobalt actions and soft mint accents on clear light surfaces or an Obsidian canvas.

**Theme:** light + dark, following the system preference.

**Status:** adopted design direction, 2026-10-27. This standalone guide covers Xenoflux's local web app. The [roadmap](docs/developer/ROADMAP.md#current-verification-and-limits) owns current implementation and built-app verification status; this design specification is not proof that its behavior has been verified.

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
- Do not add more profile colors. Every first-release comparison has exactly two sides, including a new task run, which takes exactly two profiles; repeated-comparison tables use the same two.
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

## Tokens — Typography

### IBM Plex Sans · `--font-ui`

Use locally bundled **IBM Plex Sans** at weights 400, 500 and 600, with a system sans fallback. Use the existing/system monospace stack for code, paths and identifiers. During implementation, obtain the font assets with their license and retain required notices; normal use must not fetch fonts from a remote service. Font files are not supplied by this document.

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

Show task title, profile, client, project, recorded date and state, with identifiers in details. Use one grouped list with separators, visible checkboxes, selected background/foreground tokens and a 3px link/focus-colored leading edge on selected rows. Preserve keyboard operation and selection across filters and responsive layouts. Selection never starts or resumes a session.

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
- Lead every comparison screen with its answer: a summary strip of Different / Same / Could not compare counts, with Different largest. The counts filter the list. Show the compared profiles as one compact line of side-colored chips with Swap and Change, not as a form, once both are chosen. Put any reading limit in an informational notice right below the summary.
- Give **Compare a task** and **Compare setups** equal prominence. Equal choices use equal visual weight; do not make one a filled primary action and the other a faint link.
- Within task comparison, give **Use existing sessions** and **Run a new task** equal prominence. Once a path is chosen, emphasize its next meaningful action.
- Task comparison target (2026-10-29): short conditions/coverage context, side-by-side timeline and compact chat conversations using shadcn/ui AI Elements, preserving expandable session/turn lineage. Show selected event detail in a persistent nonmodal side sheet while the reader continues browsing. Preserve independent event order, delegation and supported timing; keep missing evidence visible. The shared goal and UI handoff define the replay contract. The earlier findings-first order remains a legacy report layout, not the redesign target.
- Keep Export report discoverable and technical inspection available on demand. Use profile names and task titles as primary labels; identifiers remain in details.

Use a fluid layout with a 1152px content maximum, 24px page gutters, and 16px gutters below 800px. Below 800px, stack landing choices, search/filter controls and paired observations; repeat profile labels. Wrap navigation and action groups without changing their reading order or hiding essential actions. Let content pressure trigger stacking earlier when needed.

In a narrow session picker, render each session as a labeled row with its checkbox, task title, profile, client, project, recorded date and state. Keep all fields available; move metadata onto additional lines rather than shrinking text or dropping columns. Preserve selection across layout changes. The selection summary, with its Left/Right sides and Swap sides, and the next action follow the list in normal flow and never cover content. Wrap long names; keep full identifiers accessible in details. Confine necessary horizontal scrolling to code or genuinely two-dimensional data tables, not the whole page. Preserve all meaningful content at zoom; do not hide limitations to simplify a small screen.

## Motion Philosophy

Use brief 120–200ms transitions to explain state changes, without moving controls or shifting surrounding content. Respect reduced motion by removing nonessential movement. Avoid animated ambient backgrounds, pulsing decoration and loading indicators that imply measurable progress when none is known.

## Accessibility

Use WCAG 2.2 AA as the web accessibility target. Check normal text contrast of at least 4.5:1, qualifying large text at least 3:1, and essential control/graphic contrast at least 3:1. Support keyboard operation, visible unobscured focus, accessible names, status announcements and errors that do not rely on color. Check 200% text resizing and reflow at 320 CSS pixels, with appropriate exceptions for genuinely two-dimensional content. AA pointer targets are at least 24×24 CSS pixels or meet a permitted exception; the 40px control height above provides a more comfortable default for pointer use on macOS. These are selected checks, not a complete conformance checklist. See the [W3C reference](https://www.w3.org/WAI/WCAG22/quickref/).

Static opaque-color calculations for the adopted tokens:

| Pair | Contrast |
| --- | --- |
| Pale mint text on cobalt action, both themes | 7.03:1 |
| Light-theme cobalt link on white / canvas | 7.52:1 / 7.39:1 |
| Dark-theme lighter cobalt link on surface | 7.76:1 |
| Light-theme secondary text on canvas | 6.93:1 |
| Dark-theme secondary text on raised surface | 8.17:1 |
| Dark-theme action boundary against Obsidian canvas | 6.25:1 |
| Light / dark control boundary against raised surface | 4.71:1 / 4.52:1 |
| Light / dark selected foreground against selected background | 6.59:1 / 11.88:1 |
| Dark-theme checkmark on lighter cobalt checkbox | 8.67:1 |
| Light / dark checked checkbox fill against surface | 7.52:1 / 7.76:1 |
| Light / dark secondary text on informational surface | 6.29:1 / 8.25:1 |
| Light / dark informational leading edge against informational surface | 6.71:1 / 6.99:1 |
| Light / dark neutral badge outline against raised surface | 4.71:1 / 4.52:1 |
| Light / dark selected-row leading edge against selected background | 6.59:1 / 5.79:1 |
| Dark-theme primary text on Obsidian canvas | 17.79:1 |
| Light side A / side B text on surface | 7.10:1 / 5.36:1 |
| Light side A / side B text on its own tint | 6.48:1 / 5.15:1 |
| Light side B text on raised / selected surface | 4.87:1 / 4.70:1 |
| Dark side A / side B text on surface | 9.40:1 / 11.97:1 |
| Dark side A / side B text on its own tint | 8.26:1 / 9.40:1 |
| Filled Different badge, light / dark | 15.64:1 / 15.91:1 |

Ratios were recalculated from the selected themes' opaque sRGB tokens on 2026-10-27. Soft Mint is not a light-theme link color; use cobalt for readable interaction text. These calculations do not validate generated image pixels, actual rendering, hover states, gradients, overlays or a complete accessible interface.

Some pairs are deliberately close and must not carry meaning by fill alone: selected and hover backgrounds (1.04:1 light), canvas and surface (1.02:1 light), and the informational and raised surfaces. The leading edges, outlines, icons and text above carry the distinction.

The dark-theme cobalt action fill is only 2.31:1 against the dark surface; the lighter action boundary (`#668cff`) is what keeps the button's edge visible, so never omit it in dark mode.

The eight status text/background pairs and seven primary/destructive action-state text pairs also pass 4.5:1; their minimum is 6.47:1. Error outlines, focus colors and the dark action boundary pass 3:1 on the checked field/raised surfaces. Verify these again on actual rendered components, including composition, focus placement and disabled/busy behavior.

Validate representative landing, session selection, paired report, setup preview and export states in both themes. Include long names, missing evidence, failure, interruption and empty results. Check keyboard traversal, focus restoration, labels, approximately 800px width and 200% zoom, subject to roadmap deferrals. Exercise understandable choices, visible evidence limits and completion of the supported flow in the built app. The shared product goal and active roadmap own acceptance criteria. Record the environment, tasks, observations and remaining limitations. A style document or a passing contrast calculation does not establish a usable interface.

## Agent Prompt Guide

### Quick Color Reference

- **Light:** canvas `#fcfdff`, surface `#ffffff`, cobalt action `#2447c6`, pale mint action text `#dcfff1`, Soft Mint accent `#9de7cc`.
- **Dark:** Obsidian canvas `#0a0d16`, surface `#121a2c`, cobalt action `#2447c6`, lighter cobalt links and checked controls `#8cabff`, Soft Mint `#9de7cc` for header accents only.
- Keep success, warning, error and unknown roles independent of the brand accents.
- For token composition bars, use dedicated **uncached input** blue,
  **cached input** cyan, **other output** violet and **reasoning** orange
  measure tokens. These are measurement categories, not profile identities or
  outcomes. The one textual legend names each category; exact counts stay
  available beside the bars. Use the same scale across both compared profiles
  and all displayed actors. Cached input is part of input, and reasoning is
  part of output; split each into disjoint segments before drawing the bar.
- Comparison labels and review verdicts never use success, warning or error. Different is the one filled ink badge; Same and Could not compare are outlined.
- Profile identity: side A violet `#6d28d9` / `#c4b5fd`, side B teal `#0e7490` / `#67e8f9`, always with the profile name.

### Example Component Prompts

1. **Landing:** Create a Xenoflux landing in the selected theme. Use IBM Plex Sans, a compact header, 32px title, 24px spacing and two equally prominent 12px panels: Compare a task and Compare setups. Give Use existing sessions and Run a new task equal treatment. Keep Profiles and Open saved report accessible; omit metrics and marketing decoration.
2. **Session picker:** Show a searchable, labeled list of recorded sessions with profile/client/project/date/state. Select exactly two using checkboxes, selected surface tokens and a cobalt leading edge on selected rows. Below the list, name the Left and Right sessions with a Swap sides button. Keep the task-association basis explicit. At narrow widths, wrap metadata into labeled rows without losing information. Do not precheck a user declaration or start sessions through selection.
3. **Evidence panel:** Show a plain-language finding, its important limit and labeled observations for both profiles. Use readable 16px prose, neutral surfaces, 12px corners only where needed, and a labeled disclosure for details. Use the neutral Different / Same / Could not compare badges; keep unknown evidence explicit and put limits in the cobalt-tinted informational notice.

## Quick Start

### Token Setup

1. Declare each color table token once per theme, including four semantic measurement category tokens. System preference selects the default; an explicit Light or Dark choice overrides it. Keep both themes' semantic names identical.
2. Declare the typography, spacing and shape tokens above once. Text-size tokens contain only the font size; apply the listed line height and weight separately. Use 14px for code by default, with 13px for compact identifiers. Use relative font sizes with 16px as the reference base. Set `--font-ui` to `'IBM Plex Sans', system-ui, sans-serif` and `--font-mono` to the listed monospace stack.
3. Below 800px, set page gutter and panel padding to 16px and title size to 28px. Use the Layout rules for reflow rather than reducing text further.
4. Map tokens into the existing component stack. Keep the same token source for CSS and Tailwind; do not maintain duplicate palette blocks.

### CSS Usage Example

This documentation example consumes the declared tokens; it is not a complete stylesheet or an app implementation.

```css
.primary-action {
  background: var(--color-action);
  color: var(--color-on-action);
  border: 1px solid var(--color-action-border);
  border-radius: var(--radius-control);
  min-height: var(--control-height);
  padding: var(--space-8) var(--space-16);
  font: 500 var(--text-ui) / 1.5 var(--font-ui);
}

.primary-action:focus-visible {
  outline: 2px solid var(--color-link-focus);
  outline-offset: 2px;
}
```

Apply the hover, pressed, disabled and busy treatments from Components. Keep the focus gap backed by the surrounding surface, and test actual rendering before claiming accessibility. This reference is repository-only, not an npm package input.
