import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useSession } from "../src/lib/session";
import { styles } from "../src/lib/theme";

/** Entry point: send the driver to the board or to sign-in once the stored session is read. */
export default function Index() {
  const { session, loading } = useSession();
  if (loading) {
    return (
      <View style={[styles.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator />
      </View>
    );
  }
  return session ? <Redirect href="/(driver)" /> : <Redirect href="/(auth)/sign-in" />;
}
