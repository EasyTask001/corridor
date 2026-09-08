import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { ShipmentDetail } from "./shipment-detail";

export const metadata: Metadata = { title: "Shipment" };

export default async function ShipmentPage({
  params,
}: {
  params: Promise<{ shipmentId: string }>;
}) {
  const session = await getSession();
  if (!session?.permissions.has("shipment.read")) redirect("/dashboard");

  const { shipmentId } = await params;
  const caller = await api();
  const shipment = await caller.shipment.get({ id: shipmentId }).catch((e: unknown) => {
    if (e instanceof TRPCError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const partners = await caller.party.partners.list({ limit: 200, offset: 0 });

  return (
    <ShipmentDetail
      initial={shipment}
      partners={partners.rows.map((p) => ({
        id: p.id,
        label: p.name,
        type: p.type,
        country: (p.address as { country?: string } | null)?.country ?? null,
      }))}
      canWrite={session.permissions.has("shipment.write")}
    />
  );
}
