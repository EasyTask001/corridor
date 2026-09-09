"use client";

import { useState } from "react";
import { DRIVER_DOCUMENT_LABELS, type CrewRole } from "@corridor/domain";
import { Field } from "../field";
import { useMovementMutations, useWorkspace } from "../workspace-context";

const ROLE_LABELS: Record<CrewRole, string> = {
  person_in_charge: "Person in charge",
  crew_member: "Crew member",
  passenger: "Passenger",
};

export function CrewStep() {
  const { movement: m, options, editable } = useWorkspace();
  const { addCrew, removeCrew, setCrewRole } = useMovementMutations();
  const [adding, setAdding] = useState("");

  const onCrew = new Set(m.crew.map((c) => c.driverId));
  const available = options.drivers.filter((d) => !onCrew.has(d.id));
  // The DB enforces one person in charge per crossing; mirroring the rule here
  // means the dropdown reads as a swap rather than a rejected save.
  const picHolder = m.crew.find((c) => c.role === "person_in_charge");

  return (
    <div className="max-w-3xl space-y-4">
      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-fg-secondary">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">License</th>
              <th className="px-3 py-2 font-medium">Travel documents</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {m.crew.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-5 text-fg-secondary">
                  Nobody is on this crossing yet.
                </td>
              </tr>
            )}
            {m.crew.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-2">
                  <div className="font-medium">
                    {c.firstName} {c.lastName}
                  </div>
                  <div className="text-xs text-fg-secondary">
                    {c.personType === "passenger" ? "Passenger" : "Driver"}
                    {c.citizenship ? ` · ${c.citizenship}` : ""}
                    {c.hazmatEndorsement ? " · hazmat" : ""}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <select
                    aria-label={`Role for ${c.firstName} ${c.lastName}`}
                    className="input"
                    value={c.role}
                    disabled={!editable}
                    onChange={(e) =>
                      setCrewRole.mutate({
                        movementId: m.id,
                        driverId: c.driverId,
                        role: e.target.value as CrewRole,
                      })
                    }
                  >
                    {(Object.keys(ROLE_LABELS) as CrewRole[]).map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                        {role === "person_in_charge" &&
                        picHolder &&
                        picHolder.driverId !== c.driverId
                          ? ` (replaces ${picHolder.lastName})`
                          : ""}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {c.licenseNumber
                    ? `${c.licenseNumber} (${c.licenseJurisdiction}) · exp ${c.licenseExpiry ?? "—"}`
                    : "—"}
                </td>
                <td className="px-3 py-2 text-xs">
                  {c.documents.length === 0
                    ? "—"
                    : c.documents
                        .map(
                          (d) =>
                            `${DRIVER_DOCUMENT_LABELS[d.documentType]} · exp ${d.expiresOn ?? "—"}`,
                        )
                        .join(", ")}
                </td>
                <td className="px-3 py-2 text-right">
                  {editable && (
                    <button
                      className="text-xs text-status-danger hover:underline"
                      onClick={() => removeCrew.mutate({ movementId: m.id, driverId: c.driverId })}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editable && (
        <div className="panel flex items-end gap-3 p-4">
          <Field label="Add to crew" htmlFor="addCrew">
            <select
              id="addCrew"
              className="input w-full sm:w-72"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
            >
              <option value="">— select a person —</option>
              {available.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                  {d.personType === "passenger" ? " · passenger" : ""}
                </option>
              ))}
            </select>
          </Field>
          <button
            className="btn-secondary"
            disabled={!adding || addCrew.isPending}
            onClick={() => {
              addCrew.mutate(
                {
                  movementId: m.id,
                  driverId: adding,
                  // The first person on an empty crossing is its person in charge.
                  role: picHolder
                    ? available.find((d) => d.id === adding)?.personType === "passenger"
                      ? "passenger"
                      : "crew_member"
                    : "person_in_charge",
                },
                { onSuccess: () => setAdding("") },
              );
            }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
