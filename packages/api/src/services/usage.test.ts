import { describe, expect, it } from "vitest";
import { BILLING_PLANS, planUsageFor } from "@corridor/integrations";
import { periodStartOf, projectUsage, type UsageTotals } from "./usage";

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  documents_extracted: 0,
  copilot_messages: 0,
  movements_transmitted: 0,
  ai_suggestions: 0,
  ...over,
});

const starter = planUsageFor("starter");
const professional = planUsageFor("professional");
const enterprise = planUsageFor("enterprise");

describe("periodStartOf", () => {
  it("is the first day of the calendar month in UTC", () => {
    expect(periodStartOf(new Date("2026-09-06T13:45:00Z"))).toBe("2026-09-01");
    expect(periodStartOf(new Date("2026-01-31T23:59:59Z"))).toBe("2026-01-01");
    expect(periodStartOf(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12-01");
  });

  it("uses UTC, not the machine's timezone", () => {
    // 23:30 on 31 Aug in UTC is 19:30 the same day in Toronto and 01:30 on
    // 1 Sep in Berlin — the period is August either way.
    expect(periodStartOf(new Date("2026-08-31T23:30:00Z"))).toBe("2026-08-01");
    // The first instant of a month is already in that month.
    expect(periodStartOf(new Date("2026-09-01T00:00:00Z"))).toBe("2026-09-01");
  });
});

describe("projectUsage", () => {
  it("charges nothing inside the included allowance", () => {
    const p = projectUsage(starter, totals({ documents_extracted: 50, copilot_messages: 200 }));
    expect(p.documents.billable).toBe(0);
    expect(p.copilotMessages.billable).toBe(0);
    expect(p.projectedOverageUsd).toBe(0);
  });

  it("charges max(0, used - included) x unit price per metric", () => {
    const p = projectUsage(starter, totals({ documents_extracted: 62, copilot_messages: 250 }));
    // 12 documents over at $1.50 = $18.00; 50 messages over at $0.10 = $5.00
    expect(p.documents).toMatchObject({ used: 62, included: 50, billable: 12, amountUsd: 18 });
    expect(p.copilotMessages).toMatchObject({
      used: 250,
      included: 200,
      billable: 50,
      amountUsd: 5,
    });
    expect(p.projectedOverageUsd).toBe(23);
  });

  it("prices the same overage lower on the larger plan", () => {
    const used = totals({ documents_extracted: 510, copilot_messages: 2100 });
    const pro = projectUsage(professional, used);
    // 10 documents at $1.00 + 100 messages at $0.05
    expect(pro.projectedOverageUsd).toBe(15);
    expect(projectUsage(starter, used).projectedOverageUsd).toBeGreaterThan(
      pro.projectedOverageUsd,
    );
  });

  it("never bills an unlimited (enterprise) allowance", () => {
    const p = projectUsage(
      enterprise,
      totals({ documents_extracted: 9999, copilot_messages: 9999 }),
    );
    expect(p.documents.included).toBeNull();
    expect(p.documents.billable).toBe(0);
    expect(p.copilotMessages.billable).toBe(0);
    expect(p.projectedOverageUsd).toBe(0);
  });

  it("meters transmissions and suggestions without charging for them", () => {
    const p = projectUsage(starter, totals({ movements_transmitted: 340, ai_suggestions: 91 }));
    expect(p.totals.movements_transmitted).toBe(340);
    expect(p.totals.ai_suggestions).toBe(91);
    expect(p.projectedOverageUsd).toBe(0);
  });

  it("rounds money to cents", () => {
    // 3 messages over at $0.05 = $0.15 — must not surface as 0.15000000000000002
    const p = projectUsage(professional, totals({ copilot_messages: 2003 }));
    expect(p.copilotMessages.amountUsd).toBe(0.15);
    expect(p.projectedOverageUsd).toBe(0.15);
  });

  it("carries the period through", () => {
    expect(projectUsage(starter, totals(), "2026-04-01").periodStart).toBe("2026-04-01");
  });
});

describe("planUsageFor", () => {
  it("meters a trial against the plan it converts into", () => {
    expect(planUsageFor("trial")).toEqual(planUsageFor("starter"));
  });

  it("every plan declares an allowance", () => {
    for (const plan of BILLING_PLANS) {
      expect(plan.usage, plan.plan).toBeDefined();
      expect(plan.usage.overageUsdPerDocument).toBeGreaterThanOrEqual(0);
      expect(plan.usage.overageUsdPerMessage).toBeGreaterThanOrEqual(0);
    }
  });
});
