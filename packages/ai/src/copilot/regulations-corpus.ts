/**
 * Seed regulation corpus for the copilot's global knowledge base. These are
 * genuine, paraphrased summaries of publicly available CBP/CBSA guidance —
 * not verbatim legal text — intended to demonstrate retrieval + citation and
 * give the copilot something real to ground answers in for common carrier
 * questions. Each entry is chunked at ingestion time (ingest.ts).
 */
export interface RegulationSeed {
  source: string;
  title: string;
  jurisdiction: "US" | "CA";
  url: string;
  content: string;
}

export const REGULATION_CORPUS: RegulationSeed[] = [
  {
    source: "CBP 19 CFR 123.92",
    title: "Advance Electronic Information for Truck Cargo (ACE e-Manifest)",
    jurisdiction: "US",
    url: "https://www.ecfr.gov/current/title-19/chapter-I/part-123/subpart-C/section-123.92",
    content:
      "Carriers transporting cargo into the United States by truck must transmit advance electronic cargo information to CBP through the Automated Commercial Environment (ACE) e-Manifest system. For most land border crossings the manifest must be received by CBP no later than one hour prior to the truck's arrival at the port of entry (FAST-enrolled carriers using a dedicated FAST lane may transmit as little as 30 minutes in advance at some ports). The manifest must identify the carrier, conveyance, crew, and a description of each shipment, including the shipper, consignee, and quantity of cargo. Failure to transmit a compliant manifest within the required window may result in the truck being denied entry or referred to secondary inspection.",
  },
  {
    source: "CBP 19 CFR 149",
    title: "Importer Security Filing and cargo description requirements",
    jurisdiction: "US",
    url: "https://www.ecfr.gov/current/title-19/chapter-I/part-149",
    content:
      "The cargo description on a manifest must be precise enough for CBP to determine the admissibility and classification of the merchandise; vague descriptions such as 'general merchandise', 'FAK' (freight of all kinds), or 'consolidated freight' are not acceptable on their own and are one of the most common causes of a hold for further inspection. Where practical, the harmonized system (HS) classification number should accompany the commodity description. Corridor's document intelligence pipeline extracts the shipper's stated commodity description directly from the bill of lading; a mismatch between the extracted HS code and the described goods is flagged for review before transmission.",
  },
  {
    source: "CBSA Memoranda D3-1-1",
    title: "Advance Commercial Information (ACI) for Highway Carriers",
    jurisdiction: "CA",
    url: "https://www.cbsa-asfc.gc.ca/publications/dm-md/d3/d3-1-1-eng.html",
    content:
      "Highway carriers bringing goods into Canada must transmit cargo and conveyance data to the CBSA through the Advance Commercial Information (ACI) program at least one hour before arrival at the first port of entry. The transmission must include the carrier code, trip number, and for each shipment the shipper and consignee names and addresses, a description of the goods, and the weight. A carrier that fails to submit ACI data within the required timeframe, or whose data does not match the goods actually presented, may be assessed a penalty under the Administrative Monetary Penalty System (AMPS) and the shipment may be held for a full examination.",
  },
  {
    source: "CBSA Memoranda D17-1-4",
    title: "Release Prior to Payment (RPP) Requirements",
    jurisdiction: "CA",
    url: "https://www.cbsa-asfc.gc.ca/publications/dm-md/d17/d17-1-4-eng.html",
    content:
      "Carriers and importers participating in the Release Prior to Payment (RPP) program may obtain release of goods before final accounting and payment of duties, provided the carrier is bonded and the shipment data transmitted through ACI is complete and accurate. A carrier without an active RPP bond, or whose transaction cannot be matched to a valid importer program account, will have the shipment held pending full documentary review at the border, which commonly adds several hours to crossing time.",
  },
  {
    source: "CBP Trusted Trader / FAST Program",
    title: "Free and Secure Trade (FAST) Lane Eligibility",
    jurisdiction: "US",
    url: "https://www.cbp.gov/travel/trusted-traveler-programs/fast",
    content:
      "The Free and Secure Trade (FAST) program allows pre-approved, low-risk drivers and carriers to use dedicated lanes at participating land border crossings with expedited processing. To use a FAST lane, the driver must hold a valid FAST card, the truck's carrier must be C-TPAT or PIP certified, and the shipment must originate from a certified importer/exporter — all three conditions must be met, or CBP/CBSA will redirect the truck to the regular commercial lane. A FAST card nearing its expiry date should be renewed well before its expiry, since an expired card immediately disqualifies the driver from the FAST lane regardless of the carrier's own certification status.",
  },
  {
    source: "USMCA/CUSMA Rules of Origin",
    title: "Preferential Tariff Treatment Under USMCA/CUSMA",
    jurisdiction: "US",
    url: "https://ustr.gov/trade-agreements/free-trade-agreements/united-states-mexico-canada-agreement",
    content:
      "Goods qualifying for duty-free or reduced-duty treatment under the USMCA (known as CUSMA in Canada) must meet the agreement's rules of origin — generally requiring that the good be wholly obtained, produced entirely from originating materials, or undergo a sufficient tariff classification change or regional value content within North America. A USMCA/CUSMA certification of origin (which may be provided by the exporter, producer, or importer) should be retained and referenced on the manifest's HS classification and country-of-origin fields; goods lacking a valid certification are treated as dutiable at the standard Most-Favoured-Nation rate.",
  },
];
