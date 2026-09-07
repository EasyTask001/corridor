"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { Badge, Button, Input, Label } from "@corridor/ui";
import { useTRPC } from "@/lib/trpc/client";

type CarrierCode = inferRouterOutputs<AppRouter>["organization"]["carrierCodes"]["list"][number];

/**
 * The ACE/ACI carrier codes this org files under (migration 0018). SCAC and
 * the CBSA carrier code above stay the single onboarding-derived default per
 * regime; this panel is for the rest — a co-loaded second unit, a brokered
 * lane running under a partner's code, and so on.
 */
export function CarrierCodesPanel({ initial }: { initial: CarrierCode[] }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const listOpts = trpc.organization.carrierCodes.list.queryOptions();
  const [error, setError] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: listOpts.queryKey });
  const onError = (e: { message: string }) => setError(e.message);

  const upsert = useMutation(
    trpc.organization.carrierCodes.upsert.mutationOptions({ onSuccess: refresh, onError }),
  );
  const remove = useMutation(
    trpc.organization.carrierCodes.remove.mutationOptions({ onSuccess: refresh, onError }),
  );
  const setDefault = useMutation(
    trpc.organization.carrierCodes.setDefault.mutationOptions({ onSuccess: refresh, onError }),
  );

  const codes = initial;
  const byRegime = { ACE: codes.filter((c) => c.regime === "ACE"), ACI: codes.filter((c) => c.regime === "ACI") };

  return (
    <div className="panel space-y-4 p-6">
      <div>
        <h2 className="font-medium">Carrier codes</h2>
        <p className="text-sm text-ink-500">
          Every ACE/ACI code this fleet files manifests under, one default per regime.
        </p>
      </div>

      {error && <p className="text-sm text-danger-500">{error}</p>}

      {(["ACE", "ACI"] as const).map((regime) => (
        <div key={regime} className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            {regime}
          </div>
          <ul className="divide-y divide-ink-100 rounded-md border border-ink-100">
            {byRegime[regime].length === 0 && (
              <li className="px-3 py-2 text-sm text-ink-500">No codes yet.</li>
            )}
            {byRegime[regime].map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium">{c.code}</span>
                  {c.label && <span className="text-ink-500">{c.label}</span>}
                  {c.isDefault && <Badge variant="ok">Default</Badge>}
                </div>
                <div className="flex items-center gap-3">
                  {!c.isDefault && (
                    <button
                      type="button"
                      className="text-xs text-ink-500 hover:underline"
                      disabled={setDefault.isPending}
                      onClick={() => setDefault.mutate({ id: c.id })}
                    >
                      Make default
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-xs text-danger-500 hover:underline"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate({ id: c.id })}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              setError(null);
              const fd = new FormData(e.currentTarget);
              const code = String(fd.get("code") ?? "").trim();
              if (!code) return;
              upsert.mutate(
                {
                  regime,
                  code,
                  label: String(fd.get("label") ?? "").trim() || undefined,
                },
                { onSuccess: () => e.currentTarget?.reset?.() },
              );
            }}
          >
            <div>
              <Label htmlFor={`${regime}-code`}>Code</Label>
              <Input id={`${regime}-code`} name="code" className="w-24 font-mono uppercase" />
            </div>
            <div>
              <Label htmlFor={`${regime}-label`}>Label (optional)</Label>
              <Input id={`${regime}-label`} name="label" className="w-56" />
            </div>
            <Button type="submit" variant="secondary" disabled={upsert.isPending}>
              Add {regime} code
            </Button>
          </form>
        </div>
      ))}
    </div>
  );
}
