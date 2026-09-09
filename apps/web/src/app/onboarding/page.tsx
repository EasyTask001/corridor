import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Route } from "lucide-react";
import { getSession } from "@/lib/session";
import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = { title: "Set up your carrier" };

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/onboarding");
  if (session.activeOrganizationId) redirect("/dashboard");

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center p-4 sm:p-6">
      <div className="mb-6 flex items-center gap-2 text-sm font-semibold text-fg-primary">
        <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg shadow-sm">
          <Route className="size-4" aria-hidden />
        </span>
        Corridor
      </div>
      <div className="panel p-6 sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Set up your carrier</h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-secondary">
          You&apos;ll be the Owner. Carrier codes can be added later in Settings.
        </p>
        <div className="mt-6">
          <OnboardingForm />
        </div>
      </div>
    </main>
  );
}
