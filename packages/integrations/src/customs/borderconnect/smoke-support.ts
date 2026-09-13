import { createHash } from "node:crypto";
import type { Regime } from "@corridor/domain";
import { inboundKeys } from "./inbound";

export type ReceiveShape =
  "empty" | "array" | "messages_envelope" | "single_message" | "unknown_object" | "unknown_scalar";

export function parseSmokeRegime(args: string[]): Regime {
  const equals = args.find((arg) => arg.startsWith("--regime="))?.slice("--regime=".length);
  const index = args.indexOf("--regime");
  const value = (equals ?? (index >= 0 ? args[index + 1] : undefined) ?? "ACE").toUpperCase();
  if (value !== "ACE" && value !== "ACI") {
    throw new Error("--regime must be ACE or ACI");
  }
  return value;
}

export function receiveShape(body: unknown): ReceiveShape {
  if (body === null || body === undefined || body === "") return "empty";
  if (Array.isArray(body)) return "array";
  if (typeof body !== "object") return "unknown_scalar";
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.messages)) return "messages_envelope";
  if ("data" in record) return "single_message";
  return "unknown_object";
}

function fingerprint(value: string | null): string | undefined {
  return value
    ? `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`
    : undefined;
}

function stringField(message: Record<string, unknown>, key: string): string | undefined {
  return typeof message[key] === "string" ? String(message[key]) : undefined;
}

export function redactedSmokeRecord(input: {
  at: Date;
  direction: "send" | "receive" | "cleanup";
  regime: Regime;
  message: Record<string, unknown>;
  shape?: ReceiveShape;
  httpStatus?: number;
}) {
  const keys = inboundKeys(input.message);
  const envelope = {
    data: stringField(input.message, "data"),
    status: stringField(input.message, "status"),
    errorCode: stringField(input.message, "errorCode"),
    operation: stringField(input.message, "operation"),
    type: stringField(input.message, "type"),
    autoSend: typeof input.message.autoSend === "boolean" ? input.message.autoSend : undefined,
    bundleTripAndShipments:
      typeof input.message.bundleTripAndShipments === "boolean"
        ? input.message.bundleTripAndShipments
        : undefined,
  };
  return {
    at: input.at.toISOString(),
    direction: input.direction,
    regime: input.regime,
    ...(input.shape ? { receiveShape: input.shape } : {}),
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    envelope,
    routing: {
      companyKey: fingerprint(keys.companyKey),
      sendId: fingerprint(keys.sendId),
      tripNumber: fingerprint(keys.tripNumber),
      cargoControlNumber: fingerprint(keys.cargoControlNumber),
      shipmentControlNumber: fingerprint(keys.shipmentControlNumber),
    },
  };
}

export type RedactedSmokeRecord = ReturnType<typeof redactedSmokeRecord>;
