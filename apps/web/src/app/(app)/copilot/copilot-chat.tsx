"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Alert } from "@corridor/ui";

interface RegulationCitation {
  regulationDocumentId: string;
  title: string;
  source: string;
  jurisdiction: "US" | "CA";
  url: string | null;
  content: string;
  similarity: number;
  authority: string | null;
  lastVerifiedAt: string | null;
}
interface OrgCitation {
  id: string;
  sourceType: string;
  content: string;
  similarity: number;
}

function CitationList({
  regulations,
  orgKnowledge,
}: {
  regulations: RegulationCitation[];
  orgKnowledge: OrgCitation[];
}) {
  if (regulations.length === 0 && orgKnowledge.length === 0) return null;
  // Two chunks of the same regulation can both clear the similarity bar; show
  // the document once, keeping whichever chunk matched best.
  const byDocument = new Map<string, RegulationCitation>();
  for (const r of regulations) {
    const existing = byDocument.get(r.regulationDocumentId);
    if (!existing || r.similarity > existing.similarity) byDocument.set(r.regulationDocumentId, r);
  }
  const dedupedRegulations = [...byDocument.values()].sort((a, b) => b.similarity - a.similarity);
  return (
    <div className="mt-2 space-y-1.5 border-t border-border-default pt-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-fg-secondary">
        Sources
      </div>
      {dedupedRegulations.map((r) => (
        <div
          key={`${r.regulationDocumentId}-${r.content.slice(0, 20)}`}
          className="text-xs text-fg-secondary"
        >
          <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-fg-primary">
            {r.jurisdiction}
          </span>{" "}
          {r.authority && (
            <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-fg-primary">
              {r.authority}
            </span>
          )}{" "}
          {r.url ? (
            <a
              href={r.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-fg-primary hover:underline"
            >
              {r.source} — {r.title}
            </a>
          ) : (
            <span className="font-medium text-fg-primary">
              {r.source} — {r.title}
            </span>
          )}{" "}
          <span className="text-fg-secondary/60">
            ({Math.round(r.similarity * 100)}% match
            {r.lastVerifiedAt ? `, verified ${r.lastVerifiedAt}` : ""})
          </span>
        </div>
      ))}
      {orgKnowledge.map((k) => (
        <div key={k.id} className="text-xs text-fg-secondary">
          <span className="rounded bg-signal-500/10 px-1.5 py-0.5 font-mono text-[10px] text-status-signal">
            your org
          </span>{" "}
          <span className="italic">{k.content}</span>
        </div>
      ))}
    </div>
  );
}

export function CopilotChat({
  suggestedQuestions,
  regulationsIngested,
  regulationCount,
}: {
  suggestedQuestions: string[];
  regulationsIngested: boolean;
  regulationCount: number;
}) {
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/copilot/chat" }), []);
  const { messages, sendMessage, status } = useChat({ transport });
  const [input, setInput] = useState("");

  const submit = (text: string) => {
    if (!text.trim()) return;
    setInput("");
    void sendMessage({ text });
  };

  const busy = status === "submitted" || status === "streaming";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Alert variant="info" className="mb-3">
        Corridor Copilot gives operational guidance from paraphrased, dated regulatory summaries
        and your organization&apos;s own notes. It is not legal or customs-broker advice — verify
        anything border-critical against the linked primary source or your broker. See the{" "}
        <Link href="/legal/ai-disclaimer" className="underline hover:no-underline">
          AI disclaimer
        </Link>
        .
      </Alert>

      {!regulationsIngested && (
        <Alert variant="warn" className="mb-3">
          No regulations have been ingested yet — answers will rely only on tool lookups and
          organization notes. Run the ingestion step (part of <code>pnpm db:seed</code>) to enable
          citations.
        </Alert>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto rounded-lg border border-border-default bg-surface-raised p-4">
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-fg-secondary">
              Ask about crossing requirements, a specific movement, a driver&apos;s documents, or an
              HS code.{" "}
              {regulationsIngested && `${regulationCount} regulation summaries are indexed.`}
            </p>
            <div className="flex flex-wrap gap-2">
              {suggestedQuestions.map((q) => (
                <button
                  key={q}
                  onClick={() => submit(q)}
                  className="btn-secondary px-3 py-1.5 text-xs"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => {
          const citationsPart = m.parts.find(
            (
              p,
            ): p is {
              type: "data-citations";
              data: { regulations: RegulationCitation[]; orgKnowledge: OrgCitation[] };
            } => p.type === "data-citations",
          );
          const citations = citationsPart?.data;
          return (
            <div
              key={m.id}
              className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
            >
              <div
                data-message-role={m.role}
                className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm ${m.role === "user" ? "bg-accent text-accent-fg" : "bg-surface-sunken text-fg-primary"}`}
              >
                {m.parts.map((p, i) =>
                  p.type === "text" ? (
                    <span key={i} className="whitespace-pre-wrap">
                      {p.text}
                    </span>
                  ) : p.type.startsWith("tool-") ? (
                    <div
                      key={i}
                      className="mt-1 rounded bg-surface-sunken/60 px-2 py-1 font-mono text-[11px] text-fg-secondary"
                    >
                      🔧 {p.type.replace("tool-", "")}
                      {"state" in p && p.state === "output-available" ? " — done" : "…"}
                    </div>
                  ) : null,
                )}
                {citations && m.role === "assistant" && (
                  <CitationList
                    regulations={citations.regulations}
                    orgKnowledge={citations.orgKnowledge}
                  />
                )}
              </div>
            </div>
          );
        })}
        {busy && <p className="text-xs text-fg-secondary/60">Thinking…</p>}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the copilot…"
          aria-label="Ask the copilot"
          className="input"
          disabled={busy}
        />
        <button type="submit" className="btn-signal" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
