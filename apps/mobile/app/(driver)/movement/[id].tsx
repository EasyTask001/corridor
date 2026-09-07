import { Link, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from "react-native";
import { trpc } from "../../../src/lib/trpc";
import { useAsync } from "../../../src/lib/use-async";
import { colors, styles } from "../../../src/lib/theme";

const when = (value: Date | string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";

/** Read-only movement detail: status, crossing and the event timeline. */
export default function MovementScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, loading, refetch } = useAsync(
    () => trpc.movement.get.query({ id: id! }),
    id ?? "",
  );

  if (loading && !data) {
    return (
      <View style={[styles.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.error}>{error ?? "Movement not found"}</Text>
      </View>
    );
  }

  const { driver, truck, trailer, events, shipments } = data;
  const movement = data;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refetch()} />}
    >
      <View style={styles.panel}>
        <View style={styles.row}>
          <Text style={styles.h1}>{movement.movementNumber}</Text>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{movement.status}</Text>
          </View>
        </View>
        <Text style={styles.muted}>
          {movement.regime}
          {movement.tripNumber ? ` · Trip ${movement.tripNumber}` : ""}
        </Text>
        <Text style={styles.body}>
          Crossing: {movement.port?.name ?? movement.port?.code ?? "not set"}
        </Text>
        <Text style={styles.body}>Scheduled: {when(movement.scheduledCrossingAt)}</Text>
        {movement.customsReferenceNumber ? (
          <Text style={styles.body}>Customs ref: {movement.customsReferenceNumber}</Text>
        ) : null}
        <Text style={styles.muted}>
          {driver ? `${driver.firstName} ${driver.lastName}` : "No driver"}
          {truck ? ` · Truck ${truck.unitNumber}` : ""}
          {trailer ? ` · Trailer ${trailer.unitNumber}` : ""}
        </Text>
      </View>

      <View style={styles.panel}>
        <Text style={styles.h2}>Paperwork</Text>
        <Link
          href={`/(driver)/movement/${movement.id}/capture`}
          style={{ color: colors.accent, fontWeight: "600", paddingVertical: 6 }}
        >
          Photograph a document
        </Link>
        <Link
          href={`/(driver)/movement/${movement.id}/pod`}
          style={{ color: colors.accent, fontWeight: "600", paddingVertical: 6 }}
        >
          Capture proof of delivery
        </Link>
      </View>

      <View style={styles.panel}>
        <Text style={styles.h2}>Shipments ({shipments.length})</Text>
        {shipments.length === 0 ? (
          <Text style={styles.muted}>No shipments on this movement.</Text>
        ) : (
          shipments.map((shipment) => (
            <View key={shipment.id} style={{ gap: 2, paddingVertical: 4 }}>
              <Text style={styles.body}>{shipment.controlNumber}</Text>
              {shipment.commodities.map((line) => (
                <Text key={line.id} style={styles.muted}>
                  {line.lineNumber}. {line.commodityDescription}
                </Text>
              ))}
            </View>
          ))
        )}
      </View>

      <View style={styles.panel}>
        <Text style={styles.h2}>Timeline</Text>
        {events.length === 0 ? (
          <Text style={styles.muted}>Nothing has happened on this movement yet.</Text>
        ) : (
          events.map((event) => (
            <View key={event.id} style={{ gap: 2, paddingVertical: 4 }}>
              <Text style={styles.body}>
                {event.eventType}
                {event.toStatus ? ` → ${event.toStatus}` : ""}
              </Text>
              <Text style={styles.muted}>
                {when(event.occurredAt)}
                {event.actorName ? ` · ${event.actorName}` : ""}
              </Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}
