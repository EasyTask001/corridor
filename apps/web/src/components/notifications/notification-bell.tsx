"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

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
  const { data: unread = 0 } = useQuery({ ...unreadOpts, refetchInterval: 30_000 });
  const listOpts = trpc.notifications.list.queryOptions({
    limit: 10,
    offset: 0,
    unreadOnly: false,
  });
  const { data } = useQuery({ ...listOpts, enabled: open });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: unreadOpts.queryKey });
    qc.invalidateQueries({ queryKey: trpc.notifications.list.pathKey() });
  };
  const markRead = useMutation(
    trpc.notifications.markRead.mutationOptions({ onSuccess: invalidate }),
  );
  const markAllRead = useMutation(
    trpc.notifications.markAllRead.mutationOptions({ onSuccess: invalidate }),
  );

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    const ch = supabase
      .channel("notifications")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications" },
        invalidate,
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`}
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-full p-2 text-ink-500 hover:bg-ink-50 hover:text-ink-950"
      >
        <BellIcon />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-500 px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-96 rounded-lg border border-ink-100 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2">
            <span className="text-sm font-medium">Notifications</span>
            {unread > 0 && (
              <button
                className="text-xs text-ink-500 hover:text-ink-950"
                onClick={() => markAllRead.mutate()}
              >
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-96 divide-y divide-ink-100 overflow-y-auto">
            {!data && <li className="px-4 py-6 text-sm text-ink-500">Loading…</li>}
            {data?.rows.length === 0 && (
              <li className="px-4 py-6 text-sm text-ink-500">You&apos;re all caught up.</li>
            )}
            {data?.rows.map((n) => {
              const body = (
                <div className="px-4 py-3">
                  <div className={`text-sm ${n.readAt ? "text-ink-500" : "font-medium"}`}>
                    {n.title}
                  </div>
                  {n.body && <div className="mt-0.5 text-xs text-ink-500">{n.body}</div>}
                  <div className="mt-1 text-[11px] text-ink-300">{timeAgo(n.createdAt)}</div>
                </div>
              );
              return (
                <li key={n.id} className={n.readAt ? "" : "bg-signal-500/5"}>
                  {n.linkPath ? (
                    <Link
                      href={n.linkPath as never}
                      onClick={() => {
                        setOpen(false);
                        if (!n.readAt) markRead.mutate({ id: n.id });
                      }}
                      className="block hover:bg-ink-50"
                    >
                      {body}
                    </Link>
                  ) : (
                    <button
                      className="block w-full text-left hover:bg-ink-50"
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
            className="block border-t border-ink-100 px-4 py-2 text-center text-xs text-ink-500 hover:bg-ink-50 hover:text-ink-950"
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
