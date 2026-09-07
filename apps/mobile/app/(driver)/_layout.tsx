import { Redirect, Stack } from "expo-router";
import { useSession } from "../../src/lib/session";
import { colors } from "../../src/lib/theme";

export default function DriverLayout() {
  const { session, loading } = useSession();
  if (!loading && !session) return <Redirect href="/(auth)/sign-in" />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.panel },
        headerTintColor: colors.ink,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: "My loads" }} />
      <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
      <Stack.Screen name="movement/[id]" options={{ title: "Movement" }} />
      <Stack.Screen name="movement/[id]/capture" options={{ title: "Add document" }} />
      <Stack.Screen name="movement/[id]/pod" options={{ title: "Proof of delivery" }} />
    </Stack>
  );
}
