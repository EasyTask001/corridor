"use client";

import { Detail } from "../field";
import { useWorkspace } from "../workspace-context";
import { AssignPanel } from "./assign-panel";

export function TruckStep() {
  const { movement: m, options } = useWorkspace();
  return (
    <AssignPanel
      label="Truck"
      field="truckId"
      list={options.trucks.map((t) => ({ id: t.id, label: t.label, hint: t.plate }))}
      current={m.truck}
      detail={
        m.truck && (
          <Detail
            rows={[
              ["Plate", `${m.truck.plateNumber} ${m.truck.plateJurisdiction}`],
              ["Registration", m.truck.registrationExpiry ?? "—"],
              ["Insurance", m.truck.insuranceExpiry ?? "—"],
            ]}
          />
        )
      }
    />
  );
}
