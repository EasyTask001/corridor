#!/usr/bin/env tsx
/**
 * LIVE smoke test against the real BorderConnect Service Provider account
 * (`.env.local`, EasyTask AI Corp). This is the only place in the repo that
 * makes a network call to BorderConnect's production API with real
 * credentials — everything else (client.test.ts, ace.test.ts, transport.
 * test.ts, ...) runs against a fixture or an injected fake transport.
 *
 * Why this exists: `GET /api/receive` (`normaliseReceiveBody`, `transport.
 * ts`) has defended against four documented envelope shapes since Task 4
 * without ever seeing a real response. This script settles that by filing
 * one throwaway `ACE_TRIP` with `autoSend: false` (BorderConnect holds it in
 * its own system; it never reaches CBP) and printing exactly what `GET
 * /api/receive` sends back.
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
 *
 * Usage:
 *   source .env.local && pnpm --filter @corridor/integrations smoke:borderconnect
 *   source .env.local && pnpm --filter @corridor/integrations smoke:borderconnect -- --cleanup
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, type ManifestSource } from "../src/customs/manifest";
import { toAceTrip } from "../src/customs/borderconnect/ace";
import {
  createBorderConnectHttpTransport,
  normaliseReceiveBody,
} from "../src/customs/borderconnect/transport";
import { CustomsTransportError } from "../src/customs/types";

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
 */
function makeSource(): ManifestSource {
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
      regime: "ACE",
      movementNumber: "SMOKE-00001",
      tripNumber: null,
      carrierCode: "PFTR",
      port: { code: "3801" },
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
    trailers: [],
    shipments: [
      {
        controlNumber: "PFTRSMOKE0001",
        shipmentType: "regular_bill",
        cargoType: null,
        entryNumber: "ENT-1",
        entryPortCode: "3801",
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
 * A raw `GET /api/receive/{suffix}` call, deliberately bypassing
 * `createBorderConnectHttpTransport`'s `receive()` (which already
 * normalises) — this script's whole point is to see the envelope *before*
 * normalisation, so it can compare the two side by side.
 */
async function rawReceive(suffix: string, apiKey: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/api/receive/${suffix}`, {
    method: "GET",
    headers: { "Api-Key": apiKey, Accept: "application/json" },
  });
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, httpStatus: res.status };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  refuseIfAutoSendOverrideIsSet();
  loadDotEnvLocal();
  refuseIfAutoSendOverrideIsSet(); // re-checked after loading .env.local, in case it's set there too

  const apiUrlSuffix = requireEnv("BORDERCONNECT_API_URL_SUFFIX");
  const apiKey = requireEnv("BORDERCONNECT_API_KEY");
  const companyKey = requireEnv("BORDERCONNECT_TEST_COMPANY_KEY");

  const cleanup = process.argv.includes("--cleanup");

  const manifest = buildManifest(makeSource());
  const tripNumber = smokeTripNumber(manifest.carrier.scac ?? "SMOK");
  const sendId = `smoke-${Date.now()}`;

  // Rail #1: `autoSend` is a literal below — never a variable, never a
  // parameter with a default that could be overridden by a caller.
  const body = toAceTrip(manifest, {
    companyKey,
    sendId,
    operation: "CREATE",
    autoSend: false,
    tripNumberOverride: tripNumber,
  });

  console.log(`[smoke] tripNumber=${tripNumber} sendId=${sendId} companyKey=${companyKey}`);
  console.log("[smoke] POSTing ACE_TRIP (autoSend: false) …");

  const transport = createBorderConnectHttpTransport({ apiUrlSuffix, apiKey });
  try {
    const sendResult = await transport.send(body);
    console.log("[smoke] send() result:", JSON.stringify(sendResult, null, 2));
  } catch (e) {
    if (e instanceof CustomsTransportError) {
      console.error(
        `[smoke] send() failed: ${e.message} (status ${e.statusCode}, retryable ${e.retryable})`,
      );
    } else {
      console.error("[smoke] send() failed with an unexpected error:", e);
    }
    process.exitCode = 1;
    return;
  }

  for (let i = 1; i <= 5; i++) {
    console.log(`\n[smoke] poll ${i}/5 — GET /api/receive/${apiUrlSuffix}`);
    const rawBody = await rawReceive(apiUrlSuffix, apiKey);
    console.log("[smoke] raw body:", JSON.stringify(rawBody, null, 2));
    console.log("[smoke] normaliseReceiveBody(body):", JSON.stringify(normaliseReceiveBody(rawBody), null, 2));
    if (i < 5) await sleep(5000);
  }

  if (cleanup) {
    console.log("\n[smoke] --cleanup: sending ACE_TRIP DELETE …");
    try {
      const deleteResult = await transport.send({
        data: "ACE_TRIP",
        operation: "DELETE",
        autoSend: false,
        tripNumber,
        companyKey,
      });
      console.log("[smoke] DELETE result:", JSON.stringify(deleteResult, null, 2));
    } catch (e) {
      if (e instanceof CustomsTransportError) {
        console.error(`[smoke] DELETE failed: ${e.message} (status ${e.statusCode})`);
      } else {
        console.error("[smoke] DELETE failed with an unexpected error:", e);
      }
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error("[smoke] fatal:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
