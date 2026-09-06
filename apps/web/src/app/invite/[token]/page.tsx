import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { AcceptInvite } from "./accept-invite";

export const metadata: Metadata = { title: "Accept invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await getSession();
  if (!session) redirect(`/signup?next=${encodeURIComponent(`/invite/${token}`)}`);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <div className="panel p-8 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">You&apos;ve been invited</h1>
        <p className="mt-2 text-sm text-ink-500">
          Signed in as <span className="font-medium text-ink-950">{session.user.email}</span>.
          Accept to join the carrier&apos;s workspace.
        </p>
        <div className="mt-6">
          <AcceptInvite token={token} />
        </div>
      </div>
    </main>
  );
}
