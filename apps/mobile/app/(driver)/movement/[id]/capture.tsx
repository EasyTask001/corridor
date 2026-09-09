import { useState } from "react";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from "react-native";
import { documentType as documentTypeSchema, type DocumentType } from "@corridor/domain";
import { uploadDocument } from "../../../../src/lib/upload";
import { colors, styles } from "../../../../src/lib/theme";

const TYPES: { value: DocumentType; label: string }[] = documentTypeSchema.options.map((value) => ({
  value,
  label: value.replace(/_/g, " "),
}));

/** Extension/MIME for what the picker returns — the API only accepts a known list. */
function mimeFor(asset: ImagePicker.ImagePickerAsset): string {
  if (asset.mimeType === "image/png" || asset.fileName?.toLowerCase().endsWith(".png")) {
    return "image/png";
  }
  return "image/jpeg";
}

export default function CaptureScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [asset, setAsset] = useState<ImagePicker.ImagePickerAsset>();
  const [docType, setDocType] = useState<DocumentType>("bol");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();

  const pick = async (source: "camera" | "library") => {
    setError(undefined);
    const permission =
      source === "camera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("Corridor needs access to take or attach a photo of the paperwork.");
      return;
    }
    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync({ quality: 0.7 })
        : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ["images"] });
    if (!result.canceled) setAsset(result.assets[0]);
  };

  const upload = async () => {
    if (!asset || !id) return;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const mimeType = mimeFor(asset);
      const result = await uploadDocument({
        uri: asset.uri,
        filename:
          asset.fileName ?? `${docType}-${Date.now()}.${mimeType === "image/png" ? "png" : "jpg"}`,
        mimeType,
        documentType: docType,
        movementId: id,
      });
      setStatus(
        result.finalized
          ? "Uploaded. Extraction has been queued."
          : "Uploaded. Finalising will finish when you are back online.",
      );
      setAsset(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View style={styles.panel}>
        <Text style={styles.h2}>Document type</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {TYPES.map((t) => (
            <Pressable
              key={t.value}
              accessibilityRole="button"
              accessibilityState={{ selected: t.value === docType }}
              onPress={() => setDocType(t.value)}
              style={({ pressed }) => [
                styles.badge,
                { minHeight: 48 },
                t.value === docType && styles.badgeSelected,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.badgeText}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.panel}>
        <Text style={styles.h2}>Photo</Text>
        {asset ? (
          <Image
            source={{ uri: asset.uri }}
            accessibilityLabel="Selected document preview"
            style={{ width: "100%", height: 260, borderRadius: 12, backgroundColor: colors.bg }}
            resizeMode="contain"
          />
        ) : (
          <Text style={styles.muted}>
            Take a photo of the paperwork, or attach one you already have.
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          onPress={() => void pick("camera")}
        >
          <Text style={styles.buttonText}>Take photo</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.buttonSecondary,
            pressed && styles.buttonSecondaryPressed,
          ]}
          onPress={() => void pick("library")}
        >
          <Text style={styles.buttonSecondaryText}>Choose from library</Text>
        </Pressable>
      </View>

      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="assertive">
          {error}
        </Text>
      ) : null}
      {status ? (
        <Text style={styles.success} accessibilityLiveRegion="polite">
          {status}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !asset || busy, busy }}
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
          (!asset || busy) && styles.buttonDisabled,
        ]}
        disabled={!asset || busy}
        onPress={() => void upload()}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Upload</Text>}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => [styles.buttonSecondary, pressed && styles.buttonSecondaryPressed]}
        onPress={() => router.back()}
      >
        <Text style={styles.buttonSecondaryText}>Done</Text>
      </Pressable>
    </ScrollView>
  );
}
