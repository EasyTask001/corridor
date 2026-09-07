"use client";

import { useRouter } from "next/navigation";
import type { Regime } from "@corridor/domain";
import { PortPicker } from "@/components/port-picker";

/** Filters the movements list by port. Selecting a port pushes `?portId=`. */
export function MovementsPortFilter({
  regime,
  active,
}: {
  regime?: Regime;
  active: boolean;
}) {
  const router = useRouter();

  const apply = (portId: string | null) => {
    const params = new URLSearchParams(window.location.search);
    if (portId) params.set("portId", portId);
    else params.delete("portId");
    router.push(params.size > 0 ? `/movements?${params.toString()}` : "/movements");
  };

  return (
    <div className="flex items-center gap-2">
      <div className="w-56">
        <PortPicker
          regime={regime}
          placeholder="Filter by port…"
          onSelect={(port) => apply(port?.id ?? null)}
        />
      </div>
      {active && (
        <button
          type="button"
          className="text-xs text-ink-500 hover:underline"
          onClick={() => apply(null)}
        >
          Clear port filter
        </button>
      )}
    </div>
  );
}
