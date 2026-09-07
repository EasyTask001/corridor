import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { cookies } from "next/headers";
import { ACTIVE_ORG_COOKIE, createContext, copilotTools, retrieveContext } from "@corridor/api";
import { COPILOT_SYSTEM_PROMPT, buildContextBlock } from "@corridor/ai";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const FALLBACK_MODEL = "gpt-4.1-mini";

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

  const { messages }: { messages: UIMessage[] } = await req.json();
  const lastUserText =
    [...messages]
      .reverse()
      .find((m) => m.role === "user")
      ?.parts.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ") ?? "";

  const context = lastUserText
    ? await ctx.rls((tx) => retrieveContext(tx, orgId, lastUserText))
    : { regulations: [], orgKnowledge: [] };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Mock mode: no model configured. Retrieval still runs so citations can
    // be exercised end-to-end; the "answer" is a plain summary of what
    // retrieval found, streamed through the same UI message protocol.
    const summary = context.regulations.length
      ? `Mock copilot (no OPENAI_API_KEY configured): closest regulation match is "${context.regulations[0]!.title}" (${context.regulations[0]!.source}).`
      : "Mock copilot (no OPENAI_API_KEY configured): no matching regulation found for that question. Configure OPENAI_API_KEY to enable the real model and tools.";
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "data-citations", data: context });
        writer.write({ type: "text-start", id: "mock" });
        writer.write({ type: "text-delta", id: "mock", delta: summary });
        writer.write({ type: "text-end", id: "mock" });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }
  const contextBlock = buildContextBlock(
    context.regulations.map(
      (r: { source: string; title: string; content: string }) =>
        `(${r.source} — ${r.title}) ${r.content}`,
    ),
    context.orgKnowledge.map((k: { content: string }) => k.content),
  );

  const openai = createOpenAI({ apiKey });
  const model = openai(process.env.CORRIDOR_COPILOT_MODEL ?? FALLBACK_MODEL);

  const result = streamText({
    model,
    system: contextBlock ? `${COPILOT_SYSTEM_PROMPT}\n\n${contextBlock}` : COPILOT_SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    // Each tool call opens its own short-lived RLS transaction (see
    // copilotTools) rather than holding one open for the whole stream.
    tools: copilotTools(ctx.rls, orgId),
    stopWhen: stepCountIs(4),
    onError: ({ error }) => console.error("[copilot]", error),
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
