import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { ReviewWorkspace } from "./review-workspace";

export const metadata: Metadata = { title: "Review extraction" };

export default async function DocumentReviewPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = await params;
  const session = await getSession();
  if (!session?.permissions.has("document.read")) redirect("/dashboard");
  const caller = await api();
  let doc: Awaited<ReturnType<typeof caller.documents.get>>;
  try {
    doc = await caller.documents.get({ id: documentId });
  } catch (e) {
    if (e instanceof TRPCError && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const [movements, options] = await Promise.all([
    caller.movement.list({ status: ["draft", "rejected"], limit: 100, offset: 0 }),
    caller.movement.options(),
  ]);
  return (
    <ReviewWorkspace
      initial={doc}
      canReview={session.permissions.has("document.review_extraction")}
      canUpload={session.permissions.has("document.upload")}
      draftMovements={movements.rows.map((m) => ({
        id: m.id,
        label: `${m.movementNumber}${m.tripNumber ? ` · ${m.tripNumber}` : ""}`,
        status: m.status,
      }))}
      partners={options.partners}
    />
  );
}
