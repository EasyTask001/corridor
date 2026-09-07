"use client";

import { Detail } from "../field";
import { useWorkspace } from "../workspace-context";
import { AssignPanel } from "./assign-panel";

export function CrewStep() {
  const { movement: m, options } = useWorkspace();
  return (
    <AssignPanel
      label="Driver"
      field="driverId"
      list={options.drivers.map((d) => ({
        id: d.id,
        label: d.label,
        hint: d.licenseExpiry ? `lic. ${d.licenseExpiry}` : null,
      }))}
      current={m.driver}
      detail={
        m.driver && (
          <Detail
            rows={[
              [
                "License",
                `${m.driver.licenseNumber} (${m.driver.licenseJurisdiction}) · exp ${m.driver.licenseExpiry ?? "—"}`,
              ],
              [
                "FAST",
                m.driver.fastCardNumber
                  ? `${m.driver.fastCardNumber} · exp ${m.driver.fastCardExpiry ?? "—"}`
                  : "—",
              ],
              ["Citizenship", m.driver.citizenship ?? "—"],
            ]}
          />
        )
      }
    />
  );
}
