import type { Metadata } from "next";
import { api } from "@/lib/trpc/server";
import { getSession } from "@/lib/session";
import { CarrierCodesPanel } from "./carrier-codes-panel";
import { OrganizationForm } from "./organization-form";
import { SsoForm } from "./sso-form";

export const metadata: Metadata = { title: "Organization" };

export default async function OrganizationSettingsPage() {
  const [session, caller] = await Promise.all([getSession(), api()]);
  const org = await caller.organization.get();
  const canManage = session?.permissions.has("organization.manage") ?? false;
  const plan = session?.plan ?? "trial";

  // `sso.get` needs only `organization.manage` — deliberately not the plan.
  // A tenant that downgraded away from Enterprise keeps `enforced` (and so
  // keeps password sign-in switched off) until someone removes it, so the card
  // has to be able to show and undo that configuration on any plan.
  const sso = canManage ? await caller.organization.sso.get() : null;
  const carrierCodes = canManage ? await caller.organization.carrierCodes.list() : [];

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Organization</h1>
        <p className="text-sm text-ink-500">
          Carrier identity used on every ACE / ACI manifest. Third-party API credentials live in
          Integrations and are never shown here.
        </p>
      </header>
      <OrganizationForm
        initial={{
          name: org.name,
          legalName: org.legalName ?? "",
          scacCode: org.scacCode ?? "",
          canadianCarrierCode: org.canadianCarrierCode ?? "",
          usDotNumber: org.usDotNumber ?? "",
          mcNumber: org.mcNumber ?? "",
          filerCode: org.filerCode ?? "",
          billingEmail: org.billingEmail ?? "",
        }}
        simpleDriverSheet={org.simpleDriverSheet}
        readOnly={!canManage}
      />
      {canManage && <CarrierCodesPanel initial={carrierCodes} />}
      {canManage && <SsoForm plan={plan} initial={sso} />}
    </div>
  );
}
