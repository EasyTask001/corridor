import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { TRPCReactProvider } from "@/lib/trpc/client";
import { AppShell } from "@/components/app-shell";

/** Server Component: enforce session + active org membership for every app route. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.activeOrganizationId) redirect("/onboarding");

  const activeOrg = session.memberships.find(
    (m) => m.organizationId === session.activeOrganizationId,
  )!;

  return (
    <TRPCReactProvider>
      <AppShell
        user={session.user}
        organizationName={activeOrg.organizationName}
        roleName={activeOrg.roleName}
        permissions={[...session.permissions]}
      >
        {children}
      </AppShell>
    </TRPCReactProvider>
  );
}
