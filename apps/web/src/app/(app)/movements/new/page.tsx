import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { createMovement } from "../actions";

export const metadata: Metadata = { title: "New movement" };

const REGIMES = [
  {
    regime: "ACE" as const,
    heading: "ACE — southbound",
    lane: "Canada → United States",
    agency: "US Customs and Border Protection",
    blurb:
      "An e-manifest for a truck crossing into the United States. CBP wants the trip, crew, " +
      "conveyance and every shipment line before the driver reaches the primary booth.",
    cta: "Create ACE movement",
    className: "btn-primary",
  },
  {
    regime: "ACI" as const,
    heading: "ACI — northbound",
    lane: "United States → Canada",
    agency: "Canada Border Services Agency",
    blurb:
      "An e-manifest for a truck crossing into Canada. CBSA expects the cargo control data " +
      "one hour ahead of arrival for highway shipments.",
    cta: "Create ACI movement",
    className: "btn-signal",
  },
];

/**
 * Standalone create page. It posts the same `createMovement` server action the
 * list page's inline buttons use, so a movement started here is identical to
 * one started there — the action redirects into the new workspace.
 */
export default async function NewMovementPage() {
  const session = await getSession();
  if (!session?.permissions.has("movement.write")) redirect("/movements");

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <nav className="text-sm text-fg-secondary">
          <Link href="/movements" className="hover:text-fg-primary hover:underline">
            Movements
          </Link>
          <span aria-hidden> / </span>
          <span>New</span>
        </nav>
        <h1 className="text-2xl font-semibold tracking-tight">New movement</h1>
        <p className="text-sm text-fg-secondary">
          Pick the direction of travel. Everything else — trip, crew, truck, shipment lines and
          seals — is filled in on the movement itself, and nothing is transmitted until it passes
          validation.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {REGIMES.map((r) => (
          <form key={r.regime} action={createMovement} className="panel flex flex-col gap-3 p-5">
            <input type="hidden" name="regime" value={r.regime} />
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-semibold">{r.heading}</h2>
              <span className="font-mono text-xs text-fg-secondary">{r.regime}</span>
            </div>
            <p className="font-mono text-xs uppercase tracking-wide text-fg-secondary">{r.lane}</p>
            <p className="text-sm text-fg-primary">{r.blurb}</p>
            <p className="text-xs text-fg-secondary">Filed with {r.agency}.</p>
            <button className={`${r.className} mt-auto self-start`}>{r.cta}</button>
          </form>
        ))}
      </div>
    </div>
  );
}
