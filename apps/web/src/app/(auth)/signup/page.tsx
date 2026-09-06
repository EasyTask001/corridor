import type { Metadata } from "next";
import Link from "next/link";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Create account" };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="mt-1 text-sm text-ink-500">You&apos;ll set up your carrier next.</p>
      </div>
      <SignupForm next={next ?? "/onboarding"} />
      <p className="text-sm text-ink-500">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-ink-950 underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
