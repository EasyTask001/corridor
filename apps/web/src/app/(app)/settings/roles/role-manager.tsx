"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import type { PermissionKey } from "@corridor/domain";
import { useTRPC } from "@/lib/trpc/client";

type Outputs = inferRouterOutputs<AppRouter>;
type Role = Outputs["organization"]["roles"]["list"][number];
type Catalog = Outputs["organization"]["roles"]["catalog"];

export function RoleManager({ initialRoles, catalog }: { initialRoles: Role[]; catalog: Catalog }) {
  const trpc = useTRPC();
  const [roles, setRoles] = useState(initialRoles);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<PermissionKey>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const systemRoles = roles.filter((role) => role.isSystem);
  const customRoles = roles.filter((role) => !role.isSystem);
  const groups = useMemo(
    () =>
      Object.entries(
        catalog.reduce<Record<string, Catalog>>((result, permission) => {
          (result[permission.module] ??= []).push(permission);
          return result;
        }, {}),
      ).sort(([a], [b]) => a.localeCompare(b)),
    [catalog],
  );

  const reset = () => {
    setSelectedId(null);
    setName("");
    setSelected(new Set());
    setNotice(null);
  };

  const edit = (role: Role) => {
    setSelectedId(role.id);
    setName(role.name);
    setSelected(new Set(role.permissions));
    setNotice(null);
  };

  const create = useMutation(
    trpc.organization.roles.create.mutationOptions({
      onSuccess: (role) => {
        setRoles((current) => [...current, role].sort((a, b) => a.name.localeCompare(b.name)));
        edit(role);
        setNotice("Role created.");
      },
    }),
  );
  const update = useMutation(
    trpc.organization.roles.update.mutationOptions({
      onSuccess: (role) => {
        setRoles((current) => current.map((item) => (item.id === role.id ? role : item)));
        edit(role);
        setNotice("Role saved.");
      },
    }),
  );
  const remove = useMutation(
    trpc.organization.roles.delete.mutationOptions({
      onSuccess: ({ id }) => {
        setRoles((current) => current.filter((role) => role.id !== id));
        reset();
        setNotice("Role deleted.");
      },
    }),
  );

  const busy = create.isPending || update.isPending || remove.isPending;
  const error = create.error ?? update.error ?? remove.error;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(null);
    const input = { name, permissions: [...selected] };
    if (selectedId) update.mutate({ id: selectedId, ...input });
    else create.mutate(input);
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[20rem_1fr]">
      <aside className="space-y-4">
        <section className="panel p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-medium">Custom roles</h2>
            <button type="button" className="btn-secondary text-xs" onClick={reset}>
              New role
            </button>
          </div>
          <div className="mt-3 space-y-1">
            {customRoles.length === 0 && (
              <p className="text-sm text-fg-secondary">No custom roles yet.</p>
            )}
            {customRoles.map((role) => (
              <button
                key={role.id}
                type="button"
                aria-pressed={selectedId === role.id}
                onClick={() => edit(role)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                  selectedId === role.id
                    ? "bg-accent text-accent-fg"
                    : "bg-surface-sunken text-fg-primary hover:bg-surface-sunken"
                }`}
              >
                <span className="font-medium">{role.name}</span>
                <span className="ml-2 text-xs opacity-70">{role.permissions.length} grants</span>
              </button>
            ))}
          </div>
        </section>

        <section className="panel p-4">
          <h2 className="font-medium">System roles</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {systemRoles.map((role) => (
              <li key={role.id} className="flex justify-between gap-3">
                <span>{role.name}</span>
                <span className="text-xs text-fg-secondary">{role.permissions.length} grants</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-fg-secondary">System roles are read-only templates.</p>
        </section>
      </aside>

      <form className="panel p-5" onSubmit={submit}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">
              {selectedId ? "Edit custom role" : "New role"}
            </h2>
            <p className="text-sm text-fg-secondary">
              Permission changes take effect on a member&apos;s next request.
            </p>
          </div>
          {selectedId && (
            <button
              type="button"
              className="text-sm text-status-danger hover:underline"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Delete ${name}?`)) remove.mutate({ id: selectedId });
              }}
            >
              Delete role
            </button>
          )}
        </div>

        <div className="mt-5">
          <label className="label" htmlFor="role-name">
            Role name
          </label>
          <input
            id="role-name"
            className="input max-w-md"
            value={name}
            minLength={2}
            maxLength={64}
            required
            onChange={(event) => setName(event.target.value)}
            placeholder="Night Dispatcher"
          />
        </div>

        <div className="mt-6 space-y-6">
          {groups.map(([module, permissions]) => (
            <fieldset key={module}>
              <legend className="text-xs font-semibold uppercase tracking-wide text-fg-secondary">
                {module}
              </legend>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {permissions.map((permission) => {
                  const checked = selected.has(permission.key);
                  return (
                    <label
                      key={permission.key}
                      className={`flex gap-3 rounded-md border p-3 text-sm ${
                        permission.assignable
                          ? "border-border-default"
                          : "border-border-default bg-surface-sunken"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!permission.assignable}
                        onChange={() => {
                          setNotice(null);
                          setSelected((current) => {
                            const next = new Set(current);
                            if (next.has(permission.key)) next.delete(permission.key);
                            else next.add(permission.key);
                            return next;
                          });
                        }}
                      />
                      <span>
                        <span className="block font-mono text-xs">{permission.key}</span>
                        <span className="text-xs text-fg-secondary">{permission.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>

        {error && <p className="mt-4 text-sm text-status-danger">{error.message}</p>}
        {notice && <p className="mt-4 text-sm text-status-ok">{notice}</p>}
        <div className="mt-6 flex items-center gap-3 border-t border-border-default pt-4">
          <button
            type="submit"
            className="btn-primary"
            disabled={busy || !name.trim() || selected.size === 0}
          >
            {busy ? "Saving…" : selectedId ? "Save role" : "Create role"}
          </button>
          <span className="text-xs text-fg-secondary">{selected.size} permissions selected</span>
        </div>
      </form>
    </div>
  );
}
