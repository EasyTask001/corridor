export const AVAAL_CATEGORIES = [
  "company",
  "users",
  "email_preferences",
  "drivers",
  "trucks",
  "trailers",
  "shippers",
  "consignees",
  "ace_manifests",
  "ace_shipments",
  "aci_trips",
  "aci_cargos",
  "external_shipments",
  "tcp",
  "pars_rns",
  "inbond",
] as const;

export type AvaalCategory = (typeof AVAAL_CATEGORIES)[number];

export type AvaalFieldValue =
  | string
  | number
  | boolean
  | null
  | AvaalFieldValue[]
  | { [key: string]: AvaalFieldValue };

export interface AvaalUiRecord {
  sourceId: string;
  sourceUrl: string;
  fields: Record<string, AvaalFieldValue>;
}

export interface AvaalExtractedCategorySnapshot {
  route: string;
  displayedTotal: number | null;
  finalPageReached: true;
  pagesVisited: number[];
  records: AvaalUiRecord[];
  warnings: string[];
}

export interface AvaalNotApplicableCategorySnapshot {
  notApplicable: true;
  reason: string;
}

export type AvaalCategorySnapshot =
  | AvaalExtractedCategorySnapshot
  | AvaalNotApplicableCategorySnapshot;

export interface AvaalSnapshot {
  source: "avaal-ui";
  username: string;
  extractedAt: string;
  categories: Partial<Record<AvaalCategory, AvaalCategorySnapshot>>;
}

const TOP_LEVEL_KEYS = new Set(["source", "username", "extractedAt", "categories"]);
const CATEGORY_KEYS = new Set<string>(AVAAL_CATEGORIES);

const fail = (message: string): never => {
  throw new Error(`Invalid Avaal UI snapshot: ${message}`);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    return fail(`${path} must be a non-empty string`);
  }
  return value;
};

const validateFieldValue = (value: unknown, path: string): AvaalFieldValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return fail(`${path} must contain only finite numbers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => validateFieldValue(item, `${path}[${index}]`));
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        validateFieldValue(item, `${path}.${key}`),
      ]),
    );
  }
  return fail(`${path} contains a non-serializable value`);
};

const validateCategory = (
  value: unknown,
  category: AvaalCategory,
): AvaalCategorySnapshot => {
  if (!isObject(value)) return fail(`categories.${category} must be an object`);

  if (value.notApplicable === true) {
    return {
      notApplicable: true,
      reason: nonEmptyString(value.reason, `categories.${category}.reason`),
    };
  }

  const route = nonEmptyString(value.route, `categories.${category}.route`);
  if (value.finalPageReached !== true) {
    return fail(`categories.${category}.finalPageReached must be true`);
  }
  if (!Array.isArray(value.pagesVisited) || value.pagesVisited.length === 0) {
    return fail(`categories.${category}.pagesVisited must not be empty`);
  }
  const pagesVisited = value.pagesVisited.map((page, index) => {
    if (!Number.isInteger(page) || (page as number) <= 0) {
      return fail(`categories.${category}.pagesVisited[${index}] must be positive`);
    }
    return page as number;
  });
  if (pagesVisited.some((page, index) => page !== index + 1)) {
    return fail(`categories.${category}.pagesVisited must be contiguous from page 1`);
  }
  if (!Array.isArray(value.records)) {
    return fail(`categories.${category}.records must be an array`);
  }

  const seenIds = new Set<string>();
  const records = value.records.map((record, index): AvaalUiRecord => {
    if (!isObject(record)) {
      return fail(`categories.${category}.records[${index}] must be an object`);
    }
    const sourceId = nonEmptyString(
      record.sourceId,
      `categories.${category}.records[${index}].sourceId`,
    );
    const sourceUrl = nonEmptyString(
      record.sourceUrl,
      `categories.${category}.records[${index}].sourceUrl`,
    );
    if (seenIds.has(sourceId)) {
      return fail(`categories.${category} contains duplicate sourceId ${sourceId}`);
    }
    seenIds.add(sourceId);
    if (!isObject(record.fields)) {
      return fail(`categories.${category}.records[${index}].fields must be an object`);
    }
    const fields = Object.fromEntries(
      Object.entries(record.fields).map(([key, fieldValue]) => [
        key,
        validateFieldValue(fieldValue, `categories.${category}.records[${index}].fields.${key}`),
      ]),
    );
    return { sourceId, sourceUrl, fields };
  });

  const displayedTotal = value.displayedTotal;
  if (
    displayedTotal !== null &&
    (!Number.isInteger(displayedTotal) || (displayedTotal as number) < 0)
  ) {
    return fail(`categories.${category}.displayedTotal must be a non-negative integer or null`);
  }
  if (displayedTotal !== null && displayedTotal !== records.length) {
    return fail(
      `categories.${category}.displayedTotal does not match its ${records.length} records`,
    );
  }
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string")) {
    return fail(`categories.${category}.warnings must be a string array`);
  }

  return {
    route,
    displayedTotal,
    finalPageReached: true,
    pagesVisited,
    records,
    warnings: [...value.warnings],
  };
};

export const validateSnapshot = (value: unknown): AvaalSnapshot => {
  if (!isObject(value)) return fail("root must be an object");

  const unknownKeys = Object.keys(value).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknownKeys.length > 0) return fail(`unknown top-level keys: ${unknownKeys.join(", ")}`);
  if (value.source !== "avaal-ui") return fail('source must be "avaal-ui"');
  const username = nonEmptyString(value.username, "username");
  const extractedAt = nonEmptyString(value.extractedAt, "extractedAt");
  if (Number.isNaN(Date.parse(extractedAt))) return fail("extractedAt must be an ISO date");
  if (!isObject(value.categories)) return fail("categories must be an object");

  const unknownCategories = Object.keys(value.categories).filter(
    (category) => !CATEGORY_KEYS.has(category),
  );
  if (unknownCategories.length > 0) {
    return fail(`unknown categories: ${unknownCategories.join(", ")}`);
  }

  const categories: Partial<Record<AvaalCategory, AvaalCategorySnapshot>> = {};
  for (const category of AVAAL_CATEGORIES) {
    if (category in value.categories) {
      categories[category] = validateCategory(value.categories[category], category);
    }
  }

  return { source: "avaal-ui", username, extractedAt, categories };
};

export const snapshotCounts = (
  snapshot: AvaalSnapshot,
): Record<AvaalCategory, number> =>
  Object.fromEntries(
    AVAAL_CATEGORIES.map((category) => {
      const value = snapshot.categories[category];
      return [category, value && !("notApplicable" in value) ? value.records.length : 0];
    }),
  ) as Record<AvaalCategory, number>;
