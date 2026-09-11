import { Link, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { trpc } from "../../../src/lib/trpc";
import { useAsync } from "../../../src/lib/use-async";
import { colors, styles } from "../../../src/lib/theme";

const when = (value: Date | string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";

/** Read-only movement detail: status, crossing and the event timeline. */
export default function MovementScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, loading, refetch } = useAsync(
    () => trpc.movement.get.query({ id }),
    id ?? "",
  );

  if (loading && !data) {
    return (
      <View style={[styles.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.error} accessibilityLiveRegion="assertive">
          {error ?? "Movement not found"}
        </Text>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.buttonSecondary,
            pressed && styles.buttonSecondaryPressed,
          ]}
          onPress={() => void refetch()}
        >
          <Text style={styles.buttonSecondaryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const { crew, truck, trailers, events, shipments } = data;
  const movement = data;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refetch()} />}
    >
      <View style={styles.panel}>
        <View style={styles.row}>
          <Text style={[styles.h1, styles.flexText]}>{movement.movementNumber}</Text>
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
          {crew.length > 0 ? crew.map((c) => `${c.firstName} ${c.lastName}`).join(", ") : "No crew"}
          {truck ? ` · Truck ${truck.unitNumber}` : ""}
          {trailers.length > 0 ? ` · Trailer ${trailers.map((t) => t.unitNumber).join(" + ")}` : ""}
        </Text>
      </View>

      <View style={styles.panel}>
        <Text style={styles.h2}>Paperwork</Text>
        <Text style={styles.muted}>Choose the next step for this load.</Text>
        <Link href={`/(driver)/movement/${movement.id}/capture`} asChild>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          >
            <Text style={styles.buttonText}>Photograph a document</Text>
          </Pressable>
        </Link>
        <Link href={`/(driver)/movement/${movement.id}/pod`} asChild>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.buttonSecondary,
              pressed && styles.buttonSecondaryPressed,
            ]}
          >
            <Text style={styles.buttonSecondaryText}>Capture proof of delivery</Text>
          </Pressable>
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
