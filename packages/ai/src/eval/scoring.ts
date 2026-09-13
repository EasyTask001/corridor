export interface EvalExpected {
  documentType?: string;
  documentNumber?: string | null;
  documentDate?: string | null;
  shipper?: { name?: string | null };
  consignee?: { name?: string | null };
  cargo?: Array<Record<string, unknown>>;
  rateConfirmation?: Record<string, unknown>;
  _expectLowConfidence?: boolean;
}

export type ExtractionGateName = "regression" | "pilot" | "ga";

export function extractionGate(name: ExtractionGateName) {
  return {
    minimumDocuments: name === "ga" ? 250 : name === "pilot" ? 50 : 1,
    criticalAccuracy: 0.95,
    overallAccuracy: 0.9,
  };
}

function same(actual: unknown, expected: unknown): boolean {
  if (actual == null || expected == null) return actual == null && expected == null;
  if (typeof actual === "number" && typeof expected === "number")
    return Math.abs(actual - expected) <= Math.abs(expected) * 0.01 + 1e-9;
  return String(actual).trim().toLowerCase() === String(expected).trim().toLowerCase();
}

function normalizedField(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

const CRITICAL_FIELDS = new Set([
  "documentNumber",
  "shipper.name",
  "consignee.name",
  "cargo.length",
  "cargo[].commodityDescription",
  "cargo[].hsCode",
  "cargo[].quantity",
  "cargo[].weightKg",
  "cargo[].pieceCount",
  "cargo[].valueAmount",
  "cargo[].valueCurrency",
  "cargo[].countryOfOrigin",
  "rateConfirmation.carrierName",
  "rateConfirmation.brokerName",
  "rateConfirmation.referenceNumber",
  "rateConfirmation.rateAmount",
  "rateConfirmation.rateCurrency",
  "rateConfirmation.pickupAt",
  "rateConfirmation.deliveryAt",
]);

export interface ExtractionScore {
  name: string;
  documentType: string;
  total: number;
  hit: number;
  criticalTotal: number;
  criticalHit: number;
  accuracy: number;
  criticalAccuracy: number;
  misses: string[];
  fields: Record<string, { hit: number; total: number; critical: boolean }>;
}

export function scoreExtraction(
  actual: Record<string, unknown>,
  expected: EvalExpected,
  name: string,
): ExtractionScore {
  let total = 0;
  let hit = 0;
  let criticalTotal = 0;
  let criticalHit = 0;
  const misses: string[] = [];
  const fields: ExtractionScore["fields"] = {};
  const check = (path: string, actualValue: unknown, expectedValue: unknown) => {
    const field = normalizedField(path);
    const critical = CRITICAL_FIELDS.has(field);
    const matched = same(actualValue, expectedValue);
    total++;
    if (matched) hit++;
    if (critical) {
      criticalTotal++;
      if (matched) criticalHit++;
    }
    const current = fields[field] ?? { hit: 0, total: 0, critical };
    current.total++;
    if (matched) current.hit++;
    fields[field] = current;
    if (!matched) misses.push(path);
  };

  for (const key of ["documentType", "documentNumber", "documentDate"] as const) {
    if (key in expected) check(key, actual[key], expected[key]);
  }
  for (const party of ["shipper", "consignee"] as const) {
    const expectedParty = expected[party];
    if (expectedParty && "name" in expectedParty) {
      check(
        `${party}.name`,
        (actual[party] as { name?: unknown } | undefined)?.name,
        expectedParty.name,
      );
    }
  }
  const actualCargo = (actual.cargo as Array<Record<string, unknown>>) ?? [];
  for (const [index, expectedLine] of (expected.cargo ?? []).entries()) {
    const actualLine = actualCargo[index] ?? {};
    for (const [key, value] of Object.entries(expectedLine)) {
      check(`cargo[${index}].${key}`, actualLine[key], value);
    }
  }
  if (expected.cargo) check("cargo.length", actualCargo.length, expected.cargo.length);
  if (expected.rateConfirmation) {
    const actualRate = (actual.rateConfirmation as Record<string, unknown> | null) ?? {};
    for (const [key, value] of Object.entries(expected.rateConfirmation)) {
      check(`rateConfirmation.${key}`, actualRate[key], value);
    }
  }

  return {
    name,
    documentType: expected.documentType ?? String(actual.documentType ?? "other"),
    total,
    hit,
    criticalTotal,
    criticalHit,
    accuracy: total ? hit / total : 1,
    criticalAccuracy: criticalTotal ? criticalHit / criticalTotal : 1,
    misses,
    fields,
  };
}

interface AccuracyBucket {
  hit: number;
  total: number;
  accuracy: number;
}

export function aggregateExtractionScores(scores: ExtractionScore[]) {
  let hit = 0;
  let total = 0;
  let criticalHit = 0;
  let criticalTotal = 0;
  const fieldCounts: Record<string, { hit: number; total: number; critical: boolean }> = {};
  const typeCounts: Record<
    string,
    { documents: number; hit: number; total: number; criticalHit: number; criticalTotal: number }
  > = {};

  for (const score of scores) {
    hit += score.hit;
    total += score.total;
    criticalHit += score.criticalHit;
    criticalTotal += score.criticalTotal;
    const type = (typeCounts[score.documentType] ??= {
      documents: 0,
      hit: 0,
      total: 0,
      criticalHit: 0,
      criticalTotal: 0,
    });
    type.documents++;
    type.hit += score.hit;
    type.total += score.total;
    type.criticalHit += score.criticalHit;
    type.criticalTotal += score.criticalTotal;
    for (const [field, count] of Object.entries(score.fields)) {
      const aggregate = (fieldCounts[field] ??= { hit: 0, total: 0, critical: count.critical });
      aggregate.hit += count.hit;
      aggregate.total += count.total;
    }
  }

  const bucket = (bucketHit: number, bucketTotal: number): AccuracyBucket => ({
    hit: bucketHit,
    total: bucketTotal,
    accuracy: bucketTotal ? bucketHit / bucketTotal : 1,
  });
  return {
    documents: scores.length,
    overall: bucket(hit, total),
    critical: bucket(criticalHit, criticalTotal),
    documentTypes: Object.fromEntries(
      Object.entries(typeCounts).map(([type, count]) => [
        type,
        {
          ...count,
          accuracy: count.total ? count.hit / count.total : 1,
          criticalAccuracy: count.criticalTotal ? count.criticalHit / count.criticalTotal : 1,
        },
      ]),
    ),
    fields: Object.fromEntries(
      Object.entries(fieldCounts).map(([field, count]) => [
        field,
        { ...count, accuracy: count.total ? count.hit / count.total : 1 },
      ]),
    ),
  };
}
