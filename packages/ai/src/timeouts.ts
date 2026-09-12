/**
 * Per-call deadlines for AI SDK calls (`generateObject`, `embed`, `embedMany`).
 * Without one, a hanging provider call hangs the request forever. Matches the
 * AbortController + setTimeout pattern in
 * `packages/integrations/src/customs/gateway/transport.ts`.
 */

export const AI_TIMEOUTS_MS = {
  extraction: 90_000,
  embedding: 20_000,
} as const;

/** `CORRIDOR_AI_TIMEOUT_MS_<KIND>`, e.g. `CORRIDOR_AI_TIMEOUT_MS_EXTRACTION`. */
function envMs(kind: keyof typeof AI_TIMEOUTS_MS, env: NodeJS.ProcessEnv): number {
  const raw = env[`CORRIDOR_AI_TIMEOUT_MS_${kind.toUpperCase()}`];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : AI_TIMEOUTS_MS[kind];
}

/** An AbortSignal that fires after the kind's deadline (env-overridable). */
export function aiTimeoutSignal(
  kind: keyof typeof AI_TIMEOUTS_MS,
  env: NodeJS.ProcessEnv = process.env,
): AbortSignal {
  const ms = envMs(kind, env);
  const controller = new AbortController();
  // `unknown` here, not the environment's declared setTimeout return type: in a
  // DOM/React Native lib environment that type is `number`, which narrows the
  // `typeof t === "object"` branch below to `never` and fails typecheck even
  // though the runtime check itself is correct in every environment.
  const t: unknown = setTimeout(
    () => controller.abort(new Error(`${kind} timed out after ${ms}ms`)),
    ms,
  );
  if (t && typeof t === "object" && "unref" in t) (t as { unref: () => void }).unref();
  return controller.signal;
}
