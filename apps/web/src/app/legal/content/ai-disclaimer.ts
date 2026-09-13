export const AI_DISCLAIMER_TITLE = "AI Disclaimer";

export function aiDisclaimerContent(): string {
  return `# AI Disclaimer

Corridor uses AI models in two features. This page describes what each one does and does not
do.

## Document extraction

When you upload a bill of lading, invoice, or similar document, Corridor's AI extracts
structured data (parties, commodities, weights, and similar fields) to speed up shipment
entry. Extracted data is always shown for human review before it is applied to a shipment —
Corridor never files a manifest using unreviewed AI output. Extraction accuracy varies by
document quality and layout; always check extracted fields against the source document before
relying on them.

## Compliance Copilot

The Compliance Copilot answers questions using paraphrased, dated regulatory summaries and
your organization's own data. It is **not legal or customs-broker advice**. Every citation
shows the authority it paraphrases and the date it was last verified against the primary
source — always check that source, or your own broker, before acting on anything
border-critical.

## Tariff and border-wait data

Where Corridor shows tariff estimates or border-crossing wait times outside a live provider
integration, that data is synthetic and experimental, clearly labelled in the product, and
never used to determine compliance or inspection risk.
`;
}
