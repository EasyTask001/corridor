import { sql, type RlsTransaction } from "@corridor/db";

/** Write to the append-only audit log through its membership-checked DB function. */
export async function writeAudit(
  tx: RlsTransaction,
  organizationId: string,
  action: string,
  entityType: string,
  entityId: string,
  before?: unknown,
  after?: unknown,
) {
  const json = (value: unknown) =>
    value === null || value === undefined ? null : JSON.stringify(value);
  await tx.execute(sql`
    select public.log_audit(
      ${organizationId}::uuid, ${action}, ${entityType}, ${entityId},
      ${json(before)}::jsonb, ${json(after)}::jsonb
    )
  `);
}
