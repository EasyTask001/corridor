import { Link, useRouter } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useSession } from "../../src/lib/session";
import { trpc } from "../../src/lib/trpc";
import { useAsync } from "../../src/lib/use-async";
import { colors, styles } from "../../src/lib/theme";

/**
 * The assigned-load board. `movement.list` accepts either `movement.read` or
 * `movement.read_assigned`, and RLS narrows a Driver-Portal member to the
 * movements they are the driver on — so this is the same call the dispatcher
 * board makes, returning only this driver's work.
 */
export default function DriverBoard() {
  const router = useRouter();
  const { membership, online, pending, signOut } = useSession();
  const orgId = membership?.organizationId ?? "";
  const { data, error, loading, refetch } = useAsync(
    () => trpc.movement.list.query({ limit: 50, offset: 0 }),
    orgId,
  );

  if (loading && !data) {
    return (
      <View style={[styles.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      data={data?.rows ?? []}
      keyExtractor={(m) => m.id}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refetch()} />}
      ListHeaderComponent={
        <View style={{ gap: 8 }}>
          <View style={styles.row}>
            <Text style={styles.h1}>{membership?.organizationName ?? "Corridor"}</Text>
            <Link
              href="/(driver)/notifications"
              style={{ color: colors.accent, fontWeight: "600" }}
            >
              Alerts
            </Link>
          </View>
          <Text style={styles.muted}>
            {online ? "Online" : "Offline"}
            {pending > 0 ? ` · ${pending} change${pending === 1 ? "" : "s"} waiting to sync` : ""}
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      }
      ListEmptyComponent={
        <View style={styles.panel}>
          <Text style={styles.body}>No loads assigned to you right now.</Text>
        </View>
      }
      ListFooterComponent={
        <Pressable
          accessibilityRole="button"
          style={[styles.buttonSecondary, { marginTop: 24 }]}
          onPress={() => void signOut()}
        >
          <Text style={styles.buttonSecondaryText}>Sign out</Text>
        </Pressable>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          style={styles.panel}
          onPress={() => router.push(`/(driver)/movement/${item.id}`)}
        >
          <View style={styles.row}>
            <Text style={styles.h2}>{item.movementNumber}</Text>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{item.status}</Text>
            </View>
          </View>
          <Text style={styles.muted}>
            {item.regime} ·{" "}
            {item.port?.name ?? item.port?.code ?? "crossing not set"}
          </Text>
          <Text style={styles.muted}>
            {item.truckUnit ? `Truck ${item.truckUnit}` : "No truck"}
            {item.trailerUnit ? ` · Trailer ${item.trailerUnit}` : ""}
          </Text>
        </Pressable>
      )}
    />
  );
}
