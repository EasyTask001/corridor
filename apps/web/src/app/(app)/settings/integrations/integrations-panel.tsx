"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { useTRPC } from "@/lib/trpc/client";

type O = inferRouterOutputs<AppRouter>["integrations"];
type Configs = O["configs"]["list"];
type Events = O["events"]["list"];
type Jobs = O["jobs"]["list"];

const PROVIDERS = [
  {
    key: "cbp_ace",
    name: "CBP ACE (US)",
    desc: "Automated Commercial Environment — southbound e-manifests",
    mock: true,
    credentials: true,
  },
  {
    key: "cbsa_aci",
    name: "CBSA ACI (Canada)",
    desc: "Advance Commercial Information — northbound e-manifests",
    mock: true,
    credentials: true,
  },
  {
    key: "border_wait_time",
    name: "Border wait times",
    desc: "CBP BWT / CBSA border times feed (stub)",
    mock: false,
    credentials: false,
  },
  {
    key: "hts_tariff",
    name: "HS / HTS tariff",
    desc: "Tariff classification lookup (stub)",
    mock: false,
    credentials: false,
  },
  {
    key: "stripe",
    name: "Stripe",
    desc: "Subscription billing — managed on the Billing page",
    mock: false,
    credentials: false,
  },
] as const;

export function IntegrationsPanel({
  initialConfigs,
  initialEvents,
  initialJobs,
  initialStats,
}: {
  initialConfigs: Configs;
  initialEvents: Events;
  initialJobs: Jobs;
  initialStats: Record<string, number>;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const configsQ = useQuery({
    ...trpc.integrations.configs.list.queryOptions(),
    initialData: initialConfigs,
  });
  const eventsQ = useQuery({
    ...trpc.integrations.events.list.queryOptions({ limit: 50 }),
    initialData: initialEvents,
    refetchInterval: 5000,
  });
  const jobsQ = useQuery({
    ...trpc.integrations.jobs.list.queryOptions({ limit: 30 }),
    initialData: initialJobs,
    refetchInterval: 5000,
  });
  const statsQ = useQuery({
    ...trpc.integrations.jobs.stats.queryOptions(),
    initialData: initialStats,
    refetchInterval: 5000,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.integrations.pathKey() });
  const upsert = useMutation(
    trpc.integrations.configs.upsert.mutationOptions({ onSuccess: invalidate }),
  );
  const runNow = useMutation(
    trpc.integrations.jobs.runNow.mutationOptions({ onSuccess: invalidate }),
  );
  const clearCredentials = useMutation(
    trpc.integrations.configs.clearCredentials.mutationOptions({ onSuccess: invalidate }),
  );
  const [saved, setSaved] = useState<string | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});
  const testCustoms = useMutation(
    trpc.integrations.testCustoms.mutationOptions({
      onSuccess: (r, vars) =>
        setTested((t) => ({
          ...t,
          [vars.provider]: r.ok
            ? `Connected (${r.mode}${r.live ? ", live" : ", fixture replay"}, ${r.durationMs} ms)`
            : `Failed: ${r.error ?? "no response"}`,
        })),
      onError: (e, vars) => setTested((t) => ({ ...t, [vars.provider]: `Failed: ${e.message}` })),
    }),
  );

  const cfgFor = (p: string) => configsQ.data.find((c) => c.provider === p);

  return (
    <div className="space-y-6">
      <section className="grid gap-4 lg:grid-cols-2">
        {PROVIDERS.map((p) => {
          const cfg = cfgFor(p.key);
          const settings = (cfg?.settings ?? {}) as {
            mockDelayMs?: number;
            mockFailureRate?: number;
          };
          return (
            <form
              key={p.key}
              className="panel space-y-3 p-5"
              onSubmit={(e: FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                const form = e.currentTarget;
                const fd = new FormData(form);
                const secret = (name: string) => {
                  const value = String(fd.get(name) ?? "").trim();
                  return value.length > 0 ? value : undefined;
                };
                upsert.mutate(
                  {
                    provider: p.key,
                    environment: (fd.get("environment") as "sandbox" | "production") ?? "sandbox",
                    status: fd.get("enabled") ? "active" : "disabled",
                    mode: p.mock ? ((fd.get("mode") as "mock" | "gateway") ?? "mock") : "mock",
                    baseUrl: p.mock ? String(fd.get("baseUrl") ?? "").trim() || null : null,
                    settings: p.mock
                      ? {
                          mockDelayMs: Number(fd.get("mockDelayMs") ?? 4000),
                          mockFailureRate: Number(fd.get("mockFailureRate") ?? 0) / 100,
                        }
                      : {},
                    credentials: p.credentials
                      ? {
                          apiKey: secret("apiKey"),
                          apiSecret: secret("apiSecret"),
                          accountId: secret("accountId"),
                        }
                      : undefined,
                  },
                  {
                    onSuccess: () => {
                      setSaved(p.key);
                      // Never leave a secret sitting in the DOM after the write.
                      form
                        .querySelectorAll<HTMLInputElement>("input[data-secret]")
                        .forEach((el) => (el.value = ""));
                    },
                  },
                );
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-medium">{p.name}</h2>
                  <p className="text-xs text-fg-secondary">{p.desc}</p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  {p.credentials && cfg?.hasCredentials && (
                    <span className="rounded bg-ok-500/10 px-2 py-0.5 text-xs font-semibold uppercase text-status-ok">
                      Credentials stored
                    </span>
                  )}
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-semibold uppercase ${
                      cfg?.status === "disabled"
                        ? "bg-surface-sunken text-fg-secondary"
                        : "bg-ok-500/10 text-status-ok"
                    }`}
                  >
                    {cfg?.status ?? "default"}
                  </span>
                </div>
              </div>
              {p.key === "stripe" ? (
                <p className="text-sm">
                  <Link href="/settings/billing" className="underline">
                    Manage on the Billing page →
                  </Link>
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor={`${p.key}-env`}>
                      Environment
                    </label>
                    <select
                      id={`${p.key}-env`}
                      name="environment"
                      defaultValue={cfg?.environment ?? "sandbox"}
                      className="input"
                    >
                      <option value="sandbox">Sandbox (mock gateway)</option>
                      <option value="production">Production</option>
                    </select>
                  </div>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                      type="checkbox"
                      name="enabled"
                      defaultChecked={cfg?.status !== "disabled"}
                    />{" "}
                    Enabled
                  </label>
                  {p.mock && (
                    <>
                      <div>
                        <label className="label" htmlFor={`${p.key}-mode`}>
                          Filing mode
                        </label>
                        <select
                          id={`${p.key}-mode`}
                          name="mode"
                          defaultValue={cfg?.mode ?? "mock"}
                          className="input"
                        >
                          <option value="mock">Mock gateway (in-process)</option>
                          <option value="gateway">EDI gateway (REST API)</option>
                        </select>
                      </div>
                      <div>
                        <label className="label" htmlFor={`${p.key}-base-url`}>
                          Gateway base URL
                        </label>
                        <input
                          id={`${p.key}-base-url`}
                          name="baseUrl"
                          type="url"
                          placeholder="https://gateway.example.com/api (blank = fixtures)"
                          defaultValue={cfg?.baseUrl ?? ""}
                          className="input"
                        />
                      </div>
                      <div>
                        <label className="label" htmlFor={`${p.key}-delay`}>
                          Decision delay (ms)
                        </label>
                        <input
                          id={`${p.key}-delay`}
                          name="mockDelayMs"
                          type="number"
                          min={0}
                          step={500}
                          defaultValue={settings.mockDelayMs ?? 4000}
                          className="input"
                        />
                      </div>
                      <div>
                        <label className="label" htmlFor={`${p.key}-fail`}>
                          Failure injection (%)
                        </label>
                        <input
                          id={`${p.key}-fail`}
                          name="mockFailureRate"
                          type="number"
                          min={0}
                          max={100}
                          defaultValue={Math.round((settings.mockFailureRate ?? 0) * 100)}
                          className="input"
                        />
                      </div>
                    </>
                  )}
                  {p.credentials && (
                    <fieldset className="col-span-2 space-y-2 rounded border border-border-default p-3">
                      <legend className="px-1 text-xs font-medium uppercase tracking-wide text-fg-secondary">
                        Gateway credentials
                      </legend>
                      <p className="text-xs text-fg-secondary">
                        Encrypted into Supabase Vault on save and never sent back to this page.
                        Leave a field blank to keep its stored value; fill one to replace just that
                        field. Use “Clear credentials” to remove all three.
                      </p>
                      <div className="grid gap-2 sm:grid-cols-3">
                        <div>
                          <label className="label" htmlFor={`${p.key}-api-key`}>
                            API key
                          </label>
                          <input
                            id={`${p.key}-api-key`}
                            name="apiKey"
                            type="password"
                            data-secret
                            autoComplete="new-password"
                            defaultValue=""
                            placeholder={cfg?.hasCredentials ? "••••••••" : ""}
                            className="input"
                          />
                        </div>
                        <div>
                          <label className="label" htmlFor={`${p.key}-api-secret`}>
                            API secret
                          </label>
                          <input
                            id={`${p.key}-api-secret`}
                            name="apiSecret"
                            type="password"
                            data-secret
                            autoComplete="new-password"
                            defaultValue=""
                            placeholder={cfg?.hasCredentials ? "••••••••" : ""}
                            className="input"
                          />
                        </div>
                        <div>
                          <label className="label" htmlFor={`${p.key}-account-id`}>
                            Account ID
                          </label>
                          <input
                            id={`${p.key}-account-id`}
                            name="accountId"
                            type="password"
                            data-secret
                            autoComplete="new-password"
                            defaultValue=""
                            placeholder={cfg?.hasCredentials ? "••••••••" : ""}
                            className="input"
                          />
                        </div>
                      </div>
                      {cfg?.hasCredentials && (
                        <button
                          type="button"
                          className="btn-secondary px-2.5 py-1 text-xs"
                          disabled={clearCredentials.isPending}
                          onClick={() => clearCredentials.mutate({ provider: p.key })}
                        >
                          Clear credentials
                        </button>
                      )}
                    </fieldset>
                  )}
                  <div className="col-span-2 flex flex-wrap items-center gap-3">
                    <button className="btn-primary" disabled={upsert.isPending}>
                      Save
                    </button>
                    {saved === p.key && <span className="text-sm text-status-ok">Saved.</span>}
                    {p.mock && (
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={testCustoms.isPending}
                        onClick={() => testCustoms.mutate({ provider: p.key })}
                      >
                        Test connection
                      </button>
                    )}
                    {tested[p.key] && (
                      <span
                        className={`text-sm ${tested[p.key]!.startsWith("Failed") ? "text-status-danger" : "text-status-ok"}`}
                      >
                        {tested[p.key]}
                      </span>
                    )}
                    {cfg?.lastPolledAt && (
                      <span className="text-xs text-fg-secondary">
                        last polled {new Date(cfg.lastPolledAt).toLocaleString("en-CA")}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </form>
          );
        })}
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="panel overflow-x-auto">
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="font-medium">Integration log</h2>
            <span className="text-xs text-fg-secondary">live · last 50</span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-fg-secondary">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Provider</th>
                <th className="px-4 py-2 font-medium">Operation</th>
                <th className="px-4 py-2 font-medium">Movement</th>
                <th className="px-4 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default">
              {eventsQ.data.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-5 text-fg-secondary">
                    No integration calls yet.
                  </td>
                </tr>
              )}
              {eventsQ.data.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-fg-secondary">
                    {new Date(e.createdAt).toLocaleTimeString("en-CA")}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{e.provider}</td>
                  <td className="px-4 py-2 text-xs">
                    <span className="text-fg-secondary">
                      {e.direction === "outbound" ? "→" : "←"}
                    </span>{" "}
                    {e.operation}
                    {e.durationMs != null && (
                      <span className="ml-1 text-fg-secondary/60">{e.durationMs}ms</span>
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {e.movementId ? (
                      <Link href={`/movements/${e.movementId}`} className="hover:underline">
                        {e.movementNumber}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {e.success ? (
                      <span className="text-status-ok">
                        ok{e.statusCode ? ` ${e.statusCode}` : ""}
                      </span>
                    ) : (
                      <span className="text-status-danger" title={e.errorMessage ?? ""}>
                        {e.statusCode ?? "error"} · {e.errorMessage}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Background jobs</h2>
            <button
              className="btn-secondary px-2.5 py-1 text-xs"
              disabled={runNow.isPending}
              onClick={() => runNow.mutate()}
            >
              {runNow.isPending ? "Running…" : "Run due now"}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {Object.entries(statsQ.data).map(([k, v]) => (
              <span key={k} className="rounded bg-surface-sunken px-2 py-0.5 font-mono">
                {k} {v}
              </span>
            ))}
          </div>
          <ul className="mt-3 max-h-96 space-y-2 overflow-y-auto text-xs">
            {jobsQ.data.map((j) => (
              <li key={j.id} className="rounded border border-border-default p-2">
                <div className="flex justify-between font-mono">
                  <span>
                    #{j.id} {j.jobType}
                  </span>
                  <span
                    className={
                      j.status === "failed"
                        ? "text-status-danger"
                        : j.status === "succeeded"
                          ? "text-status-ok"
                          : "text-fg-secondary"
                    }
                  >
                    {j.status}
                  </span>
                </div>
                <div className="text-fg-secondary">
                  run {new Date(j.runAt).toLocaleTimeString("en-CA")} · attempt {j.attempts}/
                  {j.maxAttempts}
                </div>
                {j.lastError && <div className="text-status-danger">{j.lastError}</div>}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
