import type { ReactNode } from "react";
import Link from "next/link";
import { Route } from "lucide-react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-surface-canvas lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-ink-950 p-12 text-white lg:flex lg:flex-col lg:justify-between xl:p-16">
        <div
          className="absolute -right-32 top-1/3 size-80 rounded-full bg-brand-600/15 blur-3xl"
          aria-hidden
        />
        <Link
          href="/"
          className="relative flex items-center gap-3 text-lg font-semibold tracking-tight"
        >
          <span className="flex size-10 items-center justify-center rounded-xl bg-brand-600 text-white shadow-lg">
            <Route className="size-5" aria-hidden />
          </span>
          Corridor
        </Link>
        <div className="relative max-w-lg space-y-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-signal-400">
            Cross-border operations
          </p>
          <p className="text-4xl font-semibold leading-[1.15] tracking-tight xl:text-5xl">
            One manifest workflow for both sides of the border.
          </p>
          <p className="max-w-md text-base leading-relaxed text-ink-300">
            ACE and ACI in a single movement builder, AI-extracted BOLs, and compliance alerts
            before the truck reaches the booth.
          </p>
        </div>
        <p className="relative text-xs text-ink-400">Built for cross-border carriers.</p>
      </aside>
      <main className="flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-md">
          <Link
            href="/"
            className="mb-6 flex items-center gap-2 text-sm font-semibold text-fg-primary lg:hidden"
          >
            <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg">
              <Route className="size-4" aria-hidden />
            </span>
            Corridor
          </Link>
          <div className="panel p-6 sm:p-8">{children}</div>
        </div>
      </main>
    </div>
  );
}
