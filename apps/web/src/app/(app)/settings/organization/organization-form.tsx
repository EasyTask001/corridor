"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";

type Fields = {
  name: string;
  legalName: string;
  scacCode: string;
  canadianCarrierCode: string;
  usDotNumber: string;
  mcNumber: string;
  billingEmail: string;
};

const FIELDS: { key: keyof Fields; label: string; mono?: boolean }[] = [
  { key: "name", label: "Display name" },
  { key: "legalName", label: "Legal name" },
  { key: "scacCode", label: "SCAC (US)", mono: true },
  { key: "canadianCarrierCode", label: "CBSA carrier code", mono: true },
  { key: "usDotNumber", label: "USDOT #", mono: true },
  { key: "mcNumber", label: "MC #", mono: true },
  { key: "billingEmail", label: "Billing email" },
];

export function OrganizationForm({ initial, readOnly }: { initial: Fields; readOnly: boolean }) {
  const trpc = useTRPC();
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState(false);
  const update = useMutation(
    trpc.organization.update.mutationOptions({ onSuccess: () => setSaved(true) }),
  );

  return (
    <form
      className="panel space-y-4 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        const payload: Record<string, string | undefined> = {};
        for (const { key } of FIELDS) {
          const v = form[key].trim();
          if (v !== (initial[key] ?? "")) payload[key] = v || undefined;
        }
        update.mutate(payload);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map(({ key, label, mono }) => (
          <div key={key} className={key === "name" || key === "legalName" ? "sm:col-span-2" : ""}>
            <label htmlFor={key} className="label">
              {label}
            </label>
            <input
              id={key}
              value={form[key]}
              readOnly={readOnly}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              className={`input ${mono ? "font-mono" : ""} ${readOnly ? "bg-ink-50" : ""}`}
            />
          </div>
        ))}
      </div>
      {update.error && <p className="text-sm text-danger-500">{update.error.message}</p>}
      {saved && <p className="text-sm text-ok-500">Saved.</p>}
      {!readOnly && (
        <button type="submit" disabled={update.isPending} className="btn-primary">
          {update.isPending ? "Saving…" : "Save changes"}
        </button>
      )}
    </form>
  );
}
