import * as SecureStore from "expo-secure-store";
import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";

/**
 * SecureStore refuses values larger than 2048 bytes, and a Supabase session
 * (access token + refresh token + user object) regularly exceeds that. The
 * adapter therefore splits a value across `<key>.0`, `<key>.1`, ... and stores
 * the chunk count under the key itself, so the session survives round-tripping
 * on both platforms. Everything still lands in the OS keychain / keystore —
 * never in AsyncStorage, which is world-readable on a rooted device.
 */
const CHUNK_SIZE = 1800;

const chunkKey = (key: string, index: number) => `${key}.${index}`;

export const secureStorage: SupportedStorage = {
  async getItem(key) {
    const head = await SecureStore.getItemAsync(key);
    if (head === null) return null;
    const count = Number.parseInt(head, 10);
    if (!Number.isInteger(count) || count < 1) return null;
    const parts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const part = await SecureStore.getItemAsync(chunkKey(key, i));
      // A partially-written value is unusable — behave as "no session".
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join("");
  },

  async setItem(key, value) {
    await this.removeItem?.(key);
    const count = Math.max(1, Math.ceil(value.length / CHUNK_SIZE));
    for (let i = 0; i < count; i += 1) {
      await SecureStore.setItemAsync(
        chunkKey(key, i),
        value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
      );
    }
    await SecureStore.setItemAsync(key, String(count));
  },

  async removeItem(key) {
    const head = await SecureStore.getItemAsync(key);
    const count = head === null ? 0 : Number.parseInt(head, 10);
    for (let i = 0; i < (Number.isInteger(count) ? count : 0); i += 1) {
      await SecureStore.deleteItemAsync(chunkKey(key, i));
    }
    await SecureStore.deleteItemAsync(key);
  },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: secureStorage,
    autoRefreshToken: true,
    persistSession: true,
    // There is no URL bar on a handset; deep links are handled explicitly.
    detectSessionInUrl: false,
  },
});
