import type { Metadata } from "next";
import Link from "next/link";
import { Route } from "lucide-react";
import { TRPCReactProvider } from "@/lib/trpc/client";
import { TrackForm } from "./track-form";

export const metadata: Metadata = { title: "Track a PAPS / PARS" };

/**
 * Public, outside the app shell: a driver or broker who knows the carrier code
 * and the control number gets the filing's status and nothing else.
 */
export default function TrackPage() {
  return (
    <main className="relative mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-6 overflow-hidden p-4 sm:p-6">
      <div>
        <Link
          href="/login"
          className="mb-8 inline-flex items-center gap-2 text-sm font-semibold text-fg-primary"
        >
          <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg shadow-sm">
            <Route className="size-4" aria-hidden />
          </span>
          Corridor
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Check a PAPS / PARS</h1>
        <p className="mt-2 max-w-lg text-sm leading-relaxed text-fg-secondary">
          Enter the carrier code and the control number printed on the shipment paperwork.
        </p>
      </div>
      {/* Outside the app shell, so the page mounts its own tRPC provider. */}
      <TRPCReactProvider>
        <TrackForm />
      </TRPCReactProvider>
      <p className="px-1 text-xs leading-relaxed text-fg-secondary">
        Ten lookups a minute. This page shows the customs status, port, entry number and times only.
      </p>
    </main>
  );
}
