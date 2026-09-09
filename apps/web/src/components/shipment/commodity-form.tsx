"use client";

/** Create/edit form for one commodity line of a shipment. */
import { useState, type FormEvent } from "react";
import { CBP_QUANTITY_UNITS, type CommodityInput } from "@corridor/domain";
import { Field } from "@/components/movement/field";
import { HazmatFields, type HazmatDraft } from "./hazmat-fields";

export type CommodityFormValues = Omit<CommodityInput, "sourceDocumentId" | "extractionConfidence">;

export interface CommodityFormInitial {
  commodityDescription: string;
  hsCode: string | null;
  weightKg: number | null;
  weightUnit: "KG" | "LB";
  quantity: number | null;
  quantityUnit: string | null;
  packagingType: string | null;
  marksAndNumbers: string | null;
  isConsolidated: boolean;
  valueAmount: number | null;
  valueCurrency: "USD" | "CAD" | null;
  countryOfOrigin: string | null;
  hazmat: Array<{
    unCode: string;
    description: string | null;
    emergencyContact: string | null;
    emergencyPhone: string | null;
  }>;
}

export function CommodityForm({
  initial,
  pending,
  onCancel,
  onSubmit,
}: {
  initial: CommodityFormInitial | null;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (values: CommodityFormValues) => void;
}) {
  const [hazmat, setHazmat] = useState<HazmatDraft[]>(
    () =>
      initial?.hazmat.map((h) => ({
        unCode: h.unCode,
        description: h.description ?? "",
        emergencyContact: h.emergencyContact ?? "",
        emergencyPhone: h.emergencyPhone ?? "",
      })) ?? [],
  );
  const num = (v: FormDataEntryValue | null) => (v && String(v).trim() ? Number(v) : null);
  const str = (v: FormDataEntryValue | null) => (v && String(v).trim() ? String(v).trim() : null);

  return (
    <form
      role="form"
      aria-label={initial ? "Edit commodity line" : "New commodity line"}
      className="panel grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3"
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        onSubmit({
          commodityDescription: String(fd.get("commodityDescription") ?? "").trim(),
          hsCode: str(fd.get("hsCode")),
          weightKg: num(fd.get("weightKg")),
          weightUnit: (str(fd.get("weightUnit")) as "KG" | "LB" | null) ?? "KG",
          quantity: num(fd.get("quantity")),
          quantityUnit: str(fd.get("quantityUnit")) as CommodityFormValues["quantityUnit"],
          packagingType: str(fd.get("packagingType")),
          marksAndNumbers: str(fd.get("marksAndNumbers")),
          isConsolidated: fd.get("isConsolidated") === "on",
          valueAmount: num(fd.get("valueAmount")),
          valueCurrency: (str(fd.get("valueCurrency")) as "USD" | "CAD" | null) ?? null,
          countryOfOrigin: str(fd.get("countryOfOrigin"))?.toUpperCase() ?? null,
          hazmat: hazmat
            .filter((h) => h.unCode.trim())
            .map((h) => ({
              unCode: h.unCode.trim(),
              description: h.description.trim() || null,
              emergencyContact: h.emergencyContact.trim() || null,
              emergencyPhone: h.emergencyPhone.trim() || null,
            })),
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
      <Field label="HS code" htmlFor="hsCode">
        <input
          id="hsCode"
          name="hsCode"
          placeholder="7208.10"
          defaultValue={initial?.hsCode ?? ""}
          className="input font-mono"
        />
      </Field>
      <Field label="Weight" htmlFor="weightKg">
        <div className="flex gap-2">
          <input
            id="weightKg"
            name="weightKg"
            type="number"
            step="0.01"
            min="0"
            defaultValue={initial?.weightKg ?? ""}
            className="input"
          />
          <select
            aria-label="Weight unit"
            name="weightUnit"
            defaultValue={initial?.weightUnit ?? "KG"}
            className="input w-24"
          >
            <option value="KG">KG</option>
            <option value="LB">LB</option>
          </select>
        </div>
      </Field>
      <Field label="Quantity" htmlFor="quantity">
        <div className="flex gap-2">
          <input
            id="quantity"
            name="quantity"
            type="number"
            min="1"
            defaultValue={initial?.quantity ?? ""}
            className="input"
          />
          <select
            aria-label="Quantity unit"
            name="quantityUnit"
            defaultValue={initial?.quantityUnit ?? ""}
            className="input"
          >
            <option value="">—</option>
            {CBP_QUANTITY_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
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
      <Field label="Marks and numbers" htmlFor="marksAndNumbers">
        <input
          id="marksAndNumbers"
          name="marksAndNumbers"
          defaultValue={initial?.marksAndNumbers ?? ""}
          className="input font-mono"
        />
      </Field>
      <Field label="Consolidated" htmlFor="isConsolidated">
        <label className="flex items-center gap-2 pt-2 text-sm">
          <input
            id="isConsolidated"
            name="isConsolidated"
            type="checkbox"
            defaultChecked={initial?.isConsolidated ?? false}
          />
          Part of a consolidated load
        </label>
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

      <HazmatFields entries={hazmat} onChange={setHazmat} />

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
