import { describe, expect, it } from "vitest";
import { RETENTION_SCHEDULE } from "./retention";

describe("RETENTION_SCHEDULE", () => {
  it("is non-empty and every entry has both fields filled in", () => {
    expect(RETENTION_SCHEDULE.length).toBeGreaterThan(0);
    for (const entry of RETENTION_SCHEDULE) {
      expect(entry.category.length).toBeGreaterThan(0);
      expect(entry.policy.length).toBeGreaterThan(0);
    }
  });

  it("states plainly that there is no automatic background-job purge", () => {
    const jobs = RETENTION_SCHEDULE.find((e) => /background job/i.test(e.category));
    expect(jobs?.policy).toMatch(/no automatic/i);
  });

  it("does not promise a self-serve deletion flow that doesn't exist", () => {
    const deletion = RETENTION_SCHEDULE.find((e) => /organization deletion/i.test(e.category));
    expect(deletion?.policy).toMatch(/no self-serve deletion flow/i);
  });
});
