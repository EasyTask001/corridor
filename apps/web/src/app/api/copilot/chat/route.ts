import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import * as Sentry from "@sentry/nextjs";
import { cookies } from "next/headers";
import {
  ACTIVE_ORG_COOKIE,
  createContext,
  copilotTools,
  rateLimitFor,
  recordUsage,
  retrieveContext,
} from "@corridor/api";
import { COPILOT_SYSTEM_PROMPT, buildContextBlock, languageModel } from "@corridor/ai";
import { corridorMetrics } from "@corridor/observability";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const [supabase, cookieStore] = await Promise.all([createSupabaseServerClient(), cookies()]);
  const ctx = await createContext({
    headers: req.headers,
    supabase,
    activeOrgCookie: cookieStore.get(ACTIVE_ORG_COOKIE)?.value ?? null,
  });

  if (!ctx.session) return new Response("Unauthorized", { status: 401 });
  if (!ctx.session.activeOrganizationId)
    return new Response("No active organization", { status: 403 });
  if (!ctx.session.permissions.has("copilot.use"))
    return new Response("Forbidden", { status: 403 });
  const orgId = ctx.session.activeOrganizationId;

  // Same `ai` tier the copilot tRPC procedures use — applied before any model
  // or embedding call so a burst costs nothing.
  const limit = await rateLimitFor("ai", ctx.session.plan).check({
    orgId,
    userId: ctx.session.user.id,
  });
  if (!limit.success) {
    return new Response(
      `Rate limit of ${limit.limit} copilot requests/minute exceeded on the ${ctx.session.plan} plan.`,
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const body = (await req.json()) as { messages?: unknown };
  if (!Array.isArray(body.messages) || body.messages.length > 50) {
    return new Response("Invalid message history", { status: 400 });
  }
  const messages = body.messages as UIMessage[];
  const messageBytes = JSON.stringify(messages).length;
  if (messageBytes > 200_000) {
    return new Response("Message history is too large", { status: 413 });
  }
  const lastUserText =
    [...messages]
      .reverse()
      .find((m) => m.role === "user")
      ?.parts.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ") ?? "";

  let context: Awaited<ReturnType<typeof retrieveContext>> = {
    regulations: [],
    orgKnowledge: [],
  };
  if (lastUserText) {
    try {
      context = await ctx.rls((tx) => retrieveContext(tx, orgId, lastUserText));
    } catch (error) {
      corridorMetrics.aiFailure({ operation: "embedding", provider: "configured" });
      Sentry.captureException(error, { tags: { component: "copilot", operation: "embedding" } });
      throw error;
    }
  }

  /**
   * Meter one assistant message. Never allowed to fail the answer the user is
   * already reading: a lost meter row is a billing rounding error, a 500 is an
   * outage.
   */
  const meterMessage = async (mode: "model" | "mock") => {
    try {
      await ctx.rls((tx) => recordUsage(tx, orgId, "copilot_messages", 1, { mode }));
    } catch (e) {
      console.error("[copilot] usage metering failed", e);
    }
  };

  const resolved = languageModel("copilot");
  if (!resolved) {
    // Mock mode: no model configured. Retrieval still runs so citations can
    // be exercised end-to-end; the "answer" is a plain summary of what
    // retrieval found, streamed through the same UI message protocol.
    const summary = context.regulations.length
      ? `Mock copilot (no AI provider configured): closest regulation match is "${context.regulations[0]!.title}" (${context.regulations[0]!.source}).`
      : "Mock copilot (no AI provider configured): no matching regulation found for that question. Set AI_GATEWAY_API_KEY (or OPENAI_API_KEY) to enable the real model and tools.";
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "data-citations", data: context });
        writer.write({ type: "text-start", id: "mock" });
        writer.write({ type: "text-delta", id: "mock", delta: summary });
        writer.write({ type: "text-end", id: "mock" });
      },
    });
    await meterMessage("mock");
    return createUIMessageStreamResponse({ stream });
  }
  const contextBlock = buildContextBlock(
    context.regulations.map((r) => ({
      content: r.content,
      source: r.source,
      title: r.title,
      authority: r.authority,
      lastVerifiedAt: r.lastVerifiedAt,
    })),
    context.orgKnowledge.map((k: { content: string }) => k.content),
  );

  const result = streamText({
    model: resolved.model,
    system: contextBlock ? `${COPILOT_SYSTEM_PROMPT}\n\n${contextBlock}` : COPILOT_SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    // Each tool call opens its own short-lived RLS transaction (see
    // copilotTools) rather than holding one open for the whole stream.
    tools: copilotTools(ctx.rls, orgId),
    stopWhen: stepCountIs(4),
    onError: ({ error }) => {
      console.error("[copilot]", error);
      corridorMetrics.aiFailure({ operation: "copilot", provider: resolved.label });
      Sentry.captureException(error, { tags: { component: "copilot", operation: "stream" } });
    },
    // Fires once the assistant message is complete (after any tool steps), so
    // the meter counts delivered answers, not model round-trips.
    onFinish: () => meterMessage("model"),
  });

  // Citations travel as a UI message data-part (not a response header) so
  // they land in `message.parts` on the client alongside the streamed text.
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "data-citations", data: context });
      writer.merge(toUIMessageStream({ stream: result.stream }));
    },
  });
  return createUIMessageStreamResponse({ stream });
}
