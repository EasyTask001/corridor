/** Form primitives shared by every movement/shipment step panel. */

export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="label">
        {label}
      </label>
      {children}
    </div>
  );
}

export function Detail({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-fg-secondary">{k}</dt>
          <dd className="font-mono text-xs leading-5">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
