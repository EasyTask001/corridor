/**
 * Dev fallbacks so `pnpm dev` never crashes on a missing legal env var; every
 * one of these is required in production (see readiness.ts's
 * REQUIRED_PRODUCTION_ENV) so a placeholder never ships to a real customer.
 */
export const legal = {
  get entityName() {
    return process.env.NEXT_PUBLIC_LEGAL_ENTITY_NAME ?? "Corridor (development)";
  },
  get jurisdiction() {
    return process.env.NEXT_PUBLIC_LEGAL_JURISDICTION ?? "Manitoba, Canada";
  },
  get privacyEmail() {
    return (
      process.env.NEXT_PUBLIC_PRIVACY_EMAIL ??
      process.env.NEXT_PUBLIC_SUPPORT_EMAIL ??
      "privacy@corridor.local"
    );
  },
  get securityEmail() {
    return process.env.NEXT_PUBLIC_SECURITY_EMAIL ?? "security@corridor.local";
  },
  get reviewedAt() {
    return process.env.NEXT_PUBLIC_LEGAL_REVIEWED_AT ?? null;
  },
};
