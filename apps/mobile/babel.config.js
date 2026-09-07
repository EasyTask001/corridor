/** Expo's preset already handles TypeScript, JSX and expo-router's entry. */
module.exports = function babelConfig(api) {
  api.cache(true);
  return { presets: ["babel-preset-expo"] };
};
