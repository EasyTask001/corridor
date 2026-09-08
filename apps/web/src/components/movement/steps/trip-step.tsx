"use client";

import { useState, type FormEvent } from "react";
import {
  ACI_FLAG_KEYS,
  ACI_FLAG_LABELS,
  IIT_INDICATORS,
  IIT_INDICATOR_LABELS,
  type IitIndicator,
} from "@corridor/domain";
import { PortPicker, type PickablePort } from "@/components/port-picker";
import { RegimeBadge } from "../status-badge";
import { Field } from "../field";
import {
  fromLocalInput,
  toLocalInput,
  useMovementMutations,
  useWorkspace,
} from "../workspace-context";

export function TripStep() {
  const { movement: m, options, editable } = useWorkspace();
  const { update } = useMovementMutations();

  const carrierCodes = options.carrierCodes.filter((c) => c.regime === m.regime);
  const defaultCarrierCode = carrierCodes.find((c) => c.isDefault)?.code ?? null;

  const pickable = (): PickablePort | null =>
    m.port
      ? { id: m.portId!, code: m.port.code, name: m.port.name, stateProvince: m.port.stateProvince }
      : null;

  const [portId, setPortId] = useState<string | null>(m.portId);
  const [port, setPort] = useState<PickablePort | null>(pickable);

  // `m.portId` can change out from under this component without a remount —
  // accepting an AI suggestion sets it server-side, `m` refetches — so the
  // picker state (seeded once at mount) has to re-seed whenever that happens,
  // or saving the trip step with a stale local portId would silently null out
  // a port the server already set. This is React's documented
  // "adjust state during render" pattern (not an effect, so it commits in the
  // same render — no setState-in-effect lint issue, no extra flicker).
  const [trackedPortId, setTrackedPortId] = useState(m.portId);
  if (m.portId !== trackedPortId) {
    setTrackedPortId(m.portId);
    setPortId(m.portId);
    setPort(pickable());
  }

  return (
    <form
      className="grid max-w-2xl grid-cols-2 gap-4"
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        update.mutate({
          id: m.id,
          tripNumber: String(fd.get("tripNumber") ?? "").trim() || null,
          portId,
          // "" ("Use regime default") resolves to the actual default code
          // rather than clearing carrierCode outright — a movement should
          // always carry a real code once one exists for its regime.
          carrierCode: String(fd.get("carrierCode") ?? "").trim() || defaultCarrierCode,
          scheduledCrossingAt: fromLocalInput(String(fd.get("eta") ?? "")),
          isEmpty: fd.get("isEmpty") === "on",
          iitIndicator: String(fd.get("iitIndicator") ?? "none") as IitIndicator,
          ...(m.regime === "ACI" &&
            Object.fromEntries(ACI_FLAG_KEYS.map((k) => [k, fd.get(k) === "on"]))),
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
      <Field label="Port of entry" htmlFor="port">
        <PortPicker
          key={m.portId ?? "none"}
          id="port"
          regime={m.regime}
          kind={m.regime === "ACE" ? "port_of_entry" : "cbsa_office"}
          value={port}
          disabled={!editable}
          onSelect={(next) => {
            setPortId(next?.id ?? null);
            setPort(next);
          }}
        />
      </Field>
      <Field label="Carrier code" htmlFor="carrierCode">
        <select
          id="carrierCode"
          name="carrierCode"
          defaultValue={m.carrierCode ?? ""}
          disabled={!editable}
          className="input"
        >
          <option value="">Use regime default</option>
          {carrierCodes.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code}
              {c.label ? ` · ${c.label}` : ""}
              {c.isDefault ? " (default)" : ""}
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
      <Field label="Load">
        <label className="flex items-center gap-2 pt-1.5 text-sm">
          <input
            type="checkbox"
            name="isEmpty"
            defaultChecked={m.isEmpty}
            disabled={!editable}
          />
          {m.regime === "ACE" ? "Empty trailer" : "Empty trip"}
          <span className="text-xs text-ink-500">(filed with no shipments)</span>
        </label>
      </Field>
      <Field label="Instruments of international traffic" htmlFor="iitIndicator">
        <select
          id="iitIndicator"
          name="iitIndicator"
          defaultValue={m.iitIndicator}
          disabled={!editable}
          className="input"
        >
          {IIT_INDICATORS.map((v) => (
            <option key={v} value={v}>
              {IIT_INDICATOR_LABELS[v]}
            </option>
          ))}
        </select>
      </Field>
      {m.regime === "ACI" && (
        <fieldset className="col-span-2">
          <legend className="label">CBSA trip flags</legend>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            {ACI_FLAG_KEYS.map((k) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" name={k} defaultChecked={m[k]} disabled={!editable} />
                {ACI_FLAG_LABELS[k]}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {editable && (
        <div className="col-span-2">
          <button className="btn-primary" disabled={update.isPending}>
            Save trip
          </button>
        </div>
      )}
    </form>
  );
}
