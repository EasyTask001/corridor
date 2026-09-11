import { describe, expect, it } from "vitest";
import { isTextDocument, readableText } from "./text";

describe("readableText", () => {
  it("truncates text documents to the byte cap and returns undefined for binaries", () => {
    const bytes = new TextEncoder().encode("x".repeat(10_000));
    expect(readableText({ mimeType: "text/plain", bytes }, 8192)?.length).toBe(8192);
    expect(readableText({ mimeType: "application/pdf", bytes }, 8192)).toBeUndefined();
    expect(isTextDocument("application/json")).toBe(true);
  });
});
