# UI Design System Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `packages/ui`'s design tokens and core components into a modern, dark-mode-aware "best in class" foundation, and consolidate the app shell's navigation, without breaking any existing page that already consumes `@corridor/ui`.

**Architecture:** A three-layer token system (primitive → semantic → component) added to `packages/ui/src/tokens.css`, consumed by reskinned versions of the 13 existing UI-kit components plus five new primitives (checkbox, radio group, switch, tooltip, nav group/item), then wired into `apps/web`'s root layout (theme bootstrap) and `app-shell.tsx` (consolidated, icon-led, grouped navigation).

**Tech Stack:** Tailwind CSS v4 (`@theme`), Radix UI primitives, `class-variance-authority`, `lucide-react`, React 19, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-08-ui-design-system-foundation-design.md`

## Global Constraints

- All work happens on git branch `design/foundation-v2`, branched off `main`. Do not merge to `main` as part of this plan — that decision is the user's, made separately after review.
- **Primitive token key names never change**: `ink-*`, `signal-*`, `ok-*`, `warn-*`, `danger-*` stay exactly as named today (dozens of pages reference these Tailwind utilities directly, e.g. `text-ink-500`). Only their hex **values** change. New color needs get a new primitive family (`brand-*`) or live at the semantic layer — never a rename.
- No file under `apps/web/src` is modified in this plan **except** `apps/web/src/app/layout.tsx`, `apps/web/src/app/globals.css`, and `apps/web/src/components/app-shell.tsx` — those three are explicitly in scope (theme bootstrap + nav consolidation). Every other page/component that consumes `@corridor/ui` is left untouched and must keep working unmodified.
- Dark mode is attribute-driven: `data-theme="dark"` on `<html>`, with a `prefers-color-scheme` fallback when no explicit choice has been stored. No `next-themes` or other new runtime dependency for theming.
- New Radix dependencies are added to `packages/ui/package.json` via `pnpm --filter @corridor/ui add <pkg>`, not hand-edited, so the lockfile resolves correctly.
- Verification for every `packages/ui`-only task: `pnpm --filter @corridor/ui typecheck && pnpm --filter @corridor/ui lint && pnpm --filter @corridor/ui test`. Tasks that also touch `apps/web` additionally run `pnpm --filter web typecheck && pnpm --filter web lint`. The final task additionally runs `pnpm --filter web build` (`packages/ui` has no `build` script — it's consumed as TS source directly, `main: ./src/index.ts` — so `web build` is the real end-to-end compile check, bundling `packages/ui`'s source through Next's own build).
- Palette, typography, and the reduced-motion requirement are sourced from the `ui-ux-pro-max` skill's `--design-system` search for this product category, not invented — see the spec's Palette/Typography/Motion & accessibility sections for the reasoning behind each value before changing one.

---

### Task 1: Rebuild `packages/ui/src/tokens.css` (primitive + semantic + dark mode)

**Files:**
- Modify: `packages/ui/src/tokens.css:1-24` (full rewrite)

**Interfaces:**
- Produces: primitive CSS custom properties (`--color-ink-*` refreshed values, new `--color-brand-*`, refreshed `--color-signal-*`/`--color-ok-*`/`--color-warn-*`/`--color-danger-*`, `--radius-md`/`--radius-xl`, `--shadow-sm`/`--shadow-md`/`--shadow-lg`) and semantic tokens (`--color-surface-canvas`, `--color-surface-raised`, `--color-surface-sunken`, `--color-surface-overlay`, `--color-fg-primary`, `--color-fg-secondary`, `--color-fg-inverted`, `--color-border-default`, `--color-border-strong`, `--color-accent`, `--color-accent-hover`, `--color-accent-fg`, `--color-focus-ring`), each redefined under `[data-theme="dark"]` and `@media (prefers-color-scheme: dark)`. These generate Tailwind utilities of the same name (e.g. `bg-surface-raised`, `text-fg-secondary`, `ring-focus-ring/40`) that every later task consumes.
- Consumes: nothing (first task).

- [ ] **Step 1: Create the working branch**

Already done — this task runs inside a git worktree already on branch `design/foundation-v2`, off `main`. Skip this step and proceed to Step 2.

- [ ] **Step 2: Replace `packages/ui/src/tokens.css`**

Palette sourced from the `ui-ux-pro-max` skill's `--design-system` search for "B2B logistics
customs compliance dashboard SaaS" (density 8, variance 3, motion 4) — see
`docs/superpowers/specs/2026-09-08-ui-design-system-foundation-design.md`'s Palette section for
the reasoning behind each family. `--font-sans` wraps a `--font-sans-loaded` custom property that
Task 2 sets via `next/font/google` (Plus Jakarta Sans), falling back to the system stack when
unset so `packages/ui` itself carries no `next/font` dependency.

```css
/**
 * Corridor design tokens: three layers.
 *  1. Primitive  — raw color/radius/shadow scales, theme-independent.
 *  2. Semantic   — role-based aliases (`surface-*`, `fg-*`, `accent`, …) that
 *     components and pages reference; redefined per theme below.
 *  3. Component  — left to individual components; nothing global needed yet.
 *
 * Primitive key NAMES are permanent (`ink-*`, `signal-*`, `ok-*`, `warn-*`,
 * `danger-*`) — dozens of pages reference these Tailwind utilities directly
 * (e.g. `text-ink-500`). Only their VALUES change here. Do not rename them;
 * add new primitive families instead (see `brand-*`).
 *
 * Palette verified via ui-ux-pro-max's --design-system search for this
 * product category (enterprise SaaS dashboard, Minimalism & Swiss style):
 * neutral = Tailwind's slate ramp, brand = the tool's verified Primary/
 * Secondary blue pair, signal = its verified Accent/CTA orange (reused for
 * Corridor's existing border/customs domain accent), danger = its verified
 * Destructive red. warn/ok are standard, well-tested Tailwind hues chosen to
 * stay visually distinct from signal (not just "verified" but "not another
 * near-identical gold").
 */
@theme {
  --font-sans: var(--font-sans-loaded, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif);
  --font-mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;

  /* Neutral scale (historically "ink") — Tailwind's slate ramp. */
  --color-ink-950: #020617;
  --color-ink-900: #0f172a;
  --color-ink-800: #1e293b;
  --color-ink-700: #334155;
  --color-ink-600: #475569;
  --color-ink-500: #64748b;
  --color-ink-400: #94a3b8;
  --color-ink-300: #cbd5e1;
  --color-ink-200: #e2e8f0;
  --color-ink-100: #f1f5f9;
  --color-ink-50: #f8fafc;

  /* Brand accent — new. Carries interactive/brand weight: buttons, links, focus. */
  --color-brand-700: #1d4ed8;
  --color-brand-600: #2563eb;
  --color-brand-500: #3b82f6;
  --color-brand-300: #93c5fd;

  /* Signal — the existing border/customs domain accent. Kept distinct from
     both `brand` (generic interactive) and `warn` (generic status). */
  --color-signal-600: #c2410c;
  --color-signal-500: #ea580c;

  /* Status */
  --color-ok-600: #059669;
  --color-ok-500: #10b981;
  --color-warn-600: #d97706;
  --color-warn-500: #f59e0b;
  --color-danger-600: #b91c1c;
  --color-danger-500: #dc2626;

  /* Radius — softened from Tailwind's defaults for a calmer, modern feel. */
  --radius-md: 0.5rem;
  --radius-xl: 1rem;

  /* Elevation */
  --shadow-sm: 0 1px 2px rgb(2 6 23 / 0.06);
  --shadow-md: 0 4px 12px rgb(2 6 23 / 0.08), 0 1px 2px rgb(2 6 23 / 0.04);
  --shadow-lg: 0 12px 32px rgb(2 6 23 / 0.16), 0 2px 6px rgb(2 6 23 / 0.06);

  /* Semantic — light theme (default). Redefined for dark theme below. */
  --color-surface-canvas: var(--color-ink-50);
  --color-surface-raised: #ffffff;
  --color-surface-sunken: var(--color-ink-100);
  --color-surface-overlay: #ffffff;
  --color-fg-primary: var(--color-ink-800);
  --color-fg-secondary: var(--color-ink-600);
  --color-fg-inverted: #ffffff;
  --color-border-default: var(--color-ink-200);
  --color-border-strong: var(--color-ink-300);
  --color-accent: var(--color-brand-600);
  --color-accent-hover: var(--color-brand-700);
  --color-accent-fg: #ffffff;
  --color-focus-ring: var(--color-brand-600);
}

:root {
  color-scheme: light;
}

/* Dark theme: explicit opt-in via `data-theme="dark"`, or the OS preference
   when the visitor hasn't chosen (no `data-theme="light"` override present). */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --color-surface-canvas: var(--color-ink-950);
    --color-surface-raised: var(--color-ink-900);
    --color-surface-sunken: var(--color-ink-800);
    --color-surface-overlay: var(--color-ink-900);
    --color-fg-primary: var(--color-ink-50);
    --color-fg-secondary: var(--color-ink-300);
    --color-fg-inverted: var(--color-ink-950);
    --color-border-default: var(--color-ink-800);
    --color-border-strong: var(--color-ink-700);
    --color-accent: var(--color-brand-500);
    --color-accent-hover: var(--color-brand-300);
    --color-accent-fg: #ffffff;
    --color-focus-ring: var(--color-brand-300);
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --color-surface-canvas: var(--color-ink-950);
  --color-surface-raised: var(--color-ink-900);
  --color-surface-sunken: var(--color-ink-800);
  --color-surface-overlay: var(--color-ink-900);
  --color-fg-primary: var(--color-ink-50);
  --color-fg-secondary: var(--color-ink-300);
  --color-fg-inverted: var(--color-ink-950);
  --color-border-default: var(--color-ink-800);
  --color-border-strong: var(--color-ink-700);
  --color-accent: var(--color-brand-500);
  --color-accent-hover: var(--color-brand-300);
  --color-accent-fg: #ffffff;
  --color-focus-ring: var(--color-brand-300);
}
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter @corridor/ui typecheck && pnpm --filter @corridor/ui lint && pnpm --filter @corridor/ui test`
Expected: all pass (no component references anything new yet, so nothing should break).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/tokens.css
git commit -m "feat(ui): rebuild design tokens as primitive/semantic layers with dark mode"
```

---

### Task 2: Theme bootstrap — `ThemeToggle` component + FOUC-safe root layout

**Files:**
- Create: `packages/ui/src/components/theme-toggle.tsx`
- Create: `packages/ui/src/components/theme-toggle.test.tsx`
- Modify: `packages/ui/src/index.ts:1` (add export)
- Modify: `apps/web/src/app/layout.tsx:1-15` (full rewrite)

**Interfaces:**
- Consumes: `--color-fg-secondary`/`--color-fg-primary`/`--color-surface-sunken` semantic tokens (Task 1), which itself consumes the `--font-sans-loaded` custom property this task's layout change sets.
- Produces: `ThemeToggle` component (no props besides `className`); the `data-theme` attribute + `corridor-theme` `localStorage` key contract that any future theming code relies on; the `--font-sans-loaded` CSS custom property (via `next/font/google`'s Plus Jakarta Sans, per the spec's Typography section) that `packages/ui/src/tokens.css`'s `--font-sans` wraps.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/ui/src/components/theme-toggle.test.tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "./theme-toggle";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
});

describe("ThemeToggle", () => {
  it("defaults to light and switches to dark on click, persisting the choice", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const button = await screen.findByRole("button", { name: /switch to dark theme/i });
    await user.click(button);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("corridor-theme")).toBe("dark");
  });

  it("reads a stored preference on mount", async () => {
    localStorage.setItem("corridor-theme", "dark");
    render(<ThemeToggle />);

    expect(await screen.findByRole("button", { name: /switch to light theme/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @corridor/ui test -- theme-toggle`
Expected: FAIL — `./theme-toggle` does not exist.

- [ ] **Step 3: Implement `ThemeToggle`**

```tsx
// packages/ui/src/components/theme-toggle.tsx
"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "../lib/cn";

const STORAGE_KEY = "corridor-theme";

function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem(STORAGE_KEY, theme);
}

export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const resolved =
      stored === "light" || stored === "dark"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    setTheme(resolved);
  }, []);

  if (!theme) return null;

  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg-primary",
        className,
      )}
    >
      {theme === "dark" ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
    </button>
  );
}
```

- [ ] **Step 4: Export it**

In `packages/ui/src/index.ts`, add near the `Textarea` export block:

```ts
export { ThemeToggle } from "./components/theme-toggle";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @corridor/ui test -- theme-toggle`
Expected: PASS

- [ ] **Step 6: Wire the FOUC-safe theme init and Plus Jakarta Sans into the root layout**

Replace `apps/web/src/app/layout.tsx` in full:

```tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

/**
 * Self-hosted by Next (no render-blocking Google Fonts request, no layout
 * shift). Exposes `--font-sans-loaded`, which `@corridor/ui`'s
 * `tokens.css` wraps with a system-font fallback — see the spec's
 * Typography section for why Plus Jakarta Sans.
 */
const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans-loaded",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Corridor", template: "%s · Corridor" },
  description: "AI-native cross-border customs compliance for carriers.",
};

/**
 * Sets `data-theme` before paint so a stored dark-mode preference doesn't
 * flash light first. Runs inline, not via next/script, because it must
 * execute before the first paint of `<body>`.
 */
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('corridor-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={plusJakartaSans.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
```

- [ ] **Step 7: Verify**

Run: `pnpm --filter @corridor/ui typecheck && pnpm --filter @corridor/ui lint && pnpm --filter @corridor/ui test && pnpm --filter web typecheck && pnpm --filter web lint`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/components/theme-toggle.tsx packages/ui/src/components/theme-toggle.test.tsx packages/ui/src/index.ts apps/web/src/app/layout.tsx
git commit -m "feat(ui): add ThemeToggle and FOUC-safe theme bootstrap"
```

---

### Task 3: Reskin chrome components — button, badge, alert, skeleton, label, table

**Files:**
- Modify: `packages/ui/src/components/button.tsx:5-25`
- Modify: `packages/ui/src/components/badge.tsx:5-23`
- Modify: `packages/ui/src/components/alert.tsx:5-15`
- Modify: `packages/ui/src/components/skeleton.tsx:5-7`
- Modify: `packages/ui/src/components/label.tsx:9-16`
- Modify: `packages/ui/src/components/table.tsx` (all functions)
- Create: `packages/ui/src/components/button.test.tsx`

**Interfaces:**
- Consumes: semantic tokens from Task 1 (`bg-accent`, `text-accent-fg`, `bg-surface-sunken`, `text-fg-primary`, `text-fg-secondary`, `border-border-default`, `ring-focus-ring`, `bg-fg-primary`, `text-fg-inverted`).
- Produces: no prop/API changes — every existing call site (`variant="primary"`, `variant="signal"`, etc.) keeps working with new visuals.

- [ ] **Step 1: Write the failing test for `Button`**

```tsx
// packages/ui/src/components/button.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "./button";

describe("Button", () => {
  it("applies the accent-filled classes for the primary variant by default", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" }).className).toContain("bg-accent");
  });

  it("applies bordered neutral classes for the secondary variant", () => {
    render(<Button variant="secondary">Cancel</Button>);
    expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("border-border-default");
  });

  it("keeps the signal variant's amber styling", () => {
    render(<Button variant="signal">Flag</Button>);
    expect(screen.getByRole("button", { name: "Flag" }).className).toContain("bg-signal-500");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @corridor/ui test -- button`
Expected: FAIL — current classes are `bg-ink-950`/`border-ink-100`, not `bg-accent`/`border-border-default`.

- [ ] **Step 3: Reskin `button.tsx`**

Replace the `buttonVariants` definition:

```tsx
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:bg-accent-hover",
        secondary: "border border-border-default bg-surface-raised text-fg-primary hover:bg-surface-sunken",
        signal: "bg-signal-500 text-ink-950 hover:bg-signal-600",
        danger: "bg-danger-500 text-white hover:bg-danger-500/90",
        ghost: "text-fg-secondary hover:text-fg-primary",
        link: "text-fg-secondary underline-offset-2 hover:text-fg-primary hover:underline",
      },
      size: {
        md: "px-4 py-2 text-sm",
        sm: "px-3 py-1 text-xs",
        xs: "px-2 py-1 text-xs",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);
```

(`ButtonProps` and the `Button` function are unchanged.)

- [ ] **Step 4: Reskin `badge.tsx`**

Replace the `badgeVariants` definition:

```tsx
export const badgeVariants = cva(
  "inline-flex items-center rounded px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        neutral: "bg-surface-sunken text-fg-secondary",
        muted: "bg-surface-sunken text-fg-secondary/70",
        ok: "bg-ok-500/10 text-ok-500",
        warn: "bg-warn-500/10 text-warn-500",
        danger: "bg-danger-500/10 text-danger-500",
        signal: "bg-signal-500/15 text-signal-600",
        solid: "bg-fg-primary text-fg-inverted",
        outline: "border border-border-default text-fg-primary",
      },
      /** Small-caps treatment used by status/severity chips. */
      caps: { true: "font-semibold uppercase tracking-wide", false: "" },
    },
    defaultVariants: { variant: "neutral", caps: false },
  },
);
```

- [ ] **Step 5: Reskin `alert.tsx`**

Replace the `alertVariants` definition:

```tsx
export const alertVariants = cva("rounded-md border px-4 py-3 text-sm", {
  variants: {
    variant: {
      info: "border-border-default bg-surface-sunken text-fg-primary",
      ok: "border-ok-500/30 bg-ok-500/10 text-ok-500",
      warn: "border-warn-500/30 bg-warn-500/10 text-warn-500",
      danger: "border-danger-500/30 bg-danger-500/10 text-danger-500",
    },
  },
  defaultVariants: { variant: "info" },
});
```

- [ ] **Step 6: Reskin `skeleton.tsx`, `label.tsx`, `table.tsx`**

`skeleton.tsx`:

```tsx
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("animate-pulse rounded-md bg-surface-sunken", className)} {...props} />;
}
```

`label.tsx` — in the `LabelRoot` className, replace `text-ink-500` with `text-fg-secondary`:

```tsx
      className={cn(
        "mb-1 block text-xs font-medium uppercase tracking-wide text-fg-secondary",
        className,
      )}
```

`table.tsx` — full file:

```tsx
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export function Table({ className, ...props }: ComponentProps<"table">) {
  return <table className={cn("w-full text-sm", className)} {...props} />;
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return (
    <thead
      className={cn(
        "bg-surface-sunken text-left text-xs uppercase tracking-wide text-fg-secondary",
        className,
      )}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("divide-y divide-border-default", className)} {...props} />;
}

export function TableFooter({ className, ...props }: ComponentProps<"tfoot">) {
  return <tfoot className={cn("border-t border-border-default", className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={className} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return <th className={cn("px-4 py-2 font-medium", className)} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-4 py-2", className)} {...props} />;
}

export function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return <caption className={cn("px-4 py-2 text-xs text-fg-secondary", className)} {...props} />;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @corridor/ui test`
Expected: PASS, including the new `button.test.tsx` and the existing `data-table.test.tsx` (which renders `Table`/`TableHead`/etc. and only asserts on text content and roles, so it is unaffected by the class changes).

- [ ] **Step 8: Verify build**

Run: `pnpm --filter @corridor/ui typecheck && pnpm --filter @corridor/ui lint`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/ui/src/components/button.tsx packages/ui/src/components/button.test.tsx packages/ui/src/components/badge.tsx packages/ui/src/components/alert.tsx packages/ui/src/components/skeleton.tsx packages/ui/src/components/label.tsx packages/ui/src/components/table.tsx
git commit -m "feat(ui): reskin button, badge, alert, skeleton, label, table onto semantic tokens"
```

---

### Task 4: Reskin `card.tsx`, `tabs.tsx`, `data-table.tsx`

**Files:**
- Modify: `packages/ui/src/components/card.tsx` (full file)
- Modify: `packages/ui/src/components/tabs.tsx` (full file)
- Modify: `packages/ui/src/components/data-table.tsx:175-232` (sort button + loading/empty text + pagination footer)

**Interfaces:**
- Consumes: semantic tokens from Task 1, `Button` from Task 3 (unchanged import, `DataTable`'s pagination controls already use it).
- Produces: no API changes.

- [ ] **Step 1: Reskin `card.tsx`**

```tsx
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Matches the app's legacy `.panel` chrome: raised surface, hairline border, soft shadow. */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-xl border border-border-default bg-surface-raised shadow-sm", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("border-b border-border-default px-4 py-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("text-sm font-semibold text-fg-primary", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-xs text-fg-secondary", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-4 py-3", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center gap-2 border-t border-border-default px-4 py-3", className)}
      {...props}
    />
  );
}
```

- [ ] **Step 2: Reskin `tabs.tsx`**

```tsx
"use client";

import type { ComponentProps } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../lib/cn";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn("inline-flex gap-1 rounded-md bg-surface-sunken p-0.5", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "rounded px-3 py-1 text-sm text-fg-secondary transition-colors hover:text-fg-primary",
        "data-[state=active]:bg-surface-raised data-[state=active]:font-medium data-[state=active]:text-fg-primary data-[state=active]:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("mt-4 focus:outline-none", className)} {...props} />;
}
```

- [ ] **Step 3: Reskin the sort button, status text, and pagination footer in `data-table.tsx`**

Replace this block (the sort-toggle button inside `TableHead`):

```tsx
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-ink-950"
                      >
```

with:

```tsx
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-fg-primary"
                      >
```

Replace both loading/empty message cells' `text-ink-500` with `text-fg-secondary`:

```tsx
              <TableCell className="py-6 text-fg-secondary" colSpan={columnCount}>
                {loadingMessage}
              </TableCell>
```

```tsx
              <TableCell className="py-6 text-fg-secondary" colSpan={columnCount}>
                {emptyMessage}
              </TableCell>
```

Replace the pagination footer:

```tsx
        <div className="flex items-center justify-between gap-3 border-t border-ink-100 px-4 py-3 text-xs text-ink-500">
```

with:

```tsx
        <div className="flex items-center justify-between gap-3 border-t border-border-default px-4 py-3 text-xs text-fg-secondary">
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @corridor/ui test`
Expected: PASS — `data-table.test.tsx` asserts on roles/text only, unaffected by class renames.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @corridor/ui typecheck && pnpm --filter @corridor/ui lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/card.tsx packages/ui/src/components/tabs.tsx packages/ui/src/components/data-table.tsx
git commit -m "feat(ui): reskin card, tabs, data-table onto semantic tokens"
```

---

### Task 5: Reskin form chrome — `input.tsx`, `textarea.tsx`, `select.tsx`, `dialog.tsx`

**Files:**
- Modify: `packages/ui/src/components/input.tsx:5-7`
- Modify: `packages/ui/src/components/select.tsx` (full file)
- Modify: `packages/ui/src/components/dialog.tsx` (full file)

**Interfaces:**
- Consumes: semantic tokens from Task 1. `select.tsx` and `textarea.tsx` both import `fieldClassName` from `input.tsx`, so updating it there is sufficient for both.
- Produces: no API changes.

- [ ] **Step 1: Reskin `fieldClassName` in `input.tsx`**

```tsx
export const fieldClassName =
  "w-full rounded-md border border-border-default bg-surface-raised px-3 py-2 text-sm text-fg-primary " +
  "placeholder:text-fg-secondary/60 focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus-ring/15";
```

- [ ] **Step 2: Reskin `select.tsx`**

```tsx
"use client";

import type { ComponentProps } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../lib/cn";
import { fieldClassName } from "./input";

/**
 * Native `<select>` with the shared field chrome. Preferred inside forms that
 * are read back with `FormData` (uncontrolled server-style forms); use the
 * Radix `Select` below when the trigger needs custom content or portalling.
 */
export type NativeSelectProps = ComponentProps<"select">;

export function NativeSelect({ className, ...props }: NativeSelectProps) {
  return <select className={cn(fieldClassName, className)} {...props} />;
}

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(fieldClassName, "flex items-center justify-between gap-2 text-left", className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 text-fg-secondary" aria-hidden />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        className={cn(
          "z-50 max-h-72 min-w-[8rem] overflow-hidden rounded-md border border-border-default bg-surface-overlay text-sm shadow-md",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex justify-center py-1 text-fg-secondary">
          <ChevronUp className="size-4" aria-hidden />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex justify-center py-1 text-fg-secondary">
          <ChevronDown className="size-4" aria-hidden />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn("px-2 py-1.5 text-xs uppercase tracking-wide text-fg-secondary", className)}
      {...props}
    />
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex cursor-default select-none items-center rounded px-2 py-1.5 pr-7 outline-none",
        "data-[highlighted]:bg-surface-sunken data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2">
        <Check className="size-4 text-accent" aria-hidden />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator({
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator className={cn("my-1 h-px bg-border-default", className)} {...props} />
  );
}
```

- [ ] **Step 3: Reskin `dialog.tsx`**

```tsx
"use client";

import type { ComponentProps } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../lib/cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export function DialogOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn("fixed inset-0 z-40 bg-ink-950/50", className)}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2",
          "rounded-xl border border-border-default bg-surface-overlay p-6 shadow-lg focus:outline-none",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="Close"
          className="absolute right-4 top-4 text-fg-secondary transition-colors hover:text-fg-primary"
        >
          <X className="size-4" aria-hidden />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mb-4 space-y-1", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-6 flex items-center justify-end gap-2", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-lg font-semibold", className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cn("text-sm text-fg-secondary", className)} {...props} />
  );
}
```

Note: `DialogOverlay` deliberately keeps the raw `ink-950` primitive (not a semantic token) — a modal scrim is conventionally dark regardless of light/dark theme, so it should not flip to a light color in dark mode.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @corridor/ui typecheck && pnpm --filter @corridor/ui lint && pnpm --filter @corridor/ui test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/input.tsx packages/ui/src/components/select.tsx packages/ui/src/components/dialog.tsx
git commit -m "feat(ui): reskin input, select, dialog form chrome onto semantic tokens"
```

---

### Task 6: New primitives — `Checkbox`, `RadioGroup`, `Switch`

**Files:**
- Create: `packages/ui/src/components/checkbox.tsx`
- Create: `packages/ui/src/components/checkbox.test.tsx`
- Create: `packages/ui/src/components/radio-group.tsx`
- Create: `packages/ui/src/components/radio-group.test.tsx`
- Create: `packages/ui/src/components/switch.tsx`
- Create: `packages/ui/src/components/switch.test.tsx`
- Modify: `packages/ui/vitest.setup.ts:1-5` (pointer-capture polyfills, needed by jsdom for Radix's pointer-driven components)
- Modify: `packages/ui/src/index.ts` (add exports)

**Interfaces:**
- Consumes: semantic tokens from Task 1 (`border-border-strong`, `bg-surface-raised`, `bg-accent`, `text-accent-fg`, `ring-focus-ring`).
- Produces: `Checkbox`, `RadioGroup` + `RadioGroupItem`, `Switch`; the `vitest.setup.ts` pointer-capture polyfill that Task 7 and Task 8's tests also rely on.

- [ ] **Step 1: Add the pointer-capture polyfill jsdom is missing**

Append to `packages/ui/vitest.setup.ts`:

```ts
// jsdom doesn't implement the Pointer Events capture API that Radix's
// interactive primitives (Checkbox, RadioGroup, Switch, Collapsible, Select…)
// rely on for click handling. Stub it so userEvent.click works in tests.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
```

- [ ] **Step 2: Add the Radix dependencies**

Run: `pnpm --filter @corridor/ui add @radix-ui/react-checkbox @radix-ui/react-radio-group @radix-ui/react-switch`
Expected: `packages/ui/package.json` and the lockfile gain the three packages.

- [ ] **Step 3: Write the failing tests**

```tsx
// packages/ui/src/components/checkbox.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Checkbox } from "./checkbox";

describe("Checkbox", () => {
  it("toggles checked state on click", async () => {
    const user = userEvent.setup();
    render(<Checkbox aria-label="Accept terms" />);
    const box = screen.getByRole("checkbox", { name: "Accept terms" });
    expect(box).toHaveAttribute("data-state", "unchecked");

    await user.click(box);
    expect(box).toHaveAttribute("data-state", "checked");
  });

  it("does not toggle when disabled", async () => {
    const user = userEvent.setup();
    render(<Checkbox aria-label="Locked" disabled />);
    const box = screen.getByRole("checkbox", { name: "Locked" });

    await user.click(box);
    expect(box).toHaveAttribute("data-state", "unchecked");
  });
});
```

```tsx
// packages/ui/src/components/radio-group.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RadioGroup, RadioGroupItem } from "./radio-group";

describe("RadioGroup", () => {
  it("selects one item at a time", async () => {
    const user = userEvent.setup();
    render(
      <RadioGroup defaultValue="a" aria-label="Plan">
        <RadioGroupItem value="a" aria-label="Basic" />
        <RadioGroupItem value="b" aria-label="Pro" />
      </RadioGroup>,
    );

    expect(screen.getByRole("radio", { name: "Basic" })).toHaveAttribute("data-state", "checked");
    await user.click(screen.getByRole("radio", { name: "Pro" }));
    expect(screen.getByRole("radio", { name: "Pro" })).toHaveAttribute("data-state", "checked");
    expect(screen.getByRole("radio", { name: "Basic" })).toHaveAttribute("data-state", "unchecked");
  });
});
```

```tsx
// packages/ui/src/components/switch.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Switch } from "./switch";

describe("Switch", () => {
  it("toggles on click", async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="Enable notifications" />);
    const toggle = screen.getByRole("switch", { name: "Enable notifications" });
    expect(toggle).toHaveAttribute("data-state", "unchecked");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("data-state", "checked");
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @corridor/ui test -- checkbox radio-group switch`
Expected: FAIL — none of the three component files exist yet.

- [ ] **Step 5: Implement `checkbox.tsx`**

```tsx
"use client";

import type { ComponentProps } from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "../lib/cn";

export type CheckboxProps = ComponentProps<typeof CheckboxPrimitive.Root>;

export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded border border-border-strong bg-surface-raised transition-colors",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="text-accent-fg">
        <Check className="size-3" aria-hidden />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
```

- [ ] **Step 6: Implement `radio-group.tsx`**

```tsx
"use client";

import type { ComponentProps } from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "../lib/cn";

export const RadioGroup = RadioGroupPrimitive.Root;

export function RadioGroupItem({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-raised transition-colors",
        "data-[state=checked]:border-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-accent" />
    </RadioGroupPrimitive.Item>
  );
}
```

- [ ] **Step 7: Implement `switch.tsx`**

```tsx
"use client";

import type { ComponentProps } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../lib/cn";

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-border-strong transition-colors",
        "data-[state=checked]:bg-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="size-4 translate-x-0.5 rounded-full bg-surface-raised transition-transform data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  );
}
```

- [ ] **Step 8: Export the three primitives**

In `packages/ui/src/index.ts`, add:

```ts
export { Checkbox } from "./components/checkbox";
export type { CheckboxProps } from "./components/checkbox";
export { RadioGroup, RadioGroupItem } from "./components/radio-group";
export { Switch } from "./components/switch";
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm --filter @corridor/ui test`
Expected: PASS

- [ ] **Step 10: Verify**

Run: `pnpm --filter @corridor/ui typecheck && pnpm --filter @corridor/ui lint`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add packages/ui/package.json pnpm-lock.yaml packages/ui/vitest.setup.ts packages/ui/src/components/checkbox.tsx packages/ui/src/components/checkbox.test.tsx packages/ui/src/components/radio-group.tsx packages/ui/src/components/radio-group.test.tsx packages/ui/src/components/switch.tsx packages/ui/src/components/switch.test.tsx packages/ui/src/index.ts
git commit -m "feat(ui): add Checkbox, RadioGroup, and Switch primitives"
```

---

### Task 7: New primitive — `Tooltip` + provider wiring

**Files:**
- Create: `packages/ui/src/components/tooltip.tsx`
- Create: `packages/ui/src/components/tooltip.test.tsx`
- Modify: `packages/ui/src/index.ts` (add exports)
- Modify: `apps/web/src/app/layout.tsx` (wrap `children` in `TooltipProvider`)

**Interfaces:**
- Consumes: semantic tokens from Task 1 (`bg-fg-primary`, `text-surface-raised`), pointer-capture polyfill from Task 6.
- Produces: `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider` — any component built after this task may use them without further setup, since the provider is now global.

- [ ] **Step 1: Add the Radix dependency**

Run: `pnpm --filter @corridor/ui add @radix-ui/react-tooltip`

- [ ] **Step 2: Write the failing test**

```tsx
// packages/ui/src/components/tooltip.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

describe("Tooltip", () => {
  it("shows its content when the trigger is hovered", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger>Info</TooltipTrigger>
          <TooltipContent>Extra detail</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(screen.queryByText("Extra detail")).not.toBeInTheDocument();
    await user.hover(screen.getByText("Info"));
    expect(await screen.findByText("Extra detail")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @corridor/ui test -- tooltip`
Expected: FAIL — `./tooltip` does not exist.

- [ ] **Step 4: Implement `tooltip.tsx`**

```tsx
"use client";

import type { ComponentProps } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../lib/cn";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded-md bg-fg-primary px-2.5 py-1.5 text-xs font-medium text-surface-raised shadow-md",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
```

- [ ] **Step 5: Export it**

In `packages/ui/src/index.ts`, add:

```ts
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/tooltip";
```

- [ ] **Step 6: Wrap the app in `TooltipProvider`**

In `apps/web/src/app/layout.tsx`, import `TooltipProvider` from `@corridor/ui` and wrap `children` — keep the `Plus_Jakarta_Sans` font setup from Task 2 exactly as is:

```tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Plus_Jakarta_Sans } from "next/font/google";
import { TooltipProvider } from "@corridor/ui";
import "./globals.css";

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans-loaded",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Corridor", template: "%s · Corridor" },
  description: "AI-native cross-border customs compliance for carriers.",
};

const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('corridor-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={plusJakartaSans.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @corridor/ui test -- tooltip`
Expected: PASS

- [ ] **Step 8: Verify**

Run: `pnpm --filter @corridor/ui typecheck && pnpm --filter @corridor/ui lint && pnpm --filter web typecheck && pnpm --filter web lint`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/ui/package.json pnpm-lock.yaml packages/ui/src/components/tooltip.tsx packages/ui/src/components/tooltip.test.tsx packages/ui/src/index.ts apps/web/src/app/layout.tsx
git commit -m "feat(ui): add Tooltip primitive and wire TooltipProvider into the root layout"
```

---

### Task 8: New primitives — `navItemVariants`, `NavItemContent`, `NavGroup`

**Files:**
- Create: `packages/ui/src/components/nav.tsx`
- Create: `packages/ui/src/components/nav.test.tsx`
- Modify: `packages/ui/src/index.ts` (add exports)

**Interfaces:**
- Consumes: semantic tokens from Task 1 (`bg-surface-sunken`, `text-fg-primary`, `text-fg-secondary`, `ring-focus-ring`), pointer-capture polyfill from Task 6.
- Produces: `navItemVariants(props: { active?: boolean }) => string` (a `cva` function, applied by the caller to whatever link element it renders — kept framework-agnostic so `packages/ui` doesn't depend on `next/link`), `NavItemContent({ icon, children })` (icon + label row), `NavGroup({ icon, label, active, open?, defaultOpen?, onOpenChange?, children })` (collapsible section header + content, built on `@radix-ui/react-collapsible`). Task 9 (`app-shell.tsx`) consumes all three.

- [ ] **Step 1: Add the Radix dependency**

Run: `pnpm --filter @corridor/ui add @radix-ui/react-collapsible`

- [ ] **Step 2: Write the failing tests**

```tsx
// packages/ui/src/components/nav.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LayoutDashboard } from "lucide-react";
import { NavGroup, navItemVariants } from "./nav";

describe("navItemVariants", () => {
  it("marks the active state distinctly from inactive", () => {
    // Both states legitimately reference `bg-surface-sunken` (inactive gets it
    // only on hover, at reduced opacity), so distinguish on `font-medium`
    // instead of the shared color name.
    expect(navItemVariants({ active: true })).toContain("font-medium");
    expect(navItemVariants({ active: false })).not.toContain("font-medium");
  });
});

describe("NavGroup", () => {
  it("is closed by default and opens on trigger click (uncontrolled)", async () => {
    const user = userEvent.setup();
    render(
      <NavGroup icon={LayoutDashboard} label="Parties">
        <span>Drivers</span>
      </NavGroup>,
    );

    expect(screen.queryByText("Drivers")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Parties/ }));
    expect(await screen.findByText("Drivers")).toBeInTheDocument();
  });

  it("respects a controlled `open` prop", () => {
    const onOpenChange = vi.fn();
    render(
      <NavGroup icon={LayoutDashboard} label="Settings" open onOpenChange={onOpenChange}>
        <span>Billing</span>
      </NavGroup>,
    );

    expect(screen.getByText("Billing")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @corridor/ui test -- nav`
Expected: FAIL — `./nav` does not exist.

- [ ] **Step 4: Implement `nav.tsx`**

```tsx
"use client";

import type { ComponentProps, ReactNode } from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * Styles only — deliberately not an anchor. Callers apply this to whatever
 * link element they render (e.g. `next/link`'s `Link`) so `@corridor/ui`
 * stays framework-agnostic.
 */
export const navItemVariants = cva(
  "flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40",
  {
    variants: {
      active: {
        true: "bg-surface-sunken font-medium text-fg-primary",
        false: "text-fg-secondary hover:bg-surface-sunken/60 hover:text-fg-primary",
      },
    },
    defaultVariants: { active: false },
  },
);

export type NavItemVariantProps = VariantProps<typeof navItemVariants>;

export function NavItemContent({
  icon: Icon,
  children,
  className,
}: {
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 flex-1 items-center gap-2.5", className)}>
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

export interface NavGroupProps extends ComponentProps<typeof CollapsiblePrimitive.Root> {
  icon: LucideIcon;
  label: ReactNode;
  /** Highlights the group header itself, e.g. when a child route is active. */
  active?: boolean;
}

export function NavGroup({
  icon: Icon,
  label,
  active,
  className,
  children,
  ...props
}: NavGroupProps) {
  return (
    <CollapsiblePrimitive.Root className={cn("space-y-0.5", className)} {...props}>
      <CollapsiblePrimitive.Trigger className={cn(navItemVariants({ active }), "group w-full")}>
        <NavItemContent icon={Icon}>{label}</NavItemContent>
        <ChevronRight
          className="size-3.5 shrink-0 text-fg-secondary transition-transform group-data-[state=open]:rotate-90"
          aria-hidden
        />
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className="space-y-0.5 overflow-hidden pl-6">
        {children}
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}
```

- [ ] **Step 5: Export the new primitives**

In `packages/ui/src/index.ts`, add:

```ts
export { NavGroup, NavItemContent, navItemVariants } from "./components/nav";
export type { NavGroupProps, NavItemVariantProps } from "./components/nav";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @corridor/ui test -- nav`
Expected: PASS

- [ ] **Step 7: Verify**

Run: `pnpm --filter @corridor/ui typecheck && pnpm --filter @corridor/ui lint`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/ui/package.json pnpm-lock.yaml packages/ui/src/components/nav.tsx packages/ui/src/components/nav.test.tsx packages/ui/src/index.ts
git commit -m "feat(ui): add navItemVariants, NavItemContent, NavGroup primitives"
```

---

### Task 9: Consolidate `app-shell.tsx` navigation

**Files:**
- Modify: `apps/web/src/components/app-shell.tsx` (full file rewrite)

**Interfaces:**
- Consumes: `NavGroup`, `NavItemContent`, `navItemVariants` (Task 8), `ThemeToggle` (Task 2), all from `@corridor/ui`; `lucide-react` icons (already a `packages/ui` dependency and transitively available to `apps/web`).
- Produces: no exported interface change — `AppShell`'s props are unchanged, only its internal nav rendering.

- [ ] **Step 1: Replace `apps/web/src/components/app-shell.tsx`**

```tsx
"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  Bell,
  Building2,
  CreditCard,
  FileText,
  Handshake,
  LayoutDashboard,
  Package,
  Plug,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Truck,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { PermissionKey } from "@corridor/domain";
import type { SessionUser } from "@corridor/auth";
import { NavGroup, NavItemContent, ThemeToggle, navItemVariants } from "@corridor/ui";
import { NotificationBell } from "./notifications/notification-bell";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  permission?: PermissionKey;
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/movements", label: "Movements", icon: ArrowLeftRight, permission: "movement.read" },
  { href: "/documents", label: "Documents", icon: FileText, permission: "document.read" },
];

const PARTIES: NavItem[] = [
  { href: "/parties/drivers", label: "Drivers", icon: UserRound, permission: "driver.read" },
  { href: "/parties/trucks", label: "Trucks", icon: Truck, permission: "truck.read" },
  { href: "/parties/trailers", label: "Trailers", icon: Package, permission: "trailer.read" },
  { href: "/parties/partners", label: "Partners", icon: Handshake, permission: "partner.read" },
];

const REST: NavItem[] = [
  { href: "/alerts", label: "Alerts", icon: AlertTriangle, permission: "alert.read" },
  { href: "/reports", label: "Reports", icon: BarChart3, permission: "report.read" },
  { href: "/copilot", label: "Copilot", icon: Sparkles, permission: "copilot.use" },
];

const SETTINGS: NavItem[] = [
  { href: "/settings/organization", label: "Organization", icon: Building2, permission: "organization.read" },
  { href: "/settings/users", label: "Users", icon: Users, permission: "organization.members.read" },
  { href: "/settings/roles", label: "Roles", icon: ShieldCheck, permission: "organization.roles.manage" },
  { href: "/settings/audit", label: "Audit log", icon: ScrollText, permission: "audit_log.read" },
  { href: "/settings/billing", label: "Billing", icon: CreditCard, permission: "billing.read" },
  { href: "/settings/integrations", label: "Integrations", icon: Plug, permission: "integrations.manage" },
  { href: "/settings/notifications", label: "Notifications", icon: Bell },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  user,
  organizationName,
  roleName,
  permissions,
  children,
}: {
  user: SessionUser;
  organizationName: string;
  roleName: string;
  permissions: PermissionKey[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const can = (p?: PermissionKey) => !p || permissions.includes(p);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const partiesVisible = PARTIES.filter((i) => can(i.permission));
  const settingsVisible = SETTINGS.filter((i) => can(i.permission));
  const partiesActive = partiesVisible.some((i) => isActive(pathname, i.href));
  const settingsActive = settingsVisible.some((i) => isActive(pathname, i.href));

  /** Groups default open when they contain the active route, until manually toggled. */
  const isGroupOpen = (key: string, active: boolean) => openGroups[key] ?? active;
  const setGroupOpen = (key: string) => (open: boolean) =>
    setOpenGroups((prev) => ({ ...prev, [key]: open }));

  const renderItem = (item: NavItem) => (
    <Link key={item.href} href={item.href} className={navItemVariants({ active: isActive(pathname, item.href) })}>
      <NavItemContent icon={item.icon}>{item.label}</NavItemContent>
    </Link>
  );

  return (
    <div className="flex min-h-screen bg-surface-canvas">
      <aside className="flex w-64 shrink-0 flex-col gap-0.5 border-r border-border-default bg-surface-raised p-3">
        <div className="mb-4 px-3 pt-2">
          <div className="text-base font-semibold tracking-tight text-fg-primary">Corridor</div>
          <div className="mt-0.5 truncate text-xs text-fg-secondary">{organizationName}</div>
        </div>

        <nav className="space-y-0.5">
          {NAV.filter((i) => can(i.permission)).map(renderItem)}
          {partiesVisible.length > 0 && (
            <NavGroup
              icon={Users}
              label="Parties"
              active={partiesActive}
              open={isGroupOpen("parties", partiesActive)}
              onOpenChange={setGroupOpen("parties")}
            >
              {partiesVisible.map(renderItem)}
            </NavGroup>
          )}
          {REST.filter((i) => can(i.permission)).map(renderItem)}
        </nav>

        {settingsVisible.length > 0 && (
          <nav className="mt-2">
            <NavGroup
              icon={SettingsIcon}
              label="Settings"
              active={settingsActive}
              open={isGroupOpen("settings", settingsActive)}
              onOpenChange={setGroupOpen("settings")}
            >
              {settingsVisible.map(renderItem)}
            </NavGroup>
          </nav>
        )}

        <div className="mt-auto space-y-2 border-t border-border-default pt-3">
          <div className="flex items-center justify-between px-3">
            <div className="min-w-0">
              <div className="truncate text-sm text-fg-primary">{user.displayName ?? user.email}</div>
              <div className="truncate text-xs text-fg-secondary">{roleName}</div>
            </div>
            <ThemeToggle />
          </div>
          <form action="/auth/signout" method="post" className="px-3">
            <button type="submit" className="text-xs text-fg-secondary hover:text-fg-primary">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="flex justify-end border-b border-border-default bg-surface-raised px-6 py-2">
          <NotificationBell />
        </div>
        <div className="p-8">{children}</div>
      </main>
    </div>
  );
}
```

Note: if any `lucide-react` icon name above doesn't exist in the installed version, typecheck (next step) fails immediately with a clear "has no exported member" error — swap that one icon for the closest equivalent (e.g. `Package` → `Boxes`) and re-run.

- [ ] **Step 2: Verify**

Run: `pnpm --filter web typecheck && pnpm --filter web lint`
Expected: PASS. There is no existing test file for `app-shell.tsx` (it requires session/permission/router mocking the repo doesn't currently set up for this file) — correctness here is verified manually in Task 11.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/app-shell.tsx
git commit -m "feat(web): consolidate app-shell nav into grouped, icon-led sections"
```

---

### Task 10: Update `globals.css` legacy utilities to the new tokens

**Files:**
- Modify: `apps/web/src/app/globals.css` (full file)

**Interfaces:**
- Consumes: semantic tokens from Task 1.
- Produces: the `.panel`, `label`, `input`, `btn`, `btn-primary`, `btn-secondary`, `btn-signal` utility classes that ~44 files across `apps/web` already reference directly — updating their definitions here makes every one of those call sites theme-correct without editing the call sites themselves. Also produces the app-wide `prefers-reduced-motion` rule the `ui-ux-pro-max` pre-delivery checklist requires (see the spec's Motion & accessibility section).

- [ ] **Step 1: Replace `apps/web/src/app/globals.css`**

```css
@import "tailwindcss";
@import "@corridor/ui/tokens.css";

/* Tailwind 4 scans this app plus the shared component library for utilities. */
@source "../../../../packages/ui/src";

html,
body {
  height: 100%;
  background: var(--color-surface-canvas);
  color: var(--color-fg-primary);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}

.panel {
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-xl);
}

@utility label {
  @apply mb-1 block text-xs font-medium uppercase tracking-wide text-fg-secondary;
}

@utility input {
  @apply w-full rounded-md border border-border-default bg-surface-raised px-3 py-2 text-sm text-fg-primary
    placeholder:text-fg-secondary/60 focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus-ring/15;
}

@utility btn {
  @apply inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium
    transition-colors disabled:cursor-not-allowed disabled:opacity-50;
}
@utility btn-primary {
  @apply btn bg-accent text-accent-fg hover:bg-accent-hover;
}
@utility btn-secondary {
  @apply btn border border-border-default bg-surface-raised text-fg-primary hover:bg-surface-sunken;
}
@utility btn-signal {
  @apply btn bg-signal-500 text-ink-950 hover:bg-signal-600;
}

/* ui-ux-pro-max pre-delivery checklist: respect reduced-motion system-wide. */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

(The old hardcoded `:root { --bg / --fg / --muted / --panel / --border }` block is removed — `html, body` and `.panel` now reference the semantic tokens from `packages/ui` directly, which is the single source of truth `color-scheme`/dark-mode already flips via Task 1's `[data-theme="dark"]` rule.)

- [ ] **Step 2: Verify**

Run: `pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web build`
Expected: PASS. The build step in particular confirms Tailwind still resolves every `@utility` and that no page references a CSS custom property that no longer exists.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/globals.css
git commit -m "feat(web): point legacy globals.css utilities at the new semantic tokens"
```

---

### Task 11: Final verification pass

**Files:** none (verification only)

**Interfaces:** none — this task confirms every earlier task's deliverable still holds together.

- [ ] **Step 1: Full automated verification**

Run: `pnpm --filter @corridor/ui typecheck && pnpm --filter @corridor/ui lint && pnpm --filter @corridor/ui test && pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web build`
Expected: PASS end to end. (`packages/ui` has no `build` script — it's consumed as TS source directly; `pnpm --filter web build` is the real end-to-end compile check.)

- [ ] **Step 2: Manual browser verification**

Run: `pnpm dev` (from the repo root), then in a browser:

1. Visit `/dashboard`. Confirm the sidebar shows 8 top-level items (no more flat 17-link list), with icons.
2. Click "Parties" — confirm it expands to show Drivers/Trucks/Trailers/Partners; click again to confirm it collapses.
3. Navigate to `/parties/drivers` directly (address bar) — confirm the "Parties" group is open and "Drivers" is highlighted as active on load.
4. Click "Settings" — confirm the same expand/collapse behavior, and that navigating to `/settings/billing` auto-opens it.
5. Click the theme toggle (bottom of the sidebar) — confirm the whole app (sidebar, canvas, cards, tables, dialogs) flips to dark colors immediately, with no flash of the old theme on reload.
6. Open a dialog (e.g. a "New movement" or similar action) and a `Select` dropdown in both themes — confirm both are legible and themed correctly.
7. Tab through the sidebar with the keyboard — confirm every item and the theme toggle show a visible focus ring.

Expected: all seven checks pass in both light and dark theme. If anything looks wrong, fix it in the relevant task's files before proceeding — do not patch around it with new one-off classes elsewhere.

- [ ] **Step 3: Final commit (if Step 2 required fixes)**

```bash
git add -A
git commit -m "fix(ui): address manual verification findings from the foundation redesign"
```

(Skip this step if Step 2 required no changes.)
