/**
 * HS / HTS tariff lookup stub — a small embedded table for the most common
 * cross-border commodities. The real HTS / CBSA Customs Tariff API adapter
 * replaces `lookupHsCode` later; the signature stays.
 */
export interface TariffEntry {
  hsCode: string;
  description: string;
  /** general duty rate as a fraction, e.g. 0.025 = 2.5% */
  usDutyRate: number | null;
  caDutyRate: number | null;
  notes?: string;
}

const TABLE: TariffEntry[] = [
  {
    hsCode: "0808.10",
    description: "Apples, fresh",
    usDutyRate: 0,
    caDutyRate: 0,
    notes: "USMCA/CUSMA duty-free",
  },
  { hsCode: "0808.30", description: "Pears, fresh", usDutyRate: 0, caDutyRate: 0 },
  {
    hsCode: "4407.11",
    description: "Lumber, coniferous (pine), sawn",
    usDutyRate: 0,
    caDutyRate: 0,
    notes: "Softwood lumber duties may apply (AD/CVD)",
  },
  {
    hsCode: "7208.10",
    description: "Flat-rolled iron/steel, hot-rolled, in coils, with patterns in relief",
    usDutyRate: 0,
    caDutyRate: 0,
    notes: "Section 232 measures may apply",
  },
  {
    hsCode: "7210.49",
    description: "Flat-rolled iron/steel, zinc-plated (galvanized), other",
    usDutyRate: 0,
    caDutyRate: 0,
    notes: "Section 232 measures may apply",
  },
  {
    hsCode: "7308.90",
    description: "Structures and parts of iron or steel, other",
    usDutyRate: 0,
    caDutyRate: 0,
  },
  {
    hsCode: "8471.30",
    description: "Portable automatic data processing machines ≤10 kg",
    usDutyRate: 0,
    caDutyRate: 0,
  },
  {
    hsCode: "8708.99",
    description: "Parts and accessories of motor vehicles, other",
    usDutyRate: 0.025,
    caDutyRate: 0,
  },
  {
    hsCode: "3923.21",
    description: "Sacks and bags of polymers of ethylene",
    usDutyRate: 0.03,
    caDutyRate: 0,
  },
  { hsCode: "9403.60", description: "Wooden furniture, other", usDutyRate: 0, caDutyRate: 0 },
];

export function lookupHsCode(code: string | null | undefined): TariffEntry | null {
  if (!code) return null;
  const c = code.trim();
  return TABLE.find((t) => t.hsCode === c) ?? TABLE.find((t) => c.startsWith(t.hsCode)) ?? null;
}

export function searchTariff(query: string, limit = 8): TariffEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return TABLE.filter(
    (t) => t.hsCode.startsWith(q) || t.description.toLowerCase().includes(q),
  ).slice(0, limit);
}
