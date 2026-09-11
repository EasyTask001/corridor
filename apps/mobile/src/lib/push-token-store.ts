/**
 * The Expo push token is a bearer capability (anyone holding it can push a
 * notification to this device), so it belongs in SecureStore, not in the
 * offline outbox's AsyncStorage-backed queue. The token is small — unlike the
 * Supabase session in `supabase.ts` — so no chunking is needed here.
 */
import * as SecureStore from "expo-secure-store";

export const PUSH_TOKEN_KEY = "corridor.push-token";

export const savePushToken = (token: string) => SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);

export const readPushToken = () => SecureStore.getItemAsync(PUSH_TOKEN_KEY);
