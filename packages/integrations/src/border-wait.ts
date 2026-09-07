/**
 * Border wait-time stub. The real adapters (CBP BWT feed / CBSA border times)
 * are a Phase 9 concern; this returns deterministic, time-varying numbers so
 * the UI and caching paths can be exercised.
 */
export interface BorderWait {
  crossingCode: string;
  lanes: { standard: number; fast: number; commercial: number };
  updatedAt: string;
  source: "stub";
}

export function getBorderWait(crossingCode: string, now: Date = new Date()): BorderWait {
  // deterministic pseudo-random seeded by code + 10-minute bucket
  const bucket = Math.floor(now.getTime() / 600_000);
  let h = 0;
  for (const ch of `${crossingCode}:${bucket}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const base = 10 + (h % 50); // 10..59 min
  return {
    crossingCode,
    lanes: {
      standard: base,
      fast: Math.max(2, Math.round(base * 0.35)),
      commercial: Math.round(base * 0.8),
    },
    updatedAt: new Date(bucket * 600_000).toISOString(),
    source: "stub",
  };
}
