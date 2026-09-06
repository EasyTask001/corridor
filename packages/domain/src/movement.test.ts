import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  MOVEMENT_TRANSITIONS,
  TERMINAL_STATUSES,
  actorMayTransition,
  canTransition,
  cargoInput,
  hsCode,
  isEditable,
  movementStatus,
  transition,
} from "./movement";

describe("movement state machine", () => {
  it("allows the happy path draft → sent → accepted → released → arrived", () => {
    expect(transition("draft", "sent")).toBe("sent");
    expect(transition("sent", "accepted")).toBe("accepted");
    expect(transition("accepted", "released")).toBe("released");
    expect(transition("released", "arrived")).toBe("arrived");
  });

  it("allows rejection and re-submission", () => {
    expect(transition("sent", "rejected")).toBe("rejected");
    expect(transition("rejected", "draft")).toBe("draft");
    expect(transition("rejected", "sent")).toBe("sent");
  });

  it("allows hold then release", () => {
    expect(transition("accepted", "held")).toBe("held");
    expect(transition("held", "released")).toBe("released");
  });

  it("rejects skipping steps", () => {
    expect(() => transition("draft", "accepted")).toThrow(InvalidTransitionError);
    expect(() => transition("draft", "released")).toThrow(InvalidTransitionError);
    expect(() => transition("sent", "arrived")).toThrow(InvalidTransitionError);
  });

  it("terminal statuses have no outgoing transitions", () => {
    for (const s of TERMINAL_STATUSES) {
      expect(MOVEMENT_TRANSITIONS[s]).toHaveLength(0);
      for (const t of movementStatus.options) expect(canTransition(s, t)).toBe(false);
    }
  });

  it("every non-terminal status can be cancelled", () => {
    for (const s of movementStatus.options) {
      if (TERMINAL_STATUSES.includes(s)) continue;
      expect(canTransition(s, "cancelled")).toBe(true);
    }
  });

  it("customs-driven transitions cannot be initiated by a user", () => {
    expect(actorMayTransition("user", "sent", "accepted")).toBe(false);
    expect(actorMayTransition("customs_api", "sent", "accepted")).toBe(true);
    expect(actorMayTransition("system", "accepted", "held")).toBe(true);
    expect(actorMayTransition("user", "draft", "sent")).toBe(true);
    expect(actorMayTransition("ai", "draft", "sent")).toBe(true);
  });

  it("only draft/rejected movements are editable", () => {
    expect(isEditable("draft")).toBe(true);
    expect(isEditable("rejected")).toBe(true);
    expect(isEditable("sent")).toBe(false);
    expect(isEditable("accepted")).toBe(false);
  });
});

describe("cargo schema", () => {
  it("accepts HS codes at 4, 6, 8 and 10 digits", () => {
    for (const c of ["8471", "8471.30", "8471.30.01", "8471.30.01.00"]) {
      expect(hsCode.safeParse(c).success).toBe(true);
    }
    expect(hsCode.safeParse("847").success).toBe(false);
    expect(hsCode.safeParse("8471.3").success).toBe(false);
  });

  it("rejects negative weight and out-of-range confidence", () => {
    expect(
      cargoInput.safeParse({ commodityDescription: "Steel coils", weightKg: -1 }).success,
    ).toBe(false);
    expect(
      cargoInput.safeParse({ commodityDescription: "Steel coils", extractionConfidence: 1.2 })
        .success,
    ).toBe(false);
  });

  it("normalizes country code to uppercase", () => {
    const parsed = cargoInput.parse({ commodityDescription: "Lumber", countryOfOrigin: "ca" });
    expect(parsed.countryOfOrigin).toBe("CA");
  });
});
