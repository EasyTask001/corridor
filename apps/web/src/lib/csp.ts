export type CspEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * `wss://` mirrors whichever scheme Supabase is actually reached over, so a
 * local `http://127.0.0.1:...` project gets `ws://` and a hosted `https://`
 * project gets `wss://` — mismatching the two silently blocks Realtime.
 */
function supabaseOrigins(env: CspEnv): { http: string; ws: string } {
  const raw = env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return { http: "", ws: "" };
  try {
    const url = new URL(raw);
    return {
      http: url.origin,
      ws: `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`,
    };
  } catch {
    return { http: "", ws: "" };
  }
}

function enforced(env: CspEnv): boolean {
  return env.CSP_ENFORCE === "true";
}

export function buildCspHeader(nonce: string, env: CspEnv = process.env): string {
  const { http, ws } = supabaseOrigins(env);
  // React needs eval() in dev only, to reconstruct cross-environment call stacks for
  // debugging; neither React nor Next.js use it in production. See the Next.js CSP guide.
  const isDev = env.NODE_ENV === "development";
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Nonces don't cover React's inline `style={{}}` attribute (only <style> tags),
    // so 'unsafe-inline' stays for style-src.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    `img-src 'self' data: blob:${http ? ` ${http}` : ""}`,
    `connect-src 'self'${http ? ` ${http}` : ""}${ws ? ` ${ws}` : ""} https://*.ingest.sentry.io`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://billing.stripe.com",
    "object-src 'none'",
  ];
  // Chrome logs a console error for this directive under a report-only policy
  // ("ignored when delivered in a report-only policy") — real noise, not a
  // real violation, so it's only sent once the policy is actually enforced.
  if (enforced(env)) directives.push("upgrade-insecure-requests");
  if (env.CSP_REPORT_URI) directives.push(`report-uri ${env.CSP_REPORT_URI}`);
  return directives.join("; ");
}

/**
 * Report-only until CSP_ENFORCE=true — planned as a one-pilot-week rollout
 * step so Sentry CSP reports can be reviewed before the policy blocks anything.
 */
export function cspHeaderName(env: CspEnv = process.env): string {
  return enforced(env) ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}

export function generateNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}
