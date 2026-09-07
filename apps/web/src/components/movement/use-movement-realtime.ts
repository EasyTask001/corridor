"use client";

import { useEffect } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Subscribes to Realtime for one movement: new timeline events and header
 * updates (status changes from customs / other dispatchers). RLS applies to
 * the subscription, so a user only ever receives their own org's rows.
 */
export function useMovementRealtime(movementId: string, onChange: () => void) {
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel(`movement:${movementId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "movement_events",
          filter: `movement_id=eq.${movementId}`,
        },
        onChange,
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "movements", filter: `id=eq.${movementId}` },
        onChange,
      )
      .subscribe((status: string, err?: Error) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn(`[realtime] movement:${movementId} ${status}`, err?.message);
        }
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [movementId, onChange]);
}
