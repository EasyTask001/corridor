import { Document, Page, Text, View } from "@react-pdf/renderer";
import type {
  DriverSheetData,
  SheetCommodity,
  SheetCrew,
  SheetShipment,
  SheetUnit,
} from "../types";
import { Field, Footer, Masthead, Section, Table } from "./parts";
import { fmtDate, styles } from "./theme";

const ROLE: Record<string, string> = {
  person_in_charge: "Person in charge",
  crew_member: "Crew member",
  passenger: "Passenger",
};

/**
 * The sheet the driver carries to the booth: who, what, which trailer, which
 * seals, and every control / entry number the officer will ask for. The
 * `simple` variant (organizations.simple_driver_sheet) leaves the commodity
 * lines off — Avaal's "simple driver sheet".
 */
export function DriverSheet({ data }: { data: DriverSheetData }) {
  const { trip, carrier } = data;
  const agency = trip.regime === "ACE" ? "CBP" : "CBSA";
  return (
    <Document title={`${trip.movementNumber} driver sheet`} author={carrier.name}>
      <Page size="LETTER" style={styles.page}>
        <Masthead
          carrier={carrier}
          title={`${trip.regime} driver sheet`}
          meta={[trip.movementNumber, trip.tripNumber ? `Trip ${trip.tripNumber}` : ""]}
        />

        <Section title="Crossing">
          <View style={styles.grid}>
            <Field
              label={`${agency} port of entry`}
              value={trip.portCode && `${trip.portCode} ${trip.portName ?? ""}`}
              wide
            />
            <Field label="Estimated crossing" value={fmtDate(trip.scheduledCrossingAt)} />
            <Field label="Status" value={trip.status} />
            <Field label={`${agency} reference`} value={trip.customsReferenceNumber} mono />
            <Field
              label="Load"
              value={
                trip.isEmpty ? (trip.regime === "ACE" ? "Empty trailer" : "Empty trip") : "Laden"
              }
            />
            <Field
              label="IIT"
              value={trip.iitIndicator === "none" ? "None" : trip.iitIndicator.replace(/_/g, " ")}
            />
            {trip.aciFlags.length > 0 && (
              <Field label="CBSA flags" value={trip.aciFlags.join(", ")} />
            )}
          </View>
        </Section>

        <Section title="Crew">
          <Table<SheetCrew>
            columns={[
              { key: "name", label: "Name", width: 26 },
              { key: "role", label: "Role", width: 16, render: (c) => ROLE[c.role] ?? c.role },
              {
                key: "licenseNumber",
                label: "Licence",
                width: 22,
                mono: true,
                render: (c) =>
                  c.licenseNumber ? `${c.licenseNumber} ${c.licenseJurisdiction ?? ""}` : "",
              },
              { key: "citizenship", label: "Citizenship", width: 10 },
              {
                key: "documents",
                label: "Travel documents",
                width: 26,
                render: (c) =>
                  c.documents.map((d) => `${d.type.replace(/_/g, " ")} ${d.number}`).join("; "),
              },
            ]}
            rows={data.crew}
            emptyText="No crew assigned."
          />
        </Section>

        <Section title="Equipment and seals">
          <Table<SheetUnit & { kind: string }>
            columns={[
              { key: "kind", label: "Unit", width: 14 },
              { key: "unitNumber", label: "Number", width: 16, mono: true },
              { key: "type", label: "Type", width: 10, mono: true },
              {
                key: "plates",
                label: "Plates",
                width: 30,
                mono: true,
                render: (u) => u.plates.join(", "),
              },
              {
                key: "seals",
                label: "Seals",
                width: 30,
                mono: true,
                render: (u) => u.seals.join(", "),
              },
            ]}
            rows={[
              ...(data.truck ? [{ ...data.truck, kind: "Tractor" }] : []),
              ...data.trailers.map((t, i) => ({ ...t, kind: `Trailer ${i + 1}` })),
            ]}
            emptyText="No equipment assigned."
          />
        </Section>

        <Section title={trip.isEmpty ? "Shipments (none — empty)" : "Shipments"}>
          <Table<SheetShipment>
            columns={[
              {
                key: "controlNumber",
                label: trip.regime === "ACE" ? "PAPS / SCN" : "PARS / CCN",
                width: 22,
                mono: true,
              },
              {
                key: "kind",
                label: "Type",
                width: 14,
                render: (s) => (s.kind ?? "").replace(/_/g, " "),
              },
              { key: "shipper", label: "Shipper", width: 20 },
              { key: "consignee", label: "Consignee", width: 20 },
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
            emptyText={trip.isEmpty ? "Declared empty." : "No shipments on this movement."}
          />
        </Section>

        {!data.simple && data.shipments.some((s) => s.commodities.length > 0) && (
          <Section title="Commodities">
            <Table<SheetCommodity & { controlNumber: string }>
              columns={[
                { key: "controlNumber", label: "Shipment", width: 18, mono: true },
                { key: "line", label: "#", width: 4 },
                { key: "description", label: "Description", width: 30 },
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
                {
                  key: "hazmat",
                  label: "Hazmat",
                  width: 16,
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

        <View style={styles.signatureRow} wrap={false}>
          <View style={styles.signature}>
            <Text style={styles.signatureLine}>Driver signature</Text>
          </View>
          <View style={styles.signature}>
            <Text style={styles.signatureLine}>Date / time</Text>
          </View>
          <View style={styles.signature}>
            <Text style={styles.signatureLine}>{agency} officer</Text>
          </View>
        </View>

        <Footer left={`${carrier.name} · ${trip.movementNumber}`} generatedAt={data.generatedAt} />
      </Page>
    </Document>
  );
}
