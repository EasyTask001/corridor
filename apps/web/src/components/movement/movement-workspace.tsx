"use client";

import { useCallback, useState, type FormEvent } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { CROSSING_POINTS, isEditable, type MovementStatus } from "@corridor/domain";
import { useTRPC } from "@/lib/trpc/client";
import { RegimeBadge, StatusBadge } from "./status-badge";
import { Timeline } from "./timeline";
import { useMovementRealtime } from "./use-movement-realtime";

type Outputs = inferRouterOutputs<AppRouter>;
type Movement = Outputs["movement"]["get"];
type Validation = Outputs["movement"]["validate"];
type Options = Outputs["movement"]["options"];

const STEPS = [
  { key: "trip", label: "Trip" },
  { key: "truck", label: "Truck" },
  { key: "crew", label: "Crew" },
  { key: "shipment", label: "Shipment" },
  { key: "trailer", label: "Trailer" },
  { key: "seals", label: "Seals" },
  { key: "review", label: "Review" },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

function toLocalInput(d: Date | null | undefined) {
  if (!d) return "";
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 16);
}
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
const fmt = (d: Date | null | undefined) =>
  d ? new Date(d).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "—";

export function MovementWorkspace({
  initial,
  initialValidation,
  options,
  permissions,
  simulationEnabled,
}: {
  initial: Movement;
  initialValidation: Validation;
  options: Options;
  permissions: { write: boolean; transmit: boolean; cancel: boolean; amend: boolean };
  simulationEnabled: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const id = initial.id;

  const getOpts = trpc.movement.get.queryOptions({ id });
  const validateOpts = trpc.movement.validate.queryOptions({ id });
  const { data: m = initial } = useQuery({ ...getOpts, initialData: initial });
  const { data: validation = initialValidation } = useQuery({
    ...validateOpts,
    initialData: initialValidation,
  });

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: getOpts.queryKey });
    qc.invalidateQueries({ queryKey: validateOpts.queryKey });
    qc.invalidateQueries({ queryKey: trpc.movement.list.queryKey() });
    qc.invalidateQueries({ queryKey: trpc.movement.board.queryKey() });
  }, [qc, getOpts.queryKey, validateOpts.queryKey, trpc.movement.list, trpc.movement.board]);
  useMovementRealtime(id, refresh);

  const editable = permissions.write && isEditable(m.status);
  const [step, setStep] = useState<StepKey>(editable ? "trip" : "review");
  const [error, setError] = useState<string | null>(null);
  const onError = (e: { message: string }) => setError(e.message);
  const ok = () => {
    setError(null);
    refresh();
  };

  const update = useMutation(trpc.movement.update.mutationOptions({ onSuccess: ok, onError }));
  const upsertCargo = useMutation(
    trpc.movement.cargo.upsert.mutationOptions({ onSuccess: ok, onError }),
  );
  const removeCargo = useMutation(
    trpc.movement.cargo.remove.mutationOptions({ onSuccess: ok, onError }),
  );
  const addSeal = useMutation(trpc.movement.seals.add.mutationOptions({ onSuccess: ok, onError }));
  const removeSeal = useMutation(
    trpc.movement.seals.remove.mutationOptions({ onSuccess: ok, onError }),
  );
  const submit = useMutation(trpc.movement.submit.mutationOptions({ onSuccess: ok, onError }));
  const cancel = useMutation(trpc.movement.cancel.mutationOptions({ onSuccess: ok, onError }));
  const arrive = useMutation(trpc.movement.markArrived.mutationOptions({ onSuccess: ok, onError }));
  const amend = useMutation(
    trpc.movement.amend.mutationOptions({
      onSuccess: () => {
        ok();
        setAmending(false);
      },
      onError,
    }),
  );
  const customs = useMutation(
    trpc.movement.customsResponse.mutationOptions({ onSuccess: ok, onError }),
  );

  const [amending, setAmending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [editingLine, setEditingLine] = useState<string | "new" | null>(null);

  const blocking = validation.issues.filter((i) => i.severity === "blocking");
  const warnings = validation.issues.filter((i) => i.severity === "warning");
  const issuesFor = (s: StepKey) => validation.issues.filter((i) => i.step === s);

  const crossings = CROSSING_POINTS.filter((c) => c.regime === m.regime);
  const shippers = options.partners.filter((p) => p.type === "shipper" || p.type === "both");
  const consignees = options.partners.filter((p) => p.type === "consignee" || p.type === "both");

  // -------------------------------------------------------------------------
  // step panels
  // -------------------------------------------------------------------------

  const TripPanel = (
    <form
      className="grid max-w-2xl grid-cols-2 gap-4"
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const code = String(fd.get("crossing") ?? "");
        const cp = crossings.find((c) => c.code === code);
        update.mutate({
          id,
          tripNumber: String(fd.get("tripNumber") ?? "").trim() || null,
          crossingPoint: cp ? { code: cp.code, name: cp.name } : null,
          scheduledCrossingAt: fromLocalInput(String(fd.get("eta") ?? "")),
        });
      }}
    >
      <Field label="Regime">
        <div className="pt-1.5">
          <RegimeBadge regime={m.regime} />
          <span className="ml-2 text-sm text-ink-500">
            {m.regime === "ACE" ? "US CBP (southbound)" : "Canada CBSA (northbound)"}
          </span>
        </div>
      </Field>
      <Field label="Trip number" htmlFor="tripNumber">
        <input
          id="tripNumber"
          name="tripNumber"
          defaultValue={m.tripNumber ?? ""}
          disabled={!editable}
          className="input font-mono"
        />
      </Field>
      <Field label="Port of entry" htmlFor="crossing">
        <select
          id="crossing"
          name="crossing"
          defaultValue={m.crossingPoint?.code ?? ""}
          disabled={!editable}
          className="input"
        >
          <option value="">Select…</option>
          {crossings.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code} · {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Estimated crossing" htmlFor="eta">
        <input
          id="eta"
          name="eta"
          type="datetime-local"
          defaultValue={toLocalInput(m.scheduledCrossingAt)}
          disabled={!editable}
          className="input"
        />
      </Field>
      {editable && (
        <div className="col-span-2">
          <button className="btn-primary" disabled={update.isPending}>
            Save trip
          </button>
        </div>
      )}
    </form>
  );

  const assignPanel = (
    label: string,
    field: "truckId" | "driverId" | "trailerId",
    list: { id: string; label: string; hint?: string | null }[],
    current: { id: string } | null,
    detail: React.ReactNode,
  ) => (
    <div className="max-w-xl space-y-4">
      <Field label={label} htmlFor={field}>
        <select
          id={field}
          value={current?.id ?? ""}
          disabled={!editable}
          onChange={(e) => update.mutate({ id, [field]: e.target.value || null })}
          className="input"
        >
          <option value="">— none —</option>
          {list.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
              {x.hint ? ` · ${x.hint}` : ""}
            </option>
          ))}
        </select>
      </Field>
      {detail}
    </div>
  );

  const ShipmentPanel = (
    <div className="space-y-4">
      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Commodity</th>
              <th className="px-3 py-2 font-medium">HS</th>
              <th className="px-3 py-2 font-medium">Shipper → Consignee</th>
              <th className="px-3 py-2 text-right font-medium">Weight (kg)</th>
              <th className="px-3 py-2 text-right font-medium">Pieces</th>
              <th className="px-3 py-2 text-right font-medium">Value</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {m.cargo.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-5 text-ink-500">
                  No shipment lines yet.
                </td>
              </tr>
            )}
            {m.cargo.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-2 font-mono text-xs">{c.lineNumber}</td>
                <td className="px-3 py-2">
                  {c.commodityDescription}
                  {c.extractionConfidence != null && (
                    <span className="ml-2 rounded bg-ok-500/10 px-1.5 text-xs text-ok-500">
                      AI {Math.round(c.extractionConfidence * 100)}%
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{c.hsCode ?? "—"}</td>
                <td className="px-3 py-2 text-xs">
                  {c.shipperName ?? <span className="text-danger-500">no shipper</span>} →{" "}
                  {c.consigneeName ?? <span className="text-danger-500">no consignee</span>}
                </td>
                <td className="px-3 py-2 text-right font-mono">{c.weightKg ?? "—"}</td>
                <td className="px-3 py-2 text-right font-mono">{c.pieceCount ?? "—"}</td>
                <td className="px-3 py-2 text-right font-mono">
                  {c.valueAmount != null
                    ? `${c.valueAmount.toLocaleString()} ${c.valueCurrency ?? ""}`
                    : "—"}
                </td>
                {editable && (
                  <td className="px-3 py-2 text-right">
                    <button
                      className="mr-3 text-xs text-ink-500 hover:text-ink-950"
                      onClick={() => setEditingLine(c.id)}
                    >
                      Edit
                    </button>
                    <button
                      className="text-xs text-danger-500 hover:underline"
                      onClick={() => removeCargo.mutate({ movementId: id, id: c.id })}
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && !editingLine && (
        <button className="btn-secondary" onClick={() => setEditingLine("new")}>
          Add shipment line
        </button>
      )}
      {editable && editingLine && (
        <CargoForm
          key={editingLine}
          initial={
            editingLine === "new" ? null : (m.cargo.find((c) => c.id === editingLine) ?? null)
          }
          shippers={shippers}
          consignees={consignees}
          pending={upsertCargo.isPending}
          onCancel={() => setEditingLine(null)}
          onSubmit={(values) =>
            upsertCargo.mutate(
              { ...values, movementId: id, ...(editingLine !== "new" && { id: editingLine }) },
              { onSuccess: () => setEditingLine(null) },
            )
          }
        />
      )}
    </div>
  );

  const SealsPanel = (
    <div className="max-w-xl space-y-4">
      <ul className="panel divide-y divide-ink-100">
        {m.seals.length === 0 && (
          <li className="px-4 py-4 text-sm text-ink-500">No seals recorded.</li>
        )}
        {m.seals.map((s) => (
          <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
            <div>
              <span className="font-mono font-medium">{s.sealNumber}</span>
              <span className="ml-2 text-xs text-ink-500">
                {s.sealType ?? ""} {s.appliedBy ? `· ${s.appliedBy}` : ""}
              </span>
            </div>
            {editable && (
              <button
                className="text-xs text-danger-500 hover:underline"
                onClick={() => removeSeal.mutate({ movementId: id, id: s.id })}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            addSeal.mutate(
              {
                movementId: id,
                sealNumber: String(fd.get("sealNumber") ?? "").trim(),
                sealType: String(fd.get("sealType") ?? "").trim() || null,
                appliedBy: String(fd.get("appliedBy") ?? "").trim() || null,
              },
              { onSuccess: () => e.currentTarget?.reset?.() },
            );
          }}
        >
          <Field label="Seal number" htmlFor="sealNumber">
            <input id="sealNumber" name="sealNumber" required className="input font-mono" />
          </Field>
          <Field label="Type" htmlFor="sealType">
            <input id="sealType" name="sealType" placeholder="bolt" className="input" />
          </Field>
          <Field label="Applied by" htmlFor="appliedBy">
            <input id="appliedBy" name="appliedBy" className="input" />
          </Field>
          <button className="btn-secondary" disabled={addSeal.isPending}>
            Add seal
          </button>
        </form>
      )}
    </div>
  );

  const ReviewPanel = (
    <div className="max-w-2xl space-y-5">
      <div className="panel p-5">
        <h3 className="font-medium">Pre-transmit checks</h3>
        {validation.issues.length === 0 ? (
          <p className="mt-2 text-sm text-ok-500">
            All checks pass. Ready to transmit to {m.regime === "ACE" ? "CBP" : "CBSA"}.
          </p>
        ) : (
          <ul className="mt-3 space-y-1.5 text-sm">
            {blocking.map((i) => (
              <li key={i.code} className="flex gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-danger-500/10 px-1.5 text-xs font-semibold uppercase text-danger-500">
                  block
                </span>
                <button className="text-left hover:underline" onClick={() => setStep(i.step)}>
                  {i.message}
                </button>
              </li>
            ))}
            {warnings.map((i) => (
              <li key={i.code} className="flex gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-warn-500/10 px-1.5 text-xs font-semibold uppercase text-warn-500">
                  warn
                </span>
                <button className="text-left hover:underline" onClick={() => setStep(i.step)}>
                  {i.message}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Summary m={m} />
      {m.amendments.length > 0 && (
        <div className="panel p-5">
          <h3 className="font-medium">Amendments</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {m.amendments.map((a) => (
              <li key={a.id}>
                <span className="font-mono">#{a.amendmentNumber}</span> ·{" "}
                <span className="capitalize">{a.status}</span> — {a.reason}
                <ul className="ml-4 text-xs text-ink-500">
                  {Object.entries(a.diff).map(([k, v]) => (
                    <li key={k}>
                      {k}: {JSON.stringify(v.before)} → {JSON.stringify(v.after)}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  const panel: Record<StepKey, React.ReactNode> = {
    trip: TripPanel,
    truck: assignPanel(
      "Truck",
      "truckId",
      options.trucks.map((t) => ({ id: t.id, label: t.label, hint: t.plate })),
      m.truck,
      m.truck && (
        <Detail
          rows={[
            ["Plate", `${m.truck.plateNumber} ${m.truck.plateJurisdiction}`],
            ["Registration", m.truck.registrationExpiry ?? "—"],
            ["Insurance", m.truck.insuranceExpiry ?? "—"],
          ]}
        />
      ),
    ),
    crew: assignPanel(
      "Driver",
      "driverId",
      options.drivers.map((d) => ({
        id: d.id,
        label: d.label,
        hint: d.licenseExpiry ? `lic. ${d.licenseExpiry}` : null,
      })),
      m.driver,
      m.driver && (
        <Detail
          rows={[
            [
              "License",
              `${m.driver.licenseNumber} (${m.driver.licenseJurisdiction}) · exp ${m.driver.licenseExpiry ?? "—"}`,
            ],
            [
              "FAST",
              m.driver.fastCardNumber
                ? `${m.driver.fastCardNumber} · exp ${m.driver.fastCardExpiry ?? "—"}`
                : "—",
            ],
            ["Citizenship", m.driver.citizenship ?? "—"],
          ]}
        />
      ),
    ),
    shipment: ShipmentPanel,
    trailer: assignPanel(
      "Trailer",
      "trailerId",
      options.trailers.map((t) => ({ id: t.id, label: t.label, hint: t.type.replace(/_/g, " ") })),
      m.trailer,
      m.trailer && (
        <Detail
          rows={[
            ["Plate", `${m.trailer.plateNumber} ${m.trailer.plateJurisdiction}`],
            ["Type", m.trailer.trailerType.replace(/_/g, " ")],
            ["Registration", m.trailer.registrationExpiry ?? "—"],
          ]}
        />
      ),
    ),
    seals: SealsPanel,
    review: ReviewPanel,
  };

  // -------------------------------------------------------------------------
  // actions
  // -------------------------------------------------------------------------

  const terminal = m.status === "arrived" || m.status === "cancelled";

  return (
    <div className="grid min-h-[calc(100vh-4rem)] grid-cols-[1fr_20rem] gap-6">
      <div className="min-w-0 space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm text-ink-500">
              <Link href="/movements" className="hover:underline">
                Movements
              </Link>
              <span>/</span>
            </div>
            <h1 className="mt-1 flex items-center gap-3 text-2xl font-semibold tracking-tight">
              <span className="font-mono">{m.movementNumber}</span>
              <RegimeBadge regime={m.regime} />
              <StatusBadge status={m.status} />
            </h1>
            <p className="mt-1 text-sm text-ink-500">
              {m.crossingPoint?.name ?? "No crossing selected"} · ETA {fmt(m.scheduledCrossingAt)}
              {m.customsReferenceNumber && (
                <>
                  {" "}
                  · ref <span className="font-mono">{m.customsReferenceNumber}</span>
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {isEditable(m.status) && permissions.transmit && (
              <button
                className="btn-signal"
                disabled={!validation.canTransmit || submit.isPending}
                title={validation.canTransmit ? undefined : "Resolve blocking issues first"}
                onClick={() => submit.mutate({ id })}
              >
                {submit.isPending
                  ? "Transmitting…"
                  : `Transmit to ${m.regime === "ACE" ? "CBP" : "CBSA"}`}
              </button>
            )}
            {m.status === "released" && permissions.write && (
              <button
                className="btn-primary"
                disabled={arrive.isPending}
                onClick={() => arrive.mutate({ id })}
              >
                Mark arrived
              </button>
            )}
            {m.status === "accepted" && permissions.amend && (
              <button className="btn-secondary" onClick={() => setAmending((v) => !v)}>
                Amend
              </button>
            )}
            {!terminal && permissions.cancel && (
              <button
                className="btn-secondary text-danger-500"
                onClick={() => setCancelling((v) => !v)}
              >
                Cancel
              </button>
            )}
          </div>
        </header>

        {error && (
          <p role="alert" className="rounded-md bg-danger-500/10 px-3 py-2 text-sm text-danger-500">
            {error}
          </p>
        )}

        {cancelling && (
          <form
            className="panel flex items-end gap-3 p-4"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              cancel.mutate(
                {
                  id,
                  reason: String(new FormData(e.currentTarget).get("reason") ?? "") || undefined,
                },
                { onSuccess: () => setCancelling(false) },
              );
            }}
          >
            <Field label="Cancellation reason" htmlFor="cancelReason">
              <input id="cancelReason" name="reason" className="input w-96" />
            </Field>
            <button
              className="btn-primary bg-danger-500 hover:bg-danger-500/90"
              disabled={cancel.isPending}
            >
              Confirm cancel
            </button>
            <button type="button" className="btn-secondary" onClick={() => setCancelling(false)}>
              Keep
            </button>
          </form>
        )}

        {amending && (
          <form
            className="panel grid grid-cols-2 gap-4 p-4"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const code = String(fd.get("crossing") ?? "");
              const cp = crossings.find((c) => c.code === code);
              amend.mutate({
                movementId: id,
                reason: String(fd.get("reason") ?? ""),
                patch: {
                  scheduledCrossingAt: fromLocalInput(String(fd.get("eta") ?? "")),
                  crossingPoint: cp ? { code: cp.code, name: cp.name } : m.crossingPoint,
                  driverId: String(fd.get("driverId") ?? "") || null,
                  truckId: String(fd.get("truckId") ?? "") || null,
                  trailerId: String(fd.get("trailerId") ?? "") || null,
                },
              });
            }}
          >
            <div className="col-span-2 text-sm font-medium">
              Amend accepted manifest — re-transmits to customs
            </div>
            <Field label="Reason" htmlFor="amendReason">
              <input id="amendReason" name="reason" required className="input" />
            </Field>
            <Field label="Estimated crossing" htmlFor="amendEta">
              <input
                id="amendEta"
                name="eta"
                type="datetime-local"
                defaultValue={toLocalInput(m.scheduledCrossingAt)}
                className="input"
              />
            </Field>
            <Field label="Port of entry" htmlFor="amendCrossing">
              <select
                id="amendCrossing"
                name="crossing"
                defaultValue={m.crossingPoint?.code ?? ""}
                className="input"
              >
                {crossings.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Driver" htmlFor="amendDriver">
              <select
                id="amendDriver"
                name="driverId"
                defaultValue={m.driverId ?? ""}
                className="input"
              >
                <option value="">— none —</option>
                {options.drivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Truck" htmlFor="amendTruck">
              <select
                id="amendTruck"
                name="truckId"
                defaultValue={m.truckId ?? ""}
                className="input"
              >
                <option value="">— none —</option>
                {options.trucks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Trailer" htmlFor="amendTrailer">
              <select
                id="amendTrailer"
                name="trailerId"
                defaultValue={m.trailerId ?? ""}
                className="input"
              >
                <option value="">— none —</option>
                {options.trailers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="col-span-2 flex gap-2">
              <button className="btn-signal" disabled={amend.isPending}>
                Submit amendment
              </button>
              <button type="button" className="btn-secondary" onClick={() => setAmending(false)}>
                Discard
              </button>
            </div>
          </form>
        )}

        {simulationEnabled &&
          permissions.transmit &&
          ["sent", "accepted", "held"].includes(m.status) && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-signal-500/60 bg-signal-500/5 px-3 py-2 text-xs">
              <span className="font-medium text-signal-600">Customs simulation (dev)</span>
              {simDecisions(m.status).map((d) => (
                <button
                  key={d}
                  className="btn-secondary px-2.5 py-1 text-xs capitalize"
                  disabled={customs.isPending}
                  onClick={() => customs.mutate({ movementId: id, decision: d })}
                >
                  {d}
                </button>
              ))}
            </div>
          )}

        <nav className="flex gap-1 rounded-md bg-ink-100 p-0.5" aria-label="Wizard steps">
          {STEPS.map((s) => {
            const n = issuesFor(s.key);
            const hasBlock = n.some((i) => i.severity === "blocking");
            return (
              <button
                key={s.key}
                onClick={() => setStep(s.key)}
                className={`flex-1 rounded px-3 py-1.5 text-sm ${step === s.key ? "bg-white font-medium shadow-sm" : "text-ink-500 hover:text-ink-950"}`}
              >
                {s.label}
                {n.length > 0 && (
                  <span
                    className={`ml-1.5 rounded-full px-1.5 text-[10px] font-semibold ${hasBlock ? "bg-danger-500/10 text-danger-500" : "bg-warn-500/10 text-warn-500"}`}
                  >
                    {n.length}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <section className="panel p-5">{panel[step]}</section>
      </div>

      <div className="panel sticky top-4 max-h-[calc(100vh-2rem)] p-4">
        <Timeline
          movementId={id}
          events={m.events}
          canNote={permissions.write}
          onChanged={refresh}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// small pieces
// ---------------------------------------------------------------------------

function simDecisions(
  status: MovementStatus,
): Array<"accepted" | "rejected" | "released" | "held"> {
  if (status === "sent") return ["accepted", "rejected"];
  if (status === "accepted") return ["released", "held"];
  if (status === "held") return ["released"];
  return [];
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="label">
        {label}
      </label>
      {children}
    </div>
  );
}

function Detail({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-500">{k}</dt>
          <dd className="font-mono text-xs leading-5">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Summary({ m }: { m: Movement }) {
  const totalKg = m.cargo.reduce((s, c) => s + (c.weightKg ?? 0), 0);
  const pieces = m.cargo.reduce((s, c) => s + (c.pieceCount ?? 0), 0);
  return (
    <div className="panel grid grid-cols-2 gap-x-6 gap-y-2 p-5 text-sm sm:grid-cols-3">
      {[
        ["Driver", m.driver ? `${m.driver.firstName} ${m.driver.lastName}` : "—"],
        ["Truck", m.truck?.unitNumber ?? "—"],
        ["Trailer", m.trailer?.unitNumber ?? "—"],
        ["Lines", String(m.cargo.length)],
        ["Total weight", `${totalKg.toLocaleString()} kg`],
        ["Pieces", String(pieces)],
        ["Seals", m.seals.map((s) => s.sealNumber).join(", ") || "—"],
        ["Submitted", fmt(m.submittedAt)],
        ["Released", fmt(m.releasedAt)],
      ].map(([k, v]) => (
        <div key={k}>
          <div className="text-xs uppercase tracking-wide text-ink-500">{k}</div>
          <div className="font-medium">{v}</div>
        </div>
      ))}
    </div>
  );
}

type CargoValues = {
  commodityDescription: string;
  hsCode: string | null;
  weightKg: number | null;
  pieceCount: number | null;
  packagingType: string | null;
  shipperId: string | null;
  consigneeId: string | null;
  valueAmount: number | null;
  valueCurrency: "USD" | "CAD" | null;
  countryOfOrigin: string | null;
  entryNumber: string | null;
  inBondNumber: string | null;
};

function CargoForm({
  initial,
  shippers,
  consignees,
  pending,
  onCancel,
  onSubmit,
}: {
  initial: Movement["cargo"][number] | null;
  shippers: { id: string; label: string }[];
  consignees: { id: string; label: string }[];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (v: CargoValues) => void;
}) {
  const num = (v: FormDataEntryValue | null) => (v && String(v).trim() ? Number(v) : null);
  const str = (v: FormDataEntryValue | null) => (v && String(v).trim() ? String(v).trim() : null);
  return (
    <form
      role="form"
      aria-label={initial ? "Edit shipment line" : "New shipment line"}
      className="panel grid grid-cols-2 gap-4 p-4 sm:grid-cols-3"
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        onSubmit({
          commodityDescription: String(fd.get("commodityDescription") ?? "").trim(),
          hsCode: str(fd.get("hsCode")),
          weightKg: num(fd.get("weightKg")),
          pieceCount: num(fd.get("pieceCount")),
          packagingType: str(fd.get("packagingType")),
          shipperId: str(fd.get("shipperId")),
          consigneeId: str(fd.get("consigneeId")),
          valueAmount: num(fd.get("valueAmount")),
          valueCurrency: (str(fd.get("valueCurrency")) as "USD" | "CAD" | null) ?? null,
          countryOfOrigin: str(fd.get("countryOfOrigin"))?.toUpperCase() ?? null,
          entryNumber: str(fd.get("entryNumber")),
          inBondNumber: str(fd.get("inBondNumber")),
        });
      }}
    >
      <div className="col-span-2 sm:col-span-3">
        <Field label="Commodity description" htmlFor="commodityDescription">
          <input
            id="commodityDescription"
            name="commodityDescription"
            required
            defaultValue={initial?.commodityDescription ?? ""}
            className="input"
          />
        </Field>
      </div>
      <Field label="Shipper" htmlFor="shipperId">
        <select
          id="shipperId"
          name="shipperId"
          defaultValue={initial?.shipperId ?? ""}
          className="input"
        >
          <option value="">Select…</option>
          {shippers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Consignee" htmlFor="consigneeId">
        <select
          id="consigneeId"
          name="consigneeId"
          defaultValue={initial?.consigneeId ?? ""}
          className="input"
        >
          <option value="">Select…</option>
          {consignees.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="HS code" htmlFor="hsCode">
        <input
          id="hsCode"
          name="hsCode"
          placeholder="7208.10"
          defaultValue={initial?.hsCode ?? ""}
          className="input font-mono"
        />
      </Field>
      <Field label="Weight (kg)" htmlFor="weightKg">
        <input
          id="weightKg"
          name="weightKg"
          type="number"
          step="0.01"
          min="0"
          defaultValue={initial?.weightKg ?? ""}
          className="input"
        />
      </Field>
      <Field label="Pieces" htmlFor="pieceCount">
        <input
          id="pieceCount"
          name="pieceCount"
          type="number"
          min="1"
          defaultValue={initial?.pieceCount ?? ""}
          className="input"
        />
      </Field>
      <Field label="Packaging" htmlFor="packagingType">
        <input
          id="packagingType"
          name="packagingType"
          placeholder="pallet"
          defaultValue={initial?.packagingType ?? ""}
          className="input"
        />
      </Field>
      <Field label="Value" htmlFor="valueAmount">
        <input
          id="valueAmount"
          name="valueAmount"
          type="number"
          step="0.01"
          min="0"
          defaultValue={initial?.valueAmount ?? ""}
          className="input"
        />
      </Field>
      <Field label="Currency" htmlFor="valueCurrency">
        <select
          id="valueCurrency"
          name="valueCurrency"
          defaultValue={initial?.valueCurrency ?? ""}
          className="input"
        >
          <option value="">—</option>
          <option value="USD">USD</option>
          <option value="CAD">CAD</option>
        </select>
      </Field>
      <Field label="Country of origin" htmlFor="countryOfOrigin">
        <input
          id="countryOfOrigin"
          name="countryOfOrigin"
          placeholder="CA"
          maxLength={2}
          defaultValue={initial?.countryOfOrigin ?? ""}
          className="input uppercase"
        />
      </Field>
      <Field label="Entry number" htmlFor="entryNumber">
        <input
          id="entryNumber"
          name="entryNumber"
          defaultValue={initial?.entryNumber ?? ""}
          className="input font-mono"
        />
      </Field>
      <Field label="In-bond number" htmlFor="inBondNumber">
        <input
          id="inBondNumber"
          name="inBondNumber"
          defaultValue={initial?.inBondNumber ?? ""}
          className="input font-mono"
        />
      </Field>
      <div className="col-span-2 flex gap-2 sm:col-span-3">
        <button className="btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save line"}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
