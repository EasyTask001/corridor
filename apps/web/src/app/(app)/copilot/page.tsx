import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { CopilotChat } from "./copilot-chat";

export const metadata: Metadata = { title: "Copilot" };

export default async function CopilotPage() {
  // Without `copilot.use` every procedure on this page (and the chat route)
  // rejects, so say so rather than rendering a chat that can only fail.
  const session = await getSession();
  if (!session?.permissions.has("copilot.use")) {
    return (
      <div className="max-w-xl">
        <h1 className="text-2xl font-semibold tracking-tight">Compliance copilot</h1>
        <p className="mt-2 text-sm text-fg-secondary">
          The compliance copilot is not available for your role. Ask an owner or admin to grant
          &ldquo;Use the compliance copilot&rdquo;.
        </p>
      </div>
    );
  }

  const caller = await api();
  const [capabilities, regulations] = await Promise.all([
    caller.copilot.capabilities(),
    caller.copilot.regulations.list({}),
  ]);

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Compliance copilot</h1>
        <p className="text-sm text-fg-secondary">
          Answers cite ingested CBP/CBSA guidance and your organization&apos;s own movement notes,
          and can look up live movement, driver and tariff data.
          {capabilities.mode === "mock" && " Running in mock mode (no AI provider configured)."}
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
