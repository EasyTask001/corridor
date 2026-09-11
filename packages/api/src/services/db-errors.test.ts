import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { mapDbError } from "./db-errors";

function pgError(code: string, extra: Record<string, unknown> = {}) {
  return { cause: { code, ...extra } };
}

describe("mapDbError", () => {
  it("maps 23505 (unique violation) to CONFLICT", () => {
    try {
      mapDbError(pgError("23505"));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TRPCError);
      expect((e as TRPCError).code).toBe("CONFLICT");
    }
  });

  it("maps 23514 (check violation) to BAD_REQUEST", () => {
    try {
      mapDbError(pgError("23514"));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TRPCError);
      expect((e as TRPCError).code).toBe("BAD_REQUEST");
    }
  });

  it("maps 23503 (foreign key violation) to BAD_REQUEST", () => {
    try {
      mapDbError(pgError("23503", { constraint: "trailer_type_fkey" }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TRPCError);
      expect((e as TRPCError).code).toBe("BAD_REQUEST");
    }
  });

  it("maps P0001 (raised domain error) to PRECONDITION_FAILED with message passthrough", () => {
    try {
      mapDbError(pgError("P0001", { message: "Cannot close an already-closed record" }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TRPCError);
      expect((e as TRPCError).code).toBe("PRECONDITION_FAILED");
      expect((e as TRPCError).message).toBe("Cannot close an already-closed record");
    }
  });

  it("rethrows anything else as-is", () => {
    const original = new Error("connection reset");
    try {
      mapDbError(original);
      expect.unreachable();
    } catch (e) {
      expect(e).toBe(original);
    }
  });
});
