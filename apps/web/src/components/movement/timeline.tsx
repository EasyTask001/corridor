"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { useTRPC } from "@/lib/trpc/client";

type Event = inferRouterOutputs<AppRouter>["movement"]["get"]["events"][number];

const ACTOR: Record<Event["actorType"], { label: string; cls: string }> = {
  user: { label: "User", cls: "bg-ink-700" },
  system: { label: "System", cls: "bg-ink-300" },
  customs_api: { label: "Customs", cls: "bg-signal-500" },
  ai: { label: "AI", cls: "bg-ok-500" },
};

function describe(e: Event): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.eventType) {
    case "status_change":
      if (!e.fromStatus)
        return `Created as ${e.toStatus}${p.movementNumber ? ` (${p.movementNumber})` : ""}`;
      return `${e.fromStatus} → ${e.toStatus}${p.reason ? ` — ${p.reason}` : ""}`;
    case "customs_response":
      return `Customs ${String(p.decision)}${p.referenceNumber ? ` · ref ${p.referenceNumber}` : ""}${p.message ? ` — ${p.message}` : ""}${p.simulated ? " (simulated)" : ""}`;
    case "customs_event":
      return `${String(p.label ?? p.code)}${p.shipmentControlNumber ? ` · ${p.shipmentControlNumber}` : ""}${p.entryNumber ? ` · entry ${p.entryNumber}${p.entryPortCode ? ` @ ${p.entryPortCode}` : ""}` : ""}`;
    case "amendment":
      return `Amendment #${p.amendmentNumber}${p.reasonCode ? ` (${p.reasonCode})` : ""}: ${p.reason}`;
    case "note":
      return String(p.body ?? "");
    case "ai_flag":
      return `AI flag: ${String(p.title ?? "")}`;
  }
}

export function Timeline({
  movementId,
  events,
  canNote,
  onChanged,
}: {
  movementId: string;
  events: Event[];
  canNote: boolean;
  onChanged: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const getKey = trpc.movement.get.queryKey({ id: movementId });

  /**
   * The note shows up in the timeline as soon as it is posted — the round trip
   * also enqueues an embedding job, so waiting for it is a visible stall. The
   * placeholder carries a client-side id and no actor name; `onChanged()` in
   * `onSettled` refetches and replaces it with the server's row.
   */
  const addNote = useMutation(
    trpc.movement.addNote.mutationOptions({
      onMutate: async (vars) => {
        await qc.cancelQueries({ queryKey: getKey });
        const previous = qc.getQueryData(getKey);
        const optimistic: Event = {
          id: `optimistic-${crypto.randomUUID()}`,
          eventType: "note",
          fromStatus: null,
          toStatus: null,
          payload: { body: vars.body },
          actorType: "user",
          actorId: null,
          actorName: null,
          occurredAt: new Date(),
        };
        qc.setQueryData(getKey, (old) =>
          old ? { ...old, events: [optimistic, ...old.events] } : undefined,
        );
        setBody("");
        return { previous, body: vars.body };
      },
      onError: (_e, _v, ctx) => {
        if (ctx?.previous !== undefined) qc.setQueryData(getKey, ctx.previous);
        if (ctx?.body) setBody(ctx.body); // give the text back to the user
      },
      onSettled: onChanged,
    }),
  );

  return (
    <aside className="flex h-full flex-col">
      <h2 className="text-xs font-medium uppercase tracking-wide text-ink-500">Timeline</h2>
      <ol className="mt-3 flex-1 space-y-3 overflow-y-auto pr-1" aria-label="Movement timeline">
        {events.map((e) => {
          const a = ACTOR[e.actorType];
          return (
            <li key={e.id} className="flex gap-3 text-sm">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${a.cls}`} aria-hidden />
              <div className="min-w-0">
                <div
                  className={
                    e.eventType === "note"
                      ? "text-ink-700"
                      : e.eventType === "customs_event"
                        ? "text-ink-950"
                        : "font-medium"
                  }
                >
                  {describe(e)}
                </div>
                <div className="text-xs text-ink-500">
                  {a.label}
                  {e.actorName ? ` · ${e.actorName}` : ""} ·{" "}
                  {new Date(e.occurredAt).toLocaleString("en-CA", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {canNote && (
        <form
          className="mt-3 flex gap-2 border-t border-ink-100 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) addNote.mutate({ movementId, body: body.trim() });
          }}
        >
          <input
            aria-label="Add note"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a note…"
            className="input"
          />
          <button className="btn-secondary" disabled={addNote.isPending || !body.trim()}>
            Post
          </button>
        </form>
      )}
    </aside>
  );
}
