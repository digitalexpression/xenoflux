# Xenoflux UI — developer handoff (first release)

Screen-level reference; read the screen being changed rather than the complete
inventory. The [roadmap](ROADMAP.md#current-work-and-stop-condition) owns current
status and delivery order; the [goal](AUDIT-GOAL.md) owns behavior/acceptance.
[DESIGN.md](../../DESIGN.md) owns visual tokens and interaction defaults; the
[copy policy](PROFILE-COPY-POLICY.md) owns transfer rules. This handoff owns screen
composition, not backend contracts or release gates. Private canvas version 37
supplies layout references; board numbers below match its titles.

**Stack:** local Node server on `localhost` serving a React + TypeScript app
with shadcn/ui and Tailwind. One token source feeds both CSS variables and the
Tailwind theme (DESIGN.md › Quick Start). Do not add a second report renderer:
the report screen presents the same report model the CLI and Markdown export use.

---

## 1. Scope

The [goal's release boundary](AUDIT-GOAL.md#current-release-boundary) governs
which screens are required. The inventory is a reference, not a retention or
reacceptance mandate. U0–U4 labels below are historical, not active gates.

| Screen | Canvas board | Release | Suggested route |
| --- | --- | --- | --- |
| Landing | 0 · Landing | First | `/` |
| Profiles (+ More menu, create, client conflict) | 0 · Profiles and client controls | First | `/profiles` |
| Copy / create preview | 0 · Copy selected setup, with undo | First | `/profiles/:name/copy`, `/profiles/new` |
| Setup comparison | 1 · Setup comparison | Existing; may simplify or retire | `/compare/setups?a=&b=` |
| Skill package detail | 2 · Skill package detail | Existing; may simplify or retire | `/compare/setups/skills/:name?a=&b=` |
| Labels and states | 3 · Labels, gaps, empty and error states | Reference only | — |
| Choose two sessions | 4 · Choose two sessions | Existing; may simplify or retire | `/compare/sessions` |
| Browse sessions | 4b · Browse sessions | Existing; may simplify or retire | `/sessions` |
| Comparison report | 5 · Comparison report | First | `/reports/:id` |
| Run a new task | 7 · Run a new task | First | `/runs/new` |
| Review before starting | 8 · Review before starting | First | `/runs/new/review` |
| Progress and recovery | 9 · Progress, interruption and recovery | First | `/runs/:id` |
| Export a report | 10 · Export a report | First | `/reports/:id/export` |
| Open a saved report | 10b · Open a saved report | Existing; may simplify or retire | `/reports/open` |
| Reviews | 11 · Retained reviews | Existing display/import; ordinary AI review launch/result required | `/reports/:id/reviews` |
| Human review authoring | 11b · Add a review | Deferred; existing external import remains | — |
| Repeated comparisons | 12 · Repeated comparisons | Deferred UI construction | — |

Canvas-only scaffolding — **do not build:** the "Example:" segmented switches
(Copy preview, Review before starting), every "Variant ·" frame (these document
states, see each screen's states table), and the yellow walkthrough notes.

Routes are suggestions. Verify Recent, saved-report and event links when changing
them; make an unsupported old link explicit.

---

## 2. Global layout

| Rule | Value | Why |
| --- | --- | --- |
| Workspace pages | `max-width: var(--content-max)` (1152px), centered | Lists plus detail panels need width |
| Comparison report | Workspace width (1152px max) | Leaves room for an item label and two equally sized profile columns |
| Reading page (Review before starting) | 920px max | Keeps prose near 65–75 characters |
| Page gutter | `--page-gutter`: 24px; 16px below 800px | DESIGN.md › Layout Tokens |
| Page top padding | `--space-32` minus header; sections separated by `--space-24` to `--space-32` | |
| Panels | `--color-surface`, 1px `--color-divider`, `--radius-panel`, `--panel-padding` | Flat; no shadow |
| Page background | `--color-canvas` | |

### App header (every screen)

- Height 52px, `--color-surface`, bottom border 1px `--color-divider`.
- Left: wordmark `xenoflux` in `--font-mono` 16px/600 with a 10×10px mark
  (cobalt/mint diagonal split, `--color-action` / `--color-accent`, `aria-hidden`). Links to `/`.
- Nav (`<nav aria-label="Primary">`): **Compare**, **Profiles**, **Browse sessions**, **Open saved report**.
  - Current item: `aria-current="page"`, `--color-text`, 600, 3px inset bottom bar `--color-link-focus`.
  - Others: `--color-text-muted`.
  - Compare is current for `/`, `/compare/*`, `/runs/*`, `/reports/:id*` reached from a comparison.
  - **Export** sets no current item (it is reached from a report, not the nav).
- Right: "Local app · this Mac only", `--text-meta`, `--color-text-muted`.
- No sidebar.

### Breakpoints

DESIGN.md defines one layout breakpoint. Do not add tablet-specific layouts.

| Width | Changes |
| --- | --- |
| ≥ 800px | Default layouts below (list + side panel, tile rows, two-column evidence). |
| < 800px | Gutter and panel padding 16px; page title 28px. Side panels move below their list in DOM order. Summary tiles, profile slots and evidence columns stack; repeat profile labels on each stacked block. Nav and action groups wrap without reordering. |
| 320px / 200% zoom | Must reflow with no page-level horizontal scroll. Only code blocks and genuinely two-dimensional tables may scroll horizontally, inside their own container. |

Let content pressure trigger stacking earlier (flex-wrap with a min basis), not
only the media query.

---

## 3. Design tokens used

All values are defined once in DESIGN.md; this table is a lookup, not a second source.

| Token | Light / Dark | Usage in these screens |
| --- | --- | --- |
| `--color-canvas` | `#fcfdff` / `#0a0d16` | Page background |
| `--color-surface` | `#ffffff` / `#121a2c` | Panels, header, inputs |
| `--color-surface-raised` | `#f0f4ff` / `#19243a` | Panel heads, segmented-control track, row hover, changed-in-place diff lines |
| `--color-text` / `--color-text-muted` | `#18233b` / `#4d5970` · `#f1f5ff` / `#b0bdd3` | Body / supporting text |
| `--color-divider` | `#d2dcf0` / `#34415c` | Decorative separators only |
| `--color-control-border` | `#6b6d72` / `#7d8ba7` | Buttons, inputs, neutral badges |
| `--color-action`, `--color-on-action`, `--color-action-border` | cobalt fill, pale mint text, `#2447c6` / `#668cff` edge | One primary action per area |
| `--color-link-focus` | `#2447c6` / `#8cabff` | Links, focus ring, selected leading edge, notice leading edge |
| `--color-selected`, `--color-on-selected` | `#eaf0ff` / `#1c3155` | Selected rows, pressed filters |
| `--color-checked`, `--color-on-checked` | cobalt / lighter cobalt | Checkboxes and radios (`accent-color`) |
| `--color-info-surface` | `#edf2ff` / `#172241` | Informational / limits notices |
| `--color-side-a`, `--surface-side-a` | violet `#6d28d9` / `#c4b5fd` | First profile (left side) |
| `--color-side-b`, `--surface-side-b` | teal `#0e7490` / `#67e8f9` | Second profile (right side) |
| `--color-{success,warning,error,neutral}` + `--surface-*` | DESIGN.md › Status colors | Named checks and operations only |
| `--border-warning` / `--border-error` | DESIGN.md › Status colors | Decorative outline of warning and error alert panels |
| `--font-ui` / `--font-mono` | IBM Plex Sans (bundled locally) / system mono stack | Mono only for paths, identifiers, code, commands |
| `--text-title` | 32px/1.2/600 (28px narrow) | One `h1` per page |
| `--text-heading` | 22px/1.3/600 | Report section headings |
| `--text-body` | 16px/1.5 | Prose, panel titles at 600 |
| `--text-ui` | 14px/1.5 | Controls, tables, hints that change behavior |
| `--text-meta` | 13px/1.5 | Breadcrumbs, timestamps, decorative meta only |
| `--space-4 … --space-48` | 4px scale | All gaps and padding |
| `--radius-control` / `--radius-panel` / `--radius-pill` | 8 / 12 / 9999px | Controls / panels / badges, chips |
| `--control-height` | 40px | Every button, input, select, clickable row minimum |
| `--content-max` | 1152px | Workspace width |

Summary-tile numbers use `--text-count` (40px, Different) and
`--text-count-secondary` (28px), with `font-variant-numeric: tabular-nums`.

---

## 4. Shared components

Build these once (shadcn primitives underneath) and use them everywhere. Names
are suggestions.

| Component | Variants | Props | Notes |
| --- | --- | --- | --- |
| `AppHeader` | — | `current: 'compare' \| 'profiles' \| 'sessions' \| 'open' \| null` | See §2. |
| `PageTitle` | — | `breadcrumb[]`, `title`, `subtitle?` | Breadcrumb `--text-meta`, links muted. |
| `Button` | `primary`, `secondary`, `destructive`, `ghost-link` | `busyLabel?`, `disabledReason?` | DESIGN.md › Interaction States. `disabledReason` renders as adjacent text, not a tooltip. Busy keeps width and shows the named label. |
| `ComparisonBadge` | `different`, `same`, `cannot-compare` | `exactState`, `reason?` | Different: filled `--color-text` with `--color-surface` text, 600, `≠`. Same: outline `--color-divider`, muted, 400, `=`. Could not compare: dashed `--color-control-border`, 500, `?`; `reason` renders beside it. Never success/warning/error colors. |
| `NotApplicableLabel` | — | — | Muted text, no badge. |
| `StatusBadge` | `success`, `warning`, `error`, `neutral` | `label`, `icon` | Only for named checks/operations (DESIGN.md › Comparison, review and run labels). Always includes text; icons `✓ ! ✕` are `aria-hidden`. |
| `VerdictBadge` | — | `verdict: positive \| negative \| mixed \| inconclusive` | Neutral outline badge: "Verdict: Mixed". Never colored. |
| `ProfileChip` | `side: 'a' \| 'b'` | `name`, `meta?` | Pill, `--surface-side-*` fill, 1px `--color-side-*` border, 10px dot, name in side color 600, meta muted. Always shows the name. |
| `SideText` | `a`, `b` | children | Inline profile name or value in side color, 600. Use only on Different items, column headers and each side's values. |
| `SummaryTiles` | — | `counts: {different, same, cannotCompare}`, `active?`, `onFilter?` | Different tile `flex: 2 1 300px`, others `1 1 200px`. Each tile is a toggle button (`aria-pressed`) that filters the list; on the Report they are anchor links. Pressed: `--color-selected` + 1px `--color-link-focus` border + inset ring. |
| `InfoNotice` | `section`, `inline` | `title?`, `action?` | `--color-info-surface`, 3px inset leading edge `--color-link-focus`, info icon in link color. Used for evidence limits, "No verification checks selected", saved-report banner, reviewer disagreement. |
| `WarningAlert` | — | `title`, `body`, `actions?` | `--surface-warning`, warning text, `role="alert"` only when it appears in response to an action. |
| `SelectableRow` | `checkbox`, `button` | `selected`, `disabled`, `disabledReason?` | Hover: raised. Selected: `--color-selected` + 3px inset leading edge `--color-link-focus` (`box-shadow: inset 3px 0 0`). Min height 40px. |
| `SegmentedControl` | — | `options`, `value` | Raised track, selected segment on surface with 600 and a subtle shadow. Buttons with `aria-pressed`. |
| `DiffBlock` | — | `lines: {kind: ' ' \| '-' \| '+' \| '~', text}` | `-`: `--surface-side-a` + 3px side-a edge; `+`: `--surface-side-b` + side-b edge; `~`: raised. Gutter sign in side color, plus visually hidden "Removed:/Added:/Changed:". Legend below: "− only in baseline · + only in strict-review" with SideText. Mono 13px. |
| `EvidenceStep` | `cited`, `plain`, `alone` | `text`, `tag?`, `ref?`, `side` | Cited: side tint + 1px side border + 3px side edge; tag in side color. Alone (no counterpart): dashed control border. |
| `Disclosure` | — | `label`, `expandedLabel` | Native `button` with `aria-expanded`; label text changes ("Show sources" / "Hide sources"). |

---

## 5. Screens

Each screen lists layout, states and interactions, and screen-specific edge
cases. Global accessibility and edge-case rules are in §6–§8.

### 5.1 Landing (`/`)

**Purpose:** choose what to compare. Two equal entries; nothing is preselected.

**Layout:** `h1` "What do you want to compare?"; two equal panels in a
`repeat(auto-fit, minmax(320px, 1fr))` grid; Recent list below.

| Element | Spec |
| --- | --- |
| Compare a task panel | Two equal tiles: **Use existing sessions** → `/compare/sessions`; **Run a new task** → `/runs/new`. Tile: raised fill, 1px `--color-action-border`, title in `--color-on-selected` 600, description 14px muted, status line 13px/500 pinned to bottom. |
| Compare setups panel | Copy + status line + **secondary** button "Choose two profiles" → `/compare/setups`. |
| Equal weight | Neither panel nor tile is a filled primary button (DESIGN.md › Layout). |
| Status lines | Live counts: "14 sessions in 3 profiles · 1 profile couldn't be read", "3 profiles ready to run", "4 profiles · read-only, nothing is copied, activated or signed in". |
| Run banner | Only when a run is active: full-width info strip under the header, "1 task run in progress", task + profile, link "View progress". `role="status"`. |
| Recent | Up to 5 rows: type tag (Task / Setup / Saved, neutral pill), title, meta. Header link "Open a saved report…" → `/reports/open`. |

| State | Behavior |
| --- | --- |
| No profiles | Replace both panels with "Add an existing Codex folder" / "Create profile" (Profiles actions). |
| One profile | Compare setups and Run a new task explain "Needs two profiles" with a link to Profiles; Use existing sessions stays available (same-profile session comparisons are allowed). |
| No recent items | Hide the Recent list; keep the "Open a saved report…" link. |
| Status line still reading | "Reading sessions…" in muted text; never a fake count. |

The Run a new task tile reads "Run one task in two profiles. Nothing starts until you review it."

### 5.2 Profiles (`/profiles`)

**Layout:** title + subtitle; header actions **Add an existing Codex folder…**
(secondary) and **Create profile…** (secondary); one card per profile in a
wrapping grid.

**Profile card:** name (`h2`, mono 16px/600), sign-in/binding meta, one-line
summary, a `dl` of client state (Codex CLI / Codex Desktop), then two action
rows: comparison actions (**Compare with…**, **More ▾**) and client actions.

| Client state | Client actions shown |
| --- | --- |
| Neither running | "Open in Terminal (Codex CLI)…", "Open Codex Desktop" |
| CLI running in Terminal | "Show Terminal", "Open Codex Desktop…" (opens the conflict explanation below) |
| Desktop open | "Show Codex Desktop"; CLI row reads "not available while its Desktop is open" |
| Sign-in unknown | "Open in Terminal to sign in…"; plus "Bind to a project…" when unbound |

**Client conflict (dialog):** title "baseline is open in Codex CLI"; body: a
profile can't run in CLI and Desktop at once; other profiles aren't affected.
Actions: Show Terminal, Check again, Cancel. Never close Terminal sessions for the user.

**More ▾ menu** (`role="menu"`, arrow-key navigation, Escape closes and returns
focus): Copy settings from another profile… → copy preview; Change project
binding…; Rename…; Remove from Xenoflux… (secondary line "Keeps the profile's
files on disk…"; disabled with that reason while Desktop is open or a change is unfinished).
The Default profile has no More menu: it is a copy source only.

**Create profile (dialog):** Name field; radio "Start from": Empty / Selected
parts of [profile]; primary "Choose parts and preview" → create preview. Footer
note on what is never copied.

| Edge case | Behavior |
| --- | --- |
| Long profile names | Wrap (`overflow-wrap: anywhere`); never truncate in a card title. |
| Client state unknown | Show "unknown" in the `dl`, hide client actions except Check again. |
| Name taken (create) | Inline field error, keep value. |

### 5.3 Copy / create preview

**Modes:** *copy into an existing profile* ("Copy from strict-review into
baseline") or *create* ("Create careful-tests from parts of baseline").

**Layout:** breadcrumb; title; intro; origin banner when opened from a setup
comparison item ("Started from AGENTS.md in the setup comparison…", info
surface); checklist panel; two small panels ("Set up in Codex instead", "Never
copied"); primary + Cancel; client note.

| Element | Spec |
| --- | --- |
| Checklist row | `SelectableRow` with checkbox: name (mono 500), kind (muted), exact change line, note. Preselect only the item the user came from (copy) or nothing (create). |
| Primary button | Label counts the selection: "Apply 1 change to baseline" / "Create careful-tests with 3 items". With nothing selected: disabled with adjacent reason "Choose at least one item". |
| Applied state | `role="status"` panel: title, list of applied changes, note, **Undo this copy** (copy only), Back to Profiles, undo explanation. |
| Undone state | "Undone" panel, "Start over". |

| State | Behavior |
| --- | --- |
| Destination open in a client | Replace the primary with an explanation ("baseline is open in Codex CLI. Changes can only be applied while it's closed…") and **Check again**. Ask before closing any Codex app; never close Terminal sessions. Re-check immediately before apply. |
| Undo refused | `WarningAlert` "Can't undo safely": names the file edited after the copy; nothing changed. |
| Apply fails midway | Follow the copy policy's rollback/recovery; show what was and wasn't applied. |

### 5.4 Setup comparison (`/compare/setups`)

**Purpose:** answer "how do these two setups differ, and what couldn't be read?"

**Layout, top to bottom:**

1. Title block: breadcrumb, `h1` "Compare setups", meta line "Today's setup, read [date] · read-only…".
2. **Profiles line:** `ProfileChip` a, round swap button (`aria-label="Swap the two profiles"`), `ProfileChip` b, "in [project]" (mono), **Change profiles…** (secondary, right-aligned). Swap re-renders with sides and colors exchanged.
3. **SummaryTiles:** Different / Same / Could not compare counts; captions "Where the two setups differ. Start here." / "Identical within what was read" / "Not readable or not comparable; each says why". Tiles filter the list.
4. **InfoNotice** for reading limits: "Codex built-ins couldn't be read in either profile, and plugins were only partly read. Nothing is claimed about what wasn't read." + Disclosure "Show sources" (coverage table; column headers in side colors).
5. Toolbar: search ("Find an item", label visible) + `SegmentedControl` Needs attention / Everything.
6. List (flex `999 1 540px`) + detail panel (flex `1 1 380px`).

**List:** groups by category (Settings, Instructions, Skills, MCP and plugins,
Memory settings), each a panel with a raised head (name + "2 different · 1 same").
Rows are `button`s with `aria-current="true"` on the selected row:

| Row part | Different | Same | Could not compare |
| --- | --- | --- | --- |
| Badge (160px column) | filled | outline | dashed |
| Name (mono 14px) | 600, text | 400, muted | 500, text |
| Scope (14px muted) | ✓ | ✓ | ✓ |
| Summary (right) | values in `SideText` ("medium → high", "−1 +2 lines", "only in strict-review") | muted | muted |

Same items are hidden in "Needs attention" and behind a per-group "Show N that
are the same" button.

**Detail panel:** 3px top border `--color-link-focus` (it is "the item you're
looking at"); badge + exact state ("Changed", "Only in strict-review", "Seen,
but not comparable"…); name; category · scope; then either side-by-side value
boxes (side tint + 3px side edge, label in side color) or a `DiffBlock`; a
plain-language note; Disclosure "Where it's set and what we know" (source table
and facts table: "Value a session used · Not known"); actions: Open package
files (skills), Copy from strict-review into baseline… (copyable items), How to
set this up in Codex (MCP/plugins).

| State | Behavior |
| --- | --- |
| Loading | Skeleton rows in the list; summary tiles show "–" with "Reading setup…"; no counts until reading finishes. |
| No differences | Different tile shows 0; list defaults to "Everything"; message "No differences within what was read" above the list. Keep the limits notice. |
| Nothing matches filter | "Nothing matches this view" + Clear filters. |
| Access denied / not bound / contradictory sources / one part failed | See Labels board (3) and §7. |
| Same profile chosen twice | Block with "Choose two different profiles". |

### 5.5 Skill package detail

Title (mono skill name) + filled Different badge; ProfileChip a vs b; read
coverage line; tools-not-checked line. Left: file list (`nav`, current file
`aria-current` + selected style + leading edge; each line "Different · …" with
SideText). Right: per-file articles — `DiffBlock` for text, a one-line statement
for permission-only changes, side-tinted code block for side-only files with
"Show N more lines". Bottom panel "Make one side match?" with both directions
described and primary "Copy strict-review's version into baseline…" (opens the
copy preview; this page changes nothing).

### 5.6 Choose two sessions (`/compare/sessions`)

**Purpose:** pick exactly two recorded sessions. Selection never starts or resumes anything.

**Layout:** title; partial-listing `InfoNotice` when any profile's history
couldn't be read ("Partly listed … How to allow access"); filters (search,
profile select, client `SegmentedControl` All/CLI/Desktop); list panel; "Your
comparison" panel **below** the list (normal flow, never sticky over content).

| Element | Spec |
| --- | --- |
| List head | Count ("6 of 6 sessions") + live status: "0 of 2 chosen" / "1 of 2 chosen" / "**baseline** ⇄ **strict-review** chosen · untick one to change" (names in side colors). `role="status"`. |
| Row | `<label>` wrapping a real checkbox; title (500); meta line: profile (SideText when selected), client, project, recorded date, turns; history pill ("History complete" outline / "Partly recorded" dashed); side tag "Left"/"Right" in side colors when selected. |
| Limit | Two selected → other checkboxes `disabled`, cursor not-allowed; deselection always available; the reason is in the list head. No select-all. |
| Side assignment | First tick → Left (side A), second → Right (side B). Unticking frees that side; the next tick fills it. |
| Your comparison | Two slots (side tint + border + leading edge when filled, dashed when empty) showing side, profile, task, client · project · date; **Swap sides** (disabled until both chosen); hint "The first session you tick goes on the left. The report keeps this order." |
| Same task? | Shown when both chosen. One of three association boxes: recorded same opening task (raised), same opening task but later prompts differ (InfoNotice), not shown by records (dashed). Checkbox "I say these are the same task" — **never prechecked**, even when titles match; reveals Task name field and "Saved as your statement, not as proof the inputs matched." |
| Optional vary list | Disclosure "Optional: mark what you meant to vary" → checkbox chips suggested from recorded differences. |
| Primary | "Compare sessions" → report. Hint "Reads recorded history only. Nothing is started or resumed." |

| State | Behavior |
| --- | --- |
| No sessions at all | Panel "No sessions found yet" + "Run a new task" (secondary). |
| No filter matches | "No sessions match" + Clear filters. Selection persists across filters. |
| Selected session filtered out | Keep it selected and shown in Your comparison. |

### 5.7 Browse sessions (`/sessions`)

Plain list for finding and resuming work, separate from comparison. Filters:
search, profile. Row: title, meta (profile, client, date, turns, history state),
actions **Compare with…** (→ picker with this session pre-ticked as Left) and
**Resume in Codex…** / **Show in Codex Desktop** / **Open its report** (runs
started here). Footer: "Resume reopens a session in its own profile and client.
Browsing and comparing never resume or start anything." Resume obeys the same
CLI/Desktop conflict rules as Profiles.

### 5.8 Comparison report (`/reports/:id`)

**Implemented in the local source build — updated 2026-11-01:** one side-by-side session
replay for existing sessions and xfx-started tasks. This replaces the prior
findings-first primary view. The legacy findings and paired evidence page were
removed on 2026-10-31; exact event links open the replay inspector.
The roadmap records retained checks, their limits and applicable revalidation;
old replay checkpoints do not determine the current release gates.

**Chat refinement — 2026-10-29:** the user requested shadcn/ui AI Elements and a
compact conversation layout. Message/Bubble render recorded conversation text;
Trace renders compact activity rows; MessageScroller keeps each profile's scroll
position independent. Session and turn disclosures retain lineage. Selecting an
event opens a nonmodal right-hand Sheet that stays in view and updates while the
reader selects other events. Source metadata is disclosed inside it. Escape or
Close restores the selected event; F6 moves focus between the conversation and
inspector without trapping focus. Desktop layout reserves space for the Sheet.

Use equal profile columns with persistent names and side identity. Preserve each
session's order without forcing one-to-one event rows. Below 800px, stack the
sessions with clear repeated labels and preserve selected-event context; avoid
page-level horizontal scroll. Both trees and the inspector must be usable by
keyboard, with visible focus, expand/collapse controls and 200% zoom.

| Part | Current behavior and requirements |
| --- | --- |
| Header/context | Task, profile/client/model, recorded conditions, association basis and task state; distinguish current setup from recorded setup. Keep Export visible and add Review for the required launch flow. |
| Coverage | Concise missing/omitted/unavailable evidence summary, with limits also beside affected events or branches. No activity differs from unavailable activity. |
| Timeline overview | Root and child lanes on a common elapsed-time scale where timestamps support it. Show parallel work and distinguish native recorded span from runner duration. Missing time stays unknown; never sum concurrent child durations into total elapsed time. |
| Session trees | Session → turns → messages/actions. Delegation connects the spawn to the child's own turns, actions and results, with return/message/wait links only where recorded. Missing descendants stay visible as unavailable branches. |
| Event detail | Recorded messages, tool inputs, commands/results, errors, patches and file references with provenance. Load large bodies on demand; disclose truncation or omissions. Collapsed groups retain event counts. |
| Navigation | Search/filter and step between events; retain independent ordering. An overview should be understandable without animation; playback controls are optional, not the first slice's requirement. |
| Checks/outcomes | Test commands and results remain events; xfx runner and later supplemental checks have separate ownership/scope. Keep claims, completion and observed results distinct, without mandatory verification cards or a universal rubric. |
| Reviews | Preserve retained review attribution/references. Add ordinary AI review launch and captured response per section 5.15; it is required for this release. Interpretations remain distinct from source facts. |
| Export/reopen | Readable static Markdown plus structured retained replay evidence, preserving included bodies, event IDs, parent/call/result relationships and gaps without native source access. Preserve the selected inclusion/privacy/size boundary; make schema changes and unsupported formats explicit. Do not relabel a legacy partial report as a full replay. |

Show recorded assistant messages, explanations and provider-exposed reasoning
summaries when present. Do not promise or reconstruct private internal
chain-of-thought. Recorded workflow is the product's evidence boundary.

### 5.9 Event evidence and retained reports

The primary replay should open an event inspector directly, independent of a
predefined finding. Show source/actor/turn identity, native line or equivalent
reference, timestamp basis and call/result links when supported. Distinguish
unmatched records, unsupported event types, missing bodies and unreadable sources;
do not quietly discard them because they do not fit a named action category.
Treat native content as untrusted display data, never executable instructions.

Retained reviews, original failures and frozen source evidence remain intact.
The product page and readable comparison export no longer present generic
behavioral findings or paired-action judgments. Say when replay detail was never
captured. A richer view reconstructed from original sources is a new derivation,
not a rewrite of a frozen report.

Closing responses are visible side by side near the top, with full inline text
and exact event links. Assessment shows one three-column table: check, left
profile result and right profile result. Definition equivalence requires a
recorded recipe fingerprint; same-name unknown or different recipes stay labeled.
Inspect opens the existing nonmodal side-panel pattern, with profile switching,
previous/next check navigation, output search, Escape and focus return. Show
command, pass condition, timeout, exit code, start, duration and task-end baseline
only where retained. Runner checks link to their own retained execution record,
not invented replay events. Completion, check outcomes and reviews stay separate.
No selected checks produces one neutral note, with execution failures still visible.
Check definitions and canonical results bind retained evidence. Command/output
content follows the existing recorded-content export opt-in, with redaction,
64 KiB per stream and explicit omitted/unavailable/truncated states. Frozen
reopening must work without the source output files and must never rerun checks.
Time and tokens uses two compact columns ordered Workflow, Main
session, then agents with parent identity. One legend and common scale cover
uncached input, cached input, other output and reasoning; the subsets are
subtracted from their parent categories so bar segments never double count.
Row disclosures show exact counters, accounting scope and separate runner time.
Concurrent spans are never added. Verified captured-session sums remain partial
when descendant discovery is incomplete or replay is absent; do not label them
validated whole-workflow totals. Missing usage is not zero.

The retained Codex 0.164.0 accounting proof records the examined official revision
`6aaac694803004a63c6f393d153c96d22521a6b9`:
[cumulative usage records](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/protocol/src/protocol.rs#L2370-L2450),
[per-session accumulation](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/state/session.rs#L228-L260),
and [forked-child counter isolation](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/agent/control_tests.rs#L2658-L2810).
This establishes independent native thread counters, not exhaustive descendant
discovery or billed cost. These are provenance records, not a provider version pin.
Accounting now validates the supported record protocol and observed actor
baselines rather than requiring an exact provider version. An actor's first
cumulative/response counters must establish the zero baseline; otherwise its
first-turn fields remain unknown. Later verified terminal differences can still
be shown. New finalized captures retain bounded index discovery evidence before
runtime cleanup; actor coverage is complete only when indexed, captured and
verified replay actor sets agree. Keep unverified derived totals unknown while
preserving inspectable counters and other supported evidence.
A retained walkthrough validates captured-session totals, while missing run-time
discovery indexes leave its whole-workflow totals unvalidated.
Reconciliation produces a new derived report without changing the source report,
raw observations or replay events.
File counts and rows use the same retained post-setup/task-end inventory, grouped
into tracked changes and ignored artifacts. Without that inventory, show only
observed edit paths and do not claim a complete count.

### 5.10 Run a new task (`/runs/new`)

**Layout:** form (flex `999 1 600px`) + "This run" summary panel (flex `1 1 320px`).

| Section | Spec |
| --- | --- |
| Task | Textarea "What should both profiles do?" (label visible, resizable vertically); hint 14px "Sent unchanged to both profiles. Kept private; reports don't include the text."; optional "Files it may change" (mono) + hint "Used to point out edits to other files. It doesn't block them." |
| Profiles · exactly two | Two side slots: "First · left side of the report" (side A) and "Second · right side of the report" (side B), each a select (mono) with a readiness note (warning text when sign-in is unknown); round swap button between. Hint: "They run one after the other, first then second. The colours follow each profile into the report." Same profile twice → `WarningAlert` "Choose two different profiles." |
| Project | Repository select + "Commit or branch" (mono); hint about separate copies excluding uncommitted/untracked/ignored files. |
| Verification · optional | Default "No verification checks selected" + consequence + dashed "Add a check command". Added: Name + "Command you already use" (mono) + Remove; warning-colored 14px note about running outside the Codex sandbox. Never invent commands. |
| Advanced settings | Collapsed `Disclosure` whose button shows the current values in one line ("15 min per run · Codex can edit only its copy, no network · 8 MiB output · no setup commands"). Expanded: time per run, Codex access, output cap, Codex program, reasoning effort override, add setup command; note "Overrides apply to this run only". |
| This run panel | `dl`: Profiles (SideText "baseline then strict-review"), Model runs (2), Longest it can take, Verification; note on real model tasks and sign-ins; primary **Review before starting**; hint "Checks profiles, project and commit. Starts nothing." |

The task comparison runs exactly two profiles. The planner's wider range stays a
CLI capability; don't expose it here.

### 5.11 Review before starting (`/runs/new/review`)

**Purpose:** confirm and start. Summary first (DESIGN.md › Layout).

| Section | Spec |
| --- | --- |
| Ready strip (top) | Panel with 3px cobalt top border: `StatusBadge` success "✓ Ready to start" + "Profiles, project and commit checked · nothing has started"; ProfileChip a "then" ProfileChip b + "2 model runs, one after the other · up to 32 min"; **No verification checks selected** as `InfoNotice` with "Add a check" (secondary) — or "1 check after each task: …" when one exists; primary **Start 2 model runs** + Back to edit. |
| Details (`h2`) | Task (quote + Edit link + files it may change); Runs, in order (side edge + side-colored "1 · baseline" + "left side of the report ·" + client/settings/readiness; coexistence note when Desktop is open in that profile); Where each run starts; Verification; Limits; "Starting will" / "It never" panels. |
| Footer | Start (primary, repeated), Back to edit, Copy CLI command. |

| State | Behavior |
| --- | --- |
| A profile can't run | Ready strip becomes a `WarningAlert` "docs-only can't run yet" with reason; Start is disabled with that reason adjacent; actions Open Profiles (primary) and Choose another profile. Never sign in or swap profiles automatically. |
| Re-check fails at Start | Stay on the page, show the failing check; nothing starts. |
| Start clicked | Busy label "Starting…", prevent double start, then navigate to progress. |

No extra confirmation dialog when no checks are selected.

### 5.12 Progress and recovery (`/runs/:id`)

Title "Running: [task]"; meta (order, commit, run ID mono). Live panel:
"Profile 2 of 2 is working", elapsed and latest stop time, a time bar
(`role="progressbar"` labelled "Time used of the overall limit" — it measures
time against the limit, not task completion). Two columns of steps per
profile (prepared copy, task with turn and time, checks, evidence saved) with a
state pill per profile. "So far: N recorded events, N tool uses. Messages and
command output aren't shown here." **Cancel the run…** (destructive outline)
with the consequence beside it; note that refreshing or closing the tab stops nothing.

| End state | Badge | Primary |
| --- | --- | --- |
| Finished | neutral "Finished" (finishing is not verification) | Open the report |
| A check failed | error | Open the report |
| Cancelled | neutral | Open the partial report |
| Time limit reached | warning | Open the partial report |
| Interrupted (Xenoflux stopped) | warning | Preview of what tidying up would do (confirmed facts listed), then **Tidy up and keep the record** / Not now |
| Can't tidy up yet | warning | Check again / Show what's still running. Never stop programs for the user. |

Progress text updates go to a polite live region at most once per step change,
not per event.

### 5.13 Export a report (`/reports/:id/export`)

Breadcrumb from the report; `h1` "Export this report"; explanation (two files,
one folder). Left: Included / Never included / "Off unless you choose it"
(checkbox "Include setup file text" → warning panel listing the files added);
privacy note. Right: "Save to" path (mono), the two file names
(`[name].md`, `[name].md.audit.json`), "Keep both files together", primary
**Export**. After export: success panel "✓ Saved", "Both files are in the folder
above. Setup file text: [included for N files | not included]", Copy folder location.

| State | Behavior |
| --- | --- |
| Exporting | Busy "Saving…"; prevent duplicate. |
| Write fails | Error panel naming the failure; no partial pair left behind, or say which file was written. |
| Folder exists | Never overwrite silently; add a suffix or ask. |

### 5.14 Open a saved report (`/reports/open`)

`h1` "Open saved report"; subtitle (exact as saved, nothing re-read). File input
"Choose the report's JSON file" (hint about `.audit.json`) and "Recently saved"
list. After choosing: info banner with Saved report pill, title,
recorded/saved dates; a kept/not-kept list (conditions, reviews with earlier
revisions, evidence references, "Side-by-side code · Not in this report");
**View report** (primary) + Copy CLI command.

| State | Behavior |
| --- | --- |
| Markdown chosen, JSON missing | `WarningAlert` "Found x.md, but not x.md.audit.json": the Markdown is still readable; Xenoflux won't rebuild from current sessions. Actions: Locate the JSON file, Cancel. |
| Unreadable or unsupported JSON | Error with the reason; nothing opens. |

### 5.15 Reviews (`/reports/:id/reviews`)

**Target interaction** ([implementation status](ROADMAP.md#current-work-and-stop-condition)): from Report or Reviews,
choose **Review**, select a profile and its normal workspace, inspect/edit the
prompt and choose retained report content, then **Start review**. Show exact report
identity/files, cwd and the selected profile's normal settings/provider. Declared
settings are not effective-setting proof; unknowns stay explicit. Show an uncapped
model duration by default, optional time cap and the process-output bound.
Preparation and cancelling before Start invoke no model. Reuse one form and
normal single-task execution; no isolation wizard or forced JSON submission.

Show prepared/starting/running/waiting-for-user/completed/failed/cancelled,
interrupted or uncertain states according to the
[task lifecycle](REVIEW-TASK-IMPLEMENTATION.md#durable-record-api-and-lifecycle). There is no task queue.
When Codex asks for approval or input under that profile's settings, show the
native action/question and response choices inline. Submit only the user's
explicit decision to that live request. Stale requests are unavailable, not
replayed; unsupported native requests produce a visible failure. This is ordinary
task interaction, not an additional permission wizard. Prevent duplicate starts on click/reload;
never silently retry. Keep the comparison association, selected profile, actual
session/model where known, and captured natural-language response readable here.
A launch without a response is not a completed review. A task-scoped preference,
tie or inconclusive explanation is valid; do not convert prose into scores.
Keep the user able to return to the task-owned `/reports/r.<id>` frozen
comparison and cited evidence, including after server restart or source loss.
Group ordinary task results separately from structured imported review cards;
plain-text output does not populate `VerdictBadge` or rating fields. Browser
refresh follows the saved task ID; server restart shows the retained state and
never resumes automatically. Existing report exports must not claim they include
a separate task response when they do not.

**Existing external import and retained review behavior:**

Display retained reviews and allow imported external submissions. Per review topic panel ("How good the results
are", "2 reviews · 1 earlier version"); `InfoNotice` when reviewers disagree;
review cards side by side: reviewer type pill (Person / AI agent) + name/model,
`VerdictBadge`, "prefers [profile or neither]" in **plain text** (no side color:
it is the reviewer's view, not Xenoflux's), quote, "Based on:" links to evidence,
written/imported date, Disclosure "Show earlier version" (superseded revision
kept "for the record"). Unreviewed topics show a neutral "Not reviewed" badge.
"Whether differences repeat: can't be reviewed with one pair." Checks run
afterwards: `StatusBadge` per check with who ran it and on which version. Offer
**Prepare packet for external review** to open Export with an explicit recorded-
content choice; generate the evaluation envelope over the exported projection,
write Markdown/JSON, and return to that exact packet. Preparation makes no
evaluation record or reviewer call. On a packet or an already evaluated source,
offer **Attach a review** with a JSON file picker for an externally prepared
typed submission. Preview its fingerprint, scope, reviewer, model, conclusion
and evidence links before an explicit **Save review** action.
The API validates the frozen source and evidence references without writing on
preview, then stores a new immutable evaluation on save. Revisions start from the
latest saved evaluation and use `supersedes`; they do not modify the source or
earlier review. Citation links to replay events open the report with that event
selected and the inspector focused. The U0 demo labels import unavailable. Return
users to the registered projected packet after export so later submissions bind
to its fingerprint.

---

## 6. Data mapping

| Engine (`compareAuditProfiles` detail state) | Default label | Exact text in details/exports |
| --- | --- | --- |
| changed | Different | Changed |
| added | Different | Only in [profile B] |
| removed | Different | Only in [profile A] |
| identical | Same | Same within what was read |
| partial | Could not compare | Partly compared |
| unknown | Could not compare | Seen, but not comparable |
| unavailable | Could not compare | Couldn't be read |
| redacted | Could not compare | Hidden (secret values are never shown) |
| not applicable | Not applicable | Not applicable |

| Task association | Picker / report wording |
| --- | --- |
| recorded input | "Same opening task recorded" |
| recorded, later prompts differ | "Same opening task; later prompts differ" (limits later-turn findings) |
| user-declared | "You said these are the same task" (stored as a statement) |
| unknown | "Same task not shown by the records" |

Reviews: reviewer kind `human | ai`; verdict `positive | negative | mixed |
inconclusive`; evidence references required unless inconclusive; superseded
revisions retained; disagreements preserved, never averaged.

Side assignment: side A = first/left profile everywhere in one comparison
(picker first tick, task-run first profile). Swap exchanges profiles and colors
together. Persist the side order in the report so a saved report renders the same.

---

## 7. Global edge cases

- **Long text:** wrap everywhere (`overflow-wrap: anywhere` for names, paths,
  identifiers). Never truncate profile names, task titles or limits. Full
  identifiers stay available in details.
- **Missing data:** show "Not recorded", "Not known" or "Couldn't be read" with
  the reason; never zero, never blank, never hidden. Missing evidence is not an error.
- **Slow reads:** local reads can still be slow on large histories. Show named
  progress ("Reading sessions…") with skeletons; no percentages unless measured.
  Keep already-read results visible while the rest loads.
- **Partial failures:** one unreadable profile or source never blocks the rest;
  surface it in an `InfoNotice` with the reason and a next step.
- **Placeholders in the canvas** to replace with live data: `[PROJECT FOLDER]`,
  `[COMMIT]`, `[RUN ID]`, `[MODEL]`, `[REVIEWER NAME]`, `[CHECKER NAME]`,
  `[DATE]`, `[REPORTS FOLDER]`, `[L TIME]`/`[R TIME]`, `[L TOKENS]`/`[R TOKENS]`, `[VALUE]`.
- **Localization:** English only for the first release; still avoid fixed-width
  text containers so longer strings wrap.

---

## 8. Motion

DESIGN.md › Motion Philosophy: 120–200ms, no layout shift, removed under
`prefers-reduced-motion: reduce`.

| Element | Trigger | Animation | Duration | Easing |
| --- | --- | --- | --- | --- |
| Disclosure content | expand/collapse | opacity 0→1 (height snaps; no animated height) | 150ms | ease-out |
| Row / tile selection | select | background and edge color | 120ms | ease-out |
| Notices and status panels | appear | opacity | 150ms | ease-out |
| Menus and dialogs | open/close | opacity + 4px translate | 160ms | ease-out |
| Run progress bar | time tick | width | 200ms | linear |

No ambient or pulsing animation. Busy states use a static label, not a spinner
that implies measurable progress.

---

## 9. Accessibility

Target WCAG 2.2 AA (DESIGN.md › Accessibility).

- **Landmarks:** `header`, `nav aria-label="Primary"`, breadcrumb `nav aria-label="Breadcrumb"`, `main`, side panels as `aside` with labels.
- **Headings:** one `h1` per page; sections `h2`; cards `h3`. Report section order is the heading order.
- **Focus order:** header → breadcrumb → page title actions → summary tiles → notices → filters → list → detail panel → footer actions. Side panels that render below on narrow screens are already after the list in DOM order.
- **Focus ring:** 2px `--color-link-focus`, 2px offset, never clipped; move focus to the detail panel heading only on explicit "open details" actions, not on row selection.
- **Keyboard:** all actions are native buttons, links, checkboxes, radios and selects. Menus: arrow keys, Home/End, Escape. Dialogs trap focus and restore it on close; inspectors don't trap. Segmented controls are button groups with `aria-pressed`.
- **Live regions (`role="status"`, polite):** picker "N of 2 chosen" line, filter result counts, Saved, run progress step changes, applied/undone panels. `role="alert"` only for errors raised by a user action (e.g. Choose two different profiles).
- **Names:** icon buttons have `aria-label` (swap, clear); "Show steps" links name their finding; client buttons name the profile ("Open Codex Desktop for baseline").
- **Color is never alone:** comparison badges carry `≠ = ?` and text; side colors always sit with the profile name; diff lines carry `+`/`−` and hidden "Added:/Removed:" text; status badges carry text.
- **Disabled controls:** use the real `disabled` attribute plus adjacent readable reason text.
- **Verify on the built app:** keyboard-only pass, labels, focus, 800px width,
  320px reflow, 200% zoom and both themes, subject to roadmap status. Canvas
  imagery is not rendered-product verification.

---

## 10. Current validation ownership

The app has been built. Use the roadmap's current checkpoint for outstanding
host/client, layout and release checks rather than the original canvas build list.
Revalidate changed paths against the built app. Report side identity, swaps and
source-free reopen remain functional requirements. DESIGN.md owns the adopted
alert/count tokens; the canvas is historical design context.

---

## 11. Implementation notes (slices 0–5, 2026-10-28)

Deviations from the suggestions above, and why:

- **Report links.** Session reports use `/reports/:ref`. Ordinary references encode
  session keys and intended variables so they can be rebuilt after a restart.
  Reports with a same-task declaration use an opaque per-launch reference; task
  text stays server-side. Export preserves the declaration for later reopening.
  Saved reports also get a per-launch reference when opened.
- **Export location.** Each export is a new folder under `~/Xenoflux reports/`;
  a taken name gets a numbered sibling. Session comparisons carry no setup file
  text, so the "Include setup file text" choice says there is none.
- **Client state** comes from which processes hold the profile's Codex files and
  whether a holder descends from a Codex app; unknown is never shown as idle.
- **Copy and undo never close clients.** When Codex is open in the destination the
  app explains and waits; it does not offer to quit apps.
- **Long "Could not compare" lists** show five per group with a show-more control.
- **Run screens** (§5.10–5.12) use the existing experiment planner and runner.
  Review creates a short-lived token bound to the task, commit and profile
  setup; Start rechecks it and uses a durable experiment ID so retries do not
  repeat model tasks. The repository field also accepts a local path. Advanced
  overrides and explicitly entered setup/check commands are editable.
- **Recorded progress** reports observed steps and retained event counts, with
  skipped/unreached work distinguished from completed work. It does not estimate
  task completion or invent turns/tool-use counts. Tab closure leaves the server
  running; stopping the server interrupts its owned task. Recovery previews and
  reconciles stopped owned resources without resuming a model task. Experiment
  reports link back to durable progress and use the same export/reopen path.
- **Theme** has a System / Light / Dark choice in the header.
- **U0 browser follow-up (2026-10-28).** Page headings receive focus when they
  mount, including after asynchronous reads; in-page selection retains focus.
  Export completion and the opened saved-report summary receive focus so keyboard
  users can continue. Saved-report facts stack below 800px. Markdown comparison
  exports put the plain-language report before a technical appendix, retaining
  evidence and reviews. That historical pass did not exercise VoiceOver or an
  uncoached participant study; neither is required under the 2026-11-01 policy.

Current validation status is owned by the roadmap, not this historical slice note.
