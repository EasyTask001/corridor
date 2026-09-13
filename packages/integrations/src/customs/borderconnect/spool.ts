import { randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ALGORITHM = "aes-256-gcm";
const VERSION = 1;

export interface BorderConnectSpoolBatch {
  id: string;
  messages: Record<string, unknown>[];
}

export interface BorderConnectSpool {
  write(messages: Record<string, unknown>[]): Promise<BorderConnectSpoolBatch | null>;
  read(): Promise<BorderConnectBatchFile[]>;
  remove(id: string): Promise<void>;
}

interface BorderConnectBatchFile extends BorderConnectSpoolBatch {
  path: string;
}

interface Envelope {
  version: typeof VERSION;
  nonce: string;
  tag: string;
  ciphertext: string;
}

function keyFrom(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  try {
    const decoded = Buffer.from(trimmed, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

function fileName(id: string) {
  return `${id}.json`;
}

/**
 * Encrypted local handoff for a pop-on-read provider queue. The file is
 * written before the database insert and removed only after the insert
 * commits. A persistent volume should be configured for production; a
 * process-local temp directory is intentionally not treated as durable.
 */
export function createBorderConnectSpool(opts: {
  directory?: string;
  key?: string;
} = {}): BorderConnectSpool | null {
  const directory = opts.directory ?? process.env.BORDERCONNECT_SPOOL_DIR;
  const key = keyFrom(opts.key ?? process.env.BORDERCONNECT_SPOOL_KEY);
  if (!directory || !key) return null;

  const seal = (messages: Record<string, unknown>[]): Envelope => {
    const nonce = randomUUID().replace(/-/g, "").slice(0, 24);
    const cipher = createCipheriv(ALGORITHM, key, Buffer.from(nonce, "hex"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(messages), "utf8"), cipher.final()]);
    return {
      version: VERSION,
      nonce,
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
  };

  const open = (envelope: Envelope): Record<string, unknown>[] => {
    if (envelope.version !== VERSION) throw new Error("unsupported BorderConnect spool version");
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.nonce, "hex"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(plaintext);
    if (!Array.isArray(parsed)) throw new Error("invalid BorderConnect spool batch");
    return parsed.filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && !Array.isArray(item),
    );
  };

  return {
    async write(messages) {
      if (messages.length === 0) return null;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const id = `${Date.now()}-${randomUUID()}`;
      const target = join(directory, fileName(id));
      const temporary = `${target}.tmp`;
      await writeFile(temporary, JSON.stringify(seal(messages)), { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
      await chmod(target, 0o600);
      return { id, messages };
    },
    async read() {
      let names: string[];
      try {
        names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const batches: BorderConnectBatchFile[] = [];
      for (const name of names) {
        const id = name.slice(0, -5);
        const path = join(directory, name);
        const envelope = JSON.parse(await readFile(path, "utf8")) as Envelope;
        batches.push({ id, path, messages: open(envelope) });
      }
      return batches;
    },
    async remove(id) {
      try {
        await rm(join(directory, fileName(id)), { force: true });
      } catch (error) {
        throw new Error(`could not remove BorderConnect spool batch ${id}: ${String(error)}`);
      }
    },
  };
}

export type { BorderConnectBatchFile };
