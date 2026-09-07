import { StyleSheet } from "react-native";

/** A deliberately small token set — the driver app is five screens, not a design system. */
export const colors = {
  bg: "#f6f7f9",
  panel: "#ffffff",
  border: "#e3e6ea",
  ink: "#14181f",
  inkMuted: "#5b6472",
  accent: "#1d4ed8",
  danger: "#b42318",
  ok: "#067647",
};

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12 },
  panel: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  h1: { fontSize: 22, fontWeight: "700", color: colors.ink },
  h2: { fontSize: 16, fontWeight: "600", color: colors.ink },
  body: { fontSize: 14, color: colors.ink },
  muted: { fontSize: 13, color: colors.inkMuted },
  error: { fontSize: 13, color: colors.danger },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.panel,
    fontSize: 15,
    color: colors.ink,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: "center",
  },
  buttonSecondary: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: "center",
  },
  buttonText: { color: "#ffffff", fontWeight: "600", fontSize: 15 },
  buttonSecondaryText: { color: colors.ink, fontWeight: "600", fontSize: 15 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  badge: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  badgeText: { fontSize: 12, color: colors.inkMuted, fontWeight: "600" },
});
