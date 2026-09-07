@AGENTS.md

## AI providers (apps/web)

Every AI call — document extraction, copilot chat, copilot embeddings — resolves its provider
through `packages/ai/src/client.ts`. Never call `createOpenAI` / `createGateway` from a route
handler or a component; import `languageModel(role)` / `embeddingModel()` from `@corridor/ai`
instead, and branch the mock path on a `null` return (or `aiConfigured()`).

| Env                                             | Effect                                                        |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `AI_GATEWAY_API_KEY`                            | Vercel AI Gateway, Claude by default. Wins over OpenAI.       |
| `OPENAI_API_KEY`                                | OpenAI direct (`gpt-4.1-mini`), used only when no gateway key |
| neither                                         | deterministic local mode — mock extractor/embedder/copilot    |
| `CORRIDOR_{EXTRACTION,COPILOT,EMBEDDING}_MODEL` | override the model ID for that slot                           |

Defaults through the gateway are `anthropic/claude-sonnet-4.5` (extraction and copilot) and
`openai/text-embedding-3-small` (embeddings). The embedding model must stay 1536-dimensional —
that is the pgvector column width, and `createEmbedder` throws on any other width.

The copilot route (`src/app/api/copilot/chat/route.ts`) still runs retrieval in mock mode so
citations can be exercised without a key.
