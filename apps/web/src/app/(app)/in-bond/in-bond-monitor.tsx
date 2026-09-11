"use client";

/**
 * The in-bond monitor: every bonded move with where it stands, the messages
 * that can be sent next, and a drawer with what customs was told and said.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { IN_BOND_STATUS_LABELS, type InBondStatus } from "@corridor/domain";
import { Badge, Button, Input, Label, NativeSelect } from "@corridor/ui";
import { PortPicker, type PickablePort } from "@/components/port-picker";
import { useTRPC } from "@/lib/trpc/client";

type List = inferRouterOutputs<AppRouter>["inbond"]["records"]["list"];
type Row = List["rows"][number];
type Option = { id: string; label: string; regime: "ACE" | "ACI" };

const STATUS_VARIANT: Record<InBondStatus, "ok" | "neutral" | "muted" | "warn"> = {
  open: "neutral",
  arrival_sent: "warn",
  arrived: "ok",
  export_sent: "warn",
  exported: "ok",
  cancelled: "muted",
};

const fmt = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "—";

export function InBondMonitor({
  initial,
  canWrite,
  inBondShipments,
  externalShipments,
}: {
  initial: List;
  canWrite: boolean;
  inBondShipments: Option[];
  externalShipments: Option[];
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const listOpts = trpc.inbond.records.list.queryOptions({ limit: 100, offset: 0 });
  const { data = initial } = useQuery({ ...listOpts, initialData: initial });
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settle = {
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: trpc.inbond.pathKey() });
    },
    onError: (e: { message: string }) => setError(e.message),
  };
  const sendArrival = useMutation(trpc.inbond.records.sendArrival.mutationOptions(settle));
  const sendExport = useMutation(trpc.inbond.records.sendExport.mutationOptions(settle));
  const cancel = useMutation(trpc.inbond.records.cancel.mutationOptions(settle));
  const requestStatus = useMutation(trpc.inbond.records.requestStatus.mutationOptions(settle));
  const busy =
    sendArrival.isPending || sendExport.isPending || cancel.isPending || requestStatus.isPending;

  const listed = new Set(data.rows.map((r) => r.shipmentId).filter(Boolean));
  const addable = inBondShipments.filter((s) => !listed.has(s.id));

  return (
    <div className="space-y-4">
      {error && (
        <p
          role="alert"
          className="rounded-md bg-danger-500/10 px-3 py-2 text-sm text-status-danger"
        >
          {error}
        </p>
      )}
      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-fg-secondary">
            <tr>
              <th className="px-3 py-2 font-medium">Shipment</th>
              <th className="px-3 py-2 font-medium">Bond #</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Arrival → export</th>
              <th className="px-3 py-2 font-medium">FIRMS</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Checked</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-5 text-fg-secondary">
                  No bonded moves yet. An ACE in-bond shipment opens one on its own; add one below
                  for an external shipment.
                </td>
              </tr>
            )}
            {data.rows.map((r) => {
              const isOpen = open === r.id;
              return (
                <RecordRow
                  key={r.id}
                  r={r}
                  expanded={isOpen}
                  canWrite={canWrite}
                  busy={busy}
                  onToggle={() => setOpen(isOpen ? null : r.id)}
                  onEdit={() => setEditing(r)}
                  onArrival={() => sendArrival.mutate({ id: r.id })}
                  onExport={() => sendExport.mutate({ id: r.id })}
                  onCancel={() => {
                    const reason =
                      window.prompt("Reason for cancelling this in-bond move?") ?? undefined;
                    cancel.mutate({ id: r.id, reason: reason || undefined });
                  }}
                  onStatus={() => requestStatus.mutate({ id: r.id })}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {canWrite && !adding && !editing && (
        <Button variant="secondary" onClick={() => setAdding(true)}>
          Add in-bond record
        </Button>
      )}
      {canWrite && (adding || editing) && (
        <RecordForm
          record={editing}
          shipments={addable}
          externalShipments={externalShipments}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function RecordRow({
  r,
  expanded,
  canWrite,
  busy,
  onToggle,
  onEdit,
  onArrival,
  onExport,
  onCancel,
  onStatus,
}: {
  r: Row;
  expanded: boolean;
  canWrite: boolean;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onArrival: () => void;
  onExport: () => void;
  onCancel: () => void;
  onStatus: () => void;
}) {
  const live = r.status !== "exported" && r.status !== "cancelled";
  return (
    <>
      <tr>
        <td className="px-3 py-2">
          <button
            className="font-mono text-xs hover:underline"
            onClick={onToggle}
            aria-expanded={expanded}
          >
            {r.controlNumber ?? "—"}
          </button>
          <div className="text-[11px] text-fg-secondary">
            {r.regime}
            {r.external
              ? ` · external${r.originatingCarrierCode ? ` (${r.originatingCarrierCode})` : ""}`
              : " · ours"}
          </div>
        </td>
        <td className="px-3 py-2 font-mono text-xs">
          {r.bondNumber ?? <span className="text-fg-secondary/60">pending</span>}
        </td>
        <td className="px-3 py-2 font-mono text-xs">{r.entryType}</td>
        <td className="px-3 py-2 font-mono text-xs">
          {r.arrivalPortCode ?? "—"} → {r.exportPortCode ?? "—"}
        </td>
        <td className="px-3 py-2 font-mono text-xs">{r.firmsCode ?? "—"}</td>
        <td className="px-3 py-2">
          <Badge variant={STATUS_VARIANT[r.status]}>{IN_BOND_STATUS_LABELS[r.status]}</Badge>
        </td>
        <td className="px-3 py-2 text-xs text-fg-secondary">{fmt(r.lastStatusCheckedAt)}</td>
        <td className="px-3 py-2 text-right whitespace-nowrap">
          {canWrite && live && (
            <span className="inline-flex gap-2 text-xs">
              {r.status === "open" && (
                <button className="hover:underline" disabled={busy} onClick={onArrival}>
                  Send arrival
                </button>
              )}
              {r.status === "arrived" && (
                <button className="hover:underline" disabled={busy} onClick={onExport}>
                  Send export
                </button>
              )}
              {r.bondNumber && (
                <button className="hover:underline" disabled={busy} onClick={onStatus}>
                  Check status
                </button>
              )}
              <button className="hover:underline" onClick={onEdit}>
                Edit
              </button>
              <button
                className="text-status-danger hover:underline"
                disabled={busy}
                onClick={onCancel}
              >
                Cancel
              </button>
            </span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="bg-surface-sunken/60 px-3 py-3">
            <EventDrawer id={r.id} canWrite={canWrite} />
          </td>
        </tr>
      )}
    </>
  );
}

function EventDrawer({ id, canWrite }: { id: string; canWrite: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const opts = trpc.inbond.records.events.queryOptions({ id });
  const { data, isLoading } = useQuery(opts);
  const [body, setBody] = useState("");
  const addNote = useMutation(
    trpc.inbond.records.addNote.mutationOptions({
      onSuccess: () => {
        setBody("");
        qc.invalidateQueries({ queryKey: opts.queryKey });
      },
    }),
  );
  const describe = (e: NonNullable<typeof data>[number]) => {
    const p = e.payload ?? {};
    switch (e.kind) {
      case "arrival_sent":
        return `Arrival sent · ref ${p.referenceNumber ?? ""}`;
      case "export_sent":
        return `Export sent · ref ${p.referenceNumber ?? ""}`;
      case "cancel_sent":
        return `Cancellation sent${p.reason ? ` — ${p.reason}` : ""}`;
      case "status_requested":
        return `Status requested for bond ${p.bondNumber ?? ""}`;
      case "customs_response":
        return `Customs: ${String(p.status ?? "")}${p.message ? ` — ${p.message}` : ""}`;
      case "note":
        return String(p.body ?? "");
    }
  };
  return (
    <div className="space-y-2" aria-label="In-bond events">
      {isLoading && <p className="text-xs text-fg-secondary">Loading…</p>}
      {data?.length === 0 && (
        <p className="text-xs text-fg-secondary">Nothing sent or received yet.</p>
      )}
      <ol className="space-y-1.5 text-sm">
        {data?.map((e) => (
          <li key={e.id} className="flex gap-3">
            <span className="font-mono text-xs text-fg-secondary">{fmt(e.occurredAt)}</span>
            <span>{describe(e)}</span>
            <span className="text-xs text-fg-secondary">
              {e.actorType === "customs_api"
                ? "Customs"
                : e.actorType === "system"
                  ? "System"
                  : (e.actorName ?? "User")}
            </span>
          </li>
        ))}
      </ol>
      {canWrite && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) addNote.mutate({ id, body: body.trim() });
          }}
        >
          <Input
            aria-label="Add in-bond note"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a note…"
          />
          <Button type="submit" variant="secondary" disabled={addNote.isPending || !body.trim()}>
            Post
          </Button>
        </form>
      )}
    </div>
  );
}

function RecordForm({
  record,
  shipments,
  externalShipments,
  onClose,
}: {
  record: Row | null;
  shipments: Option[];
  externalShipments: Option[];
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [parent, setParent] = useState<string>(
    record ? (record.shipmentId ? `s:${record.shipmentId}` : `x:${record.externalShipmentId}`) : "",
  );
  const [arrival, setArrival] = useState<PickablePort | null>(
    record?.arrivalPortId && record.arrivalPortCode
      ? { id: record.arrivalPortId, code: record.arrivalPortCode, name: "", stateProvince: null }
      : null,
  );
  const [exportPort, setExportPort] = useState<PickablePort | null>(
    record?.exportPortId && record.exportPortCode
      ? { id: record.exportPortId, code: record.exportPortCode, name: "", stateProvince: null }
      : null,
  );
  const settle = {
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: trpc.inbond.pathKey() });
      onClose();
    },
    onError: (e: { message: string }) => setError(e.message),
  };
  const create = useMutation(trpc.inbond.records.create.mutationOptions(settle));
  const update = useMutation(trpc.inbond.records.update.mutationOptions(settle));
  const regime =
    (parent.startsWith("s:") ? shipments : externalShipments).find(
      (o) => `${parent[0]}:${o.id}` === parent,
    )?.regime ??
    record?.regime ??
    "ACE";

  return (
    <form
      role="form"
      aria-label={record ? "Edit in-bond record" : "New in-bond record"}
      className="panel grid grid-cols-1 gap-4 p-5 sm:grid-cols-2"
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const fields = {
          bondNumber: String(fd.get("bondNumber") ?? "").trim() || null,
          entryType: fd.get("entryType") as "IT" | "TE" | "IE",
          arrivalPortId: arrival?.id ?? null,
          exportPortId: exportPort?.id ?? null,
          firmsCode: String(fd.get("firmsCode") ?? "").trim() || null,
        };
        if (record) update.mutate({ id: record.id, ...fields });
        else
          create.mutate({
            ...fields,
            ...(parent.startsWith("s:")
              ? { shipmentId: parent.slice(2) }
              : { externalShipmentId: parent.slice(2) }),
          });
      }}
    >
      <div className="col-span-2">
        <Label htmlFor="ib-parent">Shipment</Label>
        {record ? (
          <p className="font-mono text-sm">{record.controlNumber}</p>
        ) : (
          <NativeSelect
            id="ib-parent"
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            required
          >
            <option value="">— select —</option>
            {shipments.length > 0 && (
              <optgroup label="Our in-bond shipments">
                {shipments.map((s) => (
                  <option key={s.id} value={`s:${s.id}`}>
                    {s.label} · {s.regime}
                  </option>
                ))}
              </optgroup>
            )}
            {externalShipments.length > 0 && (
              <optgroup label="External shipments">
                {externalShipments.map((x) => (
                  <option key={x.id} value={`x:${x.id}`}>
                    {x.label} · {x.regime}
                  </option>
                ))}
              </optgroup>
            )}
          </NativeSelect>
        )}
      </div>
      <div>
        <Label htmlFor="ib-bond">Bond number (9 digits)</Label>
        <Input
          id="ib-bond"
          name="bondNumber"
          defaultValue={record?.bondNumber ?? ""}
          className="font-mono"
          disabled={!!record?.bondNumber}
        />
      </div>
      <div>
        <Label htmlFor="ib-type">Entry type</Label>
        <NativeSelect id="ib-type" name="entryType" defaultValue={record?.entryType ?? "IT"}>
          <option value="IT">IT — immediate transportation</option>
          <option value="TE">TE — transportation and exportation</option>
          <option value="IE">IE — immediate exportation</option>
        </NativeSelect>
      </div>
      <div>
        <Label htmlFor="ib-arrival">Arrival port</Label>
        <PortPicker
          id="ib-arrival"
          regime={regime}
          kind={regime === "ACE" ? "port_of_entry" : "cbsa_office"}
          value={arrival}
          onSelect={setArrival}
        />
      </div>
      <div>
        <Label htmlFor="ib-export">Export / destination port</Label>
        <PortPicker
          id="ib-export"
          regime={regime}
          kind={regime === "ACE" ? "in_bond_destination" : "cbsa_office"}
          value={exportPort}
          onSelect={setExportPort}
        />
      </div>
      <div>
        <Label htmlFor="ib-firms">FIRMS code</Label>
        <Input
          id="ib-firms"
          name="firmsCode"
          defaultValue={record?.firmsCode ?? ""}
          className="font-mono uppercase"
          maxLength={4}
        />
      </div>
      {error && <p className="col-span-2 text-sm text-status-danger">{error}</p>}
      <div className="col-span-2 flex gap-2">
        <Button
          type="submit"
          disabled={create.isPending || update.isPending || (!record && !parent)}
        >
          {record ? "Save" : "Add record"}
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
