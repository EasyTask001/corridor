"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { ACTIVE_ORG_COOKIE } from "@corridor/api";
import { createOrganizationInput } from "@corridor/domain";
import { api } from "@/lib/trpc/server";

export type OnboardingState = { error?: string } | null;

const blankToUndefined = (v: FormDataEntryValue | null) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

export async function createOrganization(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const parsed = createOrganizationInput.safeParse({
    name: blankToUndefined(formData.get("name")),
    scacCode: blankToUndefined(formData.get("scacCode")),
    canadianCarrierCode: blankToUndefined(formData.get("canadianCarrierCode")),
    usDotNumber: blankToUndefined(formData.get("usDotNumber")),
    mcNumber: blankToUndefined(formData.get("mcNumber")),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    const caller = await api();
    const { organizationId } = await caller.organization.create(parsed.data);
    (await cookies()).set(ACTIVE_ORG_COOKIE, organizationId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
  } catch (e) {
    return { error: e instanceof TRPCError ? e.message : "Could not create organization" };
  }
  redirect("/dashboard");
}
