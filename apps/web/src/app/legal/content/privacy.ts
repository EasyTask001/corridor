export const PRIVACY_TITLE = "Privacy Policy";

export function privacyContent(ctx: { entityName: string; privacyEmail: string }): string {
  return `# Privacy Policy

**${ctx.entityName}** ("Corridor", "we", "us") operates the Corridor platform. This page
describes what we collect, why, and who we share it with.

## What we collect

- **Organization and user accounts**: name, work email, role, and organization membership.
- **Driver information**, where your organization enters it for a shipment or trip: name,
  licence number, date of birth, and citizenship — fields customs manifests require.
- **Shipment and party data**: consignees, shippers, brokers, commodities, and the documents
  (bills of lading, invoices, and similar) uploaded in support of a filing.
- **Filing and audit data**: what was submitted to CBP/CBSA, when, by whom, and the resulting
  status — kept as the compliance record of your account's activity.
- **Usage and diagnostic data**: sign-in activity, error reports, and request metadata used to
  operate and secure the service.

## Who we share it with

Corridor uses the following processors to operate the service. Each receives only the data
its function requires:

| Processor | Purpose |
| --- | --- |
| Supabase | Database, authentication, and file storage |
| Vercel | Application hosting |
| Sentry | Error and performance monitoring |
| Stripe | Billing (organizations on a paid plan) |
| AI provider (via Vercel AI Gateway, or OpenAI directly) | Document extraction and the Compliance Copilot |
| Resend | Transactional email |
| Twilio | SMS notifications (organizations that opt in) |
| BorderConnect | Submitting ACE/ACI e-manifests to CBP and CBSA on your behalf |

We do not sell personal information.

## Cross-border transfer

Because Corridor files with both U.S. and Canadian customs authorities, shipment, party, and
driver data is processed and stored in both the United States and Canada as part of the normal
operation of the service.

## Your rights and contact

You may request access to, correction of, or deletion of your organization's data by writing
to **${ctx.privacyEmail}**. See the [Data Retention & Deletion](/legal/data-retention) page for
how long different kinds of data are kept and what deletion actually does today.
`;
}
