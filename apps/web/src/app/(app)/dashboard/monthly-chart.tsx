/**
 * Twelve months of movements, ACE stacked on ACI, as inline SVG so it renders
 * on the server with no chart library. Heights scale to the busiest month.
 */
export function MonthlyChart({
  series,
}: {
  series: Array<{ month: string; ACE: number; ACI: number }>;
}) {
  const W = 720;
  const H = 180;
  const PAD = { top: 12, right: 8, bottom: 28, left: 32 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const max = Math.max(1, ...series.map((m) => m.ACE + m.ACI));
  const slot = innerW / Math.max(series.length, 1);
  const bar = Math.min(28, slot * 0.6);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const total = series.reduce((sum, m) => sum + m.ACE + m.ACI, 0);
  const label = (month: string) =>
    new Date(`${month}-01T00:00:00Z`).toLocaleString("en-CA", { month: "short", timeZone: "UTC" });

  return (
    <figure className="panel p-4" aria-label="Movements by month">
      <figcaption className="flex items-center justify-between text-sm">
        <span className="font-medium">Movements by month</span>
        <span className="flex items-center gap-3 text-xs text-fg-secondary">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent" /> ACE
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-signal-500" /> ACI
          </span>
          <span>{total} in 12 months</span>
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 w-full"
        role="img"
        aria-label={`${total} movements in the last twelve months`}
      >
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(max * t)}
              y2={y(max * t)}
              className="stroke-border-default"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(max * t) + 4}
              textAnchor="end"
              className="fill-fg-secondary"
              fontSize={10}
            >
              {Math.round(max * t)}
            </text>
          </g>
        ))}
        {series.map((m, i) => {
          const x = PAD.left + i * slot + (slot - bar) / 2;
          const aceTop = y(m.ACE + m.ACI);
          const aciTop = y(m.ACI);
          return (
            <g key={m.month}>
              <title>{`${m.month}: ${m.ACE} ACE, ${m.ACI} ACI`}</title>
              {m.ACI > 0 && (
                <rect
                  x={x}
                  y={aciTop}
                  width={bar}
                  height={y(0) - aciTop}
                  className="fill-signal-500"
                />
              )}
              {m.ACE > 0 && (
                <rect
                  x={x}
                  y={aceTop}
                  width={bar}
                  height={aciTop - aceTop}
                  className="fill-accent"
                />
              )}
              {(i % 2 === 0 || i === series.length - 1) && (
                <text
                  x={x + bar / 2}
                  y={H - 8}
                  textAnchor="middle"
                  className="fill-fg-secondary"
                  fontSize={10}
                >
                  {label(m.month)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
