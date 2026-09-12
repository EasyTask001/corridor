import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";

/**
 * The user manual is Markdown checked into docs/user-manual; the pages are
 * read and rendered on the server so the help stays versioned with the code.
 */
const MANUAL_DIR = path.resolve(process.cwd(), "..", "..", "docs", "user-manual");

export interface ManualPage {
  slug: string;
  title: string;
}

const titleOf = (md: string, slug: string) =>
  md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug.replace(/^\d+-/, "").replace(/-/g, " ");

export async function listManualPages(): Promise<ManualPage[]> {
  let files: string[] = [];
  try {
    files = (await readdir(MANUAL_DIR)).filter((f) => f.endsWith(".md")).sort();
  } catch (e) {
    console.error("[help] manual directory unreadable", e);
    return [];
  }
  return Promise.all(
    files.map(async (f) => {
      const slug = f.replace(/\.md$/, "");
      const md = await readFile(path.join(MANUAL_DIR, f), "utf8");
      return { slug, title: titleOf(md, slug) };
    }),
  );
}

export async function renderManualPage(
  slug: string,
): Promise<{ title: string; html: string } | null> {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  try {
    const md = await readFile(path.join(MANUAL_DIR, `${slug}.md`), "utf8");
    return { title: titleOf(md, slug), html: await marked.parse(md, { async: true }) };
  } catch (e) {
    console.error(`[help] manual page ${slug} unreadable`, e);
    return null;
  }
}
