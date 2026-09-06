import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = { title: "Set up your carrier" };

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/onboarding");
  if (session.activeOrganizationId) redirect("/dashboard");

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center p-6">
      <div className="panel p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Set up your carrier</h1>
        <p className="mt-1 text-sm text-ink-500">
          You&apos;ll be the Owner. Carrier codes can be added later in Settings.
        </p>
        <div className="mt-6">
          <OnboardingForm />
        </div>
      </div>
    </main>
  );
}
