import { NextResponse, type NextRequest } from "next/server";
import { ACTIVE_ORG_COOKIE } from "@corridor/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  const res = NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  res.cookies.delete(ACTIVE_ORG_COOKIE);
  return res;
}
