"use client";

import { useActionState, useRef, useState } from "react";
import Link from "next/link";
import { emailDomain } from "@corridor/domain";
import { Alert, Button, Input, Label } from "@corridor/ui";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { signIn } from "../actions";

/** What `GET /api/auth/sso` tells us about the typed address. */
type SsoHint = { domain: string; sso: boolean; enforced: boolean };

/**
 * Password sign-in, plus the SSO branch.
 *
 * The lookup happens on blur, not on every keystroke: it is a public,
 * IP-rate-limited endpoint, and the answer only matters once the address is
 * finished. Until it answers, the form is exactly the password form it has
 * always been — a failed or slow lookup can never lock anyone out.
 *
 * `signInWithSSO` runs in the browser with the anon key, which is the
 * documented flow: Supabase Auth resolves the domain to a provider and returns
 * the IdP URL to send the person to. No secret is involved, and Corridor never
 * sees the SAML assertion — the IdP posts it to Auth, which then bounces back
 * through `/auth/callback`.
 */
export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signIn, null);
  const [hint, setHint] = useState<SsoHint | null>(null);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  // Ignore an answer that arrives after the address has changed again.
  const lookupSeq = useRef(0);

  async function lookup(value: string) {
    const domain = emailDomain(value);
    setSsoError(null);
    if (!domain) {
      setHint(null);
      return;
    }
    if (hint?.domain === domain) return;
    const seq = ++lookupSeq.current;
    try {
      const response = await fetch(`/api/auth/sso?email=${encodeURIComponent(value.trim())}`);
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { sso?: boolean; enforced?: boolean };
      if (seq !== lookupSeq.current) return;
      setHint({ domain, sso: body.sso === true, enforced: body.enforced === true });
    } catch {
      // The lookup is down or rate-limited, so we know nothing about this
      // domain: offer BOTH ways in rather than guessing. Hiding the SSO button
      // would strand an SSO-only tenant; hiding the password field would
      // strand everyone else. The server action still refuses a password on an
      // enforced domain, so the extra option cannot become a way around it.
      if (seq === lookupSeq.current) setHint({ domain, sso: true, enforced: false });
    }
  }

  async function continueWithSso() {
    if (!hint?.sso) return;
    setSsoError(null);
    setRedirecting(true);
    const supabase = createSupabaseBrowserClient();
    const { data, error } = await supabase.auth.signInWithSSO({
      domain: hint.domain,
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (error || !data?.url) {
      setRedirecting(false);
      setSsoError(error?.message ?? "Could not start single sign-on. Try again.");
      return;
    }
    window.location.href = data.url;
  }

  const passwordHidden = hint?.sso === true && hint.enforced;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          onBlur={(event) => void lookup(event.target.value)}
        />
      </div>

      {passwordHidden ? (
        <Alert variant="info" data-testid="sso-enforced">
          Your organization signs in with single sign-on. Password sign-in is turned off for{" "}
          <span className="font-medium">{hint.domain}</span>.
        </Alert>
      ) : (
        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
      )}

      {!passwordHidden && (
        <div className="flex items-center justify-between text-sm">
          <label className="flex items-center gap-2" htmlFor="remember">
            <input id="remember" name="remember" type="checkbox" defaultChecked />
            Stay signed in
          </label>
          <Link
            href="/forgot-password"
            className="text-fg-secondary underline-offset-2 hover:underline"
          >
            Forgot password?
          </Link>
        </div>
      )}

      {state?.error && (
        <p role="alert" className="text-sm text-status-danger">
          {state.error}
        </p>
      )}
      {ssoError && <p className="text-sm text-status-danger">{ssoError}</p>}

      {hint?.sso && (
        <Button
          type="button"
          variant={passwordHidden ? "primary" : "secondary"}
          className="w-full"
          disabled={redirecting}
          onClick={() => void continueWithSso()}
        >
          {redirecting ? "Redirecting…" : "Continue with SSO"}
        </Button>
      )}

      {!passwordHidden && (
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      )}
    </form>
  );
}
