import { redirect } from "next/navigation";
import { api } from "@/lib/trpc/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Print" opens this in a new tab: the session is checked through the tRPC
 * caller (RLS decides whether the document is readable), then the browser is
 * sent to a 60 s signed Storage URL. Nothing is proxied through the app.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let signedUrl: string;
  try {
    const caller = await api();
    signedUrl = (await caller.pdf.download({ id })).signedUrl;
  } catch {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  redirect(signedUrl);
}
