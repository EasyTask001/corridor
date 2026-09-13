export const TERMS_TITLE = "Terms of Service";

export function termsContent(ctx: { entityName: string; jurisdiction: string }): string {
  return `# Terms of Service

**${ctx.entityName}** ("Corridor", "we", "us") operates the Corridor platform: software that
helps carriers prepare, validate, and file cross-border customs manifests (ACE for U.S.
entry, ACI for Canadian entry) and manage the shipments and documents that support them.

## What Corridor is — and is not

Corridor is compliance-support software, not a customs broker. Using Corridor does not
create a customs-broker, freight-forwarder, or power-of-attorney relationship between you
and us. You remain responsible for the accuracy of every filing submitted through Corridor,
for holding any bonds, licences, or authority your operation requires, and for your own
relationship with U.S. Customs and Border Protection, the Canada Border Services Agency,
and any customs broker you engage.

## AI-assisted features

Corridor uses AI models to extract data from uploaded documents and to answer questions in
the Compliance Copilot. AI-extracted data is always presented for human review before it is
applied to a shipment or filing — Corridor never auto-submits AI output. Copilot answers are
operational guidance drawn from paraphrased regulatory summaries and your own organization's
notes; they are not legal or customs-broker advice, and you are responsible for verifying
anything border-critical against the cited primary source or your own broker. See the
[AI disclaimer](/legal/ai-disclaimer) for detail.

## Your responsibilities

You are responsible for: the accuracy of shipment, party, and commodity data you enter or
upload; reviewing AI-extracted data before it is used in a filing; keeping your account
credentials secure; and complying with the customs law of every jurisdiction you file into.

## Availability and changes

Corridor is provided on an as-available basis. We may change, suspend, or discontinue
features with notice where practical. These terms may be updated from time to time; continued
use after an update means you accept the revised terms.

## Limitation of liability

To the maximum extent permitted by law, ${ctx.entityName} is not liable for indirect,
incidental, or consequential damages arising from use of Corridor, including customs delays,
penalties, or rejected filings, except where caused by our gross negligence or wilful
misconduct.

## Governing law

These terms are governed by the laws of ${ctx.jurisdiction}, without regard to conflict-of-law
principles.

## Contact

Questions about these terms: see the contact address on the [Privacy Policy](/legal/privacy)
page.
`;
}
