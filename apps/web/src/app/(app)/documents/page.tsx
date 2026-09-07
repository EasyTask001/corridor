import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { DocumentsPanel } from "./documents-panel";

export const metadata: Metadata = { title: "Documents" };

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ movement?: string }>;
}) {
  const session = await getSession();
  if (!session?.permissions.has("document.read")) redirect("/dashboard");
  const { movement } = await searchParams;
  const caller = await api();
  const [list, capabilities, movements] = await Promise.all([
    caller.documents.list({ limit: 100, offset: 0 }),
    caller.documents.capabilities(),
    session.permissions.has("movement.read")
      ? caller.movement.list({ status: ["draft", "rejected"], limit: 100, offset: 0 })
      : { rows: [], total: 0 },
  ]);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
        <p className="text-sm text-ink-500">
          Upload bills of lading, commercial invoices and rate confirmations. Corridor extracts the
          shipment data (
          {capabilities.extractor === "model" ? capabilities.model : "mock extractor"}), you confirm
          it, then it lands on the manifest — AI output never reaches a manifest without a human
          check.
        </p>
      </header>
      <DocumentsPanel
        initial={list}
        canUpload={session.permissions.has("document.upload")}
        canReview={session.permissions.has("document.review_extraction")}
        draftMovements={movements.rows.map((m) => ({
          id: m.id,
          label: `${m.movementNumber}${m.tripNumber ? ` · ${m.tripNumber}` : ""}`,
        }))}
        preselectedMovementId={movement ?? null}
      />
    </div>
  );
}
