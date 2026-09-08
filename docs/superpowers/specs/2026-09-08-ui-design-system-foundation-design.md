# UI design system foundation — redesign

Status: approved, palette/typography revised against `ui-ux-pro-max` verified data (see Palette/Typography below)
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

Verified via `ui-ux-pro-max`'s `--design-system` search for "B2B logistics customs compliance
dashboard SaaS" (density 8, variance 3, motion 4): style match is "Minimalism & Swiss Style",
explicitly best-for "Enterprise apps, dashboards, SaaS platforms, professional tools" — confirms
the Linear/Vercel/Stripe direction already chosen. The tool's verified color pairing for this
product category anchors every value below (exact hexes in Task 1 of the implementation plan);
this section records the roles and reasoning, not just the numbers.

- **Neutral scale**: Tailwind's standard `slate` ramp (the tool's own Background/Foreground/
  Border/Muted values for this category resolve almost exactly to slate at every stop) — more
  battle-tested than an invented ramp. Carries most UI weight, per Swiss/minimalism style.
- **Brand accent** (`brand-*`, new primitive family): a blue anchored on the tool's verified
  Primary/Secondary pair (`#2563eb` / `#3b82f6`). Used for buttons, links, focus rings, active
  nav — the sole generic interactive color.
- **Signal** (`signal-*`, existing name, the border/customs domain accent): the tool separately
  recommends an orange (`#ea580c`) as this category's accent/CTA color. Corridor's amber
  "signal" is conceptually that same "domain attention" role, so `signal-500` takes that
  verified value directly rather than the muted gold used before.
- **Warn** (`warn-*`, generic status): shifted to true amber so it's visually distinct from the
  now-orange `signal` — the two were near-identical golds in the first draft, which is exactly
  the anti-pattern (brand accent doubling as implied status color) this section originally
  flagged.
- **Danger** (`danger-*`): the tool's verified Destructive value (`#dc2626`), replacing an
  invented red.
- **Ok** (`ok-*`): no direct tool output for this role; kept to a standard, well-tested Tailwind
  hue family (emerald) rather than a custom guess, consistent with the rest of the palette now
  being sourced from verified/standard scales rather than invented ones.

This is a genuine change from the first draft, not just now-verified versions of the same
choices — the earlier indigo brand accent and near-identical signal/warn golds are both gone.

## Typography

`ui-ux-pro-max` recommends **Plus Jakarta Sans** for this exact product category ("SaaS, B2B,
dashboards, productivity tools" — mood: friendly, modern, professional), over the bare
system-font stack the first draft kept. Loaded via `next/font/google` in the root layout (Next's
self-hosted approach — avoids the render-blocking external stylesheet request and layout shift a
raw Google Fonts `<link>`/`@import` would cost), exposed as a CSS custom property that
`packages/ui/src/tokens.css`'s `--font-sans` wraps with the original system-font stack as a
fallback (so `packages/ui` itself never depends on `next/font`).

## Motion & accessibility

`ui-ux-pro-max`'s pre-delivery checklist flags `prefers-reduced-motion` support as required; the
first draft didn't have it. Adding a single global rule in `globals.css` that collapses
transition/animation durations under that media query. Everything else the checklist calls for
(150-300ms hover transitions, visible focus rings on every interactive control, no dark-mode-by-
default) was already true of the plan as designed.

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

## Skills used

`ui-ux-pro-max` was invoked (`--design-system` search plus targeted `ux`/`color`/`nextjs`
queries) to source the Palette, Typography, and Motion & accessibility sections above from
verified data rather than invented values — see those sections for what came from it and why.
