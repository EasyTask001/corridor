import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { RoleManager } from "./role-manager";

export const metadata: Metadata = { title: "Roles" };

export default async function RolesPage() {
  const session = await getSession();
  if (!session?.permissions.has("organization.roles.manage")) redirect("/dashboard");

  const caller = await api();
  const [roles, catalog] = await Promise.all([
    caller.organization.roles.list(),
    caller.organization.roles.catalog(),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Roles</h1>
        <p className="text-sm text-fg-secondary">
          Create organization-specific roles without granting permissions you do not hold.
        </p>
      </header>
      <RoleManager initialRoles={roles} catalog={catalog} />
    </div>
  );
}
