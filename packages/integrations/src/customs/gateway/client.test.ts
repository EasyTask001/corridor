import { beforeEach, describe, expect, it } from "vitest";
import { CustomsTransportError, type ManifestPayload } from "../types";
import { clearCustomsFixtureState } from "../fixture-state";
import { createGatewayCustomsClient } from "./client";
import { parseInboundMessage, signInbound, verifyInboundSignature } from "./inbound";
import { createFixtureTransport, createHttpTransport, type GatewayTransport } from "./transport";

const manifest: ManifestPayload = {
  regime: "ACE",
  carrier: {
    code: "PFTR",
    filerCode: null,
    usDotNumber: "1234567",
    name: "Pathfinder",
    scac: "PFTR",
    canadianCarrierCode: "1234567",
    timezone: "America/Toronto",
  },
  trip: {
    movementNumber: "ACE-26-00001",
    tripNumber: "TRIP-1",
    portOfEntry: "3801",
    estimatedArrival: "2026-09-08T14:00:00.000Z",
    isEmpty: false,
    iitIndicator: "none",
    aci: { lvs: false, postal: false, flyingTruck: false, inTransit: false, iit: false },
  },
  crew: [],
  conveyance: {
    unitNumber: "T-101",
    vin: null,
    plate: "AB1",
    plateJurisdiction: "ON",
    plates: [],
    truckType: "TR",
    dotNumber: null,
    insurance: null,
    seals: [],
  },
  equipment: [],
  shipments: [
    {
      controlNumber: "PFTRPAPS0001",
      shipmentType: "regular_bill",
      cargoType: null,
      entryNumber: null,
      entryPort: null,
      inBond: null,
      loading: { country: null, province: null, city: null },
      delivery: null,
      loadedOn: null,
      shipper: null,
      consignee: null,
      commodities: [],
    },
  ],
};

const withControl = (controlNumber: string): ManifestPayload => ({
  ...manifest,
  shipments: [{ ...manifest.shipments[0]!, controlNumber }],
});

const fixedNow = () => new Date("2026-09-06T12:00:00.000Z");

beforeEach(clearCustomsFixtureState);

describe("gateway customs client (fixture transport)", () => {
  it("submits, polls to accepted, then released with an entry per shipment", async () => {
    const c = createGatewayCustomsClient({ provider: "cbp_ace", now: fixedNow, tenantKey: "t1" });
    expect(c.mode).toBe("gateway");
    const ack = await c.transmit(manifest, { correlationId: "c-1" });
    expect(ack.referenceNumber).toMatch(/^ACE-FX\d{5}$/);
    expect(ack.raw.live).toBe(false);

    const first = await c.fetchStatus(ack.referenceNumber);
    expect(first.status).toBe("accepted");
    expect(first.events.map((e) => e.code)).toEqual([
      "sending",
      "preliminary_check_passed",
      "accepted",
    ]);
    expect(first.shipments).toEqual([
      { controlNumber: "PFTRPAPS0001", status: "accepted", entryNumber: null, entryPortCode: null },
    ]);

    const second = await c.fetchStatus(ack.referenceNumber);
    expect(second.status).toBe("released");
    expect(second.decision).toBe("released");
    expect(second.events.map((e) => e.code)).toEqual([
      "entry_on_file",
      "arrival_recorded",
      "released",
    ]);
    expect(second.events[0]).toMatchObject({
      shipmentControlNumber: "PFTRPAPS0001",
      entryPortCode: "3801",
      entryNumber: expect.stringMatching(/^300\d{8}$/),
    });
    expect(second.shipments[0]).toMatchObject({
      status: "released",
      entryNumber: second.events[0]?.entryNumber,
    });
    // The last stage repeats.
    expect((await c.fetchStatus(ack.referenceNumber)).status).toBe("released");
  });

  it("H-suffixed control numbers hold before release; R-suffixed are rejected", async () => {
    const c = createGatewayCustomsClient({ provider: "cbsa_aci", now: fixedNow, tenantKey: "t1" });
    const held = await c.transmit(withControl("7ELUPARS00H"));
    expect((await c.fetchStatus(held.referenceNumber)).status).toBe("accepted");
    const hold = await c.fetchStatus(held.referenceNumber);
    expect(hold.status).toBe("held");
    expect(hold.events.map((e) => e.code)).toEqual(["entry_on_file", "held"]);
    expect((await c.fetchStatus(held.referenceNumber)).status).toBe("released");

    const rejected = await c.transmit(withControl("7ELUPARS00R"));
    const r = await c.fetchStatus(rejected.referenceNumber);
    expect(r.status).toBe("rejected");
    expect(r.decision).toBe("rejected");
  });

  it("fetchDecision keeps the caller polling while the gateway says pending", async () => {
    const c = createGatewayCustomsClient({
      provider: "cbp_ace",
      tenantKey: "t1",
      transport: createFixtureTransport({
        "POST /manifests": () => ({ referenceNumber: "ACE-P1", receivedAt: "now" }),
        "GET /manifests/ACE-P1": () => ({ referenceNumber: "ACE-P1", status: "pending" }),
      }),
    });
    await c.transmit(manifest);
    const d = await c.fetchDecision("ACE-P1", manifest, { currentStatus: "sent" });
    expect(d.events).toEqual([]);
    expect(d.shipments).toEqual([]);
  });

  it("amend keeps the reference and restarts the sequence; cancel acknowledges; ping and notices answer", async () => {
    const c = createGatewayCustomsClient({ provider: "cbp_ace", now: fixedNow, tenantKey: "t1" });
    const ack = await c.transmit(manifest);
    expect((await c.fetchStatus(ack.referenceNumber)).status).toBe("accepted");
    const amended = await c.amend(manifest, ack.referenceNumber);
    expect(amended.referenceNumber).toBe(ack.referenceNumber);
    expect((await c.fetchStatus(ack.referenceNumber)).status).toBe("accepted");
    const cancelled = await c.cancel(ack.referenceNumber, "Load cancelled");
    expect(cancelled.referenceNumber).toBe(ack.referenceNumber);
    expect((await c.ping()).ok).toBe(true);
    const notices = await c.fetchNotices(null);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ provider: "cbp_ace", severity: "warning" });
  });

  it("a filing transmitted through one instance is visible to fetchStatus on a second instance of the same tenant", async () => {
    const mk = () =>
      createGatewayCustomsClient({ provider: "cbp_ace", now: fixedNow, tenantKey: "org-a" });
    const ack = await mk().transmit(manifest);
    // Every poll below is from a fresh instance — what customsClientFor does per request.
    const stages: string[] = [];
    for (let i = 0; i < 3; i++) stages.push((await mk().fetchStatus(ack.referenceNumber)).status);
    expect(stages).toEqual(["accepted", "released", "released"]);
    const last = await mk().fetchStatus(ack.referenceNumber);
    expect(last.shipments[0]).toMatchObject({
      controlNumber: "PFTRPAPS0001",
      status: "released",
      entryPortCode: "3801",
    });
  });

  it("a second instance of the same tenant continues the reference sequence", async () => {
    const mk = () =>
      createGatewayCustomsClient({ provider: "cbp_ace", now: fixedNow, tenantKey: "org-a" });
    const first = await mk().transmit(manifest);
    const second = await mk().transmit(withControl("PFTRPAPS0002"));
    expect(first.referenceNumber).toBe("ACE-FX00001");
    expect(second.referenceNumber).toBe("ACE-FX00002");
    expect((await mk().fetchStatus(first.referenceNumber)).shipments[0]?.controlNumber).toBe(
      "PFTRPAPS0001",
    );
  });
});

describe("in-bond messages", () => {
  const rec = {
    bondNumber: "123456789",
    entryType: "IT" as const,
    arrivalPortCode: "3801",
    exportPortCode: "0901",
    firmsCode: "A123",
    carrierCode: "PFTR",
    controlNumber: "PFTRPAPS00009",
  };

  it("the fixture gateway acknowledges arrival, export and cancel, and reports the last one", async () => {
    const c = createGatewayCustomsClient({ provider: "cbp_ace", now: fixedNow, tenantKey: "t1" });
    expect((await c.inBondStatus(rec.bondNumber)).status).toBe("open");
    const arrival = await c.inBondArrival(rec);
    expect(arrival.referenceNumber).toMatch(/^ACE-FX/);
    expect((await c.inBondStatus(rec.bondNumber)).status).toBe("arrived");
    await c.inBondExport(rec);
    expect((await c.inBondStatus(rec.bondNumber)).status).toBe("exported");
    await c.inBondCancel(rec, "Load rerouted");
    expect((await c.inBondStatus(rec.bondNumber)).status).toBe("cancelled");
  });

  it("a live client posts the in-bond document and reads the status back", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const transport: GatewayTransport = {
      post: (path, body) => {
        calls.push({ path, body });
        return Promise.resolve({ referenceNumber: "IB-1", receivedAt: "2026-09-06T12:00:00.000Z" });
      },
      get: (path) => {
        calls.push({ path });
        return Promise.resolve({ bondNumber: "123456789", status: "ARRIVED", message: "At port" });
      },
    };
    const c = createGatewayCustomsClient({ provider: "cbp_ace", tenantKey: "t1", transport });
    expect((await c.inBondArrival(rec)).referenceNumber).toBe("IB-1");
    expect(calls[0]).toMatchObject({ path: "/in-bond/123456789/arrival" });
    expect((calls[0]?.body as { firmsCode: string }).firmsCode).toBe("A123");
    expect(await c.inBondStatus("123456789")).toMatchObject({
      status: "arrived",
      message: "At port",
    });
  });

  it("two tenants with the same bond number do not see each other's status", async () => {
    const a = createGatewayCustomsClient({
      provider: "cbp_ace",
      now: fixedNow,
      tenantKey: "org-a",
    });
    const b = createGatewayCustomsClient({
      provider: "cbp_ace",
      now: fixedNow,
      tenantKey: "org-b",
    });
    await a.inBondArrival(rec);
    expect((await a.inBondStatus(rec.bondNumber)).status).toBe("arrived");
    expect((await b.inBondStatus(rec.bondNumber)).status).toBe("open");
    await b.inBondCancel(rec, "rerouted");
    expect((await b.inBondStatus(rec.bondNumber)).status).toBe("cancelled");
    expect((await a.inBondStatus(rec.bondNumber)).status).toBe("arrived");
  });
});

describe("http transport", () => {
  const fetchStub = (responses: Array<{ status: number; body: unknown }>) => () => {
    const next = responses.shift()!;
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  it("sends the bearer key and marks 429 / 5xx retryable, 4xx not", async () => {
    let seen: RequestInit | undefined;
    const t = createHttpTransport({
      baseUrl: "https://gw.example/",
      apiKey: "k1",
      fetchImpl: (url: string | URL | Request, init?: RequestInit) => {
        seen = init;
        expect(String(url)).toBe("https://gw.example/manifests/ping");
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      },
    });
    expect(await t.get("/manifests/ping")).toEqual({ ok: true });
    expect((seen?.headers as Record<string, string>).Authorization).toBe("Bearer k1");

    const busy = createHttpTransport({
      baseUrl: "https://gw.example",
      apiKey: "k1",
      fetchImpl: fetchStub([{ status: 429, body: { message: "slow down" } }]),
    });
    await expect(busy.get("/manifests/x")).rejects.toMatchObject({
      statusCode: 429,
      retryable: true,
      message: "Customs gateway: slow down",
    });
    const bad = createHttpTransport({
      baseUrl: "https://gw.example",
      apiKey: "k1",
      fetchImpl: fetchStub([{ status: 400, body: { message: "bad manifest" } }]),
    });
    const err = await bad.post("/manifests", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomsTransportError);
    expect(err).toMatchObject({ statusCode: 400, retryable: false });
  });

  it("a live client goes through the transport with the manifest as the body", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const transport: GatewayTransport = {
      post: (path, body) => {
        calls.push({ path, body });
        return Promise.resolve({
          referenceNumber: "ACE-LIVE1",
          receivedAt: "2026-09-06T12:00:00.000Z",
        });
      },
      get: (path) => {
        calls.push({ path });
        return Promise.resolve({
          referenceNumber: "ACE-LIVE1",
          status: "accepted",
          events: [{ code: "accepted" }],
        });
      },
    };
    const c = createGatewayCustomsClient({ provider: "cbp_ace", tenantKey: "t1", transport });
    const ack = await c.transmit(manifest, { correlationId: "corr" });
    expect(ack.referenceNumber).toBe("ACE-LIVE1");
    expect(calls[0]).toMatchObject({ path: "/manifests" });
    expect((calls[0]?.body as { correlationId: string }).correlationId).toBe("corr");
    expect((calls[0]?.body as { shipments: unknown[] }).shipments).toHaveLength(1);
    const s = await c.fetchStatus("ACE-LIVE1");
    expect(s.events[0]?.label).toBe("Accepted");
  });
});

describe("inbound signature", () => {
  const body = JSON.stringify({ eventId: "evt-1", referenceNumber: "ACE-1", status: "released" });
  const headers = (sig: string | null) => ({
    get: (n: string) => (n === "x-corridor-signature" ? sig : null),
  });

  it("accepts a correct HMAC, rejects a wrong one, a missing one and a missing secret", () => {
    const sig = signInbound(body, "s3cret");
    expect(verifyInboundSignature(body, sig, "s3cret")).toBe(true);
    expect(verifyInboundSignature(body, `sha256=${sig}`, "s3cret")).toBe(true);
    expect(verifyInboundSignature(body, sig, "other")).toBe(false);
    expect(verifyInboundSignature(body, null, "s3cret")).toBe(false);
    expect(verifyInboundSignature(body, sig, undefined)).toBe(false);
    expect(verifyInboundSignature(body, "zz", "s3cret")).toBe(false);
  });

  it("parses a signed status document and derives the event id", () => {
    const parsed = parseInboundMessage(body, headers(signInbound(body, "s3cret")), "s3cret");
    expect(parsed).toMatchObject({
      eventId: "evt-1",
      referenceNumber: "ACE-1",
      status: "released",
      decision: "released",
    });
    expect(parseInboundMessage(body, headers("nope"), "s3cret")).toBeNull();
    expect(
      parseInboundMessage("not json", headers(signInbound("not json", "s3cret")), "s3cret"),
    ).toBeNull();
    const noId = JSON.stringify({ referenceNumber: "ACE-2", status: "held" });
    expect(parseInboundMessage(noId, headers(signInbound(noId, "s3cret")), "s3cret")?.eventId).toBe(
      "ACE-2:held",
    );
  });
});
