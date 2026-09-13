/**
 * A deliberately fail-closed Sentry event scrubber. Operational events keep
 * stack locations, low-cardinality tags, counts, and timings; customer data,
 * provider envelopes, credentials, and identity fields never leave the
 * process.
 */

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const AUTH_VALUE =
  /\b(?:bearer|api[-_ ]?key|password|secret|token|companyKey)(?:\s*[:=]\s*|\s+)[^\s,;]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const PHONE = /(?<!\d)(?:\+?\d[\d(). -]{7,}\d)(?!\d)/g;

function scrubString(value: string): string {
  return value
    .replace(EMAIL, "[REDACTED_EMAIL]")
    .replace(UUID, "[REDACTED_ID]")
    .replace(JWT, "[REDACTED_TOKEN]")
    .replace(AUTH_VALUE, "[REDACTED_CREDENTIAL]")
    .replace(PHONE, "[REDACTED_PHONE]");
}

function sanitizedUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return scrubString(value.split("?")[0] ?? "");
  }
}

function scrubValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(scrubValue(item, seen));
    return output;
  }

  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // This generic helper is used only after the event-specific allowlists
    // below. Keep it conservative if a new caller accidentally passes an
    // arbitrary object: unknown keys are dropped rather than copied.
    if (
      /^(?:count|safeCount|durationMs|status|statusCode|depth|ageMs|messageCount|provider|operation|regime|component|condition|severity)$/.test(
        key,
      )
    ) {
      if (typeof child === "number" || typeof child === "boolean") output[key] = child;
      else if (typeof child === "string") output[key] = scrubString(child).slice(0, 120);
    }
  }
  return output;
}

const SAFE_TAGS = new Set([
  "component",
  "operation",
  "provider",
  "regime",
  "condition",
  "severity",
  "runtime",
  "environment",
]);

function safeTags(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const tags: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!SAFE_TAGS.has(key) || typeof child !== "string") continue;
    tags[key] = scrubString(child).slice(0, 120);
  }
  return Object.keys(tags).length ? tags : undefined;
}

function safeContexts(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, unknown> = {};
  const operation = (value as Record<string, unknown>).operation;
  if (operation && typeof operation === "object" && !Array.isArray(operation)) {
    const safe = scrubValue(operation, new WeakMap());
    if (safe && typeof safe === "object" && Object.keys(safe).length) output.operation = safe;
  }
  return Object.keys(output).length ? output : undefined;
}

function safeExtra(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const safe = scrubValue(value, new WeakMap());
  return safe && typeof safe === "object" && Object.keys(safe).length
    ? (safe as Record<string, unknown>)
    : undefined;
}

/** Compatible with Sentry's `beforeSend` callback without depending on an SDK. */
export function scrubTelemetryEvent<T extends object>(event: T): T {
  const source = event as unknown as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const key of [
    "event_id",
    "timestamp",
    "level",
    "platform",
    "logger",
    "release",
    "environment",
    "transaction",
    "fingerprint",
  ]) {
    const value = source[key];
    if (typeof value === "string" || Array.isArray(value))
      output[key] = scrubValue(value, new WeakMap());
  }
  const tags = safeTags(source.tags);
  if (tags) output.tags = tags;
  const contexts = safeContexts(source.contexts);
  if (contexts) output.contexts = contexts;
  const extra = safeExtra(source.extra);
  if (extra) output.extra = extra;

  // Sentry's `user` object is entirely identifying; partial preservation is
  // easy to get wrong and adds no value to the operational alerts here.
  delete output.user;
  // Free-form messages and exception values can contain provider responses or
  // extracted document text even when their enclosing field looks harmless.
  // Keep the exception type and stack locations for grouping/debugging, but
  // never export uncontrolled text.
  delete output.message;

  const request = source.request as Record<string, unknown> | undefined;
  if (request) {
    const safeRequest: Record<string, unknown> = {};
    if (typeof request.method === "string") safeRequest.method = request.method;
    const url = sanitizedUrl(request.url);
    if (url) {
      try {
        safeRequest.url = new URL(url).origin;
      } catch {
        // Invalid or relative URLs carry no operational value and are dropped.
      }
    }
    if (Object.keys(safeRequest).length) output.request = safeRequest;
  }

  const exception = source.exception as Record<string, unknown> | undefined;
  if (exception && Array.isArray(exception.values)) {
    output.exception = {
      values: exception.values.map((item) => {
        if (!item || typeof item !== "object") return { value: "[REDACTED_EXCEPTION]" };
        const value = item as Record<string, unknown>;
        const safe: Record<string, unknown> = { value: "[REDACTED_EXCEPTION]" };
        if (typeof value.type === "string") safe.type = value.type;
        const stack = value.stacktrace as Record<string, unknown> | undefined;
        const frames = stack?.frames;
        if (Array.isArray(frames)) {
          safe.stacktrace = {
            frames: frames.map((frame) => {
              if (!frame || typeof frame !== "object") return {};
              const f = frame as Record<string, unknown>;
              return Object.fromEntries(
                ["filename", "function", "module", "lineno", "colno"].flatMap((key) =>
                  f[key] === undefined ? [] : [[key, scrubValue(f[key], new WeakMap())]],
                ),
              );
            }),
          };
        }
        return safe;
      }),
    };
  }

  const breadcrumbs = source.breadcrumbs;
  if (Array.isArray(breadcrumbs)) {
    const safe = breadcrumbs
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => {
        const crumb: Record<string, unknown> = {};
        if (typeof item.category === "string")
          crumb.category = scrubString(item.category).slice(0, 80);
        const data = safeExtra(item.data);
        if (data) crumb.data = data;
        return crumb;
      })
      .filter((item) => Object.keys(item).length);
    if (safe.length) output.breadcrumbs = safe;
  }

  return output as T;
}
