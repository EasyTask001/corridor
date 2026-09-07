/**
 * Static guard: every mutation in `appRouter` is classified in
 * `services/audit.ts` — either it writes an audit row (`AUDITED_MUTATIONS`) or
 * it carries a written justification for not doing so
 * (`AUDIT_EXEMPT_MUTATIONS`).
 *
 * A new mutation therefore fails the build until someone decides which it is,
 * and a mutation that is renamed or deleted fails until the list is cleaned up,
 * so the allow-list cannot quietly rot into a list of names that no longer
 * exist.
 *
 * The test cannot see *inside* a resolver, so it proves classification, not the
 * `writeAudit` call itself. That is the point at which review takes over.
 */
import { describe, expect, it } from "vitest";
import { appRouter } from "./router/_app";
import { AUDITED_MUTATIONS, AUDIT_EXEMPT_MUTATIONS } from "./services/audit";

/** Dotted paths of every mutation procedure, from tRPC's own procedure map. */
function mutationPaths(): string[] {
  const procedures = appRouter._def.procedures as unknown as Record<
    string,
    { _def: { type: "query" | "mutation" | "subscription" } }
  >;
  return Object.entries(procedures)
    .filter(([, p]) => p._def.type === "mutation")
    .map(([path]) => path)
    .sort();
}

describe("audit coverage", () => {
  const paths = mutationPaths();

  it("finds the router's mutations", () => {
    // Guards against the introspection silently returning nothing after a tRPC
    // upgrade, which would make every assertion below vacuously true.
    expect(paths.length).toBeGreaterThan(40);
    expect(paths).toContain("movement.submit");
  });

  it("every mutation is audited or explicitly exempt", () => {
    const unclassified = paths.filter(
      (path) => !(path in AUDITED_MUTATIONS) && !(path in AUDIT_EXEMPT_MUTATIONS),
    );
    expect(
      unclassified,
      "add each of these to AUDITED_MUTATIONS in services/audit.ts (or, with a " +
        "written reason, to AUDIT_EXEMPT_MUTATIONS)",
    ).toEqual([]);
  });

  it("no mutation is both audited and exempt", () => {
    const both = paths.filter(
      (path) => path in AUDITED_MUTATIONS && path in AUDIT_EXEMPT_MUTATIONS,
    );
    expect(both).toEqual([]);
  });

  it("has no stale entries: every listed name is still a mutation", () => {
    const known = new Set(paths);
    const stale = [...Object.keys(AUDITED_MUTATIONS), ...Object.keys(AUDIT_EXEMPT_MUTATIONS)]
      .filter((path) => !known.has(path))
      .sort();
    expect(stale, "these names are in the audit lists but no longer exist").toEqual([]);
  });

  it("every entry carries a non-empty action / reason", () => {
    for (const [path, value] of Object.entries(AUDITED_MUTATIONS)) {
      expect(value.trim(), `AUDITED_MUTATIONS["${path}"]`).not.toBe("");
    }
    for (const [path, reason] of Object.entries(AUDIT_EXEMPT_MUTATIONS)) {
      expect(reason.trim().length, `AUDIT_EXEMPT_MUTATIONS["${path}"]`).toBeGreaterThan(20);
    }
  });

  it("queries are not in the audit lists", () => {
    const procedures = appRouter._def.procedures as unknown as Record<
      string,
      { _def: { type: string } }
    >;
    const queries = Object.entries(procedures)
      .filter(([, p]) => p._def.type === "query")
      .map(([path]) => path);
    const misfiled = queries.filter(
      (path) => path in AUDITED_MUTATIONS || path in AUDIT_EXEMPT_MUTATIONS,
    );
    expect(misfiled).toEqual([]);
  });
});
