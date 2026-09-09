"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { useTRPC } from "@/lib/trpc/client";
import { markedRead } from "@/components/notifications/mark-read";

type List = inferRouterOutputs<AppRouter>["notifications"]["list"];

export function NotificationsList({ initial }: { initial: List }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const listOpts = trpc.notifications.list.queryOptions({ limit: 50, unreadOnly });
  const { data = initial } = useQuery({
    ...listOpts,
    initialData: unreadOnly ? undefined : initial,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.notifications.pathKey() });

  /**
   * Optimistic mark-read: the row must stop looking unread the instant it is
   * clicked (often while the click also navigates away). `onSettled`
   * invalidation reconciles with the server's `read_at`.
   */
  const snapshot = async () => {
    await qc.cancelQueries({ queryKey: listOpts.queryKey });
    return { list: qc.getQueryData(listOpts.queryKey) };
  };
  const rollback = (ctx?: { list?: List }) => {
    if (ctx?.list !== undefined) qc.setQueryData(listOpts.queryKey, ctx.list);
  };
  const patchRows = (fn: (rows: List["rows"]) => List["rows"]) =>
    qc.setQueryData(listOpts.queryKey, (old) => (old ? { ...old, rows: fn(old.rows) } : undefined));

  const markRead = useMutation(
    trpc.notifications.markRead.mutationOptions({
      onMutate: async ({ id }) => {
        const ctx = await snapshot();
        patchRows((rows) =>
          unreadOnly
            ? rows.filter((r) => r.id !== id)
            : rows.map((r) => (r.id === id ? markedRead(r) : r)),
        );
        return ctx;
      },
      onError: (_e, _v, ctx) => rollback(ctx),
      onSettled: invalidate,
    }),
  );
  const markAllRead = useMutation(
    trpc.notifications.markAllRead.mutationOptions({
      onMutate: async () => {
        const ctx = await snapshot();
        patchRows((rows) => (unreadOnly ? [] : rows.map(markedRead)));
        return ctx;
      },
      onError: (_e, _v, ctx) => rollback(ctx),
      onSettled: invalidate,
    }),
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-fg-primary">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
          />
          Unread only
        </label>
        <button
          className="btn-secondary px-3 py-1 text-xs"
          disabled={markAllRead.isPending}
          onClick={() => markAllRead.mutate()}
        >
          Mark all read
        </button>
      </div>
      <div className="panel divide-y divide-border-default">
        {data.rows.length === 0 && (
          <p className="px-4 py-6 text-sm text-fg-secondary">Nothing here.</p>
        )}
        {data.rows.map((n) => (
          <div
            key={n.id}
            className={`flex items-start gap-3 px-4 py-3 ${n.readAt ? "" : "bg-signal-500/5"}`}
          >
            <div className="min-w-0 flex-1">
              <div className={`text-sm ${n.readAt ? "text-fg-primary" : "font-medium"}`}>
                {n.linkPath ? (
                  <Link
                    href={n.linkPath as never}
                    className="hover:underline"
                    onClick={() => !n.readAt && markRead.mutate({ id: n.id })}
                  >
                    {n.title}
                  </Link>
                ) : (
                  n.title
                )}
              </div>
              {n.body && <div className="mt-0.5 text-sm text-fg-secondary">{n.body}</div>}
              <div className="mt-1 text-xs text-fg-secondary/60">
                {new Date(n.createdAt).toLocaleString("en-CA", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </div>
            </div>
            {!n.readAt && (
              <button
                className="shrink-0 text-xs text-fg-secondary hover:text-fg-primary"
                onClick={() => markRead.mutate({ id: n.id })}
              >
                Mark read
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
