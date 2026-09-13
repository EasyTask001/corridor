export const SECURITY_TITLE = "Vulnerability Disclosure Policy";

export function securityContent(ctx: { securityEmail: string }): string {
  return `# Vulnerability Disclosure Policy

We take the security of Corridor and the customs data it handles seriously, and we welcome
reports from security researchers.

## Reporting a vulnerability

Email **${ctx.securityEmail}** with a description of the issue, the steps to reproduce it, and
its potential impact. Please do not include customer data, live customs filings, or driver PII
in a report — describe the issue, and we will follow up if we need more.

## What to expect

We will acknowledge a report, investigate, and follow up with the outcome. Please give us a
reasonable window to fix a confirmed issue before any public disclosure, and avoid actions that
degrade the service or access data beyond what is needed to demonstrate the issue.

This is referenced from \`/.well-known/security.txt\` per RFC 9116.
`;
}
