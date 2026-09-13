/**
 * Shared shape behind both HTTP transports (`gateway/transport.ts`,
 * `borderconnect/transport.ts`): timeout/AbortController, the abort→504 /
 * unreachable→503 mapping, and lenient JSON parsing. Each transport supplies
 * its own auth header, URL, and how it recognizes a failure body.
 */
import { CustomsTransportError } from "./types";

export const retryableStatus = (status: number): boolean => status === 429 || status >= 500;

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export interface FetchJsonOptions {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Name used in timeout/unreachable error messages, e.g. "Customs gateway". */
  label: string;
  /** Returns the failure message to throw for a completed response, or null if it succeeded. */
  failureDetail: (res: Response, json: unknown) => string | null;
}

export async function fetchJson(opts: FetchJsonOptions): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeout = opts.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res: Response;
  try {
    res = await doFetch(opts.url, {
      method: opts.method,
      headers: {
        Accept: "application/json",
        ...(opts.body !== undefined && { "Content-Type": "application/json" }),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new CustomsTransportError(
      aborted ? `${opts.label} timed out after ${timeout} ms` : `${opts.label} unreachable`,
      aborted ? 504 : 503,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  const json: unknown = text ? safeJson(text) : null;
  const detail = opts.failureDetail(res, json);
  if (detail !== null) {
    throw new CustomsTransportError(detail, res.status, retryableStatus(res.status));
  }
  return json;
}
