import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-fg-secondary">Dispatcher and admin access.</p>
      </div>
      {error === "auth_callback" && (
        <p className="rounded-md bg-danger-500/10 p-3 text-sm text-status-danger">
          That sign-in link is invalid or expired.
        </p>
      )}
      <LoginForm next={next ?? "/"} />
      <p className="text-sm text-fg-secondary">
        New carrier?{" "}
        <Link href="/signup" className="font-medium text-fg-primary underline">
          Create an account
        </Link>
      </p>
      <p className="text-sm text-fg-secondary">
        Driver or broker?{" "}
        <Link href="/track" className="font-medium text-fg-primary underline">
          Check PAPS/PARS status
        </Link>
      </p>
    </div>
  );
}
