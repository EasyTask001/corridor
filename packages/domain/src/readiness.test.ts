import { describe, expect, it } from "vitest";
import { crossingReadiness, type CrossingReadinessInput, type ReadinessEvent } from "./readiness";

const T0 = "2026-09-10T08:00:00Z";
const T1 = "2026-09-10T09:00:00Z";
const T2 = "2026-09-10T10:00:00Z";

function aceShipment(overrides: Partial<CrossingReadinessInput["shipments"][number]> = {}) {
  return {
    controlNumber: "PFTR0001",
    status: "sent" as const,
    entryNumber: null,
    isPars: false,
    rnsReleasedAt: null,
    isInBond: false,
    ...overrides,
  };
}

function aciShipment(overrides: Partial<CrossingReadinessInput["shipments"][number]> = {}) {
  return {
    controlNumber: "PFTRPARS0001",
    status: "sent" as const,
    entryNumber: null,
    isPars: true,
    rnsReleasedAt: null,
    isInBond: false,
    ...overrides,
  };
}

function checkFor(result: ReturnType<typeof crossingReadiness>, key: string) {
  const check = result.checks.find((c) => c.key === key);
  if (!check) throw new Error(`No "${key}" check in result: ${JSON.stringify(result.checks)}`);
  return check;
}

describe("crossingReadiness — ACE", () => {
  const base: CrossingReadinessInput = {
    regime: "ACE",
    status: "accepted",
    shipments: [aceShipment({ entryNumber: "ENT1" })],
    events: [],
  };

  describe("manifest", () => {
    it("ok when accepted or released", () => {
      expect(checkFor(crossingReadiness({ ...base, status: "accepted" }), "manifest").state).toBe(
        "ok",
      );
      expect(checkFor(crossingReadiness({ ...base, status: "released" }), "manifest").state).toBe(
        "ok",
      );
    });

    it("pending while sent", () => {
      expect(checkFor(crossingReadiness({ ...base, status: "sent" }), "manifest").state).toBe(
        "pending",
      );
    });

    it("blocked when rejected or held", () => {
      expect(checkFor(crossingReadiness({ ...base, status: "rejected" }), "manifest").state).toBe(
        "blocked",
      );
      expect(checkFor(crossingReadiness({ ...base, status: "held" }), "manifest").state).toBe(
        "blocked",
      );
    });
  });

  describe("entries", () => {
    it("ok when every non-in-bond shipment has an entry number", () => {
      const result = crossingReadiness({
        ...base,
        shipments: [aceShipment({ entryNumber: "ENT1" })],
      });
      expect(checkFor(result, "entries").state).toBe("ok");
    });

    it("ok when the entry number is missing but an entry_on_file event names the shipment", () => {
      const result = crossingReadiness({
        ...base,
        shipments: [aceShipment({ controlNumber: "PFTR0001", entryNumber: null })],
        events: [{ code: "entry_on_file", shipmentControlNumber: "PFTR0001", occurredAt: T0 }],
      });
      expect(checkFor(result, "entries").state).toBe("ok");
    });

    it("pending when a non-in-bond shipment has neither", () => {
      const result = crossingReadiness({
        ...base,
        shipments: [aceShipment({ entryNumber: null })],
        events: [],
      });
      expect(checkFor(result, "entries").state).toBe("pending");
    });

    it("ignores in-bond shipments entirely", () => {
      const result = crossingReadiness({
        ...base,
        shipments: [aceShipment({ entryNumber: null, isInBond: true })],
        events: [],
      });
      expect(checkFor(result, "entries").state).toBe("ok");
    });
  });

  describe("holds", () => {
    it("ok with no held events", () => {
      const result = crossingReadiness({ ...base, events: [] });
      expect(checkFor(result, "holds").state).toBe("ok");
    });

    it("ok when a held event is followed by a later accepted/released", () => {
      const result = crossingReadiness({
        ...base,
        events: [
          { code: "held", shipmentControlNumber: null, occurredAt: T0 },
          { code: "released", shipmentControlNumber: null, occurredAt: T1 },
        ],
      });
      expect(checkFor(result, "holds").state).toBe("ok");
    });

    it("blocked when a held event is newer than the last accepted/released", () => {
      const result = crossingReadiness({
        ...base,
        events: [
          { code: "accepted", shipmentControlNumber: null, occurredAt: T0 },
          { code: "held", shipmentControlNumber: null, occurredAt: T1 },
        ],
      });
      expect(checkFor(result, "holds").state).toBe("blocked");
    });
  });

  describe("rejects", () => {
    it("ok with no rejected events", () => {
      const result = crossingReadiness({ ...base, events: [] });
      expect(checkFor(result, "rejects").state).toBe("ok");
    });

    it("ok when accepted is newer than the last rejected", () => {
      const result = crossingReadiness({
        ...base,
        events: [
          { code: "rejected", shipmentControlNumber: null, occurredAt: T0 },
          { code: "accepted", shipmentControlNumber: null, occurredAt: T1 },
        ],
      });
      expect(checkFor(result, "rejects").state).toBe("ok");
    });

    it("blocked when the last rejected is newer than the last accepted", () => {
      const result = crossingReadiness({
        ...base,
        events: [
          { code: "accepted", shipmentControlNumber: null, occurredAt: T0 },
          { code: "rejected", shipmentControlNumber: null, occurredAt: T1 },
        ],
      });
      expect(checkFor(result, "rejects").state).toBe("blocked");
    });
  });

  it("ready is true only when every check is ok", () => {
    const allOk = crossingReadiness({
      regime: "ACE",
      status: "released",
      shipments: [aceShipment({ entryNumber: "ENT1" })],
      events: [{ code: "accepted", shipmentControlNumber: null, occurredAt: T0 }],
    });
    expect(allOk.checks.every((c) => c.state === "ok")).toBe(true);
    expect(allOk.ready).toBe(true);

    const oneBlocked = crossingReadiness({
      regime: "ACE",
      status: "released",
      shipments: [aceShipment({ entryNumber: "ENT1" })],
      events: [
        { code: "accepted", shipmentControlNumber: null, occurredAt: T0 },
        { code: "held", shipmentControlNumber: null, occurredAt: T1 },
      ],
    });
    expect(oneBlocked.ready).toBe(false);
  });
});

describe("crossingReadiness — ACI", () => {
  const base: CrossingReadinessInput = {
    regime: "ACI",
    status: "accepted",
    shipments: [aciShipment()],
    events: [],
  };

  describe("manifest", () => {
    it("ok when accepted or released", () => {
      expect(checkFor(crossingReadiness({ ...base, status: "accepted" }), "manifest").state).toBe(
        "ok",
      );
      expect(checkFor(crossingReadiness({ ...base, status: "released" }), "manifest").state).toBe(
        "ok",
      );
    });

    it("pending while sent", () => {
      expect(checkFor(crossingReadiness({ ...base, status: "sent" }), "manifest").state).toBe(
        "pending",
      );
    });

    it("blocked when rejected or held", () => {
      expect(checkFor(crossingReadiness({ ...base, status: "rejected" }), "manifest").state).toBe(
        "blocked",
      );
      expect(checkFor(crossingReadiness({ ...base, status: "held" }), "manifest").state).toBe(
        "blocked",
      );
    });
  });

  describe("pars_match", () => {
    it("ok when every PARS shipment has a pars_matched event", () => {
      const result = crossingReadiness({
        ...base,
        shipments: [aciShipment({ controlNumber: "PFTRPARS0001" })],
        events: [
          { code: "pars_matched", shipmentControlNumber: "PFTRPARS0001", occurredAt: T0 },
        ],
      });
      expect(checkFor(result, "pars_match").state).toBe("ok");
    });

    it("pending when a PARS shipment has no match event yet", () => {
      const result = crossingReadiness({
        ...base,
        shipments: [aciShipment({ controlNumber: "PFTRPARS0001" })],
        events: [],
      });
      expect(checkFor(result, "pars_match").state).toBe("pending");
    });

    it("blocked when a PARS shipment's latest event is pars_not_matched", () => {
      const result = crossingReadiness({
        ...base,
        shipments: [aciShipment({ controlNumber: "PFTRPARS0001" })],
        events: [
          { code: "pars_not_matched", shipmentControlNumber: "PFTRPARS0001", occurredAt: T0 },
        ],
      });
      expect(checkFor(result, "pars_match").state).toBe("blocked");
    });

    it("ok when a pars_not_matched is superseded by a later pars_matched", () => {
      const result = crossingReadiness({
        ...base,
        shipments: [aciShipment({ controlNumber: "PFTRPARS0001" })],
        events: [
          { code: "pars_not_matched", shipmentControlNumber: "PFTRPARS0001", occurredAt: T0 },
          { code: "pars_matched", shipmentControlNumber: "PFTRPARS0001", occurredAt: T1 },
        ],
      });
      expect(checkFor(result, "pars_match").state).toBe("ok");
    });
  });

  describe("rns_release", () => {
    it("ok when every PARS shipment has an RNS release timestamp", () => {
      const result = crossingReadiness({
        ...base,
        shipments: [aciShipment({ rnsReleasedAt: T0 })],
      });
      expect(checkFor(result, "rns_release").state).toBe("ok");
    });

    it("ok when a PARS shipment's own status is already released", () => {
      const result = crossingReadiness({
        ...base,
        shipments: [aciShipment({ rnsReleasedAt: null, status: "released" })],
      });
      expect(checkFor(result, "rns_release").state).toBe("ok");
    });

    it("pending when a PARS shipment has neither", () => {
      const result = crossingReadiness({
        ...base,
        shipments: [aciShipment({ rnsReleasedAt: null, status: "sent" })],
      });
      expect(checkFor(result, "rns_release").state).toBe("pending");
    });
  });

  describe("rejects", () => {
    it("ok with no rejected events", () => {
      expect(checkFor(crossingReadiness({ ...base, events: [] }), "rejects").state).toBe("ok");
    });

    it("blocked when the last rejected is newer than the last accepted", () => {
      const result = crossingReadiness({
        ...base,
        events: [
          { code: "accepted", shipmentControlNumber: null, occurredAt: T0 },
          { code: "rejected", shipmentControlNumber: null, occurredAt: T1 },
        ],
      });
      expect(checkFor(result, "rejects").state).toBe("blocked");
    });
  });

  it("ready is true only when every check is ok", () => {
    const allOk = crossingReadiness({
      regime: "ACI",
      status: "released",
      shipments: [aciShipment({ rnsReleasedAt: T0 })],
      events: [
        { code: "accepted", shipmentControlNumber: null, occurredAt: T0 },
        { code: "pars_matched", shipmentControlNumber: "PFTRPARS0001", occurredAt: T0 },
      ],
    });
    expect(allOk.ready).toBe(true);

    const onePending = crossingReadiness({
      regime: "ACI",
      status: "released",
      shipments: [aciShipment({ rnsReleasedAt: null, status: "sent" })],
      events: [
        { code: "accepted", shipmentControlNumber: null, occurredAt: T0 },
        { code: "pars_matched", shipmentControlNumber: "PFTRPARS0001", occurredAt: T0 },
      ],
    });
    expect(onePending.ready).toBe(false);
  });
});

describe("crossingReadiness — empty trip", () => {
  it("produces only the manifest and rejects checks, regardless of regime", () => {
    const events: ReadinessEvent[] = [];
    const ace = crossingReadiness({ regime: "ACE", status: "accepted", shipments: [], events });
    const aci = crossingReadiness({ regime: "ACI", status: "accepted", shipments: [], events });
    expect(ace.checks.map((c) => c.key)).toEqual(["manifest", "rejects"]);
    expect(aci.checks.map((c) => c.key)).toEqual(["manifest", "rejects"]);
  });

  it("is ready once manifest and rejects are both ok", () => {
    const result = crossingReadiness({
      regime: "ACE",
      status: "released",
      shipments: [],
      events: [],
    });
    expect(result.ready).toBe(true);
  });

  it("is not ready when the manifest was rejected", () => {
    const result = crossingReadiness({
      regime: "ACI",
      status: "rejected",
      shipments: [],
      events: [],
    });
    expect(result.ready).toBe(false);
  });
});
