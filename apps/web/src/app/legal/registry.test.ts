import { describe, expect, it } from "vitest";
import { LEGAL_SLUGS, isLegalSlug, legalPage } from "./registry";

describe("legal registry", () => {
  it("recognizes every declared slug and rejects an unknown one", () => {
    for (const slug of LEGAL_SLUGS) expect(isLegalSlug(slug)).toBe(true);
    expect(isLegalSlug("not-a-real-page")).toBe(false);
  });

  it("renders a title and non-placeholder markdown for every slug", () => {
    for (const slug of LEGAL_SLUGS) {
      const { title, markdown } = legalPage(slug);
      expect(title.length).toBeGreaterThan(0);
      expect(markdown).not.toMatch(/TBD|TODO|FIXME/);
      expect(markdown.length).toBeGreaterThan(100);
    }
  });

  it("interpolates the legal env values into the content that reads them", () => {
    process.env.NEXT_PUBLIC_LEGAL_ENTITY_NAME = "Acme Freight Inc.";
    process.env.NEXT_PUBLIC_LEGAL_JURISDICTION = "Ontario, Canada";
    const { markdown: terms } = legalPage("terms");
    expect(terms).toContain("Acme Freight Inc.");
    expect(terms).toContain("Ontario, Canada");
    delete process.env.NEXT_PUBLIC_LEGAL_ENTITY_NAME;
    delete process.env.NEXT_PUBLIC_LEGAL_JURISDICTION;
  });
});
