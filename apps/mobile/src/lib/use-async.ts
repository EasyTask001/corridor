import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  refetch: () => Promise<void>;
}

/**
 * The driver app makes a handful of one-shot reads, so it calls the tRPC
 * client directly instead of pulling React Query (and a second cache) onto the
 * handset. `key` is what re-runs the fetch — a route param, usually; the
 * fetcher itself is held in a ref because it is a fresh closure every render.
 */
export function useAsync<T>(fetcher: () => Promise<T>, key: string = ""): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const latest = useRef(fetcher);
  latest.current = fetcher;

  const run = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setData(await latest.current());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run, key]);

  return { data, error, loading, refetch: run };
}
