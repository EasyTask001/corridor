/**
 * The only vendor-specific file (so far) for BorderConnect: how bytes reach
 * their eManifest API. Mirrors `../gateway/transport.ts`'s retry/timeout/
 * error conventions, with BorderConnect's own wire protocol: an `Api-Key`
 * header (not `Authorization: Bearer`) and `POST /api/send/{suffix}` /
 * `GET /api/receive/{suffix}` instead of a configurable REST path per call.
 */
import { fetchJson } from "../http";

export interface BorderConnectTransport {
  /** POST /api/send/{suffix}: files one message, returns its ack status. */
  send(message: Record<string, unknown>): Promise<{ status: string }>;
  /** GET /api/receive/{suffix}: polls for queued inbound messages, normalised. */
  receive(): Promise<Record<string, unknown>[]>;
}

export interface BorderConnectHttpOptions {
  /** BorderConnect's per-company API URL suffix (their "company key" path segment). */
  apiUrlSuffix: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Per-call deadline. */
  timeoutMs?: number;
  /** default https://borderconnect.com */
  baseUrl?: string;
}

/** Error codes BorderConnect documents in its send/receive API responses. */
export const BORDERCONNECT_ERROR_CODES = [
  "MISSING_API_KEY",
  "INVALID_API_KEY",
  "EXPIRED_API_KEY",
  "API_KEY_URL_MISMATCH",
  "FAILED_TO_IMPORT_DATA",
  "WRONG_HTTP_METHOD",
  "TOO_MANY_REQUESTS",
] as const;

const DEFAULT_BASE_URL = "https://borderconnect.com";

/** BorderConnect spells its failure status both ways across message types. */
const isFailureStatus = (json: unknown): boolean => {
  if (!json || typeof json !== "object" || !("status" in json)) return false;
  const status = String(json.status).toUpperCase();
  return status === "FAILURE" || status === "FAILED";
};

const extractErrorCode = (json: unknown): string | undefined => {
  if (!json || typeof json !== "object" || !("errorCode" in json)) return undefined;
  const code = json.errorCode;
  return typeof code === "string" ? code : undefined;
};

/** `Api-Key`-authenticated JSON over HTTPS, 30 s deadline, typed failures. */
export function createBorderConnectHttpTransport(
  opts: BorderConnectHttpOptions,
): BorderConnectTransport {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const suffix = opts.apiUrlSuffix.replace(/^\/+|\/+$/g, "");

  const call = (method: "GET" | "POST", kind: "send" | "receive", body?: Record<string, unknown>) =>
    fetchJson({
      url: `${base}/api/${kind}/${suffix}`,
      method,
      headers: { "Api-Key": opts.apiKey },
      body,
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
      label: "BorderConnect",
      failureDetail: (res, json) => {
        if (!res.ok || isFailureStatus(json)) {
          const code = extractErrorCode(json) ?? `HTTP ${res.status}`;
          return `BorderConnect: ${code} (${res.status})`;
        }
        return null;
      },
    });

  return {
    send: async (message) => {
      const json = await call("POST", "send", message);
      const status =
        json && typeof json === "object" && typeof (json as { status?: unknown }).status === "string"
          ? (json as { status: string }).status
          : "OK";
      return { status };
    },
    receive: async () => normaliseReceiveBody(await call("GET", "receive")),
  };
}

/**
 * BorderConnect's `receive` body shows up in several documented shapes:
 * an array of messages already, `null`/`""` when the queue is empty, a
 * `{messages: [...]}` envelope, or a single message object (identified by
 * a `data` field) that isn't wrapped in an array at all. Anything else
 * (e.g. a bare `{status:"OK"}` with nothing queued) normalises to `[]`.
 */
export function normaliseReceiveBody(body: unknown): Record<string, unknown>[] {
  if (body === null || body === undefined || body === "") return [];
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (typeof body !== "object") return [];
  const obj = body as Record<string, unknown>;
  if (Array.isArray(obj.messages)) return obj.messages as Record<string, unknown>[];
  if ("data" in obj) return [obj];
  return [];
}
