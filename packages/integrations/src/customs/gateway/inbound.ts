/**
 * Inbound webhook: HMAC-SHA256 over the raw body with the shared secret,
 * hex-encoded in `X-Corridor-Signature` (also accepted as `X-Signature`).
 * Compared in constant time; a missing secret rejects everything.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundCustomsMessage } from "../types";
import { fromGatewayStatus } from "./mapping";

export function signInbound(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function verifyInboundSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !signature) return false;
  const expected = Buffer.from(signInbound(rawBody, secret), "hex");
  const given = Buffer.from(signature.trim().replace(/^sha256=/i, ""), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Null when the signature fails or the body is not a status document. */
export function parseInboundMessage(
  rawBody: string,
  headers: { get(name: string): string | null },
  secret: string | undefined,
): InboundCustomsMessage | null {
  const signature = headers.get("x-corridor-signature") ?? headers.get("x-signature");
  if (!verifyInboundSignature(rawBody, signature, secret)) return null;
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const status = fromGatewayStatus(json);
  if (!status.referenceNumber) return null;
  const eventId =
    json && typeof json === "object" && typeof (json as { eventId?: unknown }).eventId === "string"
      ? (json as { eventId: string }).eventId
      : null;
  return { ...status, eventId: eventId ?? `${status.referenceNumber}:${status.status}` };
}
