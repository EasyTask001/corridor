import base from "@corridor/config/eslint/base.js";

/**
 * The workspace base config plus the two things a React Native app needs:
 * CommonJS globals for Metro/Babel config files, and React's JSX globals.
 * `eslint-plugin-react-native` is deliberately not installed — its rules are
 * about stylesheet hygiene, which Prettier and review already cover.
 */
export default [
  ...base,
  {
    // Metro and Babel load their config with `require`, so these two files are
    // CommonJS by necessity.
    files: ["*.js", "*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { __dirname: "readonly", module: "writable", require: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      globals: {
        console: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        crypto: "readonly",
        process: "readonly",
      },
    },
  },
  { ignores: [".expo/**", "expo-env.d.ts"] },
];
