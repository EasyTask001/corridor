"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { useTRPC } from "@/lib/trpc/client";
import { useRealtimeClient } from "@/lib/supabase/use-realtime-client";
import { markedRead } from "./mark-read";

type List = inferRouterOutputs<AppRouter>["notifications"]["list"];

function timeAgo(date: string | Date) {
  const s = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function NotificationBell() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const unreadOpts = trpc.notifications.unreadCount.queryOptions();
  // Realtime delivers the INSERT; this is the reconciliation floor for a
  // dropped socket or a tab the browser has been throttling.
  const { data: unread = 0 } = useQuery({ ...unreadOpts, refetchInterval: 60_000 });
  const listOpts = trpc.notifications.list.queryOptions({
    limit: 10,
    unreadOnly: false,
  });
  const { data } = useQuery({ ...listOpts, enabled: open });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: unreadOpts.queryKey });
    qc.invalidateQueries({ queryKey: trpc.notifications.list.pathKey() });
  };

  /** Snapshot both caches, apply `patch`, and hand back the rollback state. */
  const optimistic = async (patch: () => void) => {
    await Promise.all([
      qc.cancelQueries({ queryKey: unreadOpts.queryKey }),
      qc.cancelQueries({ queryKey: listOpts.queryKey }),
    ]);
    const previous = {
      unread: qc.getQueryData(unreadOpts.queryKey),
      list: qc.getQueryData(listOpts.queryKey),
    };
    patch();
    return previous;
  };
  const rollback = (ctx?: { unread?: number; list?: List }) => {
    if (ctx?.unread !== undefined) qc.setQueryData(unreadOpts.queryKey, ctx.unread);
    if (ctx?.list !== undefined) qc.setQueryData(listOpts.queryKey, ctx.list);
  };

  const markRead = useMutation(
    trpc.notifications.markRead.mutationOptions({
      onMutate: ({ id }) =>
        optimistic(() => {
          const row = qc.getQueryData(listOpts.queryKey)?.rows.find((r) => r.id === id);
          if (!row || !row.readAt) {
            qc.setQueryData(unreadOpts.queryKey, (n) => Math.max(0, (n ?? 1) - 1));
          }
          qc.setQueryData(listOpts.queryKey, (old) =>
            old
              ? { ...old, rows: old.rows.map((r) => (r.id === id ? markedRead(r) : r)) }
              : undefined,
          );
        }),
      onError: (_e, _v, ctx) => rollback(ctx),
      onSettled: invalidate,
    }),
  );
  const markAllRead = useMutation(
    trpc.notifications.markAllRead.mutationOptions({
      onMutate: () =>
        optimistic(() => {
          qc.setQueryData(unreadOpts.queryKey, 0);
          qc.setQueryData(listOpts.queryKey, (old) =>
            old ? { ...old, rows: old.rows.map(markedRead) } : undefined,
          );
        }),
      onError: (_e, _v, ctx) => rollback(ctx),
      onSettled: invalidate,
    }),
  );

  const realtime = useRealtimeClient();
  useEffect(() => {
    if (!realtime) return;
    const ch = realtime
      .channel("notifications")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications" },
        invalidate,
      )
      .subscribe();
    return () => {
      void realtime.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realtime]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex size-11 items-center justify-center rounded-full text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40 sm:size-10"
      >
        <BellIcon />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-500 px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border-default bg-surface-overlay shadow-lg">
          <div className="flex items-center justify-between border-b border-border-default px-4 py-2">
            <span className="text-sm font-medium">Notifications</span>
            {unread > 0 && (
              <button
                type="button"
                className="min-h-11 text-xs font-medium text-fg-secondary hover:text-fg-primary sm:min-h-8"
                onClick={() => markAllRead.mutate()}
              >
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-96 divide-y divide-border-default overflow-y-auto">
            {!data && <li className="px-4 py-6 text-sm text-fg-secondary">Loading…</li>}
            {data?.rows.length === 0 && (
              <li className="px-4 py-6 text-sm text-fg-secondary">You&apos;re all caught up.</li>
            )}
            {data?.rows.map((n) => {
              const body = (
                <div className="px-4 py-3">
                  <div className={`text-sm ${n.readAt ? "text-fg-secondary" : "font-medium"}`}>
                    {n.title}
                  </div>
                  {n.body && <div className="mt-0.5 text-xs text-fg-secondary">{n.body}</div>}
                  <div className="mt-1 text-[11px] text-fg-secondary/60">
                    {timeAgo(n.createdAt)}
                  </div>
                </div>
              );
              return (
                <li key={n.id} className={n.readAt ? "" : "bg-signal-500/5"}>
                  {n.linkPath ? (
                    <Link
                      href={n.linkPath}
                      onClick={() => {
                        setOpen(false);
                        if (!n.readAt) markRead.mutate({ id: n.id });
                      }}
                      className="block hover:bg-surface-sunken"
                    >
                      {body}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="block w-full text-left hover:bg-surface-sunken"
                      onClick={() => !n.readAt && markRead.mutate({ id: n.id })}
                    >
                      {body}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="block min-h-11 border-t border-border-default px-4 py-3 text-center text-xs font-medium text-fg-secondary hover:bg-surface-sunken hover:text-fg-primary"
          >
            View all
          </Link>
        </div>
      )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
