"use client";

/**
 * Everything a movement step panel needs: the loaded movement, its validation,
 * the wizard's step list, and the mutations — all created once by the shell
 * (movement-workspace.tsx) so a step file never has to thread props or repeat
 * the invalidate-on-settle wiring.
 */
import { createContext, useContext } from "react";
import { useMutation } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import type { ValidationIssue } from "@corridor/domain";
import { useTRPC } from "@/lib/trpc/client";

type Outputs = inferRouterOutputs<AppRouter>;
export type Movement = Outputs["movement"]["get"];
export type MovementShipment = Movement["shipments"][number];
export type Commodity = MovementShipment["commodities"][number];
export type Validation = Outputs["movement"]["validate"];
export type Options = Outputs["movement"]["options"];
export type Capabilities = Outputs["integrations"]["customsCapabilities"];

export const STEPS = [
  { key: "trip", label: "Trip" },
  { key: "truck", label: "Truck" },
  { key: "crew", label: "Crew" },
  { key: "shipment", label: "Shipments" },
  { key: "trailer", label: "Trailers" },
  { key: "seals", label: "Seals" },
  { key: "review", label: "Review" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];

/** Commodity-level issues are fixed on the shipments step. */
export const stepForIssue = (step: ValidationIssue["step"]): StepKey =>
  step === "commodity" ? "shipment" : step;

export interface WorkspaceValue {
  movement: Movement;
  validation: Validation;
  options: Options;
  capabilities: Capabilities;
  permissions: { write: boolean; transmit: boolean; cancel: boolean; amend: boolean };
  /** Movement is in an editable status AND the caller may write. */
  editable: boolean;
  refresh: () => void;
  setError: (message: string | null) => void;
  goToStep: (step: StepKey) => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({
  value,
  children,
}: {
  value: WorkspaceValue;
  children: React.ReactNode;
}) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside a MovementWorkspace");
  return value;
}

/** Every mutation a step can fire, wired to the shell's refresh + error banner. */
export function useMovementMutations() {
  const trpc = useTRPC();
  const { refresh, setError } = useWorkspace();
  const onError = (e: { message: string }) => {
    setError(e.message);
    refresh(); // a failed transmit still writes an integration_events row
  };
  const onSuccess = () => {
    setError(null);
    refresh();
  };
  const opts = { onSuccess, onError };

  return {
    update: useMutation(trpc.movement.update.mutationOptions(opts)),
    addCrew: useMutation(trpc.movement.crew.add.mutationOptions(opts)),
    removeCrew: useMutation(trpc.movement.crew.remove.mutationOptions(opts)),
    setCrewRole: useMutation(trpc.movement.crew.setRole.mutationOptions(opts)),
    addTrailer: useMutation(trpc.movement.trailers.add.mutationOptions(opts)),
    removeTrailer: useMutation(trpc.movement.trailers.remove.mutationOptions(opts)),
    reorderTrailers: useMutation(trpc.movement.trailers.reorder.mutationOptions(opts)),
    addSeal: useMutation(trpc.movement.seals.add.mutationOptions(opts)),
    removeSeal: useMutation(trpc.movement.seals.remove.mutationOptions(opts)),
    createShipment: useMutation(trpc.shipment.create.mutationOptions(opts)),
    upsertCommodity: useMutation(trpc.shipment.commodities.upsert.mutationOptions(opts)),
    removeCommodity: useMutation(trpc.shipment.commodities.remove.mutationOptions(opts)),
    removeShipment: useMutation(trpc.shipment.remove.mutationOptions(opts)),
    assignShipments: useMutation(trpc.shipment.assign.mutationOptions(opts)),
    unassignShipments: useMutation(trpc.shipment.unassign.mutationOptions(opts)),
  };
}

export function toLocalInput(d: Date | null | undefined) {
  if (!d) return "";
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 16);
}
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
export const fmt = (d: Date | null | undefined) =>
  d ? new Date(d).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "—";
