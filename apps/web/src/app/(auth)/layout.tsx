import type { ReactNode } from "react";
import Link from "next/link";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <aside className="hidden bg-ink-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Corridor
        </Link>
        <div className="max-w-md space-y-4">
          <p className="text-3xl font-semibold leading-tight">
            One manifest workflow for both sides of the border.
          </p>
          <p className="text-ink-300">
            ACE and ACI in a single movement builder, AI-extracted BOLs, and compliance alerts
            before the truck reaches the booth.
          </p>
        </div>
        <p className="text-xs text-ink-500">Built for cross-border carriers.</p>
      </aside>
      <main className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
