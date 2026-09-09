const { getDefaultConfig } = require("expo/metro-config");

// Expo's SDK 54 defaults discover pnpm workspaces and package dependencies.
module.exports = getDefaultConfig(__dirname);
