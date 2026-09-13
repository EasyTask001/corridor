import { describe, expect, it } from "vitest";
import { scrubTelemetryEvent } from "./redact";

describe("scrubTelemetryEvent", () => {
  it("removes customs payloads, document text, credentials, company keys, and personal data", () => {
    const event = {
      message:
        "failed for jane@example.com with Api-Key secret-value and companyKey=c-real-carrier-key",
      user: { id: "user-1", email: "jane@example.com", ip_address: "192.0.2.1" },
      request: {
        method: "POST",
        url: "https://corridor.example/api/trpc?token=secret",
        headers: { authorization: "Bearer secret", "user-agent": "browser" },
        data: { manifest: { driverName: "Jane Driver" } },
      },
      extra: {
        apiKey: "secret-value",
        company_key: "c-real-carrier-key",
        customsPayload: { tripNumber: "TRIP-1" },
        documentText: "private bill of lading contents",
        email: "jane@example.com",
        safeCount: 3,
      },
      contexts: {
        operation: { provider: "border_connect", regime: "ace", shipmentId: "private-id" },
      },
    };

    const scrubbed = scrubTelemetryEvent(event);
    const encoded = JSON.stringify(scrubbed);

    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.request).toEqual({ method: "POST", url: "https://corridor.example" });
    expect(encoded).not.toContain("jane@example.com");
    expect(encoded).not.toContain("secret-value");
    expect(encoded).not.toContain("c-real-carrier-key");
    expect(encoded).not.toContain("private bill of lading contents");
    expect(encoded).not.toContain("Jane Driver");
    expect(scrubbed.extra?.safeCount).toBe(3);
    expect(scrubbed.contexts?.operation).toEqual({ provider: "border_connect", regime: "ace" });
  });

  it("removes frame variables and sanitizes breadcrumbs without discarding stack frames", () => {
    const scrubbed = scrubTelemetryEvent({
      message: "provider returned private document text",
      exception: {
        values: [
          {
            type: "Error",
            value: "contact bob@example.com; password=hunter2",
            stacktrace: {
              frames: [{ filename: "src/worker.ts", function: "run", vars: { token: "secret" } }],
            },
          },
        ],
      },
      breadcrumbs: [
        {
          category: "customs",
          message: "companyKey=c-private",
          data: { requestPayload: { secret: true }, status: 503 },
        },
      ],
    });

    expect(scrubbed.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      filename: "src/worker.ts",
      function: "run",
    });
    expect(scrubbed.exception?.values?.[0]?.value).toBe("[REDACTED_EXCEPTION]");
    expect(scrubbed.message).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toMatch(/bob@example|hunter2|c-private|requestPayload/);
    expect(scrubbed.breadcrumbs?.[0]?.data).toEqual({ status: 503 });
  });

  it("drops arbitrary unknown extra/context fields instead of attempting to scrub them", () => {
    const scrubbed = scrubTelemetryEvent({
      extra: { provider: "border_connect", unknownBlob: { private: "customer document" } },
      contexts: { operation: { operation: "drain" }, arbitrary: { private: "secret" } },
    });
    expect(scrubbed.extra).toEqual({ provider: "border_connect" });
    expect(scrubbed.contexts).toEqual({ operation: { operation: "drain" } });
  });
});
