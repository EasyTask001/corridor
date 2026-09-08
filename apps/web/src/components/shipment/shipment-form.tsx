"use client";

/** Create/edit form for a shipment header. Commodity lines are edited separately. */
import { useState, type FormEvent } from "react";
import {
  ACE_SHIPMENT_TYPES,
  ACI_CARGO_TYPES,
  type AceShipmentType,
  type AciCargoType,
  type Regime,
} from "@corridor/domain";
import { expectedPartnerCountry } from "@corridor/domain";
import { PortPicker, type PickablePort } from "@/components/port-picker";
import { Field } from "@/components/movement/field";

export interface ShipmentFormValues {
  controlReference: string;
  shipmentType?: AceShipmentType;
  cargoType?: AciCargoType;
  isPars: boolean;
  shipperId: string | null;
  consigneeId: string | null;
  entryNumber: string | null;
  entryPortId: string | null;
  inBondEntryType: "IT" | "TE" | "IE" | null;
  inBondDestinationPortId: string | null;
  inBondNumber: string | null;
  destinationPortId?: string | null;
  sublocationPortId?: string | null;
  loadingCountry?: string | null;
  loadingProvince?: string | null;
  loadingCity?: string | null;
  consigneeBusinessNumber?: string | null;
  deliveryAddress?: { line1?: string; city?: string; region?: string; postalCode?: string };
  notes: string | null;
}

export interface ShipmentFormInitial {
  controlReference: string;
  shipmentType: AceShipmentType | null;
  cargoType: AciCargoType | null;
  isPars: boolean;
  shipperId: string | null;
  consigneeId: string | null;
  entryNumber: string | null;
  entryPortId: string | null;
  inBondEntryType: "IT" | "TE" | "IE" | null;
  inBondDestinationPortId: string | null;
  inBondNumber: string | null;
  destinationPortId: string | null;
  sublocationPortId: string | null;
  loadingCountry: string | null;
  loadingProvince: string | null;
  loadingCity: string | null;
  consigneeBusinessNumber: string | null;
  deliveryAddress: { line1?: string; city?: string; region?: string; postalCode?: string };
  notes: string | null;
}

const label = (value: string) => value.replace(/_/g, " ");

export function ShipmentForm({
  regime,
  initial,
  partners,
  portLabels,
  pending,
  disabled,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  regime: Regime;
  initial: ShipmentFormInitial | null;
  partners: { id: string; label: string; type: string; country?: string | null }[];
  /** id → code/name for the ports `initial` already points at, so the pickers
   * open showing what is stored rather than an empty box. */
  portLabels?: Record<string, { code: string; name: string }>;
  pending: boolean;
  disabled?: boolean;
  submitLabel: string;
  onCancel?: () => void;
  onSubmit: (values: ShipmentFormValues) => void;
}) {
  // ACE loads are picked up in Canada and delivered in the US, ACI the reverse:
  // offer the partners on the expected side first, with an override.
  const [anyCountry, setAnyCountry] = useState(false);
  const bySide = (direction: "shipper" | "consignee", keep: string | null | undefined) => {
    const pool = partners.filter((p) => p.type === direction || p.type === "both");
    if (anyCountry) return pool;
    const expected = expectedPartnerCountry(regime, direction);
    const local = pool.filter((p) => p.id === keep || !p.country || p.country === expected);
    return local.length > 0 ? local : pool;
  };
  const shippers = bySide("shipper", initial?.shipperId);
  const consignees = bySide("consignee", initial?.consigneeId);

  const [entryPortId, setEntryPortId] = useState(initial?.entryPortId ?? null);
  const [inBondPortId, setInBondPortId] = useState(initial?.inBondDestinationPortId ?? null);
  const [destinationPortId, setDestinationPortId] = useState(initial?.destinationPortId ?? null);
  const [sublocationPortId, setSublocationPortId] = useState(initial?.sublocationPortId ?? null);

  const str = (v: FormDataEntryValue | null) => (v && String(v).trim() ? String(v).trim() : null);
  const pick = (setter: (id: string | null) => void) => (port: PickablePort | null) =>
    setter(port?.id ?? null);
  const portLabel = (id: string | null) => (id ? (portLabels?.[id] ?? null) : null);

  return (
    <form
      role="form"
      aria-label={initial ? "Edit shipment" : "New shipment"}
      className="panel grid grid-cols-2 gap-4 p-4 sm:grid-cols-3"
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        onSubmit({
          controlReference: String(fd.get("controlReference") ?? "")
            .trim()
            .toUpperCase(),
          ...(regime === "ACE"
            ? { shipmentType: String(fd.get("shipmentType")) as AceShipmentType }
            : { cargoType: String(fd.get("cargoType")) as AciCargoType }),
          isPars: fd.get("isPars") === "on",
          shipperId: str(fd.get("shipperId")),
          consigneeId: str(fd.get("consigneeId")),
          entryNumber: str(fd.get("entryNumber")),
          entryPortId,
          inBondEntryType: (str(fd.get("inBondEntryType")) as "IT" | "TE" | "IE" | null) ?? null,
          inBondDestinationPortId: inBondPortId,
          inBondNumber: str(fd.get("inBondNumber")),
          ...(regime === "ACI" && {
            destinationPortId,
            sublocationPortId,
            loadingCountry: str(fd.get("loadingCountry"))?.toUpperCase() ?? null,
            loadingProvince: str(fd.get("loadingProvince")),
            loadingCity: str(fd.get("loadingCity")),
            consigneeBusinessNumber: str(fd.get("consigneeBusinessNumber")),
            deliveryAddress: {
              ...(str(fd.get("deliveryLine1")) && { line1: str(fd.get("deliveryLine1"))! }),
              ...(str(fd.get("deliveryCity")) && { city: str(fd.get("deliveryCity"))! }),
              ...(str(fd.get("deliveryRegion")) && { region: str(fd.get("deliveryRegion"))! }),
              ...(str(fd.get("deliveryPostalCode")) && {
                postalCode: str(fd.get("deliveryPostalCode"))!,
              }),
            },
          }),
          notes: str(fd.get("notes")),
        });
      }}
    >
      <Field label="Control reference" htmlFor="controlReference">
        <input
          id="controlReference"
          name="controlReference"
          required
          placeholder="PAPS0001"
          defaultValue={initial?.controlReference ?? ""}
          disabled={disabled}
          className="input font-mono uppercase"
        />
      </Field>
      {regime === "ACE" ? (
        <Field label="Shipment type" htmlFor="shipmentType">
          <select
            id="shipmentType"
            name="shipmentType"
            defaultValue={initial?.shipmentType ?? "regular_bill"}
            disabled={disabled}
            className="input capitalize"
          >
            {ACE_SHIPMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {label(t)}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field label="Cargo type" htmlFor="cargoType">
          <select
            id="cargoType"
            name="cargoType"
            defaultValue={initial?.cargoType ?? "regular"}
            disabled={disabled}
            className="input capitalize"
          >
            {ACI_CARGO_TYPES.map((t) => (
              <option key={t} value={t}>
                {label(t)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="PARS" htmlFor="isPars">
        <label className="flex items-center gap-2 pt-2 text-sm">
          <input
            id="isPars"
            name="isPars"
            type="checkbox"
            defaultChecked={initial?.isPars ?? false}
            disabled={disabled}
          />
          Broker files a PARS for this shipment
        </label>
      </Field>

      <Field label="Shipper" htmlFor="shipperId">
        <select
          id="shipperId"
          name="shipperId"
          defaultValue={initial?.shipperId ?? ""}
          disabled={disabled}
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
          disabled={disabled}
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
      <Field label="Partner countries" htmlFor="anyCountry">
        <label className="flex items-center gap-2 text-sm" htmlFor="anyCountry">
          <input
            id="anyCountry"
            type="checkbox"
            checked={anyCountry}
            onChange={(e) => setAnyCountry(e.target.checked)}
            disabled={disabled}
          />
          Show partners in any country
        </label>
        {!anyCountry && (
          <p className="mt-1 text-xs text-ink-500">
            {regime === "ACE" ? "Canadian shippers, US consignees" : "US shippers, Canadian consignees"}
          </p>
        )}
      </Field>
      <Field label="Entry number" htmlFor="entryNumber">
        <input
          id="entryNumber"
          name="entryNumber"
          defaultValue={initial?.entryNumber ?? ""}
          disabled={disabled}
          className="input font-mono"
        />
      </Field>
      <Field label="Entry port" htmlFor="entryPort">
        <PortPicker
          id="entryPort"
          value={portLabel(entryPortId)}
          regime={regime}
          kind={regime === "ACE" ? "port_of_entry" : "cbsa_office"}
          disabled={disabled}
          onSelect={pick(setEntryPortId)}
        />
      </Field>
      <Field label="In-bond entry type" htmlFor="inBondEntryType">
        <select
          id="inBondEntryType"
          name="inBondEntryType"
          defaultValue={initial?.inBondEntryType ?? ""}
          disabled={disabled}
          className="input"
        >
          <option value="">— none —</option>
          <option value="IT">IT — immediate transportation</option>
          <option value="TE">TE — transportation and exportation</option>
          <option value="IE">IE — immediate exportation</option>
        </select>
      </Field>
      <Field label="In-bond destination" htmlFor="inBondPort">
        <PortPicker
          id="inBondPort"
          value={portLabel(inBondPortId)}
          regime={regime}
          kind="in_bond_destination"
          disabled={disabled}
          onSelect={pick(setInBondPortId)}
        />
      </Field>
      <Field label="In-bond number" htmlFor="inBondNumber">
        <input
          id="inBondNumber"
          name="inBondNumber"
          defaultValue={initial?.inBondNumber ?? ""}
          disabled={disabled}
          className="input font-mono"
        />
      </Field>

      {regime === "ACI" && (
        <>
          <Field label="Destination office" htmlFor="destinationPort">
            <PortPicker
              id="destinationPort"
              value={portLabel(destinationPortId)}
              regime="ACI"
              kind="cbsa_office"
              disabled={disabled}
              onSelect={pick(setDestinationPortId)}
            />
          </Field>
          <Field label="Sublocation" htmlFor="sublocationPort">
            <PortPicker
              id="sublocationPort"
              value={portLabel(sublocationPortId)}
              regime="ACI"
              kind="sublocation"
              disabled={disabled}
              onSelect={pick(setSublocationPortId)}
            />
          </Field>
          <Field label="Consignee business number" htmlFor="consigneeBusinessNumber">
            <input
              id="consigneeBusinessNumber"
              name="consigneeBusinessNumber"
              defaultValue={initial?.consigneeBusinessNumber ?? ""}
              disabled={disabled}
              className="input font-mono"
            />
          </Field>
          <Field label="Loading country" htmlFor="loadingCountry">
            <input
              id="loadingCountry"
              name="loadingCountry"
              maxLength={2}
              placeholder="US"
              defaultValue={initial?.loadingCountry ?? ""}
              disabled={disabled}
              className="input uppercase"
            />
          </Field>
          <Field label="Loading province/state" htmlFor="loadingProvince">
            <input
              id="loadingProvince"
              name="loadingProvince"
              defaultValue={initial?.loadingProvince ?? ""}
              disabled={disabled}
              className="input"
            />
          </Field>
          <Field label="Loading city" htmlFor="loadingCity">
            <input
              id="loadingCity"
              name="loadingCity"
              defaultValue={initial?.loadingCity ?? ""}
              disabled={disabled}
              className="input"
            />
          </Field>
          <Field label="Delivery address" htmlFor="deliveryLine1">
            <input
              id="deliveryLine1"
              name="deliveryLine1"
              placeholder="Street"
              defaultValue={initial?.deliveryAddress.line1 ?? ""}
              disabled={disabled}
              className="input"
            />
          </Field>
          <Field label="Delivery city" htmlFor="deliveryCity">
            <input
              id="deliveryCity"
              name="deliveryCity"
              defaultValue={initial?.deliveryAddress.city ?? ""}
              disabled={disabled}
              className="input"
            />
          </Field>
          <Field label="Delivery region / postal code" htmlFor="deliveryRegion">
            <div className="flex gap-2">
              <input
                id="deliveryRegion"
                name="deliveryRegion"
                defaultValue={initial?.deliveryAddress.region ?? ""}
                disabled={disabled}
                className="input"
              />
              <input
                aria-label="Delivery postal code"
                name="deliveryPostalCode"
                defaultValue={initial?.deliveryAddress.postalCode ?? ""}
                disabled={disabled}
                className="input font-mono"
              />
            </div>
          </Field>
        </>
      )}

      <div className="col-span-2 sm:col-span-3">
        <Field label="Notes" htmlFor="notes">
          <input
            id="notes"
            name="notes"
            defaultValue={initial?.notes ?? ""}
            disabled={disabled}
            className="input"
          />
        </Field>
      </div>

      {!disabled && (
        <div className="col-span-2 flex gap-2 sm:col-span-3">
          <button className="btn-primary" disabled={pending}>
            {pending ? "Saving…" : submitLabel}
          </button>
          {onCancel && (
            <button type="button" className="btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      )}
    </form>
  );
}
