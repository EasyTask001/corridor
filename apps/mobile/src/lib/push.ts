/**
 * Expo push registration. The token is stored server-side through
 * `notifications.registerDevice`; the fan-out in
 * `packages/api/src/services/notifications.ts` sends to every device a
 * recipient has registered whose rule includes the `push` channel.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { devicePlatform } from "@corridor/domain";
import { outbox } from "./outbox-client";

export type PushRegistration =
  { status: "registered"; token: string } | { status: "skipped"; reason: string };

Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldPlaySound: false,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
});

function projectId(): string | undefined {
  const easProjectId = Constants.expoConfig?.extra?.eas?.projectId;
  return typeof easProjectId === "string" ? easProjectId : undefined;
}

export async function registerForPushNotifications(): Promise<PushRegistration> {
  // Simulators never receive a token, so this is a normal outcome in dev.
  if (!Device.isDevice) return { status: "skipped", reason: "Push needs a physical device" };

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Corridor",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  const granted = existing.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return { status: "skipped", reason: "Notification permission denied" };

  const platform = devicePlatform.safeParse(Platform.OS);
  if (!platform.success)
    return { status: "skipped", reason: `Unsupported platform ${Platform.OS}` };

  try {
    const id = projectId();
    const { data: token } = await Notifications.getExpoPushTokenAsync(
      id ? { projectId: id } : undefined,
    );
    // Queued rather than called directly: a driver often starts the app with
    // no signal, and the registration should survive until they have one.
    await outbox.submit("notifications.registerDevice", {
      expoPushToken: token,
      platform: platform.data,
    });
    return { status: "registered", token };
  } catch (error) {
    return {
      status: "skipped",
      reason: error instanceof Error ? error.message : "Could not obtain an Expo push token",
    };
  }
}
