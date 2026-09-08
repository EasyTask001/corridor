"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { PERSIST_SESSION_COOKIE, PERSIST_SESSION_MAX_AGE } from "@corridor/auth";
import { email as emailSchema } from "@corridor/domain";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { passwordSignInBlockedFor } from "@/lib/sso";
import { env } from "@/lib/env";

export type AuthState = { error?: string; message?: string } | null;

const credentials = z.object({
  email: emailSchema,
  password: z.string().min(8, "Password must be at least 8 characters"),
});

function safeNext(v: FormDataEntryValue | null): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  // Enforcement lives here, not in the form: an organization that requires SSO
  // must not be reachable with a password by anyone who scripts the POST or
  // whose login page kept the field because the hint lookup failed.
  const blocked = await passwordSignInBlockedFor(parsed.data.email);
  if (blocked) return { error: blocked };

  // "Stay signed in" decides whether the auth cookies outlive the browser.
  const persist = formData.get("remember") === "on";
  const cookieStore = await cookies();
  if (persist) {
    cookieStore.set(PERSIST_SESSION_COOKIE, "1", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: PERSIST_SESSION_MAX_AGE,
      path: "/",
    });
  } else {
    cookieStore.delete(PERSIST_SESSION_COOKIE);
  }
  const supabase = await createSupabaseServerClient({ persist });
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: "Invalid email or password" };

  redirect(safeNext(formData.get("next")));
}

/** Send the password-recovery e-mail; the link lands on /reset-password. */
export async function forgotPassword(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = emailSchema.safeParse(formData.get("email"));
  if (!parsed.success) return { error: "Enter your work e-mail address" };
  const supabase = await createSupabaseServerClient();
  await supabase.auth.resetPasswordForEmail(parsed.data, {
    redirectTo: `${env.appUrl}/auth/callback?next=${encodeURIComponent("/reset-password")}`,
  });
  // Same answer whether or not the address exists: no account enumeration.
  return { message: "If that address has an account, a reset link is on its way." };
}

const newPassword = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: "The passwords do not match", path: ["confirm"] });

/** Set a new password on the session the recovery link created, or on the signed-in user. */
export async function resetPassword(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = newPassword.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "That reset link is invalid or expired. Request a new one." };
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { error: error.message };
  if (formData.get("stay") === "on") return { message: "Password changed." };
  redirect("/dashboard");
}

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentials
    .extend({ displayName: z.string().trim().min(1, "Name is required").max(80) })
    .safeParse({
      email: formData.get("email"),
      password: formData.get("password"),
      displayName: formData.get("displayName"),
    });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  // Same gate on the way in: a domain that requires SSO gets its accounts from
  // the IdP, not from a password sign-up form.
  const blocked = await passwordSignInBlockedFor(parsed.data.email);
  if (blocked) return { error: blocked };

  const supabase = await createSupabaseServerClient();
  const next = safeNext(formData.get("next"));
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { display_name: parsed.data.displayName },
      emailRedirectTo: `${env.appUrl}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });
  if (error) return { error: error.message };

  // Local dev has email confirmation off → session exists immediately.
  if (data.session) redirect(next);
  return { message: "Check your email to confirm your account." };
}
