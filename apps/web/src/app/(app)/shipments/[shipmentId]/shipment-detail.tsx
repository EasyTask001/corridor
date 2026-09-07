"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { isEditable } from "@corridor/domain";
import { CommodityForm } from "@/components/shipment/commodity-form";
import { ShipmentForm } from "@/components/shipment/shipment-form";
import { useTRPC } from "@/lib/trpc/client";

type Shipment = inferRouterOutputs<AppRouter>["shipment"]["get"];

export function ShipmentDetail({
  initial,
  partners,
  canWrite,
}: {
  initial: Shipment;
  partners: { id: string; label: string; type: string }[];
  canWrite: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [editingLine, setEditingLine] = useState<string | "new" | null>(null);

  const { data: s = initial } = useQuery({
    ...trpc.shipment.get.queryOptions({ id: initial.id }),
    initialData: initial,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: trpc.shipment.pathKey() });
  const onError = (e: { message: string }) => setError(e.message);
  const onSuccess = () => {
    setError(null);
    refresh();
  };
  const opts = { onSuccess, onError };

  const update = useMutation(trpc.shipment.update.mutationOptions(opts));
  const upsertCommodity = useMutation(trpc.shipment.commodities.upsert.mutationOptions(opts));
  const removeCommodity = useMutation(trpc.shipment.commodities.remove.mutationOptions(opts));
  const remove = useMutation(
    trpc.shipment.remove.mutationOptions({
      onSuccess: () => router.push("/shipments"),
      onError,
    }),
  );

  // Frozen while the movement carrying it has been transmitted (the DB guard
  // enforces the same rule).
  const editable =
    canWrite && (!s.movement || isEditable(s.movement.status)) && s.status !== "cancelled";

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm text-ink-500">
            <Link href="/shipments" className="hover:underline">
              Shipments
            </Link>{" "}
            /
          </div>
          <h1 className="mt-1 flex items-center gap-3 text-2xl font-semibold tracking-tight">
            <span className="font-mono">{s.controlNumber}</span>
            <span className="rounded bg-ink-100 px-2 py-0.5 text-xs uppercase">{s.regime}</span>
            <span className="rounded bg-ink-100 px-2 py-0.5 text-xs capitalize">
              {s.status.replace(/_/g, " ")}
            </span>
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            {s.movement ? (
              <>
                On{" "}
                <Link href={`/movements/${s.movement.id}`} className="hover:underline">
                  {s.movement.movementNumber}
                </Link>{" "}
                ({s.movement.status})
              </>
            ) : (
              "Not assigned to a movement yet."
            )}
          </p>
        </div>
        {editable && s.status === "draft" && (
          <button
            className="btn-secondary text-danger-500"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ id: s.id })}
          >
            Delete shipment
          </button>
        )}
      </header>

      {error && (
        <p role="alert" className="rounded-md bg-danger-500/10 px-3 py-2 text-sm text-danger-500">
          {error}
        </p>
      )}

      <ShipmentForm
        key={s.updatedAt.toString()}
        regime={s.regime}
        initial={{
          controlReference: s.controlReference,
          shipmentType: s.shipmentType,
          cargoType: s.cargoType,
          isPars: s.isPars,
          shipperId: s.shipperId,
          consigneeId: s.consigneeId,
          entryNumber: s.entryNumber,
          entryPortId: s.entryPortId,
          inBondEntryType: s.inBondEntryType,
          inBondDestinationPortId: s.inBondDestinationPortId,
          inBondNumber: s.inBondNumber,
          destinationPortId: s.destinationPortId,
          sublocationPortId: s.sublocationPortId,
          loadingCountry: s.loadingCountry,
          loadingProvince: s.loadingProvince,
          loadingCity: s.loadingCity,
          consigneeBusinessNumber: s.consigneeBusinessNumber,
          deliveryAddress: s.deliveryAddress,
          notes: s.notes,
        }}
        portLabels={s.ports}
        partners={partners}
        pending={update.isPending}
        disabled={!editable}
        submitLabel="Save shipment"
        onSubmit={(values) => update.mutate({ ...values, id: s.id })}
      />

      <section className="panel p-5">
        <h2 className="font-medium">Commodities</h2>
        <ul className="mt-3 space-y-1 text-sm">
          {s.commodities.length === 0 && (
            <li className="text-ink-500">No commodity lines on this shipment.</li>
          )}
          {s.commodities.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-baseline gap-x-3 border-b border-ink-100 py-1.5"
            >
              <span className="font-mono text-xs">{c.lineNumber}.</span>
              <span className="font-medium">{c.commodityDescription}</span>
              <span className="text-xs text-ink-500">
                {c.hsCode ?? "no HS"} · {c.weightKg ?? "—"} kg · {c.quantity ?? "—"}{" "}
                {c.quantityUnit ?? ""}
                {c.valueAmount != null ? ` · ${c.valueAmount} ${c.valueCurrency ?? ""}` : ""}
              </span>
              {c.hazmat.length > 0 && (
                <span className="rounded bg-warn-500/10 px-1.5 text-xs text-warn-500">
                  {c.hazmat.map((h) => h.unCode).join(", ")}
                </span>
              )}
              {editable && (
                <span className="ml-auto text-xs">
                  <button
                    className="mr-3 text-ink-500 hover:text-ink-950"
                    onClick={() => setEditingLine(c.id)}
                  >
                    Edit
                  </button>
                  <button
                    className="text-danger-500 hover:underline"
                    onClick={() => removeCommodity.mutate({ shipmentId: s.id, id: c.id })}
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {editable && !editingLine && (
          <button className="mt-3 btn-secondary" onClick={() => setEditingLine("new")}>
            Add commodity line
          </button>
        )}
        {editable && editingLine && (
          <div className="mt-3">
            <CommodityForm
              key={editingLine}
              initial={
                editingLine === "new"
                  ? null
                  : (s.commodities.find((c) => c.id === editingLine) ?? null)
              }
              pending={upsertCommodity.isPending}
              onCancel={() => setEditingLine(null)}
              onSubmit={(values) => {
                upsertCommodity.mutate({
                  ...values,
                  shipmentId: s.id,
                  ...(editingLine !== "new" && { id: editingLine }),
                });
                setEditingLine(null);
              }}
            />
          </div>
        )}
      </section>
    </div>
  );
}
