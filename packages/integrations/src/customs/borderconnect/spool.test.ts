import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBorderConnectSpool } from "./spool";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // gitleaks:allow
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("BorderConnect encrypted spool", () => {
  it("round-trips a batch and leaves an encrypted, mode-0600 file until removed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "corridor-bc-spool-"));
    dirs.push(directory);
    const spool = createBorderConnectSpool({ directory, key: KEY });
    expect(spool).not.toBeNull();

    const batch = await spool!.write([{ data: "API_RESPONSE", companyKey: "private" }]);
    expect(batch?.messages).toHaveLength(1);
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect((await readFile(join(directory, files[0]!), "utf8"))).not.toContain("private");
    const replay = await spool!.read();
    expect(replay[0]?.messages).toEqual([{ data: "API_RESPONSE", companyKey: "private" }]);
    await spool!.remove(batch!.id);
    expect(await spool!.read()).toEqual([]);
  });

  it("is disabled without both a directory and a valid 32-byte key", () => {
    expect(createBorderConnectSpool()).toBeNull();
    expect(createBorderConnectSpool({ directory: "/tmp/corridor", key: "short" })).toBeNull();
  });
});
