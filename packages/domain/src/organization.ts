import { z } from "zod";
import { email, nonEmpty, uuid } from "./common";
import { address } from "./registry";
import { membershipStatus } from "./role";

export const subscriptionPlan = z.enum(["trial", "starter", "professional", "enterprise"]);
export type SubscriptionPlan = z.infer<typeof subscriptionPlan>;

export const subscriptionStatus = z.enum([
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
]);
export type SubscriptionStatus = z.infer<typeof subscriptionStatus>;

/** SCAC: 2–4 uppercase letters. Canadian carrier code: 4 alphanumerics. */
export const scacCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2,4}$/, "SCAC must be 2–4 letters");
export const canadianCarrierCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4}$/, "Carrier code must be 4 alphanumeric characters");
export const usDotNumber = z
  .string()
  .trim()
  .regex(/^\d{1,8}$/, "USDOT must be 1–8 digits");
export const mcNumber = z
  .string()
  .trim()
  .regex(/^(MC-?)?\d{1,8}$/i, "Invalid MC number");
/** Customs filer/broker identifier printed alongside the carrier code on a manifest. */
export const filerCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{3}$/, "Filer code must be 3 alphanumeric characters");

export const organizationSchema = z.object({
  id: uuid,
  name: nonEmpty.max(120),
  legalName: z.string().trim().max(200).nullable(),
  scacCode: scacCode.nullable(),
  canadianCarrierCode: canadianCarrierCode.nullable(),
  usDotNumber: usDotNumber.nullable(),
  mcNumber: mcNumber.nullable(),
  filerCode: filerCode.nullable(),
  billingEmail: email.nullable(),
  subscriptionPlan,
  subscriptionStatus,
});
export type Organization = z.infer<typeof organizationSchema>;

export const createOrganizationInput = z.object({
  name: nonEmpty.max(120),
  legalName: z.string().trim().max(200).optional(),
  scacCode: scacCode.optional(),
  canadianCarrierCode: canadianCarrierCode.optional(),
  usDotNumber: usDotNumber.optional(),
  mcNumber: mcNumber.optional(),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationInput>;

export const updateOrganizationInput = createOrganizationInput.partial().extend({
  billingEmail: email.optional(),
  filerCode: filerCode.optional(),
  /** Print driver sheets without commodity lines (0024). */
  simpleDriverSheet: z.boolean().optional(),
  // 0025 — company profile
  timezone: z
    .string()
    .trim()
    .max(64)
    .refine(
      (tz) => {
        try {
          new Intl.DateTimeFormat("en-CA", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      },
      { message: "Unknown IANA time zone" },
    )
    .optional(),
  billingAddress: address.optional(),
  /** ACI PARS cargo control numbers carry the PARS prefix. */
  includeParsInCargoNumbers: z.boolean().optional(),
  /** Where driver sheets and entry notices are e-mailed (at most five). */
  dispatchEmails: z.array(email).max(5).optional(),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationInput>;

export const organizationMemberSchema = z.object({
  id: uuid,
  organizationId: uuid,
  userId: uuid.nullable(),
  roleId: uuid,
  roleName: z.string(),
  status: membershipStatus,
  invitedEmail: email.nullable(),
  displayName: z.string().nullable(),
});
export type OrganizationMember = z.infer<typeof organizationMemberSchema>;

export const inviteMemberInput = z.object({
  email,
  roleId: uuid,
});
export type InviteMemberInput = z.infer<typeof inviteMemberInput>;

/**
 * Billable events Corridor meters. The list is mirrored by the
 * `usage_records.metric` CHECK constraint (migration 0013) — add to both or
 * neither.
 */
export const USAGE_METRICS = [
  "documents_extracted",
  "copilot_messages",
  "movements_transmitted",
  "ai_suggestions",
] as const;
export const usageMetric = z.enum(USAGE_METRICS);
export type UsageMetric = (typeof USAGE_METRICS)[number];

/** Settings → My profile (Task 13). */
export const profileUpdateInput = z.object({
  displayName: z.string().trim().min(1, "Name is required").max(80),
  phone: z.string().trim().max(40).nullable().optional(),
});
export type ProfileUpdateInput = z.infer<typeof profileUpdateInput>;
