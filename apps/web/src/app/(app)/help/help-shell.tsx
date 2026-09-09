import Link from "next/link";
import type { ReactNode } from "react";
import type { ManualPage } from "./manual";

const support = {
  email: process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
  phone: process.env.NEXT_PUBLIC_SUPPORT_PHONE,
  url: process.env.NEXT_PUBLIC_SUPPORT_URL,
};

export function HelpShell({
  pages,
  current,
  children,
}: {
  pages: ManualPage[];
  current?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
      <aside className="space-y-4">
        <nav aria-label="Manual">
          <h2 className="text-xs font-medium uppercase tracking-wide text-fg-secondary">
            User manual
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {pages.map((p) => (
              <li key={p.slug}>
                <Link
                  href={`/help/${p.slug}`}
                  className={`block rounded px-2 py-1 hover:bg-surface-sunken ${p.slug === current ? "bg-surface-sunken font-medium" : ""}`}
                >
                  {p.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <section className="panel p-4 text-sm" aria-label="Support">
          <h2 className="font-medium">Support</h2>
          <ul className="mt-2 space-y-1 text-fg-primary">
            {support.email && (
              <li>
                <a href={`mailto:${support.email}`} className="underline-offset-2 hover:underline">
                  {support.email}
                </a>
              </li>
            )}
            {support.phone && (
              <li>
                <a
                  href={`tel:${support.phone.replace(/[^\d+]/g, "")}`}
                  className="underline-offset-2 hover:underline"
                >
                  {support.phone}
                </a>
              </li>
            )}
            {support.url && (
              <li>
                <a
                  href={support.url}
                  target="_blank"
                  rel="noopener"
                  className="underline-offset-2 hover:underline"
                >
                  Support portal
                </a>
              </li>
            )}
            {!support.email && !support.phone && !support.url && (
              <li className="text-fg-secondary">Ask your administrator for support contacts.</li>
            )}
          </ul>
        </section>
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
