import { describe, expect, it } from "vitest";
import { canTransitionAlert } from "./alert";
import { daysBetween, driverDocuments, evaluateExpiries, truckDocuments } from "./compliance";

const TODAY = "2026-09-06";
const driver = { type: "driver" as const, id: "d1", displayName: "Dana Driver" };

describe("daysBetween", () => {
  it("is timezone-agnostic and signed", () => {
    expect(daysBetween("2026-09-06", "2026-09-07")).toBe(1);
    expect(daysBetween("2026-09-06", "2026-09-06")).toBe(0);
    expect(daysBetween("2026-09-06", "2026-08-30")).toBe(-7);
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
  });
});

describe("evaluateExpiries", () => {
  it("ignores documents with more than 60 days left", () => {
    const f = evaluateExpiries(
      driver,
      [{ field: "x", label: "X", expiry: "2027-01-01", requiredForCrossing: true }],
      TODAY,
    );
    expect(f).toEqual([]);
  });

  it("warns inside 60 days, critical inside 14, critical when expired", () => {
    const docs = [
      { field: "a", label: "A", expiry: "2026-10-20", requiredForCrossing: true }, // 44 days
      { field: "b", label: "B", expiry: "2026-09-15", requiredForCrossing: true }, // 9 days
      { field: "c", label: "C", expiry: "2026-09-01", requiredForCrossing: true }, // -5 days
      { field: "d", label: "D", expiry: TODAY, requiredForCrossing: true }, // today
    ];
    const f = evaluateExpiries(driver, docs, TODAY);
    expect(f.map((x) => [x.field, x.severity, x.daysRemaining])).toEqual([
      ["a", "warning", 44],
      ["b", "critical", 9],
      ["c", "critical", -5],
      ["d", "critical", 0],
    ]);
    expect(f[2]!.title).toContain("expired 5 days ago");
    expect(f[3]!.title).toContain("expires today");
    expect(f[1]!.title).toContain("expires in 9 days");
  });

  it("flags missing required dates as missing_data, ignores missing optional ones", () => {
    const f = evaluateExpiries(
      driver,
      [
        { field: "req", label: "Req", expiry: null, requiredForCrossing: true },
        { field: "opt", label: "Opt", expiry: null, requiredForCrossing: false },
      ],
      TODAY,
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ field: "req", alertType: "missing_data", severity: "warning" });
  });

  it("produces a stable dedupe key per entity+field", () => {
    const [f] = evaluateExpiries(
      driver,
      [{ field: "license_expiry", label: "L", expiry: "2026-09-10", requiredForCrossing: true }],
      TODAY,
    );
    expect(f!.dedupeKey).toBe("driver:d1:license_expiry");
  });
});

describe("document sets", () => {
  it("driver: travel documents are tracked by document type", () => {
    const without = driverDocuments({ licenseExpiry: null, medicalCertExpiry: null });
    expect(without.map((d) => d.field)).toEqual(["license_expiry", "medical_cert_expiry"]);

    const withCards = driverDocuments({ licenseExpiry: null, medicalCertExpiry: null }, [
      { documentType: "fast", expiresOn: "2026-01-01" },
      { documentType: "passport", expiresOn: "2030-01-01" },
    ]);
    expect(withCards.map((d) => d.field)).toEqual([
      "license_expiry",
      "fast",
      "passport",
      "medical_cert_expiry",
    ]);
    // A travel document with no expiry on file is normal, so it is not a finding.
    expect(withCards.filter((d) => d.requiredForCrossing).map((d) => d.field)).toEqual([
      "license_expiry",
    ]);
  });

  it("driver: FAST expiry now dedupes on the document type", () => {
    const [finding] = evaluateExpiries(
      driver,
      driverDocuments({ licenseExpiry: "2030-01-01", medicalCertExpiry: null }, [
        { documentType: "fast", expiresOn: "2026-09-20" },
      ]),
      TODAY,
    );
    expect(finding).toMatchObject({ field: "fast", dedupeKey: "driver:d1:fast", label: "FAST card" });
  });

  it("driver: a passenger has no license to expire", () => {
    const docs = driverDocuments({
      licenseExpiry: null,
      medicalCertExpiry: null,
      personType: "passenger",
    });
    expect(docs.filter((d) => d.requiredForCrossing)).toEqual([]);
  });

  it("truck: registration + insurance required, inspection optional", () => {
    const docs = truckDocuments({
      registrationExpiry: null,
      insuranceExpiry: null,
      annualInspectionExpiry: null,
    });
    expect(docs.filter((d) => d.requiredForCrossing).map((d) => d.field)).toEqual([
      "registration_expiry",
      "insurance_expiry",
    ]);
  });
});

describe("alert transitions", () => {
  it("open → acknowledged/resolved/dismissed; resolved/dismissed can reopen only", () => {
    expect(canTransitionAlert("open", "acknowledged")).toBe(true);
    expect(canTransitionAlert("open", "resolved")).toBe(true);
    expect(canTransitionAlert("resolved", "open")).toBe(true);
    expect(canTransitionAlert("resolved", "acknowledged")).toBe(false);
    expect(canTransitionAlert("dismissed", "resolved")).toBe(false);
  });
});
