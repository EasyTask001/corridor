/**
 * Shared Postgres error -> TRPCError mapping (ISSUE-030).
 *
 * `party.ts` and `inbond.ts` each hand-rolled a `.catch()` mapper for the
 * Postgres error codes their mutations can raise. This is the union of both:
 * the registry-style unique/check/foreign-key codes from `party.ts`, plus the
 * `P0001` (raised domain error, e.g. a trigger rejecting an update) case from
 * `inbond.ts`. Router-specific one-off catches with a custom message for a
 * single constraint (e.g. inbond's "That shipment already has an in-bond
 * record") are out of scope and stay inline.
 */
import { TRPCError } from "@trpc/server";

export function mapDbError(e: unknown): never {
  const cause = (e as { cause?: { code?: string; constraint_name?: string; constraint?: string; message?: string } })
    ?.cause;
  const constraint = cause?.constraint_name ?? cause?.constraint ?? "";
  if (cause?.code === "23505") {
    const which = constraint.includes("vin")
      ? "VIN"
      : constraint.includes("document")
        ? "document number"
        : constraint.includes("license")
          ? "license number"
          : constraint.includes("plates")
            ? "plate position"
            : "unit number";
    throw new TRPCError({
      code: "CONFLICT",
      message: `A record with this ${which} already exists`,
    });
  }
  if (cause?.code === "23514") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A field failed validation" });
  }
  if (cause?.code === "23503" && constraint.includes("trailer_type")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown equipment type code" });
  }
  if (cause?.code === "P0001") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: cause.message ?? "Rejected" });
  }
  throw e;
}
