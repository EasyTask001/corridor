"use server";

import { redirect } from "next/navigation";
import { regime as regimeSchema } from "@corridor/domain";
import { api } from "@/lib/trpc/server";

export async function createMovement(formData: FormData) {
  const regime = regimeSchema.parse(formData.get("regime"));
  const caller = await api();
  const m = await caller.movement.create({ regime });
  redirect(`/movements/${m.id}`);
}
