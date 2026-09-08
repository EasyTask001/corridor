import { z } from "zod";
import { isoDateTime } from "./common";

/**
 * The public PAPS/PARS lookup (0027): gated on the carrier code + control
 * number pair, and it returns nothing but where the filing stands.
 */
export const trackingLookupInput = z.object({
  carrierCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,4}$/, "Carrier code is 2–4 letters or digits"),
  controlNumber: z
    .string()
    .trim()
    .transform((v) => v.replace(/\s+/g, "").toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{6,24}$/, "Control number is 6–24 letters or digits")),
});
export type TrackingLookupInput = z.infer<typeof trackingLookupInput>;

export const trackingResult = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    status: z.string(),
    portCode: z.string().nullable(),
    portName: z.string().nullable(),
    entryNumber: z.string().nullable(),
    updatedAt: isoDateTime,
    releasedAt: isoDateTime.nullable(),
  }),
]);
export type TrackingResult = z.infer<typeof trackingResult>;

/** Per-IP ceilings for the public lookup: bursts and a daily budget. */
export const TRACKING_RATE_LIMITS = {
  perMinute: 10,
  perDay: 100,
} as const;

/** The PARS RNS screen (shipment.rns.list). */
export const rnsListInput = z.object({
  q: z.string().trim().max(40).optional(),
  /** Days back from now; the screen offers today, 7 and 30. */
  rangeDays: z.number().int().min(1).max(365).default(30),
  limit: z.number().int().min(1).max(200).default(100),
  offset: z.number().int().min(0).default(0),
});
export type RnsListInput = z.infer<typeof rnsListInput>;
