import { z } from "zod";
import { email, nonEmpty, uuid } from "./common";
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

export const organizationSchema = z.object({
  id: uuid,
  name: nonEmpty.max(120),
  legalName: z.string().trim().max(200).nullable(),
  scacCode: scacCode.nullable(),
  canadianCarrierCode: canadianCarrierCode.nullable(),
  usDotNumber: usDotNumber.nullable(),
  mcNumber: mcNumber.nullable(),
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
