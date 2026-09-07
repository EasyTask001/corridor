"use client";

/** The shared "pick one registry record for this movement" panel. */
import { Field } from "../field";
import { useMovementMutations, useWorkspace } from "../workspace-context";

export function AssignPanel({
  label,
  field,
  list,
  current,
  detail,
}: {
  label: string;
  field: "truckId" | "trailerId";
  list: { id: string; label: string; hint?: string | null }[];
  current: { id: string } | null;
  detail: React.ReactNode;
}) {
  const { movement, editable } = useWorkspace();
  const { update } = useMovementMutations();
  return (
    <div className="max-w-xl space-y-4">
      <Field label={label} htmlFor={field}>
        <select
          id={field}
          value={current?.id ?? ""}
          disabled={!editable}
          onChange={(e) => update.mutate({ id: movement.id, [field]: e.target.value || null })}
          className="input"
        >
          <option value="">— none —</option>
          {list.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
              {x.hint ? ` · ${x.hint}` : ""}
            </option>
          ))}
        </select>
      </Field>
      {detail}
    </div>
  );
}
