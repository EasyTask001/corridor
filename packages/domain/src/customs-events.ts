import { z } from "zod";

/**
 * The messages a customs gateway sends back about one manifest, in the
 * vocabulary Avaal shows on its status screen. One `movement_events` row of
 * type `customs_event` is written per message (migration 0022).
 */
export const CUSTOMS_EVENT_CODES = [
  "sending",
  "preliminary_check_passed",
  "accepted",
  "rejected",
  "entry_on_file",
  "arrival_recorded",
  "released",
  "held",
  "entered_and_released",
  "cancelled",
  // BorderConnect-specific (task 6): CBSA ACI_NOTICE / API_RESPONSE vocabulary
  // with no earlier gateway/mock equivalent.
  "pars_matched",
  "pars_not_matched",
  "review_time_warning",
  "csa_reported",
  "import_error",
  "entry_number_assigned",
] as const;
export const customsEventCode = z.enum(CUSTOMS_EVENT_CODES);
export type CustomsEventCode = z.infer<typeof customsEventCode>;

export const CUSTOMS_EVENT_LABELS: Record<CustomsEventCode, string> = {
  sending: "Sending",
  preliminary_check_passed: "Preliminary check passed",
  accepted: "Accepted",
  rejected: "Rejected",
  entry_on_file: "Entry on file",
  arrival_recorded: "Arrival recorded",
  released: "Released",
  held: "Held for inspection",
  entered_and_released: "Entered and released",
  cancelled: "Cancelled",
  pars_matched: "PARS matched",
  pars_not_matched: "PARS not matched",
  review_time_warning: "Insufficient review time",
  csa_reported: "CSA reported",
  import_error: "Import error",
  entry_number_assigned: "Entry number assigned",
};

/** Payload of a `customs_event` timeline row. */
export const customsEventPayload = z.object({
  code: customsEventCode,
  label: z.string(),
  referenceNumber: z.string().nullable().optional(),
  entryNumber: z.string().nullable().optional(),
  entryPortCode: z.string().nullable().optional(),
  shipmentControlNumber: z.string().nullable().optional(),
  occurredAt: z.string().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});
export type CustomsEventPayload = z.infer<typeof customsEventPayload>;
