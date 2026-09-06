import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { MovementWorkspace } from "@/components/movement/movement-workspace";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ movementId: string }>;
}): Promise<Metadata> {
  const { movementId } = await params;
  try {
    const m = await (await api()).movement.get({ id: movementId });
    return { title: m.movementNumber };
  } catch {
    return { title: "Movement" };
  }
}

export default async function MovementPage({
  params,
}: {
  params: Promise<{ movementId: string }>;
}) {
  const { movementId } = await params;
  const session = await getSession();
  if (!session?.permissions.has("movement.read")) redirect("/dashboard");

  const caller = await api();
  let movement: Awaited<ReturnType<typeof caller.movement.get>>;
  let validation: Awaited<ReturnType<typeof caller.movement.validate>>;
  try {
    [movement, validation] = await Promise.all([
      caller.movement.get({ id: movementId }),
      caller.movement.validate({ id: movementId }),
    ]);
  } catch (e) {
    if (e instanceof TRPCError && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const options = await caller.movement.options();

  const p = session.permissions;
  return (
    <MovementWorkspace
      initial={movement}
      initialValidation={validation}
      options={options}
      permissions={{
        write: p.has("movement.write"),
        transmit: p.has("movement.transmit_to_customs"),
        cancel: p.has("movement.cancel"),
        amend: p.has("movement.amend"),
      }}
      simulationEnabled={
        process.env.CORRIDOR_ALLOW_CUSTOMS_SIMULATION === "true" ||
        process.env.NODE_ENV !== "production"
      }
    />
  );
}
