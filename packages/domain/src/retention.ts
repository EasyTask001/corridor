export interface RetentionEntry {
  category: string;
  policy: string;
}

/**
 * What the code actually does today, not an aspirational policy — the
 * data-retention legal page renders this verbatim. Every tenant table cascades
 * on `organization_id ... on delete cascade` (CLAUDE.md's schema rule), so an
 * org delete is the one deletion path that exists; there is no scheduled purge
 * job for anything below, including background_jobs.
 */
export const RETENTION_SCHEDULE: RetentionEntry[] = [
  {
    category:
      "Organization, user, and driver records — including licence number, date of birth, and citizenship fields",
    policy: "Retained for the life of the account. Deleted only when the organization itself is deleted.",
  },
  {
    category: "Shipments, movements, and customs filings",
    policy: "Retained for the life of the account, as the compliance record of what was filed and when.",
  },
  {
    category: "Uploaded documents and AI-extracted data",
    policy: "Retained for the life of the account, alongside the shipment or movement they belong to.",
  },
  {
    category: "Audit log",
    policy: "Retained for the life of the account. Never deleted independently of the account.",
  },
  {
    category: "Background jobs, queued and completed",
    policy: "Retained until manually purged. No automatic time-based deletion runs today.",
  },
  {
    category: "Organization deletion",
    policy:
      "Deleting an organization cascades to every record above through its foreign keys. There is no self-serve deletion flow yet — a customer requests deletion through the privacy contact address.",
  },
];
