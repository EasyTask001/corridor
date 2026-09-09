import { useState } from "react";
import { Redirect } from "expo-router";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSession } from "../../src/lib/session";
import { colors, styles } from "../../src/lib/theme";

export default function SignInScreen() {
  const { session, signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  if (session) return <Redirect href="/(driver)" />;

  const submit = async () => {
    if (!email.trim() || !password || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.authContent}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <Text style={styles.eyebrow}>Corridor driver</Text>
          <Text style={styles.h1}>Welcome back</Text>
          <Text style={styles.muted}>Sign in with the account your dispatcher set up for you.</Text>

          <View style={[styles.panel, { marginTop: 14 }]}>
            <Text style={styles.h2}>Email address</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="Email address"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              inputMode="email"
              placeholder="driver@carrier.com"
              placeholderTextColor={colors.inkMuted}
              selectionColor={colors.accent}
              returnKeyType="next"
            />
            <Text style={styles.h2}>Password</Text>
            <View>
              <TextInput
                style={[styles.input, { paddingRight: 76 }]}
                accessibilityLabel="Password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                autoComplete="current-password"
                placeholderTextColor={colors.inkMuted}
                selectionColor={colors.accent}
                returnKeyType="done"
                onSubmitEditing={() => void submit()}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${showPassword ? "Hide" : "Show"} password`}
                accessibilityState={{ expanded: showPassword }}
                hitSlop={8}
                style={({ pressed }) => ({
                  position: "absolute",
                  right: 8,
                  top: 2,
                  minHeight: 44,
                  justifyContent: "center",
                  paddingHorizontal: 8,
                  opacity: pressed ? 0.6 : 1,
                })}
                onPress={() => setShowPassword((visible) => !visible)}
              >
                <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>
                  {showPassword ? "Hide" : "Show"}
                </Text>
              </Pressable>
            </View>
            {error ? (
              <Text style={styles.error} accessibilityLiveRegion="assertive">
                {error}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy || !email || !password, busy }}
              style={({ pressed }) => [
                styles.button,
                pressed && styles.buttonPressed,
                (busy || !email || !password) && styles.buttonDisabled,
              ]}
              disabled={busy || !email || !password}
              onPress={() => void submit()}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Sign in</Text>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
