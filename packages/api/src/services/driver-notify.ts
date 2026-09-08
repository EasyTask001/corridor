/**
 * `driver.notify` (0025): when customs accepts a manifest, and again when every
 * shipment on it has an entry number, render the driver sheet and send it —
 * e-mail (Resend, mock without a key) to the dispatch list and to the person
 * in charge, SMS (Twilio, mock without credentials) of the entry numbers to
 * the driver's regime phone — then note the delivery on the movement's
 * timeline. Runs under the worker's service role.
 */
import { eq, schema, type RlsTransaction } from "@corridor/db";
import { sendEmail, sendSms, type SendEmailResult, type SendSmsResult } from "@corridor/integrations";
import { logIntegrationEvent } from "./customs";
import { addEvent, loadFull, loadOrganization } from "./movements";
import { generateForMovement } from "./pdf";

const { drivers } = schema;

export type DriverNotifyTrigger = "accepted" | "entries_complete";

export interface DriverNotifySenders {
  email: typeof sendEmail;
  sms: typeof sendSms;
}

const defaultSenders: DriverNotifySenders = { email: sendEmail, sms: sendSms };

/** Every shipment on the movement carries an entry number. */
export const entriesComplete = (shipments: Array<{ entryNumber: string | null }>) =>
  shipments.length > 0 && shipments.every((s) => !!s.entryNumber);

export async function runDriverNotify(
  tx: RlsTransaction,
  orgId: string,
  input: { movementId: string; trigger: DriverNotifyTrigger },
  senders: DriverNotifySenders = defaultSenders,
) {
  const full = await loadFull(tx, orgId, input.movementId);
  const org = await loadOrganization(tx, orgId);
  const actor = { orgId, userId: null };
  const agency = full.regime === "ACE" ? "CBP" : "CBSA";

  const sheet = await generateForMovement(tx, actor, { movementId: full.id, kind: "driver_sheet" });
  const label = full.tripNumber ?? full.movementNumber;

  // Who hears about it: the dispatch list, and the person in charge when their
  // record asks for the sheet by e-mail / entries by SMS.
  const pic = full.crew.find((c) => c.role === "person_in_charge");
  const picDriver = pic
    ? (await tx.select().from(drivers).where(eq(drivers.id, pic.driverId)).limit(1))[0]
    : undefined;

  const recipients = new Set<string>(org.dispatchEmails.map((e) => e.toLowerCase()));
  if (picDriver?.emailDriverSheet && picDriver.email) recipients.add(picDriver.email.toLowerCase());

  const subject =
    input.trigger === "accepted"
      ? `${label}: manifest accepted by ${agency} — driver sheet attached`
      : `${label}: entry numbers on file — driver sheet attached`;
  const entryLines = full.shipments
    .filter((s) => s.entryNumber)
    .map((s) => `${s.controlNumber}: entry ${s.entryNumber}${s.entryPortCode ? ` @ ${s.entryPortCode}` : ""}`);
  const text = [
    `${full.movementNumber}${full.tripNumber ? ` (trip ${full.tripNumber})` : ""} — ${full.port?.code ?? ""} ${full.port?.name ?? ""}`.trim(),
    ...(entryLines.length ? ["", "Entries:", ...entryLines] : []),
    "",
    `Driver sheet (link valid for one minute): ${sheet.signedUrl}`,
  ].join("\n");

  const emailed: Array<{ to: string; result: SendEmailResult }> = [];
  for (const to of recipients) {
    const started = Date.now();
    const result = await senders.email({ to, subject, text });
    emailed.push({ to, result });
    await logIntegrationEvent(tx, {
      orgId,
      movementId: full.id,
      provider: "email",
      direction: "outbound",
      operation: `driver_notify:${input.trigger}`,
      request: { to, subject, documentId: sheet.id },
      response: { id: result.id, mode: result.mode },
      success: !result.error,
      error: result.error,
      durationMs: Date.now() - started,
    });
  }

  let sms: { to: string; result: SendSmsResult } | null = null;
  const phone = picDriver?.smsOptIn
    ? full.regime === "ACE"
      ? (picDriver.smsPhoneAce ?? picDriver.phone)
      : (picDriver.smsPhoneAci ?? picDriver.phone)
    : null;
  if (phone && entryLines.length > 0) {
    const started = Date.now();
    const body = `${label}: ${entryLines.join("; ")}`.slice(0, 640);
    const result = await senders.sms({ to: phone, body });
    sms = { to: phone, result };
    await logIntegrationEvent(tx, {
      orgId,
      movementId: full.id,
      provider: "sms",
      direction: "outbound",
      operation: `driver_notify:${input.trigger}`,
      request: { to: phone, length: body.length },
      response: { id: result.id, mode: result.mode },
      success: !result.error,
      error: result.error,
      durationMs: Date.now() - started,
    });
  }

  const delivered = emailed.filter((e) => !e.result.error).map((e) => e.to);
  const failed = emailed.filter((e) => e.result.error).map((e) => `${e.to} (${e.result.error})`);
  await addEvent(tx, actor, full.id, {
    eventType: "note",
    actorType: "system",
    payload: {
      body: [
        `Driver sheet ${input.trigger === "accepted" ? "sent on acceptance" : "sent with entry numbers"}`,
        delivered.length ? `e-mailed to ${delivered.join(", ")}` : "no e-mail recipients",
        failed.length ? `e-mail failed for ${failed.join(", ")}` : null,
        sms ? (sms.result.error ? `SMS to ${sms.to} failed (${sms.result.error})` : `SMS to ${sms.to} (${sms.result.mode})`) : null,
      ]
        .filter(Boolean)
        .join(" · "),
      documentId: sheet.id,
      trigger: input.trigger,
    },
  });

  return {
    documentId: sheet.id,
    emailed: delivered.length,
    emailFailed: failed.length,
    sms: sms ? { to: sms.to, ok: !sms.result.error, mode: sms.result.mode } : null,
  };
}
