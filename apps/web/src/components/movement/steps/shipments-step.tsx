"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CommodityForm, type CommodityFormValues } from "@/components/shipment/commodity-form";
import { ShipmentForm, type ShipmentFormValues } from "@/components/shipment/shipment-form";
import { useTRPC } from "@/lib/trpc/client";
import { useMovementMutations, useWorkspace, type MovementShipment } from "../workspace-context";

const kindOf = (s: { shipmentType: string | null; cargoType: string | null }) =>
  (s.shipmentType ?? s.cargoType ?? "").replace(/_/g, " ");

/** `shipmentInput` is a discriminated union, so the regime has to be narrowed
 * into a literal before the form's flat values can be handed to the mutation. */
export function shipmentPayload(
  regime: "ACE" | "ACI",
  values: ShipmentFormValues,
  movementId?: string,
) {
  return regime === "ACE"
    ? { ...values, regime: "ACE" as const, shipmentType: values.shipmentType!, movementId }
    : { ...values, regime: "ACI" as const, cargoType: values.cargoType!, movementId };
}

export function ShipmentsStep() {
  const { movement: m, options, editable } = useWorkspace();
  const {
    createShipment,
    removeShipment,
    unassignShipments,
    upsertCommodity,
    removeCommodity,
    assignShipments,
  } = useMovementMutations();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [assigning, setAssigning] = useState(false);

  return (
    <div className="space-y-4">
      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-fg-secondary">
            <tr>
              <th className="px-3 py-2 font-medium">Control number</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Shipper → Consignee</th>
              <th className="px-3 py-2 text-right font-medium">Lines</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {m.shipments.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-5 text-fg-secondary">
                  No shipments on this movement yet.
                </td>
              </tr>
            )}
            {m.shipments.map((s) => (
              <ShipmentRows
                key={s.id}
                shipment={s}
                expanded={expanded === s.id}
                editable={editable}
                onToggle={() => setExpanded((cur) => (cur === s.id ? null : s.id))}
                onUnassign={() => unassignShipments.mutate({ shipmentIds: [s.id] })}
                onRemove={() => removeShipment.mutate({ id: s.id })}
                onSaveCommodity={(values, id) =>
                  upsertCommodity.mutate({ ...values, shipmentId: s.id, ...(id && { id }) })
                }
                onRemoveCommodity={(id) => removeCommodity.mutate({ shipmentId: s.id, id })}
                commodityPending={upsertCommodity.isPending}
              />
            ))}
          </tbody>
        </table>
      </div>

      {editable && !adding && !assigning && (
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => setAdding(true)}>
            Add shipment
          </button>
          <button className="btn-secondary" onClick={() => setAssigning(true)}>
            Assign existing
          </button>
        </div>
      )}

      {editable && adding && (
        <ShipmentForm
          regime={m.regime}
          initial={null}
          partners={options.partners}
          pending={createShipment.isPending}
          submitLabel="Save shipment"
          onCancel={() => setAdding(false)}
          onSubmit={(values) =>
            createShipment.mutate(shipmentPayload(m.regime, values, m.id), {
              onSuccess: () => setAdding(false),
            })
          }
        />
      )}

      {editable && assigning && (
        <AssignExistingPanel
          movementId={m.id}
          pending={assignShipments.isPending}
          onCancel={() => setAssigning(false)}
          onAssign={(shipmentIds) =>
            assignShipments.mutate(
              { movementId: m.id, shipmentIds },
              { onSuccess: () => setAssigning(false) },
            )
          }
        />
      )}
    </div>
  );
}

function ShipmentRows({
  shipment: s,
  expanded,
  editable,
  onToggle,
  onUnassign,
  onRemove,
  onSaveCommodity,
  onRemoveCommodity,
  commodityPending,
}: {
  shipment: MovementShipment;
  expanded: boolean;
  editable: boolean;
  onToggle: () => void;
  onUnassign: () => void;
  onRemove: () => void;
  onSaveCommodity: (values: CommodityFormValues, id?: string) => void;
  onRemoveCommodity: (id: string) => void;
  commodityPending: boolean;
}) {
  const [editingLine, setEditingLine] = useState<string | "new" | null>(null);
  return (
    <>
      <tr>
        <td className="px-3 py-2 font-mono text-xs">
          <button className="hover:underline" onClick={onToggle} aria-expanded={expanded}>
            {s.controlNumber}
          </button>
          {s.isPars && <span className="ml-2 text-[10px] uppercase text-fg-secondary">PARS</span>}
          {s.entryNumber && (
            <div className="mt-0.5 text-[11px] text-fg-secondary">
              entry {s.entryNumber}
              {s.entryPortCode ? ` @ ${s.entryPortCode}` : ""}
            </div>
          )}
        </td>
        <td className="px-3 py-2 capitalize">{kindOf(s)}</td>
        <td className="px-3 py-2 text-xs">
          {s.shipperName ?? <span className="text-status-danger">no shipper</span>} →{" "}
          {s.consigneeName ?? <span className="text-status-danger">no consignee</span>}
        </td>
        <td className="px-3 py-2 text-right font-mono">{s.commodities.length}</td>
        <td className="px-3 py-2 capitalize">{s.status}</td>
        <td className="px-3 py-2 text-right whitespace-nowrap">
          <Link
            href={`/shipments/${s.id}`}
            className="mr-3 text-xs text-fg-secondary hover:text-fg-primary"
          >
            Open
          </Link>
          {editable && (
            <>
              <button
                className="mr-3 text-xs text-fg-secondary hover:text-fg-primary"
                onClick={onUnassign}
              >
                Unassign
              </button>
              <button className="text-xs text-status-danger hover:underline" onClick={onRemove}>
                Remove
              </button>
            </>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="bg-surface-sunken/60 px-3 py-3">
            <ul className="space-y-1 text-xs">
              {s.commodities.length === 0 && (
                <li className="text-fg-secondary">No commodity lines on this shipment.</li>
              )}
              {s.commodities.map((c) => (
                <li key={c.id} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-mono">{c.lineNumber}.</span>
                  <span className="font-medium">{c.commodityDescription}</span>
                  {c.extractionConfidence != null && (
                    <span className="rounded bg-ok-500/10 px-1.5 text-status-ok">
                      AI {Math.round(c.extractionConfidence * 100)}%
                    </span>
                  )}
                  <span className="text-fg-secondary">
                    {c.hsCode ?? "no HS"} · {c.weightKg ?? "—"} kg · {c.quantity ?? "—"}{" "}
                    {c.quantityUnit ?? ""}
                  </span>
                  {c.hazmat.length > 0 && (
                    <span className="rounded bg-warn-500/10 px-1.5 text-status-warn">
                      {c.hazmat.map((h) => h.unCode).join(", ")}
                    </span>
                  )}
                  {editable && (
                    <span className="ml-auto">
                      <button
                        className="mr-3 text-fg-secondary hover:text-fg-primary"
                        onClick={() => setEditingLine(c.id)}
                      >
                        Edit
                      </button>
                      <button
                        className="text-status-danger hover:underline"
                        onClick={() => onRemoveCommodity(c.id)}
                      >
                        Remove
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {editable && !editingLine && (
              <button
                className="mt-3 text-xs text-fg-secondary hover:text-fg-primary"
                onClick={() => setEditingLine("new")}
              >
                + Add commodity line
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
                  pending={commodityPending}
                  onCancel={() => setEditingLine(null)}
                  onSubmit={(values) => {
                    onSaveCommodity(values, editingLine === "new" ? undefined : editingLine);
                    setEditingLine(null);
                  }}
                />
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function AssignExistingPanel({
  movementId,
  pending,
  onCancel,
  onAssign,
}: {
  movementId: string;
  pending: boolean;
  onCancel: () => void;
  onAssign: (shipmentIds: string[]) => void;
}) {
  const trpc = useTRPC();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const candidates = useQuery(
    trpc.shipment.listForAssign.queryOptions({ movementId, q: q || undefined }),
  );

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <section className="panel space-y-3 p-4" aria-label="Assign existing shipments">
      <div className="flex flex-wrap items-end gap-3">
        <label className="label" htmlFor="assignSearch">
          Unassigned shipments
        </label>
        <input
          id="assignSearch"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search control number…"
          className="input w-64 font-mono"
        />
      </div>
      <ul className="divide-y divide-border-default text-sm">
        {(candidates.data ?? []).length === 0 && (
          <li className="py-3 text-fg-secondary">No unassigned draft shipments for this regime.</li>
        )}
        {(candidates.data ?? []).map((c) => (
          <li key={c.id} className="flex items-center gap-3 py-2">
            <input
              type="checkbox"
              id={`assign-${c.id}`}
              checked={selected.includes(c.id)}
              onChange={() => toggle(c.id)}
            />
            <label htmlFor={`assign-${c.id}`} className="flex flex-wrap gap-x-3">
              <span className="font-mono">{c.controlNumber}</span>
              <span className="capitalize text-fg-secondary">{kindOf(c)}</span>
              <span className="text-fg-secondary">{c.shipperName ?? "no shipper"}</span>
              <span className="text-fg-secondary">{c.commodityCount} line(s)</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <button
          className="btn-primary"
          disabled={pending || selected.length === 0}
          onClick={() => onAssign(selected)}
        >
          Assign {selected.length || ""}
        </button>
        <button className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
