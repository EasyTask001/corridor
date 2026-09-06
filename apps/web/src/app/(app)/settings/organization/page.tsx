import type { Metadata } from "next";
import { api } from "@/lib/trpc/server";
import { getSession } from "@/lib/session";
import { OrganizationForm } from "./organization-form";

export const metadata: Metadata = { title: "Organization" };

export default async function OrganizationSettingsPage() {
  const [session, caller] = await Promise.all([getSession(), api()]);
  const org = await caller.organization.get();
  const canManage = session?.permissions.has("organization.manage") ?? false;

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
          billingEmail: org.billingEmail ?? "",
        }}
        readOnly={!canManage}
      />
    </div>
  );
}
