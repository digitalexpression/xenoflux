---
name: shadcn
description: Manages shadcn components and projects — adding, searching, fixing, debugging, styling, and composing UI, including chat interfaces. Provides project context, component docs, and usage examples. Applies to shadcn/ui component, registry and preset work; the presence of components.json alone does not make unrelated tasks UI work. Also triggers for "shadcn init", "create an app with --preset", "switch to --preset", and for building a design system or applying a DESIGN.md or brand spec to shadcn/ui.
allowed-tools: Bash(npx shadcn@latest *), Bash(pnpm dlx shadcn@latest *), Bash(bunx --bun shadcn@latest *)
---

# shadcn/ui

A framework for building ui, components and design systems. Components are added as source code to the user's project via the CLI.

> **IMPORTANT:** Run all CLI commands using the project's package runner: `npx shadcn@latest`, `pnpm dlx shadcn@latest`, or `bunx --bun shadcn@latest` — based on the project's `packageManager`. Examples below use `npx shadcn@latest` but substitute the correct runner for the project.

## Xenoflux scope and precedence

Follow the current request and [repository instructions](../../../AGENTS.md).
[DESIGN.md](../../../DESIGN.md) and existing local component behavior take precedence
over generic conventions in this skill and its references. Run CLI commands from
`web/`, where `components.json` lives. Inspect installed code/config first; add only
components needed for the requested outcome. Convention-only differences do not
justify rewrites, a new showcase, bulk installation or another permission question.
Preserve real API/accessibility constraints and verify the affected built-app path.

## Current Project Context

Read `web/components.json` and the relevant installed component source. If current
CLI-derived context is needed, run `npx shadcn@latest info --json` from `web/`.
Do not assume context was automatically injected. Use `docs <component>` and fetch
the returned URLs when installed source and available docs leave an API question.

## Principles

1. **Use existing components first.** Inspect the local components before registry search. Search the established registry only when the task needs a component not already available.
2. **Compose, don't reinvent.** Settings page = Tabs + Card + form controls. Dashboard = Sidebar + Card + Chart + Table.
3. **Use built-in variants before custom styles.** `variant="outline"`, `size="sm"`, etc.
4. **Use semantic colors.** `bg-primary`, `text-muted-foreground` — never raw values like `bg-blue-500`.

## Critical Rules

These are default composition conventions, subject to the Xenoflux scope above.
Do not replace working project-specific composition solely to satisfy a convention.
API requirements and accessible controls still need verification. Each reference
contains examples, not independent permission to expand the task.

### Styling & Tailwind → [styling.md](./rules/styling.md)

- **`className` for layout, not styling.** Never override component colors or typography.
- **No `space-x-*` or `space-y-*`.** Use `flex` with `gap-*`. For vertical stacks, `flex flex-col gap-*`.
- **Use `size-*` when width and height are equal.** `size-10` not `w-10 h-10`.
- **Use `truncate` shorthand.** Not `overflow-hidden text-ellipsis whitespace-nowrap`.
- **No manual `dark:` color overrides.** Use semantic tokens (`bg-background`, `text-muted-foreground`).
- **Use `cn()` for conditional classes.** Don't write manual template literal ternaries.
- **No manual `z-index` on overlay components.** Dialog, Sheet, Popover, etc. handle their own stacking.

### Forms & Inputs → [forms.md](./rules/forms.md)

- **Forms use `FieldGroup` + `Field`.** Never use raw `div` with `space-y-*` or `grid gap-*` for form layout.
- **`InputGroup` uses `InputGroupInput`/`InputGroupTextarea`.** Never raw `Input`/`Textarea` inside `InputGroup`.
- **Buttons inside inputs use `InputGroup` + `InputGroupAddon`.**
- **Option sets (2–7 choices) use `ToggleGroup`.** Don't loop `Button` with manual active state.
- **`FieldSet` + `FieldLegend` for grouping related checkboxes/radios.** Don't use a `div` with a heading.
- **Field validation uses `data-invalid` + `aria-invalid`.** `data-invalid` on `Field`, `aria-invalid` on the control. For disabled: `data-disabled` on `Field`, `disabled` on the control.

### Component Structure → [composition.md](./rules/composition.md)

- **Items always inside their Group.** `SelectItem` → `SelectGroup`. `DropdownMenuItem` → `DropdownMenuGroup`. `CommandItem` → `CommandGroup`.
- **Use `asChild` (radix) or `render` (base) for custom triggers.** Check the installed primitive imports or, when needed, the `base` field from `npx shadcn@latest info`. → [base-vs-radix.md](./rules/base-vs-radix.md)
- **Dialog, Sheet, and Drawer always need a Title.** `DialogTitle`, `SheetTitle`, `DrawerTitle` required for accessibility. Use `className="sr-only"` if visually hidden.
- **Use full Card composition.** `CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`. Don't dump everything in `CardContent`.
- **Button has no `isPending`/`isLoading`.** Compose with `Spinner` + `data-icon` + `disabled`.
- **`TabsTrigger` must be inside `TabsList`.** Never render triggers directly in `Tabs`.
- **`Avatar` always needs `AvatarFallback`.** For when the image fails to load.

### Use Components, Not Custom Markup → [composition.md](./rules/composition.md)

- **Use existing components before custom markup.** Check if a component exists before writing a styled `div`.
- **Callouts use `Alert`.** Don't build custom styled divs.
- **Empty states use `Empty`.** Don't build custom empty state markup.
- **Toast follows the project base.** Use `toast` from the `toast` component for
  Base UI projects. Use `toast()` from `sonner` for Radix and React Aria
  projects.
- **Use `Separator`** instead of `<hr>` or `<div className="border-t">`.
- **Use `Skeleton`** for loading placeholders. No custom `animate-pulse` divs.
- **Use `Badge`** instead of custom styled spans.

### Icons → [icons.md](./rules/icons.md)

- **Icons in `Button` use `data-icon`.** `data-icon="inline-start"` or `data-icon="inline-end"` on the icon.
- **No sizing classes on icons inside components.** Components handle icon sizing via CSS. No `size-4` or `w-4 h-4`.
- **Pass icons as objects, not string keys.** `icon={CheckIcon}`, not a string lookup.

### Chat & Messaging → [chat.md](./rules/chat.md)

- **Chat UI composes the chat primitives.** Conversations use `MessageScroller`, rows use `Message`, surfaces use `Bubble`. Never hand-rolled bubble `div`s or a raw scroll container.
- **`MessageScroller` owns scroll behavior.** Streaming follow, anchoring, and jump-to-latest (`MessageScrollerButton`) are built in. Don't write a `useStickToBottom`/`ResizeObserver` hook.
- **Attachments use `Attachment`; system notes and dividers use `Marker`.** Not `Item` cards or `Separator` + a label.
- **Assistant activity uses `Trace`.** Reasoning, tool calls, sources and steps are `TraceLine`s in a `Trace`, one `Trace` per run of message parts. Behavior wraps the line: `TraceCollapsible`, a sheet trigger or a link. Not a hand-rolled `Collapsible` or a `Marker`.

### CLI

- **Never decode preset codes or build preset URLs manually.** Use `npx shadcn@latest preset decode <code>`, `preset url <code>`, or `preset open <code>`. For project-aware preset detection, use `npx shadcn@latest preset resolve`.
- **Apply preset codes directly with the CLI.** Use `npx shadcn@latest apply <code>` for existing projects, or `npx shadcn@latest init --preset <code>` when initializing.

## Key Patterns

These are the most common patterns that differentiate correct shadcn/ui code. For edge cases, see the linked rule files above.

```tsx
// Form layout: FieldGroup + Field, not div + Label.
<FieldGroup>
  <Field>
    <FieldLabel htmlFor="email">Email</FieldLabel>
    <Input id="email" />
  </Field>
</FieldGroup>

// Validation: data-invalid on Field, aria-invalid on the control.
<Field data-invalid>
  <FieldLabel>Email</FieldLabel>
  <Input aria-invalid />
  <FieldDescription>Invalid email.</FieldDescription>
</Field>

// Icons in buttons: data-icon, no sizing classes.
<Button>
  <SearchIcon data-icon="inline-start" />
  Search
</Button>

// Spacing: gap-*, not space-y-*.
<div className="flex flex-col gap-4">  // correct
<div className="space-y-4">           // wrong

// Equal dimensions: size-*, not w-* h-*.
<Avatar className="size-10">   // correct
<Avatar className="w-10 h-10"> // wrong

// Status colors: Badge variants or semantic tokens, not raw colors.
<Badge variant="secondary">+20.1%</Badge>    // correct
<span className="text-emerald-600">+20.1%</span> // wrong
```

## Component Selection

| Need                       | Use                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| Button/action              | `Button` with appropriate variant                                                                   |
| Form inputs                | `Input`, `Select`, `Combobox`, `Switch`, `Checkbox`, `RadioGroup`, `Textarea`, `InputOTP`, `Slider` |
| Toggle between 2–5 options | `ToggleGroup` + `ToggleGroupItem`                                                                   |
| Data display               | `Table`, `Card`, `Badge`, `Avatar`                                                                  |
| Navigation                 | `Sidebar`, `NavigationMenu`, `Breadcrumb`, `Tabs`, `Pagination`                                     |
| Overlays                   | `Dialog` (modal), `Sheet` (side panel), `Drawer` (bottom sheet), `AlertDialog` (confirmation)       |
| Feedback                   | `toast` (Base UI), `sonner` (Radix/Aria), `Alert`, `Progress`, `Skeleton`, `Spinner`                 |
| Command palette            | `Command` inside `Dialog`                                                                           |
| Charts                     | `Chart` (wraps Recharts)                                                                            |
| Layout                     | `Card`, `Separator`, `Resizable`, `ScrollArea`, `Accordion`, `Collapsible`                          |
| Empty states               | `Empty`                                                                                             |
| Menus                      | `DropdownMenu`, `ContextMenu`, `Menubar`                                                            |
| Tooltips/info              | `Tooltip`, `HoverCard`, `Popover`                                                                   |
| Chat / conversation UI     | `MessageScroller`, `Message`, `Bubble`, `Attachment`, `Marker`, `Trace`                             |

## Key Fields

When CLI context is needed, `info --json` can supply these fields. Otherwise use the relevant local config/source; context is not automatically injected:

- **`aliases`** → use the actual alias prefix for imports (e.g. `@/`, `~/`), never hardcode.
- **`isRSC`** → when `true`, components using `useState`, `useEffect`, event handlers, or browser APIs need `"use client"` at the top of the file. Always reference this field when advising on the directive.
- **`tailwindVersion`** → `"v4"` uses `@theme inline` blocks; `"v3"` uses `tailwind.config.js`.
- **`tailwindCssFile`** → the global CSS file where custom CSS variables are defined. Always edit this file, never create a new one.
- **`style`** → component visual treatment (e.g. `nova`, `vega`).
- **`base`** → primitive library (`radix` or `base`). Affects component APIs and available props.
- **`iconLibrary`** → determines icon imports. Use `lucide-react` for `lucide`, `@tabler/icons-react` for `tabler`, etc. Never assume `lucide-react`.
- **`resolvedPaths`** → exact file-system destinations for components, utils, hooks, etc.
- **`framework`** → routing and file conventions (e.g. Next.js App Router vs Vite SPA).
- **`packageManager`** → use this for any non-shadcn dependency installs (e.g. `pnpm add date-fns` vs `npm install date-fns`).
- **`preset`** → resolved preset code and values for the current project. Use `npx shadcn@latest preset resolve --json` when you only need preset information.

See [cli.md — `info` command](./cli.md) for the full field reference.

## Component Docs, Examples, and Usage

When component documentation is needed, `npx shadcn@latest docs <component>` returns its documentation, example and API-reference URLs. Fetch the relevant URL for the actual content.

```bash
npx shadcn@latest docs button dialog select
```

Fetch component documentation when adding an unfamiliar API, updating upstream code,
or resolving behavior not established by installed source. Reuse relevant fetched
docs within the task; routine local edits do not require repeating CLI/network setup.

## Workflow

1. **Get relevant project context** — inspect local config/source; use `info` if needed. Apply only the following steps needed for the task.
2. **Check installed components first** — before running `add`, always check the `components` list from project context or list the `resolvedPaths.ui` directory. Don't import components that haven't been added, and don't re-add ones already installed.
3. **Find missing components** — use `npx shadcn@latest search` when local components do not cover the requested behavior.
4. **Resolve unfamiliar APIs** — when installed source leaves a question, run `npx shadcn@latest docs <component>` to get URLs and fetch the relevant page. Use `npx shadcn@latest view` to browse registry items you haven't installed. To preview changes to installed components, use `npx shadcn@latest add --diff`.
5. **Install or update** — `npx shadcn@latest add`. When updating existing components, use `--dry-run` and `--diff` to preview changes first (see [Updating Components](#updating-components) below).
6. **Fix imports in third-party components** — After adding components from community registries (e.g. `@bundui`, `@magicui`), check the added non-UI files for hardcoded import paths like `@/components/ui/...`. These won't match the project's actual aliases. Read `components.json` (or use `info` when needed) to get the correct `ui` alias (e.g. `@workspace/ui/components`) and rewrite the imports accordingly. The CLI rewrites imports for its own UI files, but third-party registry components may use default paths that don't match the project.
7. **Review added components** — After adding a component or block from any registry, **always read the added files and verify they are correct**. Check for missing sub-components (e.g. `SelectItem` without `SelectGroup`), missing imports, incorrect composition, or violations of the [Critical Rules](#critical-rules). Also replace any icon imports with the project's `iconLibrary` from the project context (e.g. if the registry item uses `lucide-react` but the project uses `hugeicons`, swap the imports and icon names accordingly). Fix all issues before moving on.
8. **Use established registry context** — honor a registry named by the user or established by project config/components. Ask only when an unresolved choice materially changes dependencies, behavior or trust; do not ask again for an already established source.
9. **Switching presets** — use the user's requested scope and preview the affected files. Ask about **overwrite**, **partial**, **merge**, or **skip** only when the request leaves a material choice unresolved.
   - **Inspect current preset**: `npx shadcn@latest preset resolve`. Use `--json` when you need structured values.
   - **Inspect incoming preset**: `npx shadcn@latest preset decode <code>`. Use `preset url <code>` or `preset open <code>` to share or open the preset builder.
   - **Overwrite**: `npx shadcn@latest apply <code>`. Overwrites detected components, fonts, and CSS variables.
   - **Partial**: `npx shadcn@latest apply <code> --only theme,font`. Updates only the selected preset parts without reinstalling UI components. Supported values are `theme` and `font`; comma-separated combinations are allowed. `icon` is intentionally not supported, because icon changes may require full component reinstall and transforms.
   - **Merge**: `npx shadcn@latest init --preset <code> --force --no-reinstall`, then run `npx shadcn@latest info` to list installed components, then for each installed component use `--dry-run` and `--diff` to [smart merge](#updating-components) it individually.
   - **Skip**: `npx shadcn@latest init --preset <code> --force --no-reinstall`. Only updates config and CSS, leaves components as-is.
   - **Important**: Always run preset commands inside the user's project directory. `apply` only works in an existing project with a `components.json` file. The CLI automatically preserves the current base (`base` vs `radix`) from `components.json`. If you must use a scratch/temp directory (e.g. for `--dry-run` comparisons), pass `--base <current-base>` explicitly — preset codes do not encode the base.

## Design Systems from DESIGN.md

Use [design-system.md](./design-system.md) only for an explicitly requested new
full design-system/showcase project. Applying DESIGN.md to the existing app uses
the scoped component workflow above; it does not imply scaffolding or `add --all`.
The linked reference owns the showcase sequence and its verification guidance.

## Updating Components

When the user asks to update a component from upstream while keeping their local changes, use `--dry-run` and `--diff` to intelligently merge. Prefer the CLI diff workflow; read-only upstream source inspection is also valid evidence. Do not blindly overwrite local adaptations.

1. Run `npx shadcn@latest add <component> --dry-run` to see all files that would be affected.
2. For each file, run `npx shadcn@latest add <component> --diff <file>` to see what changed upstream vs local.
3. Decide per file based on the diff:
   - No local changes → safe to overwrite.
   - Has local changes → read the local file, analyze the diff, and apply upstream updates while preserving local modifications.
   - User explicitly authorizes replacing the identified files → the reviewed overwrite can proceed within that grant.
4. Preserve unrelated local changes. Ask only if the proposed overwrite exceeds the granted scope; do not repeat an approval already covering it.

## Quick Reference

```bash
# Create a new project.
npx shadcn@latest init --name my-app --preset base-nova
npx shadcn@latest init --name my-app --preset a2r6bw --template vite

# Create a design system app (then follow design-system.md).
npx shadcn@latest init --name my-ds --preset b0 --template vite --no-monorepo -y
npx shadcn@latest init --name my-ds --base base --preset maia --template vite --no-monorepo -y
npx shadcn@latest add --all -y

# Create a monorepo project.
npx shadcn@latest init --name my-app --preset base-nova --monorepo
npx shadcn@latest init --name my-app --preset base-nova --template next --monorepo

# Initialize existing project.
npx shadcn@latest init --preset base-nova
npx shadcn@latest init --defaults  # shortcut: --template=next --preset=nova (base style implied)

# Apply a preset to an existing project.
npx shadcn@latest apply a2r6bw
npx shadcn@latest apply a2r6bw --only theme
npx shadcn@latest apply a2r6bw --only font
npx shadcn@latest apply a2r6bw --only theme,font

# Inspect preset codes and project preset state.
npx shadcn@latest preset decode a2r6bw
npx shadcn@latest preset url a2r6bw
npx shadcn@latest preset open a2r6bw
npx shadcn@latest preset resolve
npx shadcn@latest preset resolve --json

# Add components.
npx shadcn@latest add button card dialog
npx shadcn@latest add @magicui/shimmer-button
npx shadcn@latest add owner/repo/item
npx shadcn@latest add --all

# Preview changes before adding/updating.
npx shadcn@latest add button --dry-run
npx shadcn@latest add button --diff button.tsx
npx shadcn@latest add @acme/form --view button.tsx
npx shadcn@latest add owner/repo/item --dry-run

# Search registries.
npx shadcn@latest search @shadcn -q "sidebar"
npx shadcn@latest search @tailark -q "stats"
npx shadcn@latest search owner/repo -q "login"
npx shadcn@latest search                          # all configured registries
npx shadcn@latest search @shadcn -q "menu" -t ui  # filter by item type

# Get component docs and example URLs.
npx shadcn@latest docs button dialog select

# View registry item details (for items not yet installed).
npx shadcn@latest view @shadcn/button
npx shadcn@latest view owner/repo/item
```

**Named presets:** `nova`, `vega`, `maia`, `lyra`, `mira`, `luma`
**Templates:** `next`, `vite`, `start`, `react-router`, `astro` (all support `--monorepo`) and `laravel` (not supported for monorepo)
**Preset codes:** Version-prefixed base62 strings (e.g. `a2r6bw` or `b0`), from [ui.shadcn.com](https://ui.shadcn.com).

## Detailed References

- [rules/forms.md](./rules/forms.md) — FieldGroup, Field, InputGroup, ToggleGroup, FieldSet, validation states
- [rules/composition.md](./rules/composition.md) — Groups, overlays, Card, Tabs, Avatar, Alert, Empty, Toast, Separator, Skeleton, Badge, Button loading
- [rules/chat.md](./rules/chat.md) — MessageScroller, Message, Bubble, Attachment, Marker, Trace; streaming, anchoring, jump-to-latest, assistant activity rows
- [rules/icons.md](./rules/icons.md) — data-icon, icon sizing, passing icons as objects
- [rules/styling.md](./rules/styling.md) — Semantic colors, variants, className, spacing, size, truncate, dark mode, cn(), z-index
- [rules/base-vs-radix.md](./rules/base-vs-radix.md) — asChild vs render, Select, ToggleGroup, Slider, Accordion
- [cli.md](./cli.md) — Commands, flags, presets, templates
- [registry.md](./registry.md) — Authoring source registries, `include`, item definitions, dependencies, GitHub registry rules
- [customization.md](./customization.md) — Theming, CSS variables, extending components
- [design-system.md](./design-system.md): DESIGN.md (with or without a preset) to a themed app: style picking, token mapping, radius, fonts, type scale, control heights, showcase traps, verification
- [design-system-page.md](./design-system-page.md): What goes on a design system page and how: foundations, component tiers, pinned state matrices, contrast pairs, edge cases, do/don't, recipes
