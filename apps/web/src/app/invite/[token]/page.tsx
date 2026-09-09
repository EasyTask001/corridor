import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Route } from "lucide-react";
import { getSession } from "@/lib/session";
import { AcceptInvite } from "./accept-invite";

export const metadata: Metadata = { title: "Accept invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await getSession();
  if (!session) redirect(`/signup?next=${encodeURIComponent(`/invite/${token}`)}`);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-4 sm:p-6">
      <div className="mb-6 flex items-center justify-center gap-2 text-sm font-semibold text-fg-primary">
        <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg shadow-sm">
          <Route className="size-4" aria-hidden />
        </span>
        Corridor
      </div>
      <div className="panel p-6 text-center sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight">You&apos;ve been invited</h1>
        <p className="mt-2 text-sm text-fg-secondary">
          Signed in as <span className="font-medium text-fg-primary">{session.user.email}</span>.
          Accept to join the carrier&apos;s workspace.
        </p>
        <div className="mt-6">
          <AcceptInvite token={token} />
        </div>
      </div>
    </main>
  );
}
