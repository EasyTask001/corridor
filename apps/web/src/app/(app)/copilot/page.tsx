import type { Metadata } from "next";
import { api } from "@/lib/trpc/server";
import { CopilotChat } from "./copilot-chat";

export const metadata: Metadata = { title: "Copilot" };

export default async function CopilotPage() {
  const caller = await api();
  const [capabilities, regulations] = await Promise.all([
    caller.copilot.capabilities(),
    caller.copilot.regulations.list({}),
  ]);

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Compliance copilot</h1>
        <p className="text-sm text-ink-500">
          Answers cite ingested CBP/CBSA guidance and your organization&apos;s own movement notes,
          and can look up live movement, driver and tariff data.
          {capabilities.mode === "mock" && " Running in mock mode (no OPENAI_API_KEY configured)."}
        </p>
      </header>
      <CopilotChat
        suggestedQuestions={[...capabilities.suggestedQuestions]}
        regulationsIngested={capabilities.regulationsIngested}
        regulationCount={regulations.length}
      />
    </div>
  );
}
