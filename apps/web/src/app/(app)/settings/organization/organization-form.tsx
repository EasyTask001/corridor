"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { useTRPC } from "@/lib/trpc/client";

type Fields = {
  name: string;
  legalName: string;
  scacCode: string;
  canadianCarrierCode: string;
  usDotNumber: string;
  mcNumber: string;
  filerCode: string;
  billingEmail: string;
  timezone: string;
  borderConnectCompanyKey: string;
};

type AddressFields = {
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
};

const FIELDS: { key: keyof Fields; label: string; mono?: boolean; helper?: string }[] = [
  { key: "name", label: "Display name" },
  { key: "legalName", label: "Legal name" },
  { key: "scacCode", label: "SCAC (US)", mono: true },
  { key: "canadianCarrierCode", label: "CBSA carrier code", mono: true },
  { key: "usDotNumber", label: "USDOT #", mono: true },
  { key: "mcNumber", label: "MC #", mono: true },
  { key: "filerCode", label: "Filer code", mono: true },
  { key: "billingEmail", label: "Billing email" },
  { key: "timezone", label: "Time zone (IANA)", mono: true },
  {
    key: "borderConnectCompanyKey",
    label: "BorderConnect company key",
    mono: true,
    helper:
      "Issued by BorderConnect for your carrier account; required for BorderConnect filing mode.",
  },
];

const ADDRESS: { key: keyof AddressFields; label: string; wide?: boolean }[] = [
  { key: "line1", label: "Address line 1", wide: true },
  { key: "line2", label: "Address line 2", wide: true },
  { key: "city", label: "City" },
  { key: "region", label: "Province / state" },
  { key: "postalCode", label: "Postal / ZIP" },
  { key: "country", label: "Country" },
];

type BillingStatus = inferRouterOutputs<AppRouter>["billing"]["status"];

export function OrganizationForm({
  initial,
  readOnly,
  simpleDriverSheet: initialSimple = false,
  includeParsInCargoNumbers: initialPars = false,
  billingAddress: initialAddress,
  dispatchEmails: initialDispatch = [],
  billing = null,
}: {
  initial: Fields;
  readOnly: boolean;
  /** organizations.simple_driver_sheet (0024): print sheets without commodity lines. */
  simpleDriverSheet?: boolean;
  /** organizations.include_pars_in_cargo_numbers (0025). */
  includeParsInCargoNumbers?: boolean;
  billingAddress?: Partial<AddressFields>;
  /** Up to five dispatch addresses that receive driver sheets and entry notices. */
  dispatchEmails?: string[];
  /** Read-only plan block (billing.status), when the caller may see billing. */
  billing?: BillingStatus | null;
}) {
  const trpc = useTRPC();
  const [form, setForm] = useState(initial);
  const [simpleDriverSheet, setSimpleDriverSheet] = useState(initialSimple);
  const [includePars, setIncludePars] = useState(initialPars);
  const [address, setAddress] = useState<AddressFields>({
    line1: initialAddress?.line1 ?? "",
    line2: initialAddress?.line2 ?? "",
    city: initialAddress?.city ?? "",
    region: initialAddress?.region ?? "",
    postalCode: initialAddress?.postalCode ?? "",
    country: initialAddress?.country ?? "",
  });
  const [dispatch, setDispatch] = useState<string[]>(
    Array.from({ length: 5 }, (_, i) => initialDispatch[i] ?? ""),
  );
  const [saved, setSaved] = useState(false);
  const update = useMutation(
    trpc.organization.update.mutationOptions({ onSuccess: () => setSaved(true) }),
  );

  const cls = (mono?: boolean) =>
    `input ${mono ? "font-mono" : ""} ${readOnly ? "bg-surface-sunken" : ""}`;

  return (
    <form
      className="panel space-y-5 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        const payload: Record<string, unknown> = {};
        for (const { key } of FIELDS) {
          const v = form[key].trim();
          if (v !== (initial[key] ?? "")) {
            // Every other field treats "blank" as "leave unchanged" (send
            // `undefined`). The company key is the one field a dispatcher must
            // be able to actually clear — e.g. to unassign a decommissioned
            // BorderConnect account — so a blank here sends `null` instead.
            payload[key] = v || (key === "borderConnectCompanyKey" ? null : undefined);
          }
        }
        if (simpleDriverSheet !== initialSimple) payload.simpleDriverSheet = simpleDriverSheet;
        if (includePars !== initialPars) payload.includeParsInCargoNumbers = includePars;
        const cleanAddress = Object.fromEntries(
          Object.entries(address)
            .map(([k, v]) => [k, v.trim()])
            .filter(([, v]) => v),
        );
        if (JSON.stringify(cleanAddress) !== JSON.stringify(initialAddress ?? {}))
          payload.billingAddress = cleanAddress;
        const emails = dispatch.map((d) => d.trim().toLowerCase()).filter(Boolean);
        if (JSON.stringify(emails) !== JSON.stringify(initialDispatch))
          payload.dispatchEmails = emails;
        update.mutate(payload);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map(({ key, label, mono, helper }) => (
          <div key={key} className={key === "name" || key === "legalName" ? "sm:col-span-2" : ""}>
            <label htmlFor={key} className="label">
              {label}
            </label>
            <input
              id={key}
              value={form[key]}
              readOnly={readOnly}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              className={cls(mono)}
              aria-describedby={helper ? `${key}-helper` : undefined}
            />
            {helper && (
              <p id={`${key}-helper`} className="mt-1 text-xs text-fg-secondary">
                {helper}
              </p>
            )}
          </div>
        ))}
      </div>

      <fieldset>
        <legend className="label">Billing address</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {ADDRESS.map(({ key, label, wide }) => (
            <div key={key} className={wide ? "sm:col-span-2" : ""}>
              <label htmlFor={`billing-${key}`} className="label">
                {label}
              </label>
              <input
                id={`billing-${key}`}
                value={address[key]}
                readOnly={readOnly}
                onChange={(e) => setAddress({ ...address, [key]: e.target.value })}
                className={cls(key === "country" || key === "region" || key === "postalCode")}
              />
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="label">
          Dispatch e-mail (driver sheets and entry notices, up to five)
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {dispatch.map((value, i) => (
            <input
              key={i}
              aria-label={`Dispatch e-mail ${i + 1}`}
              type="email"
              value={value}
              readOnly={readOnly}
              placeholder={i === 0 ? "dispatch@example.com" : ""}
              onChange={(e) => setDispatch(dispatch.map((d, j) => (j === i ? e.target.value : d)))}
              className={cls()}
            />
          ))}
        </div>
      </fieldset>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={simpleDriverSheet}
            disabled={readOnly}
            onChange={(e) => setSimpleDriverSheet(e.target.checked)}
          />
          Simple driver sheet
          <span className="text-xs text-fg-secondary">(print without commodity lines)</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includePars}
            disabled={readOnly}
            onChange={(e) => setIncludePars(e.target.checked)}
          />
          Include PARS in cargo control numbers
          <span className="text-xs text-fg-secondary">(ACI PARS shipments)</span>
        </label>
      </div>

      {billing && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg bg-surface-sunken px-4 py-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-fg-secondary">Plan</dt>
            <dd className="font-medium capitalize">{billing.plan}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-fg-secondary">Status</dt>
            <dd className="font-medium capitalize">{billing.status.replace(/_/g, " ")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-fg-secondary">Seats</dt>
            <dd className="font-medium">{billing.subscription?.seats ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-fg-secondary">Renews</dt>
            <dd className="font-medium">
              {billing.subscription?.currentPeriodEnd
                ? new Date(billing.subscription.currentPeriodEnd).toLocaleDateString("en-CA")
                : "—"}
            </dd>
          </div>
        </dl>
      )}

      {update.error && (
        <p role="alert" className="text-sm text-status-danger">
          {update.error.message}
        </p>
      )}
      {saved && <p className="text-sm text-status-ok">Saved.</p>}
      {!readOnly && (
        <button type="submit" disabled={update.isPending} className="btn-primary">
          {update.isPending ? "Saving…" : "Save changes"}
        </button>
      )}
    </form>
  );
}
