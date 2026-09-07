"use client";

import type { FormEvent } from "react";
import { Field } from "../field";
import { useMovementMutations, useWorkspace } from "../workspace-context";

export function SealsStep() {
  const { movement: m, editable } = useWorkspace();
  const { addSeal, removeSeal } = useMovementMutations();
  return (
    <div className="max-w-xl space-y-4">
      <ul className="panel divide-y divide-ink-100">
        {m.seals.length === 0 && (
          <li className="px-4 py-4 text-sm text-ink-500">No seals recorded.</li>
        )}
        {m.seals.map((s) => (
          <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
            <div>
              <span className="font-mono font-medium">{s.sealNumber}</span>
              <span className="ml-2 text-xs text-ink-500">
                {s.sealType ?? ""} {s.appliedBy ? `· ${s.appliedBy}` : ""}
              </span>
            </div>
            {editable && (
              <button
                className="text-xs text-danger-500 hover:underline"
                onClick={() => removeSeal.mutate({ movementId: m.id, id: s.id })}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const form = e.currentTarget;
            const fd = new FormData(form);
            addSeal.mutate(
              {
                movementId: m.id,
                sealNumber: String(fd.get("sealNumber") ?? "").trim(),
                sealType: String(fd.get("sealType") ?? "").trim() || null,
                appliedBy: String(fd.get("appliedBy") ?? "").trim() || null,
              },
              { onSuccess: () => form.reset() },
            );
          }}
        >
          <Field label="Seal number" htmlFor="sealNumber">
            <input id="sealNumber" name="sealNumber" required className="input font-mono" />
          </Field>
          <Field label="Type" htmlFor="sealType">
            <input id="sealType" name="sealType" placeholder="bolt" className="input" />
          </Field>
          <Field label="Applied by" htmlFor="appliedBy">
            <input id="appliedBy" name="appliedBy" className="input" />
          </Field>
          <button className="btn-secondary" disabled={addSeal.isPending}>
            Add seal
          </button>
        </form>
      )}
    </div>
  );
}
