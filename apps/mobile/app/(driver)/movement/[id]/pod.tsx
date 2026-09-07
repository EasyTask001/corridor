import { useMemo, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ActivityIndicator,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import {
  SIGNATURE_FILENAME,
  SIGNATURE_MIME_TYPE,
  encodeSignaturePng,
  isSignatureEmpty,
  signatureDataUri,
  strokesToSvgPath,
  type Point,
  type Stroke,
} from "../../../../src/lib/signature";
import { uploadDocument } from "../../../../src/lib/upload";
import { colors, styles } from "../../../../src/lib/theme";

const PAD_HEIGHT = 240;

/**
 * Proof of delivery. The pad captures raw touch points and `signature.ts`
 * encodes them as a PNG in pure TypeScript — no WebView canvas, no
 * `react-native-view-shot`, and nothing to mock in the unit tests. It uploads
 * as `document_type: 'other'` named `pod-signature.png`.
 */
export default function PodScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [width, setWidth] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  // Touch handling must not re-render on every move event, so the in-progress
  // stroke lives in a ref and is committed to state as the finger lifts.
  const current = useRef<Point[]>([]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          current.current = [{ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }];
          setStrokes((previous) => [...previous, current.current]);
        },
        onPanResponderMove: (event) => {
          current.current = [
            ...current.current,
            { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY },
          ];
          setStrokes((previous) => [...previous.slice(0, -1), current.current]);
        },
        onPanResponderRelease: () => {
          current.current = [];
        },
      }),
    [],
  );

  const path = strokesToSvgPath(strokes);
  const empty = isSignatureEmpty(strokes);

  const submit = async () => {
    if (!id || empty || width === 0) return;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const png = encodeSignaturePng(strokes, { width, height: PAD_HEIGHT, lineWidth: 3 });
      const result = await uploadDocument({
        uri: signatureDataUri(png),
        filename: SIGNATURE_FILENAME,
        mimeType: SIGNATURE_MIME_TYPE,
        documentType: "other",
        movementId: id,
      });
      setStatus(
        result.finalized
          ? "Signature stored against this movement."
          : "Signature uploaded; it will finish syncing when you are back online.",
      );
      setStrokes([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not upload the signature");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.panel}>
        <Text style={styles.h2}>Consignee signature</Text>
        <Text style={styles.muted}>Have the receiver sign inside the box.</Text>
        <View
          onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
          style={{
            height: PAD_HEIGHT,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 8,
            backgroundColor: "#fff",
            overflow: "hidden",
          }}
          {...responder.panHandlers}
        >
          <Svg width="100%" height={PAD_HEIGHT}>
            <Path d={path} stroke={colors.ink} strokeWidth={3} fill="none" />
          </Svg>
        </View>
        <Pressable
          accessibilityRole="button"
          style={styles.buttonSecondary}
          onPress={() => setStrokes([])}
        >
          <Text style={styles.buttonSecondaryText}>Clear</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {status ? <Text style={[styles.muted, { color: colors.ok }]}>{status}</Text> : null}

      <Pressable
        accessibilityRole="button"
        style={[styles.button, empty || busy ? { opacity: 0.5 } : null]}
        disabled={empty || busy}
        onPress={() => void submit()}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Upload signature</Text>
        )}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        style={styles.buttonSecondary}
        onPress={() => router.back()}
      >
        <Text style={styles.buttonSecondaryText}>Done</Text>
      </Pressable>
    </ScrollView>
  );
}
