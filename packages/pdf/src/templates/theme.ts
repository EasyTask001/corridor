import { StyleSheet } from "@react-pdf/renderer";

/**
 * One visual system for every printed sheet: a paper form a driver hands to a
 * CBP/CBSA officer at the booth. Dense, monochrome, ruled — Helvetica because
 * it is embedded in every PDF reader and the built-in font needs no fetch.
 */
export const ink = {
  text: "#111318",
  muted: "#5c6270",
  rule: "#c9ccd3",
  faint: "#eef0f3",
  band: "#f5f6f8",
};

export const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: ink.text,
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 36,
  },
  masthead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    borderBottomWidth: 1.5,
    borderBottomColor: ink.text,
    paddingBottom: 6,
    marginBottom: 10,
  },
  carrierName: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  carrierMeta: { fontSize: 8, color: ink.muted, marginTop: 2 },
  docTitle: { fontSize: 11, fontFamily: "Helvetica-Bold", textAlign: "right" },
  docMeta: { fontSize: 8, color: ink.muted, textAlign: "right", marginTop: 2 },
  section: { marginTop: 10 },
  sectionTitle: {
    fontSize: 7.5,
    fontFamily: "Helvetica-Bold",
    color: ink.muted,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: "25%", paddingRight: 8, paddingBottom: 5 },
  cellWide: { width: "50%", paddingRight: 8, paddingBottom: 5 },
  label: { fontSize: 7, color: ink.muted, marginBottom: 1 },
  value: { fontSize: 9.5 },
  mono: { fontFamily: "Courier", fontSize: 9.5 },
  table: { borderTopWidth: 1, borderTopColor: ink.text },
  th: {
    flexDirection: "row",
    backgroundColor: ink.band,
    borderBottomWidth: 0.75,
    borderBottomColor: ink.rule,
    paddingVertical: 3,
  },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: ink.rule,
    paddingVertical: 3,
  },
  thText: { fontSize: 7, fontFamily: "Helvetica-Bold", color: ink.muted, paddingHorizontal: 3 },
  td: { fontSize: 8.5, paddingHorizontal: 3 },
  tdMono: { fontFamily: "Courier", fontSize: 8.5, paddingHorizontal: 3 },
  footer: {
    position: "absolute",
    bottom: 22,
    left: 36,
    right: 36,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.5,
    borderTopColor: ink.rule,
    paddingTop: 4,
    fontSize: 7,
    color: ink.muted,
  },
  signatureRow: { flexDirection: "row", marginTop: 26 },
  signature: { flex: 1, marginRight: 24 },
  signatureLine: { borderTopWidth: 0.75, borderTopColor: ink.text, paddingTop: 3, fontSize: 7, color: ink.muted },
  empty: { fontSize: 8.5, color: ink.muted, fontStyle: "italic" },
});

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Toronto" }) : "—";
