import { Document, Page, Text, View } from "@react-pdf/renderer";
import type { BlankSheetData } from "../types";
import { Field, Footer, Masthead, Section } from "./parts";
import { styles } from "./theme";

/** Ruled lines a driver fills in by hand. */
function Lines({ n }: { n: number }) {
  return (
    <View>
      {Array.from({ length: n }, (_, i) => (
        <View
          key={i}
          style={{
            borderBottomWidth: 0.5,
            borderBottomColor: "#c9ccd3",
            height: 16,
            marginBottom: 2,
          }}
        />
      ))}
    </View>
  );
}

/**
 * One page per trip number: the pre-numbered sheet a dispatcher hands out
 * before the load is built, so the driver can note seals and control numbers
 * at the shipper's dock.
 */
export function BlankDriverSheet({ data }: { data: BlankSheetData }) {
  const agency = data.regime === "ACE" ? "CBP" : "CBSA";
  return (
    <Document title="Blank driver sheets" author={data.carrier.name}>
      {data.tripNumbers.map((trip) => (
        <Page key={trip} size="LETTER" style={styles.page}>
          <Masthead
            carrier={data.carrier}
            title={`${data.regime} driver sheet`}
            meta={[`Trip ${trip}`]}
          />
          <Section title="Crossing">
            <View style={styles.grid}>
              <Field label={`${agency} port of entry`} value=" " wide />
              <Field label="Estimated crossing" value=" " />
              <Field label={`${agency} reference`} value=" " />
            </View>
          </Section>
          <Section title="Crew">
            <View style={styles.grid}>
              <Field label="Driver" value={data.driverName ?? " "} wide />
              <Field label="Co-driver / passenger" value={data.coDriverName ?? " "} wide />
            </View>
          </Section>
          <Section title="Equipment and seals">
            <View style={styles.grid}>
              <Field label="Tractor" value=" " />
              <Field label="Trailer 1" value=" " />
              <Field label="Trailer 2" value=" " />
              <Field label="Seals" value=" " />
            </View>
            <Lines n={2} />
          </Section>
          <Section
            title={
              data.regime === "ACE"
                ? "Shipments (PAPS / SCN, shipper, consignee, entry #)"
                : "Shipments (PARS / CCN, shipper, consignee)"
            }
          >
            <Lines n={8} />
          </Section>
          <Section title="Notes">
            <Lines n={4} />
          </Section>
          <View style={styles.signatureRow} wrap={false}>
            <View style={styles.signature}>
              <Text style={styles.signatureLine}>Driver signature</Text>
            </View>
            <View style={styles.signature}>
              <Text style={styles.signatureLine}>Date / time</Text>
            </View>
          </View>
          <Footer left={`${data.carrier.name} · Trip ${trip}`} generatedAt={data.generatedAt} />
        </Page>
      ))}
    </Document>
  );
}
