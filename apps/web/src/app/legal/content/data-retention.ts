import { RETENTION_SCHEDULE } from "@corridor/domain";

export const DATA_RETENTION_TITLE = "Data Retention & Deletion";

export function dataRetentionContent(ctx: { privacyEmail: string }): string {
  const rows = RETENTION_SCHEDULE.map((e) => `| ${e.category} | ${e.policy} |`).join("\n");
  return `# Data Retention & Deletion

This page describes what Corridor's code actually does today, not an aspirational policy.

| Data | Retention |
| --- | --- |
${rows}

## Requesting deletion

Corridor does not yet offer self-serve organization deletion. To request that your
organization's data be deleted, write to **${ctx.privacyEmail}** from an account with
organization-owner access. We will confirm your identity and the scope of the request before
deleting anything.
`;
}
