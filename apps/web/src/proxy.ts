import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authCookieOptions, persistSessionFrom } from "@corridor/auth";
import { appCookieOptions } from "@/lib/cookies";
import { buildCspHeader, cspHeaderName, generateNonce } from "@/lib/csp";

const PUBLIC_PATHS = [
  "/login",
  "/signup",
  "/auth/callback",
  "/api/health",
  // Public PAPS/PARS lookup (0027): gated by carrier code + control number, rate limited.
  "/track",
  // Password recovery (Task 13): the reset page needs the recovery session from the e-mail link.
  "/forgot-password",
  "/reset-password",
];

function isPublic(pathname: string) {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function withCsp(response: NextResponse, headerName: string, csp: string): NextResponse {
  response.headers.set(headerName, csp);
  return response;
}

/**
 * Refreshes the Supabase session cookie on every request (so Server Components
 * never see a stale token) and gates non-public routes. Cookies are httpOnly +
 * secure + sameSite=lax — the direct fix for the legacy JWT-in-hidden-input bug.
 *
 * Also generates a per-request CSP nonce. Setting it on the request's own
 * `Content-Security-Policy` header (not just the response) is what lets Next.js
 * extract it during rendering and attach it to its own framework/page scripts;
 * `x-nonce` is our own channel for the inline theme-init script in layout.tsx.
 * Nonces only work with dynamic rendering — see the Next.js CSP guide.
 */
export async function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const csp = buildCspHeader(nonce);
  const headerName = cspHeaderName();
  request.headers.set("x-nonce", nonce);
  request.headers.set(headerName, csp);

  let response = NextResponse.next({ request });
  const persist = persistSessionFrom(request.cookies);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, {
              ...authCookieOptions(options, persist),
              ...appCookieOptions(),
            });
          }
        },
      },
    },
  );

  // IMPORTANT: getUser() (not getSession()) — validates the JWT with Supabase Auth.
  // /api/* routes are never redirected: tRPC returns UNAUTHORIZED and cron
  // routes check CRON_SECRET themselves.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !isPublic(pathname) && !pathname.startsWith("/api/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return withCsp(NextResponse.redirect(url), headerName, csp);
  }

  if (user && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return withCsp(NextResponse.redirect(url), headerName, csp);
  }

  return withCsp(response, headerName, csp);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
