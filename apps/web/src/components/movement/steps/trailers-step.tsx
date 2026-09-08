"use client";

/**
 * The tow: zero, one or two trailers in the order they are hitched. Position
 * matters on the manifest (equipment prints in tow order), so the list is
 * ordered and reorderable rather than a multi-select.
 */
import { useState } from "react";
import { Field } from "../field";
import { useMovementMutations, useWorkspace } from "../workspace-context";

export function TrailersStep() {
  const { movement: m, options, editable } = useWorkspace();
  const { addTrailer, removeTrailer, reorderTrailers } = useMovementMutations();
  const [adding, setAdding] = useState("");

  const hitched = new Set(m.trailers.map((t) => t.trailerId));
  const available = options.trailers.filter((t) => !hitched.has(t.id));
  const full = m.trailers.length >= 4;

  const move = (index: number, delta: number) => {
    const order = m.trailers.map((t) => t.trailerId);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    reorderTrailers.mutate({ movementId: m.id, trailerIds: order });
  };

  return (
    <div className="max-w-3xl space-y-4">
      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="w-12 px-3 py-2 font-medium">Tow</th>
              <th className="px-3 py-2 font-medium">Unit</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Plates</th>
              <th className="px-3 py-2 font-medium">Registration</th>
              <th className="px-3 py-2 text-right font-medium">Seals</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {m.trailers.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-5 text-ink-500">
                  {m.isEmpty
                    ? "No trailer: the trip is declared empty."
                    : "No trailer hitched yet (bobtail)."}
                </td>
              </tr>
            )}
            {m.trailers.map((t, i) => (
              <tr key={t.id}>
                <td className="px-3 py-2 font-mono text-xs text-ink-500">{i + 1}</td>
                <td className="px-3 py-2">
                  <div className="font-mono font-medium">{t.unitNumber}</div>
                  {t.lengthFt != null && (
                    <div className="text-xs text-ink-500">{t.lengthFt} ft</div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className="font-mono text-xs">{t.trailerType}</span>
                  <span className="ml-1.5 text-xs text-ink-500">
                    {options.trailers.find((o) => o.id === t.trailerId)?.typeLabel ?? ""}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {[
                    `${t.plateNumber} ${t.plateJurisdiction}`,
                    ...t.plates.map((p) => `${p.plateNumber} ${p.jurisdiction}`),
                  ].join(" · ")}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{t.registrationExpiry ?? "—"}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{t.seals.length}/4</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {editable && (
                    <>
                      <button
                        type="button"
                        aria-label={`Move ${t.unitNumber} forward`}
                        className="mr-2 text-xs text-ink-500 hover:text-ink-950 disabled:opacity-30"
                        disabled={i === 0 || reorderTrailers.isPending}
                        onClick={() => move(i, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${t.unitNumber} back`}
                        className="mr-3 text-xs text-ink-500 hover:text-ink-950 disabled:opacity-30"
                        disabled={i === m.trailers.length - 1 || reorderTrailers.isPending}
                        onClick={() => move(i, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="text-xs text-danger-500 hover:underline"
                        onClick={() =>
                          removeTrailer.mutate({ movementId: m.id, trailerId: t.trailerId })
                        }
                      >
                        Drop
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editable && (
        <div className="panel flex items-end gap-3 p-4">
          <Field label="Hitch trailer" htmlFor="addTrailer">
            <select
              id="addTrailer"
              className="input w-72"
              value={adding}
              disabled={full}
              onChange={(e) => setAdding(e.target.value)}
            >
              <option value="">{full ? "Tow is full (4)" : "— select a trailer —"}</option>
              {available.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label} · {t.typeLabel ?? t.type}
                </option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            className="btn-secondary"
            disabled={!adding || full || addTrailer.isPending}
            onClick={() =>
              addTrailer.mutate(
                { movementId: m.id, trailerId: adding },
                { onSuccess: () => setAdding("") },
              )
            }
          >
            Hitch
          </button>
        </div>
      )}
    </div>
  );
}
