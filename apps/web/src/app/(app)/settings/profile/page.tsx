import type { Metadata } from "next";
import { api } from "@/lib/trpc/server";
import { ResetPasswordForm } from "@/app/(auth)/reset-password/reset-password-form";
import { ProfilePanel } from "./profile-panel";

export const metadata: Metadata = { title: "My profile" };

export default async function ProfilePage() {
  const caller = await api();
  const profile = await caller.organization.profile();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">My profile</h1>
        <p className="text-sm text-fg-secondary">
          Your name as colleagues see it, and the phone that receives your notifications.
        </p>
      </header>
      <ProfilePanel
        initial={{
          displayName: profile.displayName ?? "",
          phone: profile.phone ?? "",
          email: profile.email ?? "",
        }}
      />
      <section className="panel max-w-md space-y-3 p-5" aria-label="Change password">
        <h2 className="font-medium">Change password</h2>
        <ResetPasswordForm stay />
      </section>
    </div>
  );
}
