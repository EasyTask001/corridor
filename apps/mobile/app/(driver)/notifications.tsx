import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useSession } from "../../src/lib/session";
import { outbox } from "../../src/lib/outbox-client";
import { trpc } from "../../src/lib/trpc";
import { useAsync } from "../../src/lib/use-async";
import { colors, styles } from "../../src/lib/theme";

/**
 * The same inbox the web bell shows. `markRead` goes through the outbox so a
 * driver reading alerts in a dead zone does not lose the change — it is
 * idempotent, which is what makes a replay safe.
 */
export default function NotificationsScreen() {
  const { membership } = useSession();
  const { data, error, loading, refetch } = useAsync(
    () => trpc.notifications.list.query({ limit: 50, offset: 0, unreadOnly: false }),
    membership?.organizationId ?? "",
  );
  const [readLocally, setReadLocally] = useState<string[]>([]);

  const markRead = useCallback(async (id: string) => {
    setReadLocally((previous) => [...previous, id]);
    await outbox.submit("notifications.markRead", { id });
  }, []);

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      data={data?.rows ?? []}
      keyExtractor={(n) => n.id}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refetch()} />}
      ListHeaderComponent={
        error ? (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null
      }
      ListEmptyComponent={
        loading ? (
          <View style={{ minHeight: 160, alignItems: "center", justifyContent: "center" }}>
            <Text style={styles.muted}>Loading notifications…</Text>
          </View>
        ) : (
          <View style={styles.panel}>
            <Text style={styles.h2}>You’re all caught up</Text>
            <Text style={styles.muted}>New operational alerts will appear here.</Text>
          </View>
        )
      }
      renderItem={({ item }) => {
        const unread = !item.readAt && !readLocally.includes(item.id);
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: unread }}
            accessibilityHint={unread ? "Marks this notification as read" : undefined}
            style={({ pressed }) => [
              styles.panel,
              unread && { borderColor: colors.accent, backgroundColor: colors.accentSoft },
              pressed && styles.panelPressed,
            ]}
            onPress={() => (unread ? void markRead(item.id) : undefined)}
          >
            <View style={styles.row}>
              <Text style={[styles.h2, styles.flexText]}>{item.title}</Text>
              {unread ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>New</Text>
                </View>
              ) : null}
            </View>
            {item.body ? <Text style={styles.body}>{item.body}</Text> : null}
            <Text style={styles.muted}>{new Date(item.createdAt).toLocaleString()}</Text>
          </Pressable>
        );
      }}
    />
  );
}
