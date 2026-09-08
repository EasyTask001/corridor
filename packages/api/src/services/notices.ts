/**
 * Carrier service notices (0023): pull what CBP/CBSA published since the
 * last sync into the global `carrier_notices` table and tell every
 * organization with an enabled config for that provider. Runs in the
 * `customs.notices_sync` job under the service role — the notices belong to
 * no tenant, and the fan-out goes through `notify_organization` per org.
 */
import { and, desc, eq, ne, schema, type RlsTransaction } from "@corridor/db";
import { createCustomsClient, type CarrierNotice } from "@corridor/integrations";

const { carrierNotices, integrationConfigs } = schema;

const PROVIDERS = ["cbp_ace", "cbsa_aci"] as const;
const LABEL = { cbp_ace: "CBP", cbsa_aci: "CBSA" } as const;

/** Notices come from the carrier network, so the client is environment-level, not per org. */
export function noticesClientFor(provider: (typeof PROVIDERS)[number]) {
  const baseUrl = process.env.CUSTOMS_GATEWAY_BASE_URL ?? null;
  const apiKey = process.env.CUSTOMS_GATEWAY_API_KEY ?? null;
  return createCustomsClient({
    regime: provider === "cbp_ace" ? "ACE" : "ACI",
    mode: baseUrl && apiKey ? "gateway" : "mock",
    baseUrl,
    apiKey,
  });
}

export async function syncCarrierNotices(
  tx: RlsTransaction,
  clientFor: typeof noticesClientFor = noticesClientFor,
) {
  const summary: Record<string, { fetched: number; inserted: number; notified: number }> = {};
  // Dynamic import: notifications.ts -> customs.ts -> movements.ts would otherwise cycle.
  const { notifyOrganization } = await import("./notifications");

  for (const provider of PROVIDERS) {
    const [latest] = await tx
      .select({ publishedAt: carrierNotices.publishedAt })
      .from(carrierNotices)
      .where(eq(carrierNotices.provider, provider))
      .orderBy(desc(carrierNotices.publishedAt))
      .limit(1);
    const fetched: CarrierNotice[] = await clientFor(provider).fetchNotices(
      latest?.publishedAt ?? null,
    );
    const fresh: CarrierNotice[] = [];
    for (const n of fetched) {
      const inserted = await tx
        .insert(carrierNotices)
        .values({
          provider: n.provider,
          externalId: n.externalId,
          severity: n.severity,
          title: n.title,
          body: n.body,
          startsAt: n.startsAt ? new Date(n.startsAt) : null,
          endsAt: n.endsAt ? new Date(n.endsAt) : null,
          publishedAt: new Date(n.publishedAt),
        })
        .onConflictDoNothing()
        .returning({ id: carrierNotices.id });
      if (inserted.length > 0) fresh.push(n);
    }

    let notified = 0;
    if (fresh.length > 0) {
      const orgs = await tx
        .selectDistinct({ orgId: integrationConfigs.organizationId })
        .from(integrationConfigs)
        .where(
          and(eq(integrationConfigs.provider, provider), ne(integrationConfigs.status, "disabled")),
        );
      for (const n of fresh) {
        for (const { orgId } of orgs) {
          const r = await notifyOrganization(tx, {
            orgId,
            eventType: "customs.notice",
            title: `${LABEL[provider]} notice: ${n.title}`,
            body: n.body ?? undefined,
            linkPath: "/settings/integrations",
          });
          notified += r.notified;
        }
      }
    }
    summary[provider] = { fetched: fetched.length, inserted: fresh.length, notified };
  }
  return summary;
}
