"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { useTRPC } from "@/lib/trpc/client";

type Member = inferRouterOutputs<AppRouter>["organization"]["members"]["list"][number];

export function MembersTable({
  initialMembers,
  roles,
  canManage,
  currentUserId,
}: {
  initialMembers: Member[];
  roles: { id: string; name: string }[];
  canManage: boolean;
  currentUserId: string;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const listOpts = trpc.organization.members.list.queryOptions();
  const { data: members = initialMembers } = useQuery({ ...listOpts, initialData: initialMembers });
  const invalidate = () => qc.invalidateQueries({ queryKey: listOpts.queryKey });

  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const invite = useMutation(
    trpc.organization.members.invite.mutationOptions({
      onSuccess: (r) => {
        setInviteLink(`${window.location.origin}${r.invitePath}`);
        invalidate();
      },
    }),
  );
  const updateRole = useMutation(
    trpc.organization.members.updateRole.mutationOptions({ onSuccess: invalidate }),
  );
  const setStatus = useMutation(
    trpc.organization.members.setStatus.mutationOptions({ onSuccess: invalidate }),
  );
  const remove = useMutation(
    trpc.organization.members.remove.mutationOptions({ onSuccess: invalidate }),
  );

  return (
    <div className="space-y-6">
      {canManage && (
        <form
          className="panel flex flex-wrap items-end gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            invite.mutate({
              email: String(fd.get("email")),
              roleId: String(fd.get("roleId")),
            });
            e.currentTarget.reset();
          }}
        >
          <div className="w-full min-w-0 flex-1 sm:min-w-64">
            <label className="label" htmlFor="invite-email">
              Invite by email
            </label>
            <input id="invite-email" name="email" type="email" required className="input" />
          </div>
          <div>
            <label className="label" htmlFor="invite-role">
              Role
            </label>
            <select id="invite-role" name="roleId" className="input" defaultValue={roles[0]?.id}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={invite.isPending} className="btn-primary">
            {invite.isPending ? "Inviting…" : "Send invite"}
          </button>
          {invite.error && (
            <p className="w-full text-sm text-status-danger">{invite.error.message}</p>
          )}
          {inviteLink && (
            <p className="w-full text-sm text-fg-secondary">
              Invite link (email delivery arrives in Phase 5):{" "}
              <code className="rounded bg-surface-sunken px-1.5 py-0.5 text-xs">{inviteLink}</code>
            </p>
          )}
        </form>
      )}

      <div className="panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-fg-secondary">
            <tr>
              <th className="px-4 py-2 font-medium">Member</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Status</th>
              {canManage && <th className="px-4 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {members.map((m) => {
              const isSelf = m.userId === currentUserId;
              return (
                <tr key={m.id}>
                  <td className="px-4 py-2">
                    <div className="font-medium">{m.displayName ?? m.invitedEmail ?? "—"}</div>
                    {m.displayName && m.invitedEmail && (
                      <div className="text-xs text-fg-secondary">{m.invitedEmail}</div>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {canManage && !isSelf ? (
                      <select
                        className="input py-1"
                        value={m.roleId}
                        onChange={(e) =>
                          updateRole.mutate({ memberId: m.id, roleId: e.target.value })
                        }
                      >
                        {roles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      m.roleName
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={m.status} />
                  </td>
                  {canManage && (
                    <td className="px-4 py-2 text-right">
                      {!isSelf && m.status !== "invited" && (
                        <button
                          className="mr-3 text-xs text-fg-secondary hover:text-fg-primary"
                          onClick={() =>
                            setStatus.mutate({
                              memberId: m.id,
                              status: m.status === "active" ? "suspended" : "active",
                            })
                          }
                        >
                          {m.status === "active" ? "Suspend" : "Reactivate"}
                        </button>
                      )}
                      {!isSelf && (
                        <button
                          className="text-xs text-status-danger hover:underline"
                          onClick={() => remove.mutate({ memberId: m.id })}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Member["status"] }) {
  const cls = {
    active: "bg-ok-500/10 text-status-ok",
    invited: "bg-warn-500/10 text-status-warn",
    suspended: "bg-danger-500/10 text-status-danger",
  }[status];
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>;
}
