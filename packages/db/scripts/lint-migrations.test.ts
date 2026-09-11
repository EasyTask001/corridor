import { describe, expect, it } from "vitest";
import { lintMigrationSource } from "./lint-migrations";

const definer = (searchPath: string) => `
create or replace function public.f() returns void
language plpgsql security definer set search_path = ${searchPath}
as $$ begin perform 1; end $$;`;

describe("lintMigrationSource", () => {
  it("accepts an empty search_path on a definer", () => {
    expect(lintMigrationSource("0041_x.sql", definer("''"))).toEqual([]);
  });
  it("rejects search_path = public on a definer (the 0036 regression)", () => {
    expect(lintMigrationSource("0041_x.sql", definer("public"))).toEqual([
      "0041_x.sql: security definer function sets search_path = public; use set search_path = '' and schema-qualify every object",
    ]);
  });
  it("rejects a definer with no search_path at all", () => {
    const src = `create function public.g() returns void language sql security definer as $$ select 1 $$;`;
    expect(lintMigrationSource("0041_x.sql", src)).toEqual([
      "0041_x.sql: security definer function without set search_path = ''",
    ]);
  });
  it("grandfathers migrations before 0032", () => {
    expect(lintMigrationSource("0007_copilot.sql", definer("public"))).toEqual([]);
  });
});
