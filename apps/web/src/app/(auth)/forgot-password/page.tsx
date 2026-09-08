import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Forgot your password?</h1>
        <p className="mt-1 text-sm text-ink-500">
          Enter your work e-mail and we will send a link to choose a new one.
        </p>
      </div>
      <ForgotPasswordForm />
      <p className="text-sm text-ink-500">
        <Link href="/login" className="font-medium text-ink-950 underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
