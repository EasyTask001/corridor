import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { MembersTable } from "./members-table";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const session = await getSession();
  if (!session?.permissions.has("organization.members.read")) redirect("/dashboard");

  const caller = await api();
  const [members, roles] = await Promise.all([
    caller.organization.members.list(),
    caller.organization.roles.list(),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-fg-secondary">
          Members and pending invitations for this carrier.
        </p>
      </header>
      <MembersTable
        initialMembers={members}
        roles={roles
          .filter((role) => role.permissions.every((key) => session.permissions.has(key)))
          .map((role) => ({ id: role.id, name: role.name }))}
        canManage={session.permissions.has("organization.members.manage")}
        currentUserId={session.user.id}
      />
    </div>
  );
}
