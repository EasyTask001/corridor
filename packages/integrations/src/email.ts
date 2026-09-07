/**
 * Email delivery via Resend, with a mock mode identical in spirit to the
 * Stripe wrapper: when RESEND_API_KEY or RESEND_FROM_EMAIL is missing, sends
 * are logged (not dispatched) so notification fan-out is fully exercised in
 * dev/CI without hitting a real inbox or requiring a verified domain.
 */

export type EmailMode = "resend" | "mock";

export interface EmailEnv {
  apiKey?: string;
  fromEmail?: string;
}

export function readEmailEnv(env: NodeJS.ProcessEnv = process.env): EmailEnv {
  return { apiKey: env.RESEND_API_KEY, fromEmail: env.RESEND_FROM_EMAIL };
}

export function emailMode(env: EmailEnv = readEmailEnv()): EmailMode {
  return env.apiKey && env.fromEmail ? "resend" : "mock";
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendEmailResult {
  mode: EmailMode;
  id: string | null;
  error?: string;
}

export async function sendEmail(
  input: SendEmailInput,
  env: EmailEnv = readEmailEnv(),
): Promise<SendEmailResult> {
  if (emailMode(env) === "mock") {
    console.log(`[email:mock] to=${input.to} subject="${input.subject}"`);
    return { mode: "mock", id: null };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.fromEmail,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html ?? `<p>${input.text.replace(/\n/g, "<br/>")}</p>`,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) return { mode: "resend", id: null, error: body.message ?? `HTTP ${res.status}` };
    return { mode: "resend", id: body.id ?? null };
  } catch (e) {
    return { mode: "resend", id: null, error: e instanceof Error ? e.message : String(e) };
  }
}
