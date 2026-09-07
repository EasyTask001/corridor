/**
 * The single place Corridor decides *who* runs an AI call.
 *
 * Precedence: Vercel AI Gateway (Claude models) when `AI_GATEWAY_API_KEY` is
 * set, else OpenAI direct when `OPENAI_API_KEY` is set, else nothing — in
 * which case every call site degrades to its deterministic local mode (mock
 * extractor, mock embedder, mock copilot). No key is ever required to run the
 * app or the test suite.
 *
 * Model IDs are env-configurable so a model swap is a deploy setting, not a
 * code change. This module must stay free of Next.js imports: it is used from
 * the worker (`packages/api`) as well as from route handlers.
 */
import { createGateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingModel, LanguageModel } from "ai";

export type AiRole = "extraction" | "copilot";

export type AiProvider =
  { kind: "none" } | { kind: "gateway"; apiKey: string } | { kind: "openai"; apiKey: string };

export type AiProviderKind = AiProvider["kind"];

/** Model IDs used when the matching env var is unset. */
export const DEFAULT_MODELS = {
  gateway: {
    extraction: "anthropic/claude-sonnet-4.5",
    copilot: "anthropic/claude-sonnet-4.5",
    embedding: "openai/text-embedding-3-small",
  },
  openai: {
    extraction: "gpt-4.1-mini",
    copilot: "gpt-4.1-mini",
    embedding: "text-embedding-3-small",
  },
} as const;

/** Env var that overrides each model ID, whichever provider is in play. */
const MODEL_ENV_VAR = {
  extraction: "CORRIDOR_EXTRACTION_MODEL",
  copilot: "CORRIDOR_COPILOT_MODEL",
  embedding: "CORRIDOR_EMBEDDING_MODEL",
} as const;

export type ModelSlot = keyof typeof MODEL_ENV_VAR;

/** Gateway wins over OpenAI when both keys are present. */
export function resolveAiProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
  const gatewayKey = env.AI_GATEWAY_API_KEY?.trim();
  if (gatewayKey) return { kind: "gateway", apiKey: gatewayKey };
  const openaiKey = env.OPENAI_API_KEY?.trim();
  if (openaiKey) return { kind: "openai", apiKey: openaiKey };
  return { kind: "none" };
}

/** True when a real provider is configured (i.e. not the deterministic local mode). */
export function aiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAiProvider(env).kind !== "none";
}

/** The model ID that would be used for a slot, or null when no provider is configured. */
export function modelId(slot: ModelSlot, env: NodeJS.ProcessEnv = process.env): string | null {
  const provider = resolveAiProvider(env);
  if (provider.kind === "none") return null;
  return env[MODEL_ENV_VAR[slot]]?.trim() || DEFAULT_MODELS[provider.kind][slot];
}

/**
 * Provenance string stored on documents / embeddings, e.g.
 * `gateway:anthropic/claude-sonnet-4.5` or `openai:gpt-4.1-mini`.
 */
export function aiProviderLabel(slot: ModelSlot, env: NodeJS.ProcessEnv = process.env): string {
  const provider = resolveAiProvider(env);
  if (provider.kind === "none") return "mock";
  return `${provider.kind}:${modelId(slot, env)}`;
}

/** A chat/structured-output model for `role`, or null when no provider is configured. */
export function languageModel(
  role: AiRole,
  env: NodeJS.ProcessEnv = process.env,
): { model: LanguageModel; id: string; label: string } | null {
  const provider = resolveAiProvider(env);
  if (provider.kind === "none") return null;
  const id = modelId(role, env)!;
  const model =
    provider.kind === "gateway"
      ? createGateway({ apiKey: provider.apiKey })(id)
      : createOpenAI({ apiKey: provider.apiKey })(id);
  return { model, id, label: `${provider.kind}:${id}` };
}

/** A text-embedding model, or null when no provider is configured. */
export function embeddingModel(
  env: NodeJS.ProcessEnv = process.env,
): { model: EmbeddingModel; id: string; label: string } | null {
  const provider = resolveAiProvider(env);
  if (provider.kind === "none") return null;
  const id = modelId("embedding", env)!;
  const model =
    provider.kind === "gateway"
      ? createGateway({ apiKey: provider.apiKey }).textEmbeddingModel(id)
      : createOpenAI({ apiKey: provider.apiKey }).textEmbeddingModel(id);
  return { model, id, label: `${provider.kind}:${id}` };
}
