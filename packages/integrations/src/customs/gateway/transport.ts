/**
 * The only vendor-specific file: how bytes reach the certified EDI gateway.
 * Everything above it speaks the provider-neutral contract in mapping.ts.
 */
import { CustomsTransportError } from "../types";

/** Reject endpoints that could target local or private server infrastructure. */
export function isSafeGatewayBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]") return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
    const private172 = /^172\.(\d{1,3})\./.exec(host)?.[1];
    if (private172 && Number(private172) >= 16 && Number(private172) <= 31) return false;
    if (host === "169.254.169.254" || host === "0.0.0.0") return false;
    return true;
  } catch {
    return false;
  }
}

export interface GatewayTransport {
  post(path: string, body: unknown): Promise<unknown>;
  get(path: string): Promise<unknown>;
}

export interface HttpTransportOptions {
  baseUrl: string;
  apiKey: string;
  /** Per-call deadline; the gateway answers a manifest in well under this. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const retryable = (status: number) => status === 429 || status >= 500;

/** Bearer-authenticated JSON over HTTPS, 30 s deadline, typed failures. */
export function createHttpTransport(opts: HttpTransportOptions): GatewayTransport {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeout = opts.timeoutMs ?? 30_000;

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          Accept: "application/json",
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      throw new CustomsTransportError(
        aborted ? `Customs gateway timed out after ${timeout} ms` : "Customs gateway unreachable",
        aborted ? 504 : 503,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    const json: unknown = text ? safeJson(text) : null;
    if (!res.ok) {
      const detail =
        json && typeof json === "object" && "message" in json
          ? String(json.message)
          : `HTTP ${res.status}`;
      throw new CustomsTransportError(
        `Customs gateway: ${detail}`,
        res.status,
        retryable(res.status),
      );
    }
    return json;
  }

  return {
    post: (path, body) => call("POST", path, body),
    get: (path) => call("GET", path),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Offline stand-in used when `gateway` mode has no base URL / API key (and in
 * tests): answers from a route table instead of the network.
 */
export function createFixtureTransport(
  routes: Record<string, (body?: unknown) => unknown>,
): GatewayTransport {
  const resolve = (method: string, path: string, body?: unknown) => {
    const key = `${method} ${path}`;
    // Exact route first, then the longest pattern with `*` wildcards.
    const match =
      routes[key] ??
      Object.entries(routes)
        .filter(([pattern]) => patternMatches(pattern, key))
        .sort((a, b) => b[0].length - a[0].length)[0]?.[1];
    if (!match) throw new CustomsTransportError(`Customs gateway: no route for ${key}`, 404, false);
    return Promise.resolve(match(body));
  };
  return {
    post: (path, body) => resolve("POST", path, body),
    get: (path) => resolve("GET", path),
  };
}

function patternMatches(pattern: string, key: string): boolean {
  const re = new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+")}$`,
  );
  return re.test(key);
}
