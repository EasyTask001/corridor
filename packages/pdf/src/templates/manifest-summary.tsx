import { Document, Page, View } from "@react-pdf/renderer";
import type { DriverSheetData, SheetCustomsEvent } from "../types";
import { Field, Footer, Masthead, Section, Table } from "./parts";
import { fmtDate, styles } from "./theme";

/**
 * Everything on the manifest plus the gateway's latest messages — the office
 * copy, printed for the file or a broker.
 */
export function ManifestSummary({ data }: { data: DriverSheetData }) {
  const { trip, carrier } = data;
  const agency = trip.regime === "ACE" ? "CBP" : "CBSA";
  return (
    <Document title={`${trip.movementNumber} manifest summary`} author={carrier.name}>
      <Page size="LETTER" style={styles.page}>
        <Masthead
          carrier={carrier}
          title={`${trip.regime} e-manifest summary`}
          meta={[
            trip.movementNumber,
            trip.tripNumber ? `Trip ${trip.tripNumber}` : "",
            `Status: ${trip.status}`,
          ]}
        />

        <Section title="Carrier and filing">
          <View style={styles.grid}>
            <Field label="Carrier" value={carrier.legalName ?? carrier.name} wide />
            <Field label="Carrier code" value={carrier.carrierCode} mono />
            <Field label="Filer code" value={carrier.filerCode} mono />
            <Field label="USDOT" value={carrier.usDotNumber} mono />
            <Field label={`${agency} reference`} value={trip.customsReferenceNumber} mono />
            <Field
              label="Port of entry"
              value={trip.portCode && `${trip.portCode} ${trip.portName ?? ""}`}
            />
            <Field label="Estimated crossing" value={fmtDate(trip.scheduledCrossingAt)} />
            <Field label="Load" value={trip.isEmpty ? "Empty" : "Laden"} />
            <Field label="IIT" value={trip.iitIndicator.replace(/_/g, " ")} />
            <Field label="CBSA flags" value={trip.aciFlags.join(", ") || "none"} wide />
          </View>
        </Section>

        <Section title="Crew">
          <Table
            columns={[
              { key: "name", label: "Name", width: 24 },
              { key: "role", label: "Role", width: 16, render: (c) => c.role.replace(/_/g, " ") },
              { key: "personType", label: "Type", width: 10 },
              { key: "licenseNumber", label: "Licence", width: 20, mono: true },
              { key: "citizenship", label: "Citizenship", width: 10 },
              {
                key: "documents",
                label: "Documents",
                width: 20,
                render: (c) =>
                  c.documents
                    .map(
                      (d) =>
                        `${d.type.replace(/_/g, " ")} ${d.number}${d.expiresOn ? ` (exp ${d.expiresOn})` : ""}`,
                    )
                    .join("; "),
              },
            ]}
            rows={data.crew}
            emptyText="No crew."
          />
        </Section>

        <Section title="Conveyance and equipment">
          <Table
            columns={[
              { key: "kind", label: "Unit", width: 14 },
              { key: "unitNumber", label: "Number", width: 14, mono: true },
              { key: "vin", label: "VIN", width: 22, mono: true },
              { key: "type", label: "Type", width: 8, mono: true },
              {
                key: "plates",
                label: "Plates",
                width: 22,
                mono: true,
                render: (u) => u.plates.join(", "),
              },
              {
                key: "seals",
                label: "Seals",
                width: 20,
                mono: true,
                render: (u) => u.seals.join(", "),
              },
            ]}
            rows={[
              ...(data.truck ? [{ ...data.truck, kind: "Tractor" }] : []),
              ...data.trailers.map((t, i) => ({ ...t, kind: `Trailer ${i + 1}` })),
            ]}
            emptyText="No equipment."
          />
        </Section>

        <Section title="Shipments">
          <Table
            columns={[
              { key: "controlNumber", label: "Control #", width: 18, mono: true },
              {
                key: "kind",
                label: "Type",
                width: 12,
                render: (s) => (s.kind ?? "").replace(/_/g, " "),
              },
              { key: "shipper", label: "Shipper", width: 18 },
              { key: "consignee", label: "Consignee", width: 18 },
              { key: "inBond", label: "In-bond", width: 10 },
              {
                key: "entryNumber",
                label: "Entry #",
                width: 16,
                mono: true,
                render: (s) =>
                  s.entryNumber
                    ? `${s.entryNumber}${s.entryPortCode ? ` @ ${s.entryPortCode}` : ""}`
                    : "",
              },
              { key: "status", label: "Status", width: 8 },
            ]}
            rows={data.shipments}
            emptyText={trip.isEmpty ? "Declared empty." : "No shipments."}
          />
        </Section>

        {data.shipments.some((s) => s.commodities.length > 0) && (
          <Section title="Commodities">
            <Table
              columns={[
                { key: "controlNumber", label: "Shipment", width: 16, mono: true },
                { key: "line", label: "#", width: 4 },
                { key: "description", label: "Description", width: 28 },
                { key: "hsCode", label: "HS", width: 10, mono: true },
                {
                  key: "quantity",
                  label: "Qty",
                  width: 12,
                  render: (c) =>
                    c.quantity != null ? `${c.quantity} ${c.quantityUnit ?? ""}` : "",
                },
                {
                  key: "weightKg",
                  label: "Weight",
                  width: 10,
                  render: (c) =>
                    c.weightKg != null ? `${c.weightKg.toLocaleString("en-CA")} kg` : "",
                },
                { key: "countryOfOrigin", label: "Origin", width: 8 },
                {
                  key: "hazmat",
                  label: "Hazmat",
                  width: 12,
                  mono: true,
                  render: (c) => c.hazmat.join(", "),
                },
              ]}
              rows={data.shipments.flatMap((s) =>
                s.commodities.map((c) => ({ ...c, controlNumber: s.controlNumber })),
              )}
              emptyText="No commodity lines."
            />
          </Section>
        )}

        <Section title={`Latest ${agency} messages`}>
          <Table<SheetCustomsEvent>
            columns={[
              { key: "occurredAt", label: "When", width: 26, render: (e) => fmtDate(e.occurredAt) },
              { key: "label", label: "Message", width: 30 },
              { key: "detail", label: "Detail", width: 44 },
            ]}
            rows={data.customsEvents}
            emptyText="Nothing received from customs yet."
          />
        </Section>

        <Footer
          left={`${carrier.name} · ${trip.movementNumber} · e-manifest summary`}
          generatedAt={data.generatedAt}
        />
      </Page>
    </Document>
  );
}
