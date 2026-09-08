"use client";

/**
 * Seals live on a physical place: one of the trailers in tow, or the tractor
 * itself. The step draws the rig in tow order with its seal slots (4 per
 * trailer, 1 on the truck — the CBP limits seals_limit() enforces) so a
 * dispatcher sees at a glance which unit is still open.
 */
import { useState, type FormEvent } from "react";
import { Field } from "../field";
import { useMovementMutations, useWorkspace, type Movement } from "../workspace-context";

const TRAILER_SLOTS = 4;
const TRUCK_SLOTS = 1;

type Seal = Movement["seals"][number];

export function SealsStep() {
  const { movement: m, editable } = useWorkspace();
  const { addSeal, removeSeal } = useMovementMutations();
  const truckSeals = m.seals.filter((s) => !s.movementTrailerId);
  const [location, setLocation] = useState<string>(() => m.trailers[0]?.id ?? "truck");

  // The first trailer is the usual place for a seal; keep the selection valid
  // if that trailer is dropped between renders.
  const validLocation =
    location === "truck" || m.trailers.some((t) => t.id === location)
      ? location
      : (m.trailers[0]?.id ?? "truck");

  const units: Array<{ key: string; title: string; hint: string; slots: number; seals: Seal[] }> =
    [
      ...(m.truck
        ? [
            {
              key: "truck",
              title: m.truck.unitNumber,
              hint: "Tractor",
              slots: TRUCK_SLOTS,
              seals: truckSeals,
            },
          ]
        : []),
      ...m.trailers.map((t, i) => ({
        key: t.id,
        title: t.unitNumber,
        hint: `Trailer ${i + 1}`,
        slots: TRAILER_SLOTS,
        seals: t.seals,
      })),
    ];

  return (
    <div className="max-w-3xl space-y-4">
      {units.length === 0 ? (
        <p className="panel px-4 py-4 text-sm text-ink-500">
          Assign a truck or hitch a trailer before recording seals.
        </p>
      ) : (
        <ol className="grid gap-3 sm:grid-cols-2" aria-label="Seal slots by unit">
          {units.map((u) => (
            <li key={u.key} className="panel p-4" aria-label={`${u.hint} ${u.title}`}>
              <div className="flex items-baseline justify-between">
                <div>
                  <span className="text-xs uppercase tracking-wide text-ink-500">{u.hint}</span>
                  <div className="font-mono font-medium">{u.title}</div>
                </div>
                <span className="font-mono text-xs text-ink-500">
                  {u.seals.length}/{u.slots}
                </span>
              </div>
              <ul className="mt-3 space-y-1.5">
                {Array.from({ length: u.slots }, (_, i) => {
                  const s = u.seals[i];
                  return (
                    <li
                      key={s?.id ?? `empty-${i}`}
                      className={`flex items-center justify-between rounded-md border px-3 py-1.5 text-sm ${
                        s ? "border-ink-100 bg-white" : "border-dashed border-ink-100 bg-ink-50"
                      }`}
                    >
                      {s ? (
                        <>
                          <div>
                            <span className="font-mono font-medium">{s.sealNumber}</span>
                            <span className="ml-2 text-xs text-ink-500">
                              {s.sealType ?? ""}
                              {s.appliedBy ? ` · ${s.appliedBy}` : ""}
                            </span>
                          </div>
                          {editable && (
                            <button
                              type="button"
                              className="text-xs text-danger-500 hover:underline"
                              onClick={() => removeSeal.mutate({ movementId: m.id, id: s.id })}
                            >
                              Remove
                            </button>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-ink-300">Slot {i + 1} open</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}

      {editable && units.length > 0 && (
        <form
          className="panel flex flex-wrap items-end gap-3 p-4"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const form = e.currentTarget;
            const fd = new FormData(form);
            addSeal.mutate(
              {
                movementId: m.id,
                movementTrailerId: validLocation === "truck" ? null : validLocation,
                sealNumber: String(fd.get("sealNumber") ?? "").trim(),
                sealType: String(fd.get("sealType") ?? "").trim() || null,
                appliedBy: String(fd.get("appliedBy") ?? "").trim() || null,
              },
              { onSuccess: () => form.reset() },
            );
          }}
        >
          <Field label="Location" htmlFor="sealLocation">
            <select
              id="sealLocation"
              className="input"
              value={validLocation}
              onChange={(e) => setLocation(e.target.value)}
            >
              {units.map((u) => (
                <option key={u.key} value={u.key} disabled={u.seals.length >= u.slots}>
                  {u.title} · {u.hint}
                  {u.seals.length >= u.slots ? " (full)" : ""}
                </option>
              ))}
            </select>
          </Field>
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
