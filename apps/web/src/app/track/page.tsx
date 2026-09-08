import type { Metadata } from "next";
import Link from "next/link";
import { TRPCReactProvider } from "@/lib/trpc/client";
import { TrackForm } from "./track-form";

export const metadata: Metadata = { title: "Track a PAPS / PARS" };

/**
 * Public, outside the app shell: a driver or broker who knows the carrier code
 * and the control number gets the filing's status and nothing else.
 */
export default function TrackPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 p-6">
      <div>
        <Link href="/login" className="text-sm text-ink-500 hover:underline">
          ← Corridor
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Check a PAPS / PARS</h1>
        <p className="mt-1 text-sm text-ink-500">
          Enter the carrier code and the control number printed on the shipment paperwork.
        </p>
      </div>
      {/* Outside the app shell, so the page mounts its own tRPC provider. */}
      <TRPCReactProvider>
        <TrackForm />
      </TRPCReactProvider>
      <p className="text-xs text-ink-500">
        Ten lookups a minute. This page shows the customs status, port, entry number and times
        only.
      </p>
    </main>
  );
}
