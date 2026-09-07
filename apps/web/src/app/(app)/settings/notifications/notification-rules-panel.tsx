"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import type { NotificationChannel } from "@corridor/domain";
import { useTRPC } from "@/lib/trpc/client";

type Rules = inferRouterOutputs<AppRouter>["notifications"]["rules"]["list"];

export function NotificationRulesPanel({ initial }: { initial: Rules }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const listOpts = trpc.notifications.rules.list.queryOptions();
  const { data = initial } = useQuery({ ...listOpts, initialData: initial });
  const upsert = useMutation(
    trpc.notifications.rules.upsert.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: listOpts.queryKey }),
    }),
  );

  const toggleChannel = (rule: Rules[number], channel: NotificationChannel) => {
    const has = rule.channel.includes(channel);
    const next = has ? rule.channel.filter((c) => c !== channel) : [...rule.channel, channel];
    upsert.mutate({
      eventType: rule.eventType,
      enabled: rule.enabled,
      channel: next.length ? next : ["in_app"],
      filters: rule.filters,
    });
  };

  return (
    <div className="panel divide-y divide-ink-100">
      {data.map((rule) => (
        <div
          key={rule.eventType}
          className="flex flex-wrap items-center justify-between gap-3 px-4 py-4"
        >
          <div className="min-w-0">
            <div className="font-medium">{rule.label}</div>
            <div className="text-sm text-ink-500">{rule.description}</div>
          </div>
          <div className="flex shrink-0 items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) =>
                  upsert.mutate({
                    eventType: rule.eventType,
                    enabled: e.target.checked,
                    channel: rule.channel,
                    filters: rule.filters,
                  })
                }
              />
              Notify me
            </label>
            <label className={`flex items-center gap-1.5 ${rule.enabled ? "" : "opacity-40"}`}>
              <input
                type="checkbox"
                disabled={!rule.enabled}
                checked={rule.channel.includes("email")}
                onChange={() => toggleChannel(rule, "email")}
              />
              Email
            </label>
            {/* Delivered to the handsets registered from the Expo driver app. */}
            <label className={`flex items-center gap-1.5 ${rule.enabled ? "" : "opacity-40"}`}>
              <input
                type="checkbox"
                disabled={!rule.enabled}
                checked={rule.channel.includes("push")}
                onChange={() => toggleChannel(rule, "push")}
              />
              Push
            </label>
          </div>
        </div>
      ))}
    </div>
  );
}
