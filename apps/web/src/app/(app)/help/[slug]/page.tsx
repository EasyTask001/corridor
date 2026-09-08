import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HelpShell } from "../help-shell";
import { listManualPages, renderManualPage } from "../manual";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const page = await renderManualPage((await params).slug);
  return { title: page ? `${page.title} · Help` : "Help" };
}

export default async function HelpArticle({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [pages, page] = await Promise.all([listManualPages(), renderManualPage(slug)]);
  if (!page) notFound();
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Help</h1>
      </header>
      <HelpShell pages={pages} current={slug}>
        <article
          className="panel manual p-6"
          aria-label={page.title}
          // The manual is our own Markdown from the repository, rendered by marked; no user input reaches it.
          dangerouslySetInnerHTML={{ __html: page.html }}
        />
      </HelpShell>
    </div>
  );
}
