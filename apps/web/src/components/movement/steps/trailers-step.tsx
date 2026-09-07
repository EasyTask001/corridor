"use client";

import { Detail } from "../field";
import { useWorkspace } from "../workspace-context";
import { AssignPanel } from "./assign-panel";

export function TrailersStep() {
  const { movement: m, options } = useWorkspace();
  return (
    <AssignPanel
      label="Trailer"
      field="trailerId"
      list={options.trailers.map((t) => ({
        id: t.id,
        label: t.label,
        hint: t.type.replace(/_/g, " "),
      }))}
      current={m.trailer}
      detail={
        m.trailer && (
          <Detail
            rows={[
              ["Plate", `${m.trailer.plateNumber} ${m.trailer.plateJurisdiction}`],
              ["Type", m.trailer.trailerType.replace(/_/g, " ")],
              ["Registration", m.trailer.registrationExpiry ?? "—"],
            ]}
          />
        )
      }
    />
  );
}
