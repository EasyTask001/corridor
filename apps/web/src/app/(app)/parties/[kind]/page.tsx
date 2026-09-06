import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { PermissionKey } from "@corridor/domain";
import { getSession } from "@/lib/session";
import { REGISTRIES, type RegistryKind } from "@/components/registry/fields";
import { RegistryPage } from "@/components/registry/registry-page";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ kind: string }>;
}): Promise<Metadata> {
  const { kind } = await params;
  return { title: REGISTRIES[kind as RegistryKind]?.title ?? "Registry" };
}

export default async function PartiesPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const cfg = REGISTRIES[kind as RegistryKind];
  if (!cfg) notFound();

  const session = await getSession();
  if (!session?.permissions.has(cfg.readPermission as PermissionKey)) redirect("/dashboard");

  return (
    <RegistryPage
      kind={cfg.kind}
      canWrite={session.permissions.has(cfg.writePermission as PermissionKey)}
    />
  );
}
