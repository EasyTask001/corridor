#!/usr/bin/env tsx
/**
 * LIVE smoke test against an approved BorderConnect Service Provider test
 * account. This is the only place in the repo that
 * makes a network call to BorderConnect's production API with real
 * credentials — everything else (client.test.ts, ace.test.ts, transport.
 * test.ts, ...) runs against a fixture or an injected fake transport.
 *
 * Why this exists: `GET /api/receive` (`normaliseReceiveBody`, `transport.
 * ts`) has defended against four documented envelope shapes since Task 4
 * without ever seeing a real response. This script settles that by filing
 * one throwaway `ACE_TRIP` or `ACI_TRIP` with `autoSend: false` (BorderConnect holds it in
 * its own system; it never reaches CBP/CBSA) and recording the receive
 * envelope shape. Evidence is written with stable routing-key hashes; raw
 * customs payloads, company keys, document data, and credentials are never
 * printed or persisted.
 *
 * Safety rails (do not weaken these):
 *   1. `autoSend` is the literal `false` below, never read from an env var,
 *      a CLI flag, or any config. There is no code path that can flip it.
 *   2. The script refuses to run at all if `BORDERCONNECT_SMOKE_AUTOSEND`
 *      is set to anything (including "false") — its only job is to prove
 *      nobody can override rail #1 by exporting a same-shaped variable.
 *   3. `tripNumber` always contains the literal string `SMOKE` plus today's
 *      date, so the filing is unmistakably a test artifact inside
 *      BorderConnect's own system, never a real crossing.
 *   4. `GET /api/receive` is NOT called unless `--drain-shared-queue` is
 *      passed. BorderConnect's receive endpoint is pop-on-read with no
 *      replay, and the queue is shared by every tenant filing through this
 *      Service Provider account — polling it here would permanently destroy
 *      real acks, decisions, RNS releases and notices that nothing else will
 *      ever see again. Without the flag the script sends and stops, which is
 *      still a complete outbound smoke test.
 *      Only pass `--drain-shared-queue` against an account no tenant is
 *      filing through, or while the drain job / listener is stopped and you
 *      accept losing whatever is in the queue. The script cannot store what
 *      it reads into `customs_inbox` itself: `storeInboundMessages` lives in
 *      `@corridor/api`, which already depends on this package, so importing
 *      it here would be a dependency cycle.
 *
 * Usage:
 *   source .env.local && pnpm --filter @corridor/integrations smoke:borderconnect -- --regime=ACE
 *   source .env.local && pnpm --filter @corridor/integrations smoke:borderconnect -- --regime=ACI
 *   source .env.local && pnpm --filter @corridor/integrations smoke:borderconnect -- --cleanup
 *   source .env.local && pnpm --filter @corridor/integrations smoke:borderconnect -- --drain-shared-queue
 *   source .env.local && pnpm --filter @corridor/integrations smoke:borderconnect -- \
 *     --regime=ACE --drain-shared-queue --record-fixtures=artifacts/borderconnect-smoke/fixtures
 *   source .env.local && pnpm --filter @corridor/integrations smoke:borderconnect -- --two-trailers
 *
 * `--two-trailers` hitches a second trailer and sets an explicit `loadedOn`
 * on the shipment, so the outbound payload carries the field
 * BORDERCONNECT_MULTI_TRAILER_ENABLED gates on — see
 * docs/operations/borderconnect-live-validation.md.
 *
 * `--record-fixtures=<dir>` writes one `sanitizeInboundForFixture()`-sanitized
 * copy of every message `--drain-shared-queue` receives into `<dir>` (mode
 * 0600), alongside the existing redacted evidence file. These are candidates,
 * not fixtures yet: a human reviews each one and promotes it into
 * `fixtures/inbound/live/` — see `docs/operations/borderconnect-live-validation.md`.
 * Without `--drain-shared-queue` there is nothing to record, so this flag has
 * no effect (a warning is printed).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, type ManifestSource } from "../src/customs/manifest";
import { toAceTrip } from "../src/customs/borderconnect/ace";
import { toAciTrip } from "../src/customs/borderconnect/aci";
import { parseInbound } from "../src/customs/borderconnect/inbound";
import { sanitizeInboundForFixture } from "../src/customs/borderconnect/sanitize";
import {
  createBorderConnectHttpTransport,
  normaliseReceiveBody,
} from "../src/customs/borderconnect/transport";
import { CustomsTransportError } from "../src/customs/types";
import {
  parseSmokeRegime,
  receiveShape,
  redactedSmokeRecord,
  type RedactedSmokeRecord,
} from "../src/customs/borderconnect/smoke-support";
import type { Regime } from "@corridor/domain";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../../");
const BASE_URL = "https://borderconnect.com";

// ---------------------------------------------------------------------------
// .env.local loading (best-effort; a shell `source .env.local` before this
// script already wins — existing process.env values are never overwritten).
// ---------------------------------------------------------------------------
function loadDotEnvLocal(): void {
  const path = resolve(REPO_ROOT, ".env.local");
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (see .env.local) — refusing to run without it`);
  }
  return value;
}

/**
 * Rail #2: the moment this env var is set to *anything*, the script exits
 * before doing anything else — before loading .env.local's real values into
 * any variable that could reach a request, before building a manifest,
 * before touching the network. There is no branch below that reads this
 * variable's value or forwards it anywhere.
 */
function refuseIfAutoSendOverrideIsSet(): void {
  if (process.env.BORDERCONNECT_SMOKE_AUTOSEND !== undefined) {
    console.error(
      "BORDERCONNECT_SMOKE_AUTOSEND is set — this script refuses to run. " +
        "autoSend is hard-coded false and is never configurable; unset this variable and re-run.",
    );
    process.exit(1);
  }
}

/**
 * A minimal, fully-populated ACE `ManifestSource` — adapted from `ace.test.
 * ts`'s `makeSource()` fixture (not exported for production/script use, so
 * duplicated here rather than reaching into a test file from a script).
 * Every optional BorderConnect field is filled in to minimise the chance of
 * an avoidable `DATA_ERROR` unrelated to what this script is trying to
 * observe (the receive envelope shape).
 *
 * `twoTrailers` hitches a second trailer and sets an explicit `loadedOn` on
 * the shipment — the one live run this smoke test cannot otherwise cover,
 * needed to validate the field before `BORDERCONNECT_MULTI_TRAILER_ENABLED`
 * can go on in production (see docs/operations/borderconnect-live-validation.md).
 */
function makeSource(regime: Regime, opts: { twoTrailers?: boolean } = {}): ManifestSource {
  const aci = regime === "ACI";
  const twoTrailers = opts.twoTrailers ?? false;
  return {
    organization: {
      name: "Corridor Smoke Test",
      usDotNumber: "1234567",
      filerCode: "F01",
      scacCode: "PFTR",
      canadianCarrierCode: "1234567",
      timezone: "America/Toronto",
    },
    movement: {
      regime,
      movementNumber: "SMOKE-00001",
      tripNumber: null,
      carrierCode: "PFTR",
      port: { code: aci ? "0409" : "3801" },
      scheduledCrossingAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      isEmpty: false,
      iitIndicator: "none",
      aciLvs: false,
      aciPostal: false,
      aciFlyingTruck: false,
      aciInTransit: false,
      aciIit: false,
    },
    crew: [
      {
        role: "person_in_charge",
        firstName: "Smoke",
        lastName: "Test",
        gender: "M",
        licenseNumber: "L1",
        licenseJurisdiction: "ON",
        citizenship: "CA",
        dateOfBirth: "1985-03-14",
        hazmatEndorsement: false,
        documents: [
          {
            documentType: "passport",
            documentNumber: "P1234567",
            issuingCountry: "CA",
            issuingState: null,
            expiresOn: "2030-01-01",
          },
        ],
      },
    ],
    truck: {
      unitNumber: "T-101",
      vin: "1FUJA6CV12LJ12345",
      plateNumber: "AB1234",
      plateJurisdiction: "ON",
      dotNumber: "1234567",
      truckType: "TR",
      insurancePolicyNumber: null,
      insuranceCompany: null,
      insuranceAmount: null,
      insuranceYear: null,
      plates: [],
      seals: ["S1"],
    },
    trailers: twoTrailers
      ? [
          {
            movementTrailerId: "smoke-trailer-1",
            unitNumber: "TR-501",
            trailerType: "TF",
            plateNumber: "SMK501",
            plateJurisdiction: "ON",
            plates: [],
            seals: ["S1"],
          },
          {
            movementTrailerId: "smoke-trailer-2",
            unitNumber: "TR-502",
            trailerType: "TF",
            plateNumber: "SMK502",
            plateJurisdiction: "ON",
            plates: [],
            seals: ["S2"],
          },
        ]
      : [],
    shipments: [
      {
        controlNumber: aci ? "PFTRPARSSMOKE1" : "PFTRSMOKE0001",
        shipmentType: aci ? null : "regular_bill",
        cargoType: aci ? "regular" : null,
        entryNumber: "ENT-1",
        entryPortCode: aci ? "0409" : "3801",
        inBondEntryType: null,
        inBondDestinationPortCode: null,
        inBondNumber: null,
        loadingCountry: "CA",
        loadingProvince: "ON",
        loadingCity: "Hamilton",
        shipperName: "Acme Steel",
        shipperAddress: {
          line1: "1 Mill Rd",
          city: "Hamilton",
          region: "ON",
          postalCode: "L8L1A1",
          country: "CA",
        },
        consigneeName: "Depot Inc",
        consigneeAddress: {
          line1: "2 Depot Ave",
          city: "Detroit",
          region: "MI",
          postalCode: "48201",
          country: "US",
        },
        deliveryAddress: {
          line1: "3 Warehouse Way",
          city: "Chicago",
          region: "IL",
          postalCode: "60601",
          country: "US",
        },
        loadedOn: twoTrailers ? { type: "TRAILER", movementTrailerId: "smoke-trailer-1" } : null,
        commodities: [
          {
            commodityDescription: "Steel Coil",
            hsCode: "7208.10",
            quantity: 2,
            quantityUnit: "Coil",
            weightKg: 1000,
            weightUnit: "KG",
            packagingType: "Skid",
            marksAndNumbers: "LOT-1",
            countryOfOrigin: "CA",
            valueAmount: 5000,
            valueCurrency: "USD",
            hazmat: [],
          },
        ],
      },
    ],
  };
}

/** `<SCAC>SMOKE<yyyymmddHHmm>` — always contains SMOKE + today's date. */
function smokeTripNumber(scac: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  return `${scac}SMOKE${stamp}`;
}

/**
 * Rail #4: `GET /api/receive` pops the shared Service Provider queue and
 * BorderConnect keeps no copy — anything this script prints is gone for the
 * real inbox drain (`customs.borderconnect_drain`) and the WebSocket listener
 * forever. So the receive half is opt-in per run, and saying no is loud but
 * not fatal: the send half already exercised the outbound path.
 */
function receiveAllowed(): boolean {
  if (process.argv.includes("--drain-shared-queue")) return true;
  console.warn(
    "\n[smoke] SKIPPING GET /api/receive — it pops the shared BorderConnect queue " +
      "with no replay, so polling it would permanently destroy every tenant's " +
      "pending acks, decisions, RNS releases and notices.\n" +
      "[smoke] Pass --drain-shared-queue to poll anyway (only against an account " +
      "no tenant is filing through, or with the drain job and listener stopped).",
  );
  return false;
}

/**
 * A raw `GET /api/receive/{suffix}` call, deliberately bypassing
 * `createBorderConnectHttpTransport`'s `receive()` (which already
 * normalises) — this script's whole point is to see the envelope *before*
 * normalisation, so it can compare the two side by side.
 */
async function rawReceive(
  suffix: string,
  apiKey: string,
): Promise<{ httpStatus: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}/api/receive/${suffix}`, {
    method: "GET",
    headers: { "Api-Key": apiKey, Accept: "application/json" },
  });
  const text = await res.text();
  if (!text) return { httpStatus: res.status, body: null };
  try {
    return { httpStatus: res.status, body: JSON.parse(text) };
  } catch {
    return { httpStatus: res.status, body: { status: "NON_JSON_RESPONSE" } };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Writes one sanitized fixture candidate per call, named from the date and
 * the `parseInbound()` kind the sanitized message resolves to (a sequence
 * number breaks ties within one run). Never writes the original message —
 * only `sanitizeInboundForFixture()`'s output ever reaches disk here.
 */
function makeFixtureWriter(dir: string): (message: Record<string, unknown>) => void {
  let seq = 0;
  return (message) => {
    const sanitized = sanitizeInboundForFixture(message);
    const kind = parseInbound(sanitized).kind;
    seq += 1;
    const date = new Date().toISOString().slice(0, 10);
    const basename = `${date}-${kind}-${String(seq).padStart(3, "0")}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${basename}.json`), `${JSON.stringify(sanitized, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(`[smoke] wrote fixture candidate ${basename}.json — review before promoting`);
  };
}

async function main(): Promise<void> {
  refuseIfAutoSendOverrideIsSet();
  loadDotEnvLocal();
  refuseIfAutoSendOverrideIsSet(); // re-checked after loading .env.local, in case it's set there too

  const apiUrlSuffix = requireEnv("BORDERCONNECT_API_URL_SUFFIX");
  const apiKey = requireEnv("BORDERCONNECT_API_KEY");
  const companyKey = requireEnv("BORDERCONNECT_TEST_COMPANY_KEY");
  const regime = parseSmokeRegime(process.argv.slice(2));

  const cleanup = process.argv.includes("--cleanup");
  const receiveRequested = receiveAllowed();
  const recordFixturesArg = process.argv
    .find((arg) => arg.startsWith("--record-fixtures="))
    ?.slice("--record-fixtures=".length);
  if (recordFixturesArg && !receiveRequested) {
    console.warn(
      "[smoke] --record-fixtures has no effect without --drain-shared-queue — nothing is received to record.",
    );
  }
  const writeFixture =
    recordFixturesArg && receiveRequested
      ? makeFixtureWriter(resolve(process.cwd(), recordFixturesArg))
      : null;
  const outputArg = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9);
  const startedAt = new Date();
  const outputPath = outputArg
    ? resolve(process.cwd(), outputArg)
    : resolve(
        REPO_ROOT,
        "artifacts/borderconnect-smoke",
        `${startedAt.toISOString().replace(/[:.]/g, "-")}-${regime.toLowerCase()}.json`,
      );
  const records: RedactedSmokeRecord[] = [];
  const record = (entry: RedactedSmokeRecord) => {
    records.push(entry);
    console.log("[smoke]", JSON.stringify(entry));
  };
  const saveEvidence = () => {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(
      outputPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          regime,
          autoSend: false,
          receiveRequested,
          records,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    console.log(`[smoke] redacted evidence written to ${outputPath}`);
  };

  const twoTrailers = process.argv.includes("--two-trailers");
  const manifest = buildManifest(makeSource(regime, { twoTrailers }));
  const tripNumber = smokeTripNumber(manifest.carrier.scac ?? "SMOK");
  const sendId = `smoke-${Date.now()}`;

  // Rail #1: `autoSend` is a literal below — never a variable, never a
  // parameter with a default that could be overridden by a caller.
  const mapper = regime === "ACE" ? toAceTrip : toAciTrip;
  const body = mapper(manifest, {
    companyKey,
    sendId,
    operation: "CREATE",
    autoSend: false,
    tripNumberOverride: tripNumber,
  });

  record(
    redactedSmokeRecord({
      at: new Date(),
      direction: "send",
      regime,
      message: body,
    }),
  );
  console.log(`[smoke] POSTing ${regime}_TRIP (autoSend: false) …`);

  const transport = createBorderConnectHttpTransport({ apiUrlSuffix, apiKey });
  try {
    const sendResult = await transport.send(body);
    record(
      redactedSmokeRecord({
        at: new Date(),
        direction: "receive",
        regime,
        message: { ...sendResult, companyKey, sendId, tripNumber },
      }),
    );
  } catch (e) {
    if (e instanceof CustomsTransportError) {
      record(
        redactedSmokeRecord({
          at: new Date(),
          direction: "receive",
          regime,
          message: {
            status: "ERROR",
            errorCode: `HTTP_${e.statusCode}`,
            companyKey,
            sendId,
            tripNumber,
          },
          httpStatus: e.statusCode,
        }),
      );
      console.error(`[smoke] send() failed (status ${e.statusCode}, retryable ${e.retryable})`);
    } else {
      console.error("[smoke] send() failed with an unexpected error");
    }
    process.exitCode = 1;
    saveEvidence();
    return;
  }

  if (receiveRequested) {
    for (let i = 1; i <= 5; i++) {
      console.log(`\n[smoke] poll ${i}/5 — GET /api/receive/[redacted-suffix]`);
      let received: Awaited<ReturnType<typeof rawReceive>>;
      try {
        received = await rawReceive(apiUrlSuffix, apiKey);
      } catch {
        record(
          redactedSmokeRecord({
            at: new Date(),
            direction: "receive",
            regime,
            message: { status: "NETWORK_ERROR", companyKey, sendId, tripNumber },
          }),
        );
        console.error("[smoke] receive failed with a network error");
        process.exitCode = 1;
        break;
      }
      const shape = receiveShape(received.body);
      const normalized = normaliseReceiveBody(received.body);
      record(
        redactedSmokeRecord({
          at: new Date(),
          direction: "receive",
          regime,
          message:
            received.body && typeof received.body === "object" && !Array.isArray(received.body)
              ? (received.body as Record<string, unknown>)
              : { status: normalized.length === 0 ? "EMPTY" : "MESSAGES" },
          shape,
          httpStatus: received.httpStatus,
        }),
      );
      for (const message of normalized) {
        record(
          redactedSmokeRecord({
            at: new Date(),
            direction: "receive",
            regime,
            message,
          }),
        );
        writeFixture?.(message);
      }
      if (i < 5) await sleep(5000);
    }
  }

  if (cleanup) {
    console.log(`\n[smoke] --cleanup: sending ${regime}_TRIP DELETE …`);
    const cleanupBody = {
      data: `${regime}_TRIP`,
      operation: "DELETE",
      autoSend: false,
      tripNumber,
      companyKey,
      sendId: `smoke-cleanup-${Date.now()}`,
    };
    record(
      redactedSmokeRecord({
        at: new Date(),
        direction: "cleanup",
        regime,
        message: cleanupBody,
      }),
    );
    try {
      const deleteResult = await transport.send(cleanupBody);
      record(
        redactedSmokeRecord({
          at: new Date(),
          direction: "receive",
          regime,
          message: { ...deleteResult, companyKey, tripNumber, sendId: cleanupBody.sendId },
        }),
      );
    } catch (e) {
      if (e instanceof CustomsTransportError) {
        console.error(`[smoke] DELETE failed (status ${e.statusCode})`);
      } else {
        console.error("[smoke] DELETE failed with an unexpected error");
      }
      process.exitCode = 1;
    }
  }
  saveEvidence();
}

main().catch((e) => {
  console.error(`[smoke] fatal (${e instanceof Error ? e.name : "unknown error"})`);
  process.exitCode = 1;
});
