import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";
import { BlankDriverSheet } from "./templates/blank-driver-sheet";
import { DriverSheet } from "./templates/driver-sheet";
import { ManifestSummary } from "./templates/manifest-summary";
import { TableReport } from "./templates/table-report";
import type { BlankSheetData, DriverSheetData, TableReportData } from "./types";

export type PdfKind = "driver_sheet" | "blank_driver_sheet" | "manifest_summary" | "report";

/** react-pdf types its root as a <Document> element; our templates render one. */
const asDocument = (el: ReactElement) => el as unknown as ReactElement<DocumentProps>;

/** Server-only: renders a template to PDF bytes (Node, no DOM). */
export async function renderDriverSheet(data: DriverSheetData): Promise<Buffer> {
  return Buffer.from(await renderToBuffer(asDocument(createElement(DriverSheet, { data }))));
}

export async function renderManifestSummary(data: DriverSheetData): Promise<Buffer> {
  return Buffer.from(await renderToBuffer(asDocument(createElement(ManifestSummary, { data }))));
}

export async function renderBlankDriverSheets(data: BlankSheetData): Promise<Buffer> {
  return Buffer.from(await renderToBuffer(asDocument(createElement(BlankDriverSheet, { data }))));
}

export async function renderTableReport(data: TableReportData): Promise<Buffer> {
  return Buffer.from(await renderToBuffer(asDocument(createElement(TableReport, { data }))));
}
