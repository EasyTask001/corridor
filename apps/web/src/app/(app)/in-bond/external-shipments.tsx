"use client";

/** Goods another carrier filed that we move under bond: identifiers only, no filing of ours. */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { Badge, Button, Input, Label, NativeSelect } from "@corridor/ui";
import { useTRPC } from "@/lib/trpc/client";

type List = inferRouterOutputs<AppRouter>["inbond"]["external"]["list"];
type Row = List["rows"][number];

export function ExternalShipments({ initial, canWrite }: { initial: List; canWrite: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const listOpts = trpc.inbond.external.list.queryOptions({ limit: 100, offset: 0 });
  const { data = initial } = useQuery({ ...listOpts, initialData: initial });
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settle = {
    onSuccess: () => {
      setError(null);
      setEditing(null);
      qc.invalidateQueries({ queryKey: trpc.inbond.pathKey() });
    },
    onError: (e: { message: string }) => setError(e.message),
  };
  const create = useMutation(trpc.inbond.external.create.mutationOptions(settle));
  const update = useMutation(trpc.inbond.external.update.mutationOptions(settle));
  const close = useMutation(trpc.inbond.external.close.mutationOptions(settle));

  return (
    <div className="space-y-4">
      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-3 py-2 font-medium">Control #</th>
              <th className="px-3 py-2 font-medium">Bond #</th>
              <th className="px-3 py-2 font-medium">Carrier</th>
              <th className="px-3 py-2 font-medium">Regime</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium">Monitor</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-5 text-ink-500">
                  No external shipments recorded.
                </td>
              </tr>
            )}
            {data.rows.map((x) => (
              <tr key={x.id} className={x.status === "closed" ? "opacity-60" : ""}>
                <td className="px-3 py-2 font-mono text-xs">{x.controlNumber ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{x.inBondNumber ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{x.originatingCarrierCode ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{x.regime}</td>
                <td className="px-3 py-2">{x.description ?? "—"}</td>
                <td className="px-3 py-2 text-xs">{x.recordStatus ? x.recordStatus.replace(/_/g, " ") : "not on monitor"}</td>
                <td className="px-3 py-2">
                  <Badge variant={x.status === "open" ? "ok" : "muted"}>{x.status}</Badge>
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap text-xs">
                  {canWrite && (
                    <>
                      <button className="mr-3 hover:underline" onClick={() => setEditing(x)}>
                        Edit
                      </button>
                      <button
                        className="hover:underline"
                        disabled={close.isPending}
                        onClick={() => close.mutate({ id: x.id, reopen: x.status === "closed" })}
                      >
                        {x.status === "closed" ? "Reopen" : "Close"}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canWrite && !editing && (
        <Button variant="secondary" onClick={() => setEditing("new")}>
          Add external shipment
        </Button>
      )}
      {canWrite && editing && (
        <form
          role="form"
          aria-label={editing === "new" ? "New external shipment" : "Edit external shipment"}
          className="panel grid grid-cols-2 gap-4 p-5"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const fields = {
              controlNumber: String(fd.get("controlNumber") ?? "").trim() || null,
              inBondNumber: String(fd.get("inBondNumber") ?? "").trim() || null,
              originatingCarrierCode: String(fd.get("originatingCarrierCode") ?? "").trim() || null,
              description: String(fd.get("description") ?? "").trim() || null,
            };
            if (editing === "new") create.mutate({ regime: fd.get("regime") as "ACE" | "ACI", ...fields });
            else update.mutate({ id: editing.id, ...fields });
          }}
        >
          {editing === "new" && (
            <div>
              <Label htmlFor="xs-regime">Regime</Label>
              <NativeSelect id="xs-regime" name="regime" defaultValue="ACE">
                <option value="ACE">ACE (US)</option>
                <option value="ACI">ACI (Canada)</option>
              </NativeSelect>
            </div>
          )}
          <div>
            <Label htmlFor="xs-control">Originating control number</Label>
            <Input id="xs-control" name="controlNumber" defaultValue={editing === "new" ? "" : (editing.controlNumber ?? "")} className="font-mono uppercase" />
          </div>
          <div>
            <Label htmlFor="xs-bond">In-bond number</Label>
            <Input id="xs-bond" name="inBondNumber" defaultValue={editing === "new" ? "" : (editing.inBondNumber ?? "")} className="font-mono" />
          </div>
          <div>
            <Label htmlFor="xs-carrier">Originating carrier code</Label>
            <Input id="xs-carrier" name="originatingCarrierCode" defaultValue={editing === "new" ? "" : (editing.originatingCarrierCode ?? "")} className="font-mono uppercase" maxLength={4} />
          </div>
          <div className="col-span-2">
            <Label htmlFor="xs-desc">Description</Label>
            <Input id="xs-desc" name="description" defaultValue={editing === "new" ? "" : (editing.description ?? "")} />
          </div>
          {error && <p className="col-span-2 text-sm text-danger-500">{error}</p>}
          <div className="col-span-2 flex gap-2">
            <Button type="submit" disabled={create.isPending || update.isPending}>
              {editing === "new" ? "Add external shipment" : "Save"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
