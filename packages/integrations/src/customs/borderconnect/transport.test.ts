import { describe, expect, it } from "vitest";
import { CustomsTransportError } from "../types";
import {
  BORDERCONNECT_ERROR_CODES,
  createBorderConnectHttpTransport,
  normaliseReceiveBody,
} from "./transport";

const jsonResponse = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );

describe("BorderConnect http transport", () => {
  it("sends the message as JSON to /api/send/<suffix> with Api-Key and Content-Type headers", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    const t = createBorderConnectHttpTransport({
      apiUrlSuffix: "acme-co",
      apiKey: "k1",
      fetchImpl: (url, init) => {
        seenUrl = String(url);
        seenInit = init;
        return jsonResponse(200, { status: "OK" });
      },
    });
    await t.send({ hello: "world" });
    expect(seenUrl).toBe("https://borderconnect.com/api/send/acme-co");
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["Api-Key"]).toBe("k1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(seenInit?.method).toBe("POST");
    expect(JSON.parse(String(seenInit?.body))).toEqual({ hello: "world" });
  });

  it("returns {status: \"OK\"} on success", async () => {
    const t = createBorderConnectHttpTransport({
      apiUrlSuffix: "acme-co",
      apiKey: "k1",
      fetchImpl: () => jsonResponse(200, { status: "OK" }),
    });
    expect(await t.send({})).toEqual({ status: "OK" });
  });

  it("a 401 FAILURE with an errorCode throws a non-retryable CustomsTransportError naming the code", async () => {
    const t = createBorderConnectHttpTransport({
      apiUrlSuffix: "acme-co",
      apiKey: "k1",
      fetchImpl: () =>
        jsonResponse(401, { status: "FAILURE", errorCode: "EXPIRED_API_KEY" }),
    });
    const err = await t.send({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomsTransportError);
    expect(err).toMatchObject({ statusCode: 401, retryable: false });
    expect((err as CustomsTransportError).message).toContain("EXPIRED_API_KEY");
  });

  it("parses the \"FAILED\" spelling variant the same as \"FAILURE\"", async () => {
    const t = createBorderConnectHttpTransport({
      apiUrlSuffix: "acme-co",
      apiKey: "k1",
      fetchImpl: () =>
        jsonResponse(401, { status: "FAILED", errorCode: "EXPIRED_API_KEY" }),
    });
    const err = await t.send({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomsTransportError);
    expect(err).toMatchObject({ statusCode: 401, retryable: false });
    expect((err as CustomsTransportError).message).toContain("EXPIRED_API_KEY");
  });

  it("a 429 TOO_MANY_REQUESTS is retryable", async () => {
    const t = createBorderConnectHttpTransport({
      apiUrlSuffix: "acme-co",
      apiKey: "k1",
      fetchImpl: () =>
        jsonResponse(429, { status: "FAILURE", errorCode: "TOO_MANY_REQUESTS" }),
    });
    const err = await t.send({}).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 429, retryable: true });
    expect((err as CustomsTransportError).message).toContain("TOO_MANY_REQUESTS");
  });

  it("a 5xx is retryable", async () => {
    const t = createBorderConnectHttpTransport({
      apiUrlSuffix: "acme-co",
      apiKey: "k1",
      fetchImpl: () => jsonResponse(503, { status: "FAILURE" }),
    });
    const err = await t.send({}).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 503, retryable: true });
  });

  it("a timeout throws a retryable 504", async () => {
    const t = createBorderConnectHttpTransport({
      apiUrlSuffix: "acme-co",
      apiKey: "k1",
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const abortError = new Error("The operation was aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        }),
    });
    const err = await t.send({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomsTransportError);
    expect(err).toMatchObject({ statusCode: 504, retryable: true });
  });

  it("receive() gets /api/receive/<suffix> with the Api-Key header and normalises the body", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    const t = createBorderConnectHttpTransport({
      apiUrlSuffix: "acme-co",
      apiKey: "k1",
      fetchImpl: (url, init) => {
        seenUrl = String(url);
        seenInit = init;
        return jsonResponse(200, { messages: [{ data: "X" }] });
      },
    });
    const messages = await t.receive();
    expect(seenUrl).toBe("https://borderconnect.com/api/receive/acme-co");
    expect((seenInit?.headers as Record<string, string>)["Api-Key"]).toBe("k1");
    expect(seenInit?.method).toBe("GET");
    expect(messages).toEqual([{ data: "X" }]);
  });

  it("exposes the documented BorderConnect error codes", () => {
    expect(BORDERCONNECT_ERROR_CODES).toContain("EXPIRED_API_KEY");
    expect(BORDERCONNECT_ERROR_CODES).toContain("TOO_MANY_REQUESTS");
  });
});

describe("normaliseReceiveBody", () => {
  it("[] stays []", () => {
    expect(normaliseReceiveBody([])).toEqual([]);
  });

  it("null and empty string become []", () => {
    expect(normaliseReceiveBody(null)).toEqual([]);
    expect(normaliseReceiveBody("")).toEqual([]);
  });

  it("an array of message objects passes through unchanged", () => {
    expect(normaliseReceiveBody([{ data: "X" }])).toEqual([{ data: "X" }]);
  });

  it("{messages: [...]} unwraps to the inner array", () => {
    expect(normaliseReceiveBody({ messages: [{ data: "A" }, { data: "B" }] })).toEqual([
      { data: "A" },
      { data: "B" },
    ]);
  });

  it("a single object with a data field wraps to a one-element array", () => {
    const body = { data: "API_RESPONSE", extra: 1 };
    expect(normaliseReceiveBody(body)).toEqual([body]);
  });

  it("{status: \"OK\"} with no data becomes []", () => {
    expect(normaliseReceiveBody({ status: "OK" })).toEqual([]);
  });
});
