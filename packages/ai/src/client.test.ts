import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  aiConfigured,
  aiProviderLabel,
  embeddingModel,
  languageModel,
  modelId,
  resolveAiProvider,
} from "./client";

const env = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;

const NONE = env({});
const OPENAI = env({ OPENAI_API_KEY: "sk-test" });
const GATEWAY = env({ AI_GATEWAY_API_KEY: "gw-test" });
const BOTH = env({ AI_GATEWAY_API_KEY: "gw-test", OPENAI_API_KEY: "sk-test" });

describe("resolveAiProvider", () => {
  it("prefers the gateway, falls back to OpenAI, then to nothing", () => {
    expect(resolveAiProvider(GATEWAY)).toEqual({ kind: "gateway", apiKey: "gw-test" });
    expect(resolveAiProvider(OPENAI)).toEqual({ kind: "openai", apiKey: "sk-test" });
    expect(resolveAiProvider(BOTH).kind).toBe("gateway");
    expect(resolveAiProvider(NONE)).toEqual({ kind: "none" });
  });

  it("treats a blank key as absent so an empty Vercel env var cannot break the app", () => {
    expect(resolveAiProvider(env({ AI_GATEWAY_API_KEY: "   ", OPENAI_API_KEY: "sk" })).kind).toBe(
      "openai",
    );
    expect(resolveAiProvider(env({ OPENAI_API_KEY: "" })).kind).toBe("none");
  });

  it("aiConfigured is the has-a-provider predicate the call sites branch on", () => {
    expect(aiConfigured(GATEWAY)).toBe(true);
    expect(aiConfigured(OPENAI)).toBe(true);
    expect(aiConfigured(NONE)).toBe(false);
  });
});

describe("model IDs", () => {
  it("defaults to Claude via the gateway and gpt-4.1-mini direct", () => {
    expect(modelId("extraction", GATEWAY)).toBe("anthropic/claude-sonnet-4.5");
    expect(modelId("copilot", GATEWAY)).toBe("anthropic/claude-sonnet-4.5");
    expect(modelId("embedding", GATEWAY)).toBe("openai/text-embedding-3-small");

    expect(modelId("extraction", OPENAI)).toBe("gpt-4.1-mini");
    expect(modelId("copilot", OPENAI)).toBe("gpt-4.1-mini");
    expect(modelId("embedding", OPENAI)).toBe("text-embedding-3-small");

    expect(modelId("extraction", NONE)).toBeNull();
  });

  it("each slot is overridable by its env var", () => {
    const overridden = env({
      AI_GATEWAY_API_KEY: "gw-test",
      CORRIDOR_EXTRACTION_MODEL: "anthropic/claude-haiku-4.5",
      CORRIDOR_COPILOT_MODEL: "openai/gpt-5",
      CORRIDOR_EMBEDDING_MODEL: "cohere/embed-v4.0",
    });
    expect(modelId("extraction", overridden)).toBe("anthropic/claude-haiku-4.5");
    expect(modelId("copilot", overridden)).toBe("openai/gpt-5");
    expect(modelId("embedding", overridden)).toBe("cohere/embed-v4.0");
  });

  it("labels carry the provider so extraction provenance is unambiguous", () => {
    expect(aiProviderLabel("extraction", GATEWAY)).toBe(
      `gateway:${DEFAULT_MODELS.gateway.extraction}`,
    );
    expect(aiProviderLabel("extraction", OPENAI)).toBe("openai:gpt-4.1-mini");
    expect(aiProviderLabel("embedding", GATEWAY)).toBe("gateway:openai/text-embedding-3-small");
    expect(aiProviderLabel("copilot", NONE)).toBe("mock");
  });
});

describe("model construction", () => {
  it("builds a language model for each configured provider and none otherwise", () => {
    const gw = languageModel("copilot", GATEWAY);
    expect(gw?.id).toBe("anthropic/claude-sonnet-4.5");
    expect(gw?.label).toBe("gateway:anthropic/claude-sonnet-4.5");
    expect(gw?.model).toBeTruthy();

    const oa = languageModel("extraction", OPENAI);
    expect(oa?.id).toBe("gpt-4.1-mini");
    expect(oa?.label).toBe("openai:gpt-4.1-mini");
    expect(oa?.model).toBeTruthy();

    expect(languageModel("extraction", NONE)).toBeNull();
  });

  it("builds an embedding model for each configured provider and none otherwise", () => {
    expect(embeddingModel(GATEWAY)?.label).toBe("gateway:openai/text-embedding-3-small");
    expect(embeddingModel(OPENAI)?.label).toBe("openai:text-embedding-3-small");
    expect(embeddingModel(NONE)).toBeNull();
  });
});
