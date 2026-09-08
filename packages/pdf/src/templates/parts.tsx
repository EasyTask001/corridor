import { Text, View } from "@react-pdf/renderer";
import type { ReactNode } from "react";
import type { SheetCarrier } from "../types";
import { fmtDate, styles } from "./theme";

export function Masthead({
  carrier,
  title,
  meta,
}: {
  carrier: SheetCarrier;
  title: string;
  meta: string[];
}) {
  return (
    <View style={styles.masthead} fixed>
      <View>
        <Text style={styles.carrierName}>{carrier.name}</Text>
        <Text style={styles.carrierMeta}>
          {[
            carrier.carrierCode && `Carrier ${carrier.carrierCode}`,
            carrier.usDotNumber && `USDOT ${carrier.usDotNumber}`,
            carrier.filerCode && `Filer ${carrier.filerCode}`,
          ]
            .filter(Boolean)
            .join("  ·  ")}
        </Text>
      </View>
      <View>
        <Text style={styles.docTitle}>{title}</Text>
        {meta.map((m) => (
          <Text key={m} style={styles.docMeta}>
            {m}
          </Text>
        ))}
      </View>
    </View>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section} wrap={false}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export function Field({
  label,
  value,
  mono,
  wide,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <View style={wide ? styles.cellWide : styles.cell}>
      <Text style={styles.label}>{label}</Text>
      <Text style={mono ? styles.mono : styles.value}>{value || "—"}</Text>
    </View>
  );
}

export interface Column<T> {
  key: keyof T | string;
  label: string;
  width: number;
  mono?: boolean;
  render?: (row: T) => string;
}

export function Table<T extends object>({
  columns,
  rows,
  emptyText,
}: {
  columns: Column<T>[];
  rows: T[];
  emptyText: string;
}) {
  if (rows.length === 0) return <Text style={styles.empty}>{emptyText}</Text>;
  return (
    <View style={styles.table}>
      <View style={styles.th} fixed>
        {columns.map((c) => (
          <Text key={String(c.key)} style={[styles.thText, { width: `${c.width}%` }]}>
            {c.label}
          </Text>
        ))}
      </View>
      {rows.map((row, i) => (
        <View key={i} style={styles.tr} wrap={false}>
          {columns.map((c) => {
            const raw = c.render ? c.render(row) : (row as Record<string, unknown>)[String(c.key)];
            return (
              <Text
                key={String(c.key)}
                style={[c.mono ? styles.tdMono : styles.td, { width: `${c.width}%` }]}
              >
                {raw === null || raw === undefined || raw === "" ? "—" : String(raw)}
              </Text>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export function Footer({ left, generatedAt }: { left: string; generatedAt: string }) {
  return (
    <View style={styles.footer} fixed>
      <Text>{left}</Text>
      <Text
        render={({ pageNumber, totalPages }) =>
          `Generated ${fmtDate(generatedAt)}  ·  page ${pageNumber} of ${totalPages}`
        }
      />
    </View>
  );
}
