import { legal } from "@/lib/legal";
import { AI_DISCLAIMER_TITLE, aiDisclaimerContent } from "./content/ai-disclaimer";
import { DATA_RETENTION_TITLE, dataRetentionContent } from "./content/data-retention";
import { PRIVACY_TITLE, privacyContent } from "./content/privacy";
import { TERMS_TITLE, termsContent } from "./content/terms";

import { SECURITY_TITLE, securityContent } from "./content/security";

export const LEGAL_SLUGS = [
  "terms",
  "privacy",
  "data-retention",
  "ai-disclaimer",
  "security",
] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

export function isLegalSlug(slug: string): slug is LegalSlug {
  return (LEGAL_SLUGS as readonly string[]).includes(slug);
}

export function legalPage(slug: LegalSlug): { title: string; markdown: string } {
  switch (slug) {
    case "terms":
      return { title: TERMS_TITLE, markdown: termsContent(legal) };
    case "privacy":
      return { title: PRIVACY_TITLE, markdown: privacyContent(legal) };
    case "data-retention":
      return { title: DATA_RETENTION_TITLE, markdown: dataRetentionContent(legal) };
    case "ai-disclaimer":
      return { title: AI_DISCLAIMER_TITLE, markdown: aiDisclaimerContent() };
    case "security":
      return { title: SECURITY_TITLE, markdown: securityContent(legal) };
  }
}
