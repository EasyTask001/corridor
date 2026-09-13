/**
 * Seed regulation corpus for the copilot's global knowledge base. These are
 * genuine, paraphrased summaries of publicly available CBP/CBSA guidance —
 * not verbatim legal text — intended to demonstrate retrieval + citation and
 * give the copilot something real to ground answers in for common carrier
 * questions. Each entry is chunked at ingestion time (ingest.ts).
 *
 * Every entry below carries `lastVerifiedAt`: the date someone actually read
 * the live source and confirmed the summary against it. `match_regulations`
 * (migration 0052) only ever retrieves a row whose `verification_status` is
 * 'verified' — a summary written but never checked stays a 'draft' and is
 * never cited. This corpus previously carried an entry mis-citing 19 CFR 149
 * (Importer Security Filing — a *vessel* ISF rule) for truck manifest cargo
 * descriptions, and a Release Prior to Payment entry that predated CARM's
 * October 2024 shift of RPP security from brokers to importers; both are
 * corrected below rather than repeated.
 */
export interface RegulationSeed {
  source: string;
  title: string;
  jurisdiction: "US" | "CA";
  url: string;
  content: string;
  /** 'CBP' | 'CBSA' | 'USTR' | ... */
  authority: string;
  /** ISO date the cited rule itself took (or will take) effect, when a single
   * date is clearly stated by the source; null when the source doesn't expose
   * one cleanly (e.g. "current" eCFR text with no single amendment date). */
  effectiveDate: string | null;
  /** Edition / notice identifier, e.g. an eCFR read date or a CBSA notice number. */
  version: string;
  /** ISO date this summary was written against the live source. */
  retrievedAt: string;
  /** ISO date someone last confirmed the summary still matches the live
   * source. Ingestion marks the row 'draft' when this is null. */
  lastVerifiedAt: string | null;
}

const VERIFIED_2026_09_13 = "2026-09-13";

export const REGULATION_CORPUS: RegulationSeed[] = [
  {
    source: "CBP 19 CFR 123.92(a)",
    title: "Advance Electronic Truck Cargo Manifest — Timing (ACE e-Manifest)",
    jurisdiction: "US",
    authority: "CBP",
    url: "https://www.ecfr.gov/current/title-19/chapter-I/part-123/subpart-C/section-123.92",
    version: "eCFR, read 2026-09-13",
    effectiveDate: null,
    retrievedAt: VERIFIED_2026_09_13,
    lastVerifiedAt: VERIFIED_2026_09_13,
    content:
      "Carriers transporting cargo into the United States by truck must transmit advance electronic cargo and conveyance information to CBP through the Automated Commercial Environment (ACE) e-Manifest system. Under 19 CFR 123.92(a), CBP must receive this information no later than one hour before the truck reaches the first U.S. port of arrival; a carrier using a dedicated FAST lane may transmit as little as 30 minutes in advance. A manifest that is late, or never received, exposes the truck to denied entry or a hold for secondary inspection at the border.",
  },
  {
    source: "CBP 19 CFR 123.92(d)",
    title: "Required Data Elements on the Advance Truck Cargo Manifest",
    jurisdiction: "US",
    authority: "CBP",
    url: "https://www.ecfr.gov/current/title-19/chapter-I/part-123/subpart-C/section-123.92",
    version: "eCFR, read 2026-09-13",
    effectiveDate: null,
    retrievedAt: VERIFIED_2026_09_13,
    lastVerifiedAt: VERIFIED_2026_09_13,
    content:
      "19 CFR 123.92(d) lists the data elements a truck carrier's advance manifest must contain: the conveyance and equipment numbers; the carrier's SCAC code; the trip number and, if applicable, a transportation reference number per shipment; container and seal numbers; the foreign location where the carrier took possession of the cargo; the scheduled arrival date and time; the cargo quantities per bill of lading; the cargo's weight; and — the most common source of a hold — 'a precise description of the cargo or the Harmonized Tariff Schedule (HTS) numbers to the 6-digit level' (19 CFR 123.92(d)(9)). Vague descriptions such as 'general merchandise', 'FAK' (freight of all kinds), or 'consolidated freight' do not satisfy this requirement on their own. The regulation also requires an internationally recognized hazardous-material code where applicable, and the shipper's and consignee's complete name and address or identification number.",
  },
  {
    source: "CBSA Memorandum D3-4-2",
    title: "Highway Pre-Arrival and Reporting Requirements (ACI Timing)",
    jurisdiction: "CA",
    authority: "CBSA",
    url: "https://www.cbsa-asfc.gc.ca/publications/dm-md/d3/d3-4-2-eng.html",
    version: "issued 2025-11-12",
    effectiveDate: "2025-11-12",
    retrievedAt: VERIFIED_2026_09_13,
    lastVerifiedAt: VERIFIED_2026_09_13,
    content:
      "Memorandum D3-4-2 sets the Advance Commercial Information (ACI) pre-arrival timing rule for highway carriers: conveyance and cargo information for specified goods must be received and validated by the CBSA no later than one hour before the truck arrives at the first CBSA office. A message received less than one hour before arrival may still be accepted, but can trigger an 'insufficient review time' warning. A carrier that transmits late, or whose data does not match the goods actually presented, risks an Administrative Monetary Penalty (AMPS) and a hold for full examination.",
  },
  {
    source: "CBSA Customs Notice 24-27",
    title: "Release Prior to Payment (RPP) Under CARM — an Importer Privilege",
    jurisdiction: "CA",
    authority: "CBSA",
    url: "https://www.cbsa-asfc.gc.ca/publications/cn-ad/cn24-27-eng.html",
    version: "CN 24-27",
    effectiveDate: "2024-10-21",
    retrievedAt: VERIFIED_2026_09_13,
    lastVerifiedAt: VERIFIED_2026_09_13,
    content:
      "Release Prior to Payment (RPP) is an importer privilege, not a carrier one. Since the CBSA Assessment and Revenue Management (CARM) system became the CBSA's official system of record on October 21, 2024, an importer can no longer obtain release of goods before paying duties by relying on a customs broker's RPP security — the importer must post its own financial security through the CARM Client Portal (CCP). CBSA gave importers a transition period, extended to May 20, 2025, to arrange their own security; since that date, an importer that has not posted security in the CCP is not eligible for release prior to payment, and a shipment tied to such an importer can be held for full accounting and payment before release, regardless of the carrier's own standing or bond.",
  },
  {
    source: "CBP Trusted Trader / FAST Program",
    title: "Free and Secure Trade (FAST) Lane Eligibility",
    jurisdiction: "US",
    authority: "CBP",
    url: "https://www.cbp.gov/travel/trusted-traveler-programs/fast",
    version: "read 2026-09-13",
    effectiveDate: null,
    retrievedAt: VERIFIED_2026_09_13,
    lastVerifiedAt: VERIFIED_2026_09_13,
    content:
      "The Free and Secure Trade (FAST) program lets a pre-approved, low-risk supply chain use dedicated lanes at participating land border crossings. CBP frames eligibility as a whole-chain requirement, not just a driver credential: the driver must hold a valid FAST card, and the manufacturer, carrier, and importer must each be certified under the Customs-Trade Partnership Against Terrorism (C-TPAT) program (or PIP, its CBSA counterpart, on the Canadian side). If any link in that chain is not certified, or the driver's FAST card has expired, CBP or CBSA will direct the truck to the regular commercial lane instead of the FAST lane.",
  },
  {
    source: "USMCA/CUSMA Rules of Origin",
    title: "Preferential Tariff Treatment Under USMCA/CUSMA",
    jurisdiction: "US",
    authority: "USTR",
    url: "https://ustr.gov/trade-agreements/free-trade-agreements/united-states-mexico-canada-agreement",
    version: "read 2026-09-13",
    effectiveDate: "2020-07-01",
    retrievedAt: VERIFIED_2026_09_13,
    lastVerifiedAt: VERIFIED_2026_09_13,
    content:
      "Goods qualifying for duty-free or reduced-duty treatment under the USMCA (CUSMA in Canada) must meet the agreement's rules of origin — generally that the good is wholly obtained in North America, produced entirely there from originating materials, or undergoes a qualifying tariff classification change or meets a regional-value-content threshold under a product-specific rule (Chapter 4). Unlike NAFTA, USMCA has no prescribed certificate form; a claim for preferential treatment instead needs nine minimum data elements set out in Annex 5-A (certifier, exporter, producer, importer, description and 6-digit HS classification, origin criterion, blanket period if any, and a signed certifying statement), which the importer, exporter, or producer of the good may complete and which may appear on an invoice or any other document. Goods claiming preference without a valid certification of origin on file are treated as dutiable at the standard Most-Favoured-Nation rate.",
  },
];
