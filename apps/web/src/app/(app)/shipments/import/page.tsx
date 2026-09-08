import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { ImportWizard } from "./import-wizard";

export const metadata: Metadata = { title: "Import from CSV" };

export default async function ImportPage() {
  const session = await getSession();
  if (!session?.permissions.has("shipment.read")) redirect("/dashboard");
  const caller = await api();
  const [batches, shipments, commodities] = await Promise.all([
    caller.imports.list({ limit: 20, offset: 0 }),
    caller.imports.template({ kind: "shipments" }),
    caller.imports.template({ kind: "commodities" }),
  ]);
  return (
    <ImportWizard
      canRun={session.permissions.has("import.run")}
      initialBatches={batches}
      templates={{ shipments, commodities }}
    />
  );
}
