"use client";

/**
 * Movement Builder shell: header, actions, the wizard stepper and the
 * timeline. Each step's panel lives in `steps/`; everything they share (the
 * loaded movement, the mutations) comes from `workspace-context.tsx`.
 */
import { useCallback, useState, type FormEvent } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import {
  CBSA_AMENDMENT_REASON_CODES,
  isEditable,
  type CbsaAmendmentReasonCode,
  type MovementStatus,
} from "@corridor/domain";
import { PortPicker, type PickablePort } from "@/components/port-picker";
import { useTRPC } from "@/lib/trpc/client";
import { Field } from "./field";
import { ReadinessPanel } from "./readiness-panel";
import { RegimeBadge, StatusBadge } from "./status-badge";
import { Timeline } from "./timeline";
import { useMovementRealtime } from "./use-movement-realtime";
import { CrewStep } from "./steps/crew-step";
import { ReviewStep } from "./steps/review-step";
import { SealsStep } from "./steps/seals-step";
import { ShipmentsStep } from "./steps/shipments-step";
import { TrailersStep } from "./steps/trailers-step";
import { TripStep } from "./steps/trip-step";
import { TruckStep } from "./steps/truck-step";
import {
  STEPS,
  WorkspaceProvider,
  fmt,
  fromLocalInput,
  stepForIssue,
  toLocalInput,
  type Capabilities,
  type Movement,
  type Options,
  type StepKey,
  type Validation,
} from "./workspace-context";

type Outputs = inferRouterOutputs<AppRouter>;
type Suggestion = NonNullable<Outputs["movement"]["suggestions"]["generate"]>;

const PANEL: Record<StepKey, () => React.ReactNode> = {
  trip: TripStep,
  truck: TruckStep,
  crew: CrewStep,
  shipment: ShipmentsStep,
  trailer: TrailersStep,
  seals: SealsStep,
  review: ReviewStep,
};

export function MovementWorkspace({
  initial,
  initialValidation,
  options,
  initialCapabilities,
  permissions,
  simulationEnabled,
}: {
  initial: Movement;
  initialValidation: Validation;
  options: Options;
  initialCapabilities: Capabilities;
  permissions: { write: boolean; transmit: boolean; cancel: boolean; amend: boolean };
  simulationEnabled: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const id = initial.id;

  const getOpts = trpc.movement.get.queryOptions({ id });
  const validateOpts = trpc.movement.validate.queryOptions({ id });
  // Seeded from the server render, then reconciled by Realtime: the socket is
  // authenticated (see use-realtime-client.ts), and every mutation on this page
  // invalidates on settle, so the timeline needs no timer of its own.
  const { data: m = initial } = useQuery({ ...getOpts, initialData: initial });
  const { data: validation = initialValidation } = useQuery({
    ...validateOpts,
    initialData: initialValidation,
  });
  const { data: capabilities = initialCapabilities } = useQuery({
    ...trpc.integrations.customsCapabilities.queryOptions({ regime: m.regime }),
    initialData: initialCapabilities,
  });

  const borderWait = useQuery({
    ...trpc.integrations.borderWait.queryOptions({ crossingCode: m.port?.code ?? "" }),
    enabled: !!m.port?.code,
    staleTime: 60_000,
  });

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: getOpts.queryKey });
    qc.invalidateQueries({ queryKey: validateOpts.queryKey });
    qc.invalidateQueries({ queryKey: trpc.movement.list.queryKey() });
    qc.invalidateQueries({ queryKey: trpc.movement.board.queryKey() });
    qc.invalidateQueries({ queryKey: trpc.shipment.pathKey() });
    qc.invalidateQueries({
      queryKey: trpc.integrations.events.forMovement.queryKey({ movementId: id }),
    });
  }, [
    qc,
    getOpts.queryKey,
    validateOpts.queryKey,
    trpc.movement.list,
    trpc.movement.board,
    trpc.shipment,
    trpc.integrations.events.forMovement,
    id,
  ]);
  useMovementRealtime(id, refresh);

  const editable = permissions.write && isEditable(m.status);
  const [step, setStep] = useState<StepKey>(editable ? "trip" : "review");
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const onError = (e: { message: string }) => {
    setError(e.message);
    refresh(); // a failed transmit still writes an integration_events row
  };
  const ok = () => {
    setError(null);
    refresh();
  };

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
  const generateSuggestion = useMutation(
    trpc.movement.suggestions.generate.mutationOptions({
      onSuccess: (value) => {
        setSuggestion(value);
        setError(value ? null : "No completed movement history is available for this regime yet.");
      },
      onError,
    }),
  );
  const acceptSuggestion = useMutation(
    trpc.movement.suggestions.accept.mutationOptions({
      onSuccess: () => {
        setSuggestion(null);
        ok();
      },
      onError,
    }),
  );
  const dismissSuggestion = useMutation(
    trpc.movement.suggestions.dismiss.mutationOptions({
      onSuccess: () => setSuggestion(null),
      onError,
    }),
  );

  const [amending, setAmending] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const issuesFor = (s: StepKey) => validation.issues.filter((i) => stepForIssue(i.step) === s);

  const carrierCodes = options.carrierCodes.filter((c) => c.regime === m.regime);
  const defaultCarrierCode = carrierCodes.find((c) => c.isDefault)?.code ?? null;

  const [amendPortId, setAmendPortId] = useState<string | null>(m.portId);
  const [amendPort, setAmendPort] = useState<PickablePort | null>(() =>
    m.port
      ? { id: m.portId!, code: m.port.code, name: m.port.name, stateProvince: m.port.stateProvince }
      : null,
  );
  // See trip-step.tsx: `m.portId` can change without a remount (an accepted AI
  // suggestion sets it server-side), so re-seed during render.
  const [trackedPortId, setTrackedPortId] = useState(m.portId);
  if (m.portId !== trackedPortId) {
    setTrackedPortId(m.portId);
    setAmendPortId(m.portId);
    setAmendPort(
      m.port
        ? {
            id: m.portId!,
            code: m.port.code,
            name: m.port.name,
            stateProvince: m.port.stateProvince,
          }
        : null,
    );
  }

  const terminal = m.status === "arrived" || m.status === "cancelled";
  const StepPanel = PANEL[step];

  return (
    <WorkspaceProvider
      value={{
        movement: m,
        validation,
        options,
        capabilities,
        permissions,
        editable,
        refresh,
        setError,
        goToStep: setStep,
      }}
    >
      <div className="grid min-h-[calc(100dvh-7rem)] gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-5">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm text-fg-secondary">
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
              <p className="mt-1 text-sm text-fg-secondary">
                {m.port?.name ?? "No port selected"} · ETA {fmt(m.scheduledCrossingAt)}
                {m.customsReferenceNumber && (
                  <>
                    {" "}
                    · ref <span className="font-mono">{m.customsReferenceNumber}</span>
                  </>
                )}
                {borderWait.data && (
                  <>
                    {" "}
                    · wait <span className="font-mono">{borderWait.data.lanes.commercial} min</span>
                    {borderWait.data.lanes.fast < borderWait.data.lanes.commercial && (
                      <span className="text-fg-secondary/60">
                        {" "}
                        · FAST {borderWait.data.lanes.fast} min
                      </span>
                    )}
                    <span className="ml-2 text-xs text-status-warn">
                      {borderWait.data.disclaimer}
                    </span>
                  </>
                )}
              </p>
              {(m.status === "sent" || m.status === "held") && (
                <p className="mt-1 inline-flex items-center gap-2 rounded bg-signal-500/10 px-2 py-0.5 text-xs text-status-signal">
                  <span
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-500"
                    aria-hidden
                  />
                  {m.status === "sent"
                    ? `Awaiting ${m.regime === "ACE" ? "CBP" : "CBSA"} decision — the timeline updates live`
                    : "Held for secondary inspection — awaiting release"}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {editable && (
                <button
                  className="btn-secondary"
                  disabled={generateSuggestion.isPending}
                  onClick={() => generateSuggestion.mutate({ movementId: id })}
                >
                  {generateSuggestion.isPending
                    ? "Finding a similar trip…"
                    : "Suggest from history"}
                </button>
              )}
              {isEditable(m.status) && permissions.transmit && (
                <button
                  className="btn-signal"
                  disabled={!capabilities.transmit || !validation.canTransmit || submit.isPending}
                  title={
                    !capabilities.transmit
                      ? capabilities.reasons.transmit
                      : validation.canTransmit
                        ? undefined
                        : "Resolve blocking issues first"
                  }
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
                <button
                  className="btn-secondary"
                  disabled={!capabilities.amend}
                  title={capabilities.reasons.amend}
                  onClick={() => setAmending((v) => !v)}
                >
                  Amend
                </button>
              )}
              {!terminal && permissions.cancel && (
                <button
                  className="btn-secondary text-status-danger"
                  disabled={!capabilities.cancel}
                  title={capabilities.reasons.cancel}
                  onClick={() => setCancelling((v) => !v)}
                >
                  Cancel
                </button>
              )}
            </div>
          </header>

          {m.status === "accepted" && permissions.amend && !capabilities.amend && (
            <p role="status" className="text-sm text-status-warn">
              {capabilities.reasons.amend}
            </p>
          )}

          {m.trailers.length > 1 && !capabilities.multiTrailer && (
            <p role="status" className="text-sm text-status-warn">
              {capabilities.reasons.multiTrailer}
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-md bg-danger-500/10 px-3 py-2 text-sm text-status-danger"
            >
              {error}
            </p>
          )}

          {suggestion && (
            <section className="rounded-md border border-signal-500/40 bg-signal-500/5 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-status-signal">
                    AI suggested · not applied
                  </div>
                  <h2 className="mt-1 font-medium">
                    Reuse the lane from {suggestion.suggestedPayload.sourceMovementNumber}
                  </h2>
                  <p className="mt-1 text-sm text-fg-secondary">
                    Similarity {suggestion.score}/100 · {suggestion.reasons.join(" · ")}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    className="btn-signal"
                    disabled={acceptSuggestion.isPending}
                    onClick={() => acceptSuggestion.mutate({ suggestionId: suggestion.id })}
                  >
                    Apply suggestion
                  </button>
                  <button
                    className="btn-secondary"
                    disabled={dismissSuggestion.isPending}
                    onClick={() => dismissSuggestion.mutate({ suggestionId: suggestion.id })}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
                <SuggestionValue
                  label="Crossing"
                  value={suggestion.suggestedPayload.port?.name ?? "—"}
                />
                <SuggestionValue
                  label="Carrier code"
                  value={suggestion.suggestedPayload.carrierCode ?? "—"}
                />
                <SuggestionValue
                  label="Crew"
                  value={
                    suggestion.suggestedPayload.crew
                      .map((c) => options.drivers.find((x) => x.id === c.driverId)?.label ?? "?")
                      .join(", ") || "—"
                  }
                />
                <SuggestionValue
                  label="Truck"
                  value={
                    options.trucks.find((x) => x.id === suggestion.suggestedPayload.truckId)
                      ?.label ?? "—"
                  }
                />
              </dl>
            </section>
          )}

          {cancelling && (
            <form
              className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-end"
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
                <input id="cancelReason" name="reason" className="input w-full sm:w-96" />
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
              className="panel grid grid-cols-1 gap-4 p-4 sm:grid-cols-2"
              onSubmit={(e: FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const reasonCode = String(fd.get("reasonCode") ?? "");
                const shipmentId = String(fd.get("amendShipment") ?? "");
                const target = shipmentId
                  ? ({ scope: "shipment", shipmentId } as const)
                  : ({ scope: "trip" } as const);
                amend.mutate({
                  movementId: id,
                  ...target,
                  reason: String(fd.get("reason") ?? ""),
                  ...(reasonCode && { reasonCode: reasonCode as CbsaAmendmentReasonCode }),
                  patch: {
                    scheduledCrossingAt: fromLocalInput(String(fd.get("eta") ?? "")),
                    portId: amendPortId,
                    carrierCode:
                      String(fd.get("amendCarrierCode") ?? "").trim() || defaultCarrierCode,
                    truckId: String(fd.get("truckId") ?? "") || null,
                    isEmpty: fd.get("isEmpty") === "on",
                  },
                });
              }}
            >
              <div className="sm:col-span-2 text-sm font-medium">
                Amend accepted manifest — re-transmits to customs
              </div>
              <Field label="Reason" htmlFor="amendReason">
                <input id="amendReason" name="reason" required className="input" />
              </Field>
              {m.regime === "ACI" && (
                <Field label="CBSA reason code" htmlFor="amendReasonCode">
                  <select id="amendReasonCode" name="reasonCode" required className="input">
                    <option value="">— select —</option>
                    {CBSA_AMENDMENT_REASON_CODES.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.code} · {r.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="About" htmlFor="amendShipment">
                <select id="amendShipment" name="amendShipment" className="input">
                  <option value="">Trip / conveyance</option>
                  {m.shipments.map((s) => (
                    <option key={s.id} value={s.id}>
                      Shipment {s.controlNumber}
                    </option>
                  ))}
                </select>
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
              <Field label="Port of entry" htmlFor="amendPort">
                <PortPicker
                  key={m.portId ?? "none"}
                  id="amendPort"
                  regime={m.regime}
                  kind={m.regime === "ACE" ? "port_of_entry" : "cbsa_office"}
                  value={amendPort}
                  onSelect={(port) => {
                    setAmendPortId(port?.id ?? null);
                    setAmendPort(port);
                  }}
                />
              </Field>
              <Field label="Carrier code" htmlFor="amendCarrierCode">
                <select
                  id="amendCarrierCode"
                  name="amendCarrierCode"
                  defaultValue={m.carrierCode ?? ""}
                  className="input"
                >
                  <option value="">Use regime default</option>
                  {carrierCodes.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                      {c.label ? ` · ${c.label}` : ""}
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
              <Field label="Load">
                <label className="flex items-center gap-2 pt-1.5 text-sm">
                  <input type="checkbox" name="isEmpty" defaultChecked={m.isEmpty} />
                  {m.regime === "ACE" ? "Empty trailer" : "Empty trip"}
                </label>
              </Field>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
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
                <span className="font-medium text-status-signal">Customs simulation (dev)</span>
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

          <nav
            className="flex gap-1 overflow-x-auto rounded-lg bg-surface-sunken p-1"
            aria-label="Wizard steps"
          >
            {STEPS.map((s) => {
              const n = issuesFor(s.key);
              const hasBlock = n.some((i) => i.severity === "blocking");
              return (
                <button
                  key={s.key}
                  onClick={() => setStep(s.key)}
                  className={`min-h-10 min-w-max flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${step === s.key ? "bg-surface-raised font-medium text-fg-primary shadow-sm" : "text-fg-secondary hover:bg-surface-raised/60 hover:text-fg-primary"}`}
                >
                  {s.label}
                  {n.length > 0 && (
                    <span
                      className={`ml-1.5 rounded-full px-1.5 text-[10px] font-semibold ${hasBlock ? "bg-danger-500/10 text-status-danger" : "bg-warn-500/10 text-status-warn"}`}
                    >
                      {n.length}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <section className="panel p-5">
            <StepPanel />
          </section>
        </div>

        <div className="flex flex-col gap-4 xl:sticky xl:top-20 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto">
          <ReadinessPanel readiness={m.readiness} />
          <div className="panel p-4">
            <Timeline
              movementId={id}
              events={m.events}
              canNote={permissions.write}
              onChanged={refresh}
            />
          </div>
        </div>
      </div>
    </WorkspaceProvider>
  );
}

function simDecisions(
  status: MovementStatus,
): Array<"accepted" | "rejected" | "released" | "held"> {
  if (status === "sent") return ["accepted", "rejected"];
  if (status === "accepted") return ["released", "held"];
  if (status === "held") return ["released"];
  return [];
}

function SuggestionValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-fg-secondary">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}
