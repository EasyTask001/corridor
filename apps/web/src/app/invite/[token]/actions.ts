"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { ACTIVE_ORG_COOKIE } from "@corridor/api";
import { api } from "@/lib/trpc/server";
import { appCookieOptions } from "@/lib/cookies";

export type InviteState = { error?: string } | null;

export async function acceptInvitation(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const token = formData.get("token");
  if (typeof token !== "string") return { error: "Invalid invitation" };
  try {
    const caller = await api();
    const { organizationId } = await caller.organization.members.acceptInvite({ token });
    (await cookies()).set(ACTIVE_ORG_COOKIE, organizationId, appCookieOptions());
  } catch (e) {
    return { error: e instanceof TRPCError ? e.message : "Could not accept invitation" };
  }
  redirect("/dashboard");
}
