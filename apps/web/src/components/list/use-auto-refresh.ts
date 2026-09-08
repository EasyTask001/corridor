"use client";

/**
 * Re-run a fetch every `intervalSec` seconds (0 = off) and expose the
 * countdown so the toolbar can show "refreshing in 12s".
 */
import { useEffect, useRef, useState } from "react";

export function useAutoRefresh(intervalSec: number, refetch: () => unknown) {
  const [secondsLeft, setSecondsLeft] = useState(intervalSec);
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  });

  useEffect(() => {
    if (intervalSec <= 0) return;
    let left = intervalSec;
    const id = window.setInterval(() => {
      left -= 1;
      if (left <= 0) {
        left = intervalSec;
        void refetchRef.current();
      }
      setSecondsLeft(left);
    }, 1000);
    return () => window.clearInterval(id);
  }, [intervalSec]);

  return { secondsLeft: intervalSec > 0 ? secondsLeft : 0 };
}
