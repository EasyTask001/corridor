import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider } from "../src/lib/session";
import { colors } from "../src/lib/theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.panel },
            headerTintColor: colors.ink,
            headerShadowVisible: false,
            headerTitleStyle: { fontWeight: "600" },
            contentStyle: { backgroundColor: colors.bg },
            animation: "slide_from_right",
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
          <Stack.Screen name="(driver)" options={{ headerShown: false }} />
        </Stack>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
