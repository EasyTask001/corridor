import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { useSession } from "../../src/lib/session";
import { outbox } from "../../src/lib/outbox-client";
import { trpc } from "../../src/lib/trpc";
import { useAsync } from "../../src/lib/use-async";
import { appendPage, type Page } from "../../src/lib/use-paged";
import { colors, styles } from "../../src/lib/theme";

type List = inferRouterOutputs<AppRouter>["notifications"]["list"];
type Row = List["rows"][number];

/**
 * The same inbox the web bell shows. `markRead` goes through the outbox so a
 * driver reading alerts in a dead zone does not lose the change — it is
 * idempotent, which is what makes a replay safe.
 *
 * Pagination is a small local reducer (`appendPage`) rather than React
 * Query's infinite-query helpers: the driver app calls the vanilla tRPC
 * client directly (see `use-async.ts`), so there is no query cache to hook
 * an infinite query onto.
 */
export default function NotificationsScreen() {
  const { membership } = useSession();
  const { data, error, loading, refetch } = useAsync(
    () => trpc.notifications.list.query({ limit: 50, unreadOnly: false }),
    membership?.organizationId ?? "",
  );
  const [page, setPage] = useState<Page<Row>>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [readLocally, setReadLocally] = useState<string[]>([]);

  // Every fresh load (first fetch or pull-to-refresh) replaces the
  // accumulated pages with the server's page one.
  useEffect(() => {
    setPage(data ? { rows: data.rows, nextCursor: data.nextCursor } : undefined);
  }, [data]);

  const loadMore = useCallback(async () => {
    if (!page?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await trpc.notifications.list.query({
        limit: 50,
        unreadOnly: false,
        cursor: page.nextCursor,
      });
      setPage((p) => appendPage(p, next));
    } finally {
      setLoadingMore(false);
    }
  }, [page?.nextCursor, loadingMore]);

  const markRead = useCallback(async (id: string) => {
    setReadLocally((previous) => [...previous, id]);
    await outbox.submit("notifications.markRead", { id });
  }, []);

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      data={page?.rows ?? []}
      keyExtractor={(n) => n.id}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refetch()} />}
      onEndReached={() => page?.nextCursor && !loadingMore && void loadMore()}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        error ? (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null
      }
      ListFooterComponent={
        loadingMore ? (
          <View style={{ paddingVertical: 16, alignItems: "center" }}>
            <Text style={styles.muted}>Loading more…</Text>
          </View>
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
