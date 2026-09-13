import type { ReactNode } from "react";
import Link from "next/link";
import { Route } from "lucide-react";
import { Alert } from "@corridor/ui";
import { legal } from "@/lib/legal";
import { LEGAL_SLUGS, legalPage } from "./registry";

/**
 * Public, outside the app shell — see PUBLIC_PATHS in proxy.ts. Every /legal/*
 * page shares this shell so the counsel-review banner and cross-page nav stay
 * in one place instead of four copies.
 */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-4 py-10 sm:px-6">
      <Link
        href="/"
        className="mb-8 inline-flex items-center gap-2 text-sm font-semibold text-fg-primary"
      >
        <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg shadow-sm">
          <Route className="size-4" aria-hidden />
        </span>
        Corridor
      </Link>
      <nav className="mb-8 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {LEGAL_SLUGS.map((slug) => (
          <Link
            key={slug}
            href={`/legal/${slug}`}
            className="text-fg-secondary hover:text-fg-primary hover:underline"
          >
            {legalPage(slug).title}
          </Link>
        ))}
      </nav>
      {!legal.reviewedAt && (
        <Alert variant="warn" className="mb-6">
          Draft for counsel review — this page has not yet been finalized by legal counsel.
        </Alert>
      )}
      <article className="panel manual p-6">{children}</article>
    </div>
  );
}
