import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { marked } from "marked";
import { legal } from "@/lib/legal";
import { isLegalSlug, legalPage } from "../registry";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return { title: isLegalSlug(slug) ? legalPage(slug).title : "Legal" };
}

export default async function LegalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isLegalSlug(slug)) notFound();
  const { title, markdown } = legalPage(slug);
  const html = await marked.parse(markdown, { async: true });
  return (
    <>
      {legal.reviewedAt && (
        <p className="mb-4 text-xs text-fg-secondary">Last updated {legal.reviewedAt}</p>
      )}
      {/* Our own Markdown from ./content, rendered by marked; no user input reaches it. */}
      <div aria-label={title} dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}
