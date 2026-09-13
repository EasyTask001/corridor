import { describe, expect, it } from "vitest";
import { getBorderWait } from "./border-wait";

describe("getBorderWait", () => {
  it("qualifies every synthetic estimate with source and disclaimer metadata", () => {
    expect(getBorderWait("3801", new Date("2026-09-12T12:00:00.000Z"))).toMatchObject({
      source: "Corridor deterministic wait-time demo",
      dataQuality: "synthetic_demo",
      updatedAt: "2026-09-12T12:00:00.000Z",
      disclaimer: "Experimental — synthetic demo data, not live",
    });
  });
});
