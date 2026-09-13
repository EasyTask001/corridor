"use client";

/** Up to three dangerous-goods declarations on one commodity line. */
import { Field } from "@/components/movement/field";

export interface HazmatDraft {
  unCode: string;
  description: string;
  emergencyContact: string;
  emergencyPhone: string;
}

export const emptyHazmat = (): HazmatDraft => ({
  unCode: "",
  description: "",
  emergencyContact: "",
  emergencyPhone: "",
});

export const MAX_HAZMAT = 3;

export function HazmatFields({
  entries,
  disabled,
  onChange,
}: {
  entries: HazmatDraft[];
  disabled?: boolean;
  onChange: (entries: HazmatDraft[]) => void;
}) {
  const update = (i: number, patch: Partial<HazmatDraft>) =>
    onChange(entries.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  return (
    <fieldset className="col-span-2 space-y-3 sm:col-span-3">
      <legend className="label">Dangerous goods</legend>
      {entries.length === 0 && (
        <p className="text-sm text-fg-secondary">No dangerous goods declared on this line.</p>
      )}
      {entries.length > 0 && (
        <p className="text-sm text-status-warn">
          Recorded for your records, but not yet filable through BorderConnect — the manifest will
          be refused at pre-flight while any dangerous goods are declared on an ACE shipment.
        </p>
      )}
      {entries.map((e, i) => (
        <div key={i} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={`UN code ${i + 1}`} htmlFor={`unCode-${i}`}>
            <input
              id={`unCode-${i}`}
              value={e.unCode}
              placeholder="UN1203"
              maxLength={6}
              disabled={disabled}
              onChange={(ev) => update(i, { unCode: ev.target.value.toUpperCase() })}
              className="input font-mono"
            />
          </Field>
          <Field label="Description" htmlFor={`unDescription-${i}`}>
            <input
              id={`unDescription-${i}`}
              value={e.description}
              disabled={disabled}
              onChange={(ev) => update(i, { description: ev.target.value })}
              className="input"
            />
          </Field>
          <Field label="24h contact" htmlFor={`unContact-${i}`}>
            <input
              id={`unContact-${i}`}
              value={e.emergencyContact}
              disabled={disabled}
              onChange={(ev) => update(i, { emergencyContact: ev.target.value })}
              className="input"
            />
          </Field>
          <Field label="24h phone" htmlFor={`unPhone-${i}`}>
            <div className="flex gap-2">
              <input
                id={`unPhone-${i}`}
                value={e.emergencyPhone}
                disabled={disabled}
                onChange={(ev) => update(i, { emergencyPhone: ev.target.value })}
                className="input font-mono"
              />
              {!disabled && (
                <button
                  type="button"
                  className="text-xs text-status-danger hover:underline"
                  onClick={() => onChange(entries.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              )}
            </div>
          </Field>
        </div>
      ))}
      {!disabled && entries.length < MAX_HAZMAT && (
        <button
          type="button"
          className="text-xs text-fg-secondary hover:text-fg-primary"
          onClick={() => onChange([...entries, emptyHazmat()])}
        >
          + Add dangerous goods
        </button>
      )}
    </fieldset>
  );
}
