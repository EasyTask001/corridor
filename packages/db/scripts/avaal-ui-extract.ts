import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentycClient } from "../src/avaal-import/agentyc-client";
import { AVAAL_EXTRACTION_ORDER, AVAAL_PAGE_CONFIGS } from "../src/avaal-import/avaal-pages";
import {
  AVAAL_CATEGORIES,
  snapshotCounts,
  validateSnapshot,
  type AvaalCategory,
  type AvaalCategorySnapshot,
  type AvaalSnapshot,
} from "../src/avaal-import/snapshot";
import { traverseCategory } from "../src/avaal-import/ui-traversal";

interface ExtractOptions {
  cdpUrl: string;
  output: string;
  username: string;
}

const usage =
  "Usage: pnpm --filter @corridor/db avaal:extract -- --cdp-url <ws-url> --output <.local/avaal-import/directory> [--username pftrans]";

const argument = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const optionsFrom = (args: string[]): ExtractOptions => {
  const cdpUrl = argument(args, "--cdp-url");
  const output = argument(args, "--output");
  const username = argument(args, "--username") ?? "pftrans";
  if (!cdpUrl || !output || !username.trim()) throw new Error(usage);
  const parsedCdpUrl = new URL(cdpUrl);
  if (!["ws:", "wss:"].includes(parsedCdpUrl.protocol)) {
    throw new Error("--cdp-url must be a WebSocket URL");
  }
  return { cdpUrl, output, username };
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const privateRoot = resolve(repoRoot, ".local/avaal-import");

const privateOutputPath = (value: string): string => {
  const output = isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
  const relation = relative(privateRoot, output);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`Output must be inside ${privateRoot}`);
  }
  return output;
};

const safeFilePart = (value: string): string => value.replace(/[^a-z0-9_-]+/gi, "-");

const writePrivateJson = async (path: string, value: unknown): Promise<void> => {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
};

const readCheckpoint = async (
  output: string,
  category: AvaalCategory,
  metadata: Pick<AvaalSnapshot, "source" | "username" | "extractedAt">,
): Promise<AvaalCategorySnapshot | undefined> => {
  const path = resolve(output, `category-${safeFilePart(category)}.json`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const snapshot = validateSnapshot({ ...metadata, categories: { [category]: value } });
  return snapshot.categories[category];
};

const assertComplete = (snapshot: AvaalSnapshot): void => {
  const missing = AVAAL_CATEGORIES.filter((category) => !(category in snapshot.categories));
  if (missing.length > 0) throw new Error(`Snapshot is missing categories: ${missing.join(", ")}`);
};

const manifestFor = (snapshot: AvaalSnapshot, complete: boolean) => ({
  source: snapshot.source,
  username: snapshot.username,
  extractedAt: snapshot.extractedAt,
  complete,
  categories: Object.fromEntries(
    AVAAL_CATEGORIES.map((category) => {
      const value = snapshot.categories[category];
      if (!value) return [category, { status: "pending", count: 0 }];
      if ("notApplicable" in value) {
        return [category, { status: "not-applicable", count: 0, reason: value.reason }];
      }
      return [
        category,
        {
          status: "complete",
          count: value.records.length,
          displayedTotal: value.displayedTotal,
          pagesVisited: value.pagesVisited,
          warnings: value.warnings,
        },
      ];
    }),
  ),
  counts: snapshotCounts(snapshot),
});

const sanitizeFailure = (message: string): string =>
  message.replace(
    /(["']?[\w-]*(?:password|cookie|token|secret)[\w-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    "$1[REDACTED]",
  );

const main = async (): Promise<void> => {
  const options = optionsFrom(process.argv.slice(2));
  const output = privateOutputPath(options.output);
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);

  const metadata = {
    source: "avaal-ui" as const,
    username: options.username,
    extractedAt: new Date().toISOString(),
  };
  const categories: Partial<Record<AvaalCategory, AvaalCategorySnapshot>> = {};
  let client: Awaited<ReturnType<typeof createAgentycClient>> | undefined;

  try {
    client = await createAgentycClient({ cdpUrl: options.cdpUrl });
    for (const category of AVAAL_EXTRACTION_ORDER) {
      const resumed = await readCheckpoint(output, category, metadata);
      if (resumed) {
        categories[category] = resumed;
        console.log(`${category}: resumed completed checkpoint`);
        continue;
      }

      const config = AVAAL_PAGE_CONFIGS[category];
      const result: AvaalCategorySnapshot =
        "notApplicable" in config
          ? { notApplicable: true, reason: config.reason }
          : await traverseCategory(client, config);
      categories[category] = result;
      await writePrivateJson(resolve(output, `category-${safeFilePart(category)}.json`), result);

      const partial = validateSnapshot({ ...metadata, categories });
      await writePrivateJson(resolve(output, "manifest.json"), manifestFor(partial, false));
      const count = "notApplicable" in result ? 0 : result.records.length;
      console.log(`${category}: completed ${count} records`);
    }

    const snapshot = validateSnapshot({ ...metadata, categories });
    assertComplete(snapshot);
    await writePrivateJson(resolve(output, "snapshot.json"), snapshot);
    await writePrivateJson(resolve(output, "manifest.json"), manifestFor(snapshot, true));
    console.log(`Avaal UI extraction complete: ${AVAAL_CATEGORIES.length} categories accounted for`);
  } catch (error) {
    const message = sanitizeFailure(error instanceof Error ? error.message : String(error));
    await writePrivateJson(resolve(output, "failure.json"), {
      failedAt: new Date().toISOString(),
      message,
      completedCategories: Object.keys(categories),
    });
    throw new Error(message);
  } finally {
    await client?.close();
  }
};

void main();
