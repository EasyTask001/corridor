# UI design system foundation — redesign

Status: draft, pending user review
Branch for implementation: `design/foundation-v2` (off `main`, main untouched until merge)

## Why

Current state: `packages/ui/src/tokens.css` is a flat, palette-only token file (colors only —
no type scale, spacing scale, radius scale, elevation, or motion tokens). Dark mode does not
exist. The 13 existing components (`packages/ui/src/components/`) are functional but visually
bare. The app shell sidebar (`apps/web/src/components/app-shell.tsx`) renders 17 nav links flat,
with no grouping, no icons, no collapse — a wall of text.

Goal: rebuild the design system foundation (tokens + core components + nav) to a modern,
elegant, "best in class" enterprise-SaaS bar (Linear/Vercel/Stripe-dashboard grade), so every
page in the app inherits a crisper look without per-page rewrites. This is sub-project 1 of a
larger redesign; later sub-projects (dashboard, movements, documents, settings, auth/onboarding)
each get their own design pass once this foundation lands.

Out of scope for this pass: rewriting the ~22 files that consume `@corridor/ui` today (they
keep working unchanged against the reskinned components), and any change to page-level layout
or IA beyond the sidebar itself.

## Approach

Additive token layering, in place — not a parallel package, not a wholesale shadcn replatform.
`packages/ui/src/tokens.css` is restructured into three layers; the 13 existing components keep
their file names and prop APIs so call sites are untouched. New primitives are added alongside
for things currently hand-rolled per-page (checkbox, radio, switch, tooltip — found live-coded
in `settings/notifications`, `settings/organization`, `settings/roles`, `notifications`,
`settings/integrations`, `components/registry`), and for the nav (nav item, collapsible nav
group). Revert path is the git branch itself — no feature flag, no duplicated legacy files.

## Token architecture

Three layers, Tailwind v4 `@theme` + CSS custom properties:

1. **Primitive** — raw scales, no semantic meaning: neutral gray ramp (11 steps), primary brand
   ramp (11 steps, replacing today's single-shade `ink`), status ramps for ok/warn/danger (11
   steps each, kept separate from brand), spacing scale, radius scale, elevation/shadow scale
   (0–4), type scale (display → caption), motion durations/easings.
2. **Semantic** — role-based aliases that components and pages actually reference:
   `--bg-surface`, `--bg-canvas`, `--text-primary`, `--text-muted`, `--border-default`,
   `--accent-interactive`, `--status-warn`, etc. Redefined per theme (see Dark mode below).
3. **Component** — a thin layer only where a component needs something no semantic token covers.

## Palette

Restrained, near-monochrome neutral scale carrying most UI weight, one confident primary accent
for interactive elements (buttons, links, focus rings, active nav), status colors kept strictly
separate from the brand accent. This fixes today's anti-pattern where the amber `signal` button
variant doubles as an implied warning color. Amber stays, scoped to status/warn only; a new
primary accent (deep indigo/blue candidates, brought as swatches during implementation rather
than decided in text) carries brand/interactive weight.

Concrete swatch values are a visual decision made during implementation (with the
`design-system`/`ui-ux-pro-max` skills), not fixed in this doc — the plan step should produce
2-3 concrete palette options for sign-off before they're locked into `tokens.css`.

## Dark mode

`data-theme="dark"` attribute on `<html>`, no new dependency (no `next-themes`). Semantic tokens
redefined under `[data-theme="dark"]`, with a `prefers-color-scheme` media-query fallback for
"system." Built from the start, not retrofitted — every component and the nav must look correct
in both themes before this sub-project is done.

## Components

Reskin all 13 existing components (button, card, table, data-table, dialog, input, select,
textarea, tabs, badge, alert, skeleton, label) onto the new tokens, same props.

Add missing primitives found hand-rolled across the app: checkbox, radio, switch, tooltip.
These are added to `packages/ui` but existing call sites are not migrated to them in this pass.

## Navigation consolidation

`apps/web/src/components/app-shell.tsx` currently renders `NAV` (10 items) and `SETTINGS` (7
items) as two flat lists — 17 links with no icons, no grouping.

Redesign:
- Collapse `Drivers/Trucks/Trailers/Partners` into one **Parties** group.
- Collapse the 7 `/settings/*` routes into one **Settings** group.
- Top-level nav becomes 8 items: Dashboard, Movements, Documents, Parties, Alerts, Reports,
  Copilot, Settings. Whichever group contains the active route auto-expands.
- Icons on every top-level item and group header via `lucide-react` (already a dependency of
  `packages/ui`).
- New reusable primitives (nav item, collapsible nav group) go in `packages/ui`, since they're
  generic; `app-shell.tsx` stays the app-specific composition against its `NAV`/`SETTINGS` data,
  matching the existing UI-kit/app-component boundary from `CONTRIBUTING.md`.
- Restyled on the new semantic tokens so it flips correctly in dark mode.

## Testing / verification

No Storybook or visual-regression harness exists in this repo. Verification is:
`pnpm --filter @corridor/ui build`, `pnpm typecheck`, `pnpm lint`, plus a manual browser pass
(`pnpm dev`) against a couple of real pages (dashboard, settings) in both light and dark theme,
checking the consolidated nav's collapse/expand and active-route auto-expand behavior.

## Skills to use during implementation

Per `apps/web` and global CLAUDE.md conventions, implementation should invoke `ui-ux-pro-max` as
the primary UI/UX skill, with `design-system` for the token architecture/component spec work and
`brand`/`design`/`ui-styling` as needed for the palette and visual polish decisions called out
above as "decided during implementation."
