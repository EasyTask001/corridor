import { env } from "@/lib/env";
import { legal } from "@/lib/legal";

export const dynamic = "force-dynamic";

export function GET() {
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 1);
  const body = [
    `Contact: mailto:${legal.securityEmail}`,
    `Policy: ${env.appUrl}/legal/security`,
    `Expires: ${expires.toISOString()}`,
  ].join("\n");
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
