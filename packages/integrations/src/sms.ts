/**
 * SMS delivery via Twilio, with a mock mode identical in spirit to email.ts:
 * when any of TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER is
 * missing, sends are logged (not dispatched), so driver notifications are
 * fully exercised in dev/CI without a Twilio account.
 */

export type SmsMode = "twilio" | "mock";

export interface SmsEnv {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
}

export function readSmsEnv(env: NodeJS.ProcessEnv = process.env): SmsEnv {
  return {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    fromNumber: env.TWILIO_FROM_NUMBER,
  };
}

/** Never throws: an incomplete configuration is the mock, not an error. */
export function smsMode(env: SmsEnv = readSmsEnv()): SmsMode {
  return env.accountSid && env.authToken && env.fromNumber ? "twilio" : "mock";
}

export interface SendSmsInput {
  to: string;
  body: string;
}

export interface SendSmsResult {
  mode: SmsMode;
  /** Twilio message SID, null in mock mode or on failure. */
  id: string | null;
  error?: string;
}

/** E.164-ish: digits with an optional leading +, 8–15 digits. */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  const body = digits.startsWith("+") ? digits.slice(1) : digits;
  if (!/^\d{8,15}$/.test(body)) return null;
  // North American numbers without a country code get +1.
  return `+${body.length === 10 ? `1${body}` : body}`;
}

export async function sendSms(
  input: SendSmsInput,
  env: SmsEnv = readSmsEnv(),
  fetchImpl: typeof fetch = fetch,
): Promise<SendSmsResult> {
  const to = normalisePhone(input.to);
  if (!to) return { mode: smsMode(env), id: null, error: `invalid phone number: ${input.to}` };
  if (smsMode(env) === "mock") {
    console.log(`[sms:mock] to=${to} body="${input.body.slice(0, 80)}"`);
    return { mode: "mock", id: null };
  }
  try {
    const params = new URLSearchParams({ To: to, From: env.fromNumber!, Body: input.body });
    const res = await fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.accountSid!)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${env.accountSid}:${env.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      },
    );
    const body = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) return { mode: "twilio", id: null, error: body.message ?? `HTTP ${res.status}` };
    return { mode: "twilio", id: body.sid ?? null };
  } catch (e) {
    return { mode: "twilio", id: null, error: e instanceof Error ? e.message : String(e) };
  }
}
