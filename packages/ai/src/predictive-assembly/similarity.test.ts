import { describe, expect, it } from "vitest";
import { rankSimilarMovements, type MovementFingerprint } from "./similarity";

const now = new Date("2026-09-06T12:00:00.000Z");
const target: MovementFingerprint = {
  id: "target",
  regime: "ACE",
  crossingCode: "3801",
  shipperId: "shipper-a",
  consigneeId: "consignee-a",
  createdAt: now,
};

describe("rankSimilarMovements", () => {
  it("prefers an exact historical lane over a merely recent movement", () => {
    const ranked = rankSimilarMovements(
      target,
      [
        {
          ...target,
          id: "recent",
          crossingCode: "0901",
          shipperId: "shipper-b",
          consigneeId: "consignee-b",
          createdAt: new Date("2026-09-05T12:00:00.000Z"),
        },
        {
          ...target,
          id: "exact-lane",
          createdAt: new Date("2026-01-01T12:00:00.000Z"),
        },
      ],
      now,
    );

    expect(ranked[0]).toMatchObject({
      movementId: "exact-lane",
      score: 90,
      reasons: ["same ACE filing regime", "same border crossing", "same shipper", "same consignee"],
    });
  });

  it("excludes the target and movements from another filing regime", () => {
    const ranked = rankSimilarMovements(
      target,
      [target, { ...target, id: "aci", regime: "ACI" }],
      now,
    );
    expect(ranked).toEqual([]);
  });
});
