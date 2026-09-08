import type { Metadata } from "next";
import Link from "next/link";
import { HelpShell } from "./help-shell";
import { listManualPages } from "./manual";

export const metadata: Metadata = { title: "Help" };

export default async function HelpPage() {
  const pages = await listManualPages();
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Help</h1>
        <p className="text-sm text-ink-500">The manual, page by page, and how to reach support.</p>
      </header>
      <HelpShell pages={pages}>
        <ol className="panel divide-y divide-ink-100" aria-label="Manual contents">
          {pages.map((p, i) => (
            <li key={p.slug}>
              <Link href={`/help/${p.slug}`} className="flex items-baseline gap-3 px-4 py-3 hover:bg-ink-50">
                <span className="w-6 font-mono text-xs text-ink-500">{i + 1}</span>
                <span className="font-medium">{p.title}</span>
              </Link>
            </li>
          ))}
          {pages.length === 0 && <li className="px-4 py-3 text-sm text-ink-500">The manual is not installed.</li>}
        </ol>
      </HelpShell>
    </div>
  );
}
