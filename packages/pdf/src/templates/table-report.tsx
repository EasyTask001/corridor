import { Document, Page, Text } from "@react-pdf/renderer";
import type { TableReportData } from "../types";
import { Footer, Masthead, Table } from "./parts";
import { styles } from "./theme";

/** Hard ceiling inside the package: a registry export with no upstream limit must still render. */
export const MAX_TABLE_REPORT_ROWS = 2000;

export function truncateTableRows<T>(rows: T[]): { rows: T[]; truncatedFrom: number | null } {
  return rows.length > MAX_TABLE_REPORT_ROWS
    ? { rows: rows.slice(0, MAX_TABLE_REPORT_ROWS), truncatedFrom: rows.length }
    : { rows, truncatedFrom: null };
}

/**
 * A landscape table for reports and registry exports (Task 12): the column
 * set is whatever the report picked, widths shared evenly unless given.
 */
export function TableReport({ data }: { data: TableReportData }) {
  const { rows, truncatedFrom } = truncateTableRows(data.rows);
  const given = data.columns.reduce((sum, c) => sum + (c.width ?? 0), 0);
  const unsized = data.columns.filter((c) => !c.width).length;
  const fill = unsized > 0 ? Math.max(4, (100 - given) / unsized) : 0;
  return (
    <Document title={data.title} author={data.carrier.name}>
      <Page size="LETTER" orientation="landscape" style={styles.page}>
        <Masthead
          carrier={data.carrier}
          title={data.title}
          meta={[
            data.subtitle ?? "",
            truncatedFrom
              ? `showing first ${MAX_TABLE_REPORT_ROWS} of ${truncatedFrom} rows`
              : `${rows.length} row${rows.length === 1 ? "" : "s"}`,
          ]}
        />
        {rows.length === 0 ? (
          <Text style={styles.empty}>No rows match.</Text>
        ) : (
          <Table
            columns={data.columns.map((c) => ({
              key: c.key,
              label: c.label,
              width: c.width ?? fill,
            }))}
            rows={rows}
            emptyText="No rows match."
          />
        )}
        <Footer left={`${data.carrier.name} · ${data.title}`} generatedAt={data.generatedAt} />
      </Page>
    </Document>
  );
}
